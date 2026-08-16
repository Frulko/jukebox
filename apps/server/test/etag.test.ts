import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { routeTable } from '../src/openapi.ts'

/**
 * The collection ETag, which is one of the five network rules.
 *
 * The rule is easy to satisfy wrongly, and this file exists because it *was*
 * satisfied wrongly: every ETag was keyed on the library revision, including
 * for collections the revision does not describe. Adding a schedule changed no
 * counter the revision tracks, so the server answered 304 and a client went on
 * showing a list without the row it had just created — stale not by a second
 * but until something unrelated happened.
 *
 * So the test is not "does it have an ETag". It is "does the ETag change when
 * the answer does", which is the only version of the question worth asking.
 */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-etag-'))
  const app = createApp(join(dir, 'db.sqlite'))
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.app.fetch(new Request(`http://x/api/v1${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }))
  return { app, call, cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

/** A collection, something that changes it, and nothing else. */
const CASES: { path: string; change: (call: any) => Promise<unknown> }[] = [
  {
    path: '/schedules',
    change: (call) => call('POST', '/schedules',
      { name: 'Nightly', kind: 'scan', cron: '0 3 * * *', payload: { sourceId: 'x' } }),
  },
  {
    path: '/sources',
    change: (call) => call('POST', '/sources', { id: 's2', name: 'Second', root: '/tmp' }),
  },
  {
    path: '/devices',
    change: (call) => call('POST', '/devices', { id: 'ipod', name: 'iPod', kind: 'ipod-classic' }),
  },
  {
    path: '/users',
    change: (call) => call('POST', '/users', { username: 'someone', password: 'longenough' }),
  },
  {
    path: '/playlists',
    change: (call) => call('POST', '/playlists', { name: 'Evening' }),
  },
]

for (const { path, change } of CASES) {
  test(`${path} stops saying 304 once it has changed`, async () => {
    const h = await harness()
    try {
      const first = await h.call('GET', path)
      const etag = first.headers.get('etag')
      assert.ok(etag, `${path} carries no ETag at all`)
      const before = await first.text()

      await change(h.call)

      // The body really did change, or this test proves nothing.
      const after = await (await h.call('GET', path)).text()
      assert.notEqual(after, before, `${path} did not actually change`)

      const revalidated = await h.call('GET', path, undefined, { 'if-none-match': etag! })
      assert.notEqual(revalidated.status, 304,
        `${path} answered 304 with an ETag that no longer describes it`)
      assert.notEqual(revalidated.headers.get('etag'), etag, `${path} reused a stale ETag`)
    } finally { await h.cleanup() }
  })
}

test('an unchanged collection still revalidates cheaply', async () => {
  const h = await harness()
  try {
    // The other half of the rule: if nothing changed, a client must not be made
    // to download the list again. An ETag that changes every time is as useless
    // as one that never does.
    for (const path of ['/schedules', '/sources', '/playlists', '/jobs', '/users']) {
      const first = await h.call('GET', path)
      const etag = first.headers.get('etag')
      assert.ok(etag, `${path} carries no ETag`)

      const again = await h.call('GET', path, undefined, { 'if-none-match': etag! })
      assert.equal(again.status, 304, `${path} re-sent a list that had not changed`)
    }
  } finally { await h.cleanup() }
})

test('every collection route carries an ETag', async () => {
  const h = await harness()
  try {
    // Read off the router rather than a list kept by hand, so a collection
    // added later is covered without anyone remembering to add it here.
    //
    // `/events` is a stream that never ends and `/outputs` runs three network
    // discoveries; neither is a cacheable collection.
    const skip = new Set(['/events', '/outputs', '/tracks/delta', '/store'])
    const missing: string[] = []

    for (const r of routeTable(h.app.app)) {
      if (r.method !== 'GET' || r.path.includes(':') || skip.has(r.path)) continue
      const res = await h.call('GET', r.path)
      if (res.status !== 200) continue
      const body = await res.text()
      // A collection is an answer with a list in it. Scalars and single objects
      // are not what this rule is about.
      if (!/"(items|groups)"\s*:/.test(body)) continue
      if (!res.headers.get('etag')) missing.push(r.path)
    }

    assert.deepEqual(missing, [], 'collections served without an ETag')
  } finally { await h.cleanup() }
})
