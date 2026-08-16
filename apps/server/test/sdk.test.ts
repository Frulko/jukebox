import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { ApiError, createClient } from '../../../packages/client-sdk/src/index.ts'

const FIXTURES = process.env.JUKEBOX_FIXTURES ?? ''
const skip = FIXTURES ? false : 'JUKEBOX_FIXTURES is not set'

/**
 * The SDK gets `app.fetch` as its transport: the whole client/server contract
 * is checked end to end, with no port and nothing to wait on. If the two drift
 * apart, this test breaks before the UI does.
 */
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-sdk-'))
  const musicDir = join(dir, 'music')
  await cp(FIXTURES, musicDir, { recursive: true })
  const { app, jobs } = createApp(join(dir, 'db.sqlite'))
  const api = createClient({
    baseUrl: 'http://x/api/v1',
    fetch: ((input: any, init: any) => app.fetch(new Request(input, init))) as typeof fetch,
  })
  return { api, jobs, musicDir, cleanup: () => { jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

const settle = async (jobs: any, ms = 4000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('the queue never drains')
}

test('the SDK talks to the real API with no privileged path', { skip }, async () => {
  const h = await harness()
  try {
    assert.equal((await h.api.health()).ok, true)

    const src = await h.api.sources.create({ id: 'loc', name: 'Music', root: h.musicDir, writable: true })
    assert.equal(src.id, 'loc')
    assert.equal(src.writable, 1)

    const job = await h.api.sources.scan('loc')
    assert.ok(['queued', 'running', 'done'].includes(job.state))
    await settle(h.jobs)

    const page = await h.api.tracks.list({ sort: 'artist', limit: 10 })
    assert.equal(page.items.length, 4)
    assert.equal(page.next, null, 'last page')
    assert.ok(page.items[0].devices instanceof Array)
    assert.equal(typeof page.items[0].duration, 'number', 'duration, not time')
  } finally { await h.cleanup() }
})

test('the SDK ETag cache avoids a second transfer', { skip }, async () => {
  const h = await harness()
  try {
    await h.api.sources.create({ id: 'loc', name: 'M', root: h.musicDir })
    await h.api.sources.scan('loc'); await settle(h.jobs)

    let appels = 0
    const app2 = createApp(join(await mkdtemp(join(tmpdir(), 'jukebox-etag-')), 'db.sqlite'))
    // We count the bodies actually received, through an instrumented transport.
    const api = createClient({
      baseUrl: 'http://x/api/v1',
      fetch: (async (input: any, init: any) => {
        const res = await app2.app.fetch(new Request(input, init))
        if (res.status === 200) appels++
        return res
      }) as typeof fetch,
    })
    await api.sources.list()
    await api.sources.list()
    assert.equal(appels, 1, 'the second call is a 304 served from the local cache')
    app2.jobs.stop()
  } finally { await h.cleanup() }
})

test('bulk editing goes through the SDK and returns a job', { skip }, async () => {
  const h = await harness()
  try {
    await h.api.sources.create({ id: 'loc', name: 'M', root: h.musicDir, writable: true })
    await h.api.sources.scan('loc'); await settle(h.jobs)

    const { items } = await h.api.tracks.list({ limit: 100 })
    const ids = items.filter((t) => t.artist === 'Daft Punk').map((t) => t.id)
    const res = await h.api.tracks.patch(ids, { genre: 'French House', rating: 5 })
    assert.equal(res.updated, 3)
    assert.ok(res.job, 'the write-through to disk is a job')
    await settle(h.jobs)

    const delta = await h.api.tracks.delta(0)
    assert.ok(delta.changed.every((t) => t.rev > 0))
    const edited = delta.changed.filter((t) => ids.includes(t.id))
    assert.ok(edited.every((t) => t.genre === 'French House' && t.rating === 5))
  } finally { await h.cleanup() }
})

test('an API error surfaces typed, not as raw text', { skip }, async () => {
  const h = await harness()
  try {
    await assert.rejects(
      () => h.api.tracks.get('does-not-exist'),
      (err: unknown) => err instanceof ApiError && err.status === 404 && err.code === 'not_found',
    )
  } finally { await h.cleanup() }
})

test('paginate walks every page', { skip }, async () => {
  const h = await harness()
  try {
    await h.api.sources.create({ id: 'loc', name: 'M', root: h.musicDir })
    await h.api.sources.scan('loc'); await settle(h.jobs)

    const vues: string[] = []
    for await (const lot of h.api.paginate({ limit: 2, sort: 'name' })) vues.push(...lot.map((t) => t.id))
    assert.equal(vues.length, 4)
    assert.equal(new Set(vues).size, 4, 'no duplicates across pages')
  } finally { await h.cleanup() }
})
