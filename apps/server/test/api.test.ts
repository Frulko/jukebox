import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { readTags } from '../src/tags.ts'

const FIXTURES = process.env.JUKEBOX_FIXTURES ?? ''
const skip = FIXTURES ? false : 'JUKEBOX_FIXTURES is not set'

/** The app is exercised as Request → Response: no port, nothing to wait on. */
async function harness(writable = true) {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-api-'))
  const musicDir = join(dir, 'music')
  await cp(FIXTURES, musicDir, { recursive: true })
  const { app, jobs } = createApp(join(dir, 'db.sqlite'))

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(new Request(`http://x/api/v1${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
  }

  await call('POST', '/sources', { id: 'loc', name: 'Music', root: musicDir, writable })
  await call('POST', '/sources/loc/scan')
  await settle(jobs)
  const raw = (method: string, path: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://x/api/v1${path}`, { method, headers }))

  return { call, raw, jobs, musicDir, cleanup: () => { jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

/** Waits for the queue to drain — more reliable than a fixed delay. */
async function settle(jobs: any, ms = 4000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const busy = jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')
    if (!busy) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('the queue never drains')
}

test('scan then read: the library fills up and paginates', { skip }, async () => {
  const h = await harness()
  try {
    const { body } = await h.call('GET', '/tracks?limit=100')
    assert.equal(body.items.length, 4, '4 files indexed')
    const daft = body.items.filter((t: any) => t.artist === 'Daft Punk')
    assert.equal(daft.length, 3)
    assert.ok(daft.every((t: any) => t.duration > 0), 'durations read from the signal')
    assert.ok(daft.every((t: any) => Array.isArray(t.devices)), 'device presence ships with the page')
  } finally { await h.cleanup() }
})

test('ETag: the second call returns no bytes', { skip }, async () => {
  const h = await harness()
  try {
    const first = await h.call('GET', '/tracks')
    const etag = first.headers.get('etag')!
    assert.ok(etag)

    const again = await h.raw('GET', '/tracks', { 'if-none-match': etag })
    assert.equal(again.status, 304)
    assert.equal((await again.text()).length, 0, 'no body bytes')

    // A write changes the revision, so the ETag, so the client reloads.
    const ids = first.body.items.slice(0, 1).map((t: any) => t.id)
    await h.call('PATCH', '/tracks', { ids, patch: { rating: 5 }, writeToFiles: false })
    const afterWrite = await h.raw('GET', '/tracks', { 'if-none-match': etag })
    assert.equal(afterWrite.status, 200, 'after a write, the old ETag no longer holds')
  } finally { await h.cleanup() }
})

test('bulk edit: the database answers immediately, the disk follows in a job', { skip }, async () => {
  const h = await harness(true)
  try {
    const before = await h.call('GET', '/tracks?limit=100')
    const ids = before.body.items.filter((t: any) => t.artist === 'Daft Punk').map((t: any) => t.id)
    assert.equal(ids.length, 3)

    const res = await h.call('PATCH', '/tracks', { ids, patch: { genre: 'French House', year: 2001 } })
    assert.equal(res.status, 200)
    assert.equal(res.body.updated, 3)
    assert.ok(res.body.job, 'a write-through job is created')

    // The database is up to date immediately, without waiting for the disk.
    const after = await h.call('GET', '/tracks?limit=100')
    const edited = after.body.items.filter((t: any) => ids.includes(t.id))
    assert.ok(edited.every((t: any) => t.genre === 'French House'), 'database up to date right away')

    await settle(h.jobs)
    assert.equal(h.jobs.get(res.body.job.id)!.state, 'done')

    // And the file on disk really carries the new tag.
    const tags = await readTags(join(h.musicDir, 'Daft Punk/Discovery/01.mp3'))
    assert.equal(tags.tags.genre, 'French House', 'the tag is written into the file')
    assert.equal(tags.tags.year, 2001)
  } finally { await h.cleanup() }
})

test('a read-only source keeps its files untouched', { skip }, async () => {
  const h = await harness(false)
  try {
    const page = await h.call('GET', '/tracks?limit=100')
    const one = page.body.items.find((t: any) => t.path.endsWith('01.mp3'))
    const before = await readTags(join(h.musicDir, one.path))

    const res = await h.call('PATCH', '/tracks', { ids: [one.id], patch: { genre: 'Must not be written' } })
    await settle(h.jobs)
    assert.equal(h.jobs.get(res.body.job.id)!.state, 'done', 'the job completes without failing')

    const after = await readTags(join(h.musicDir, one.path))
    assert.equal(after.tags.genre, before.tags.genre, 'the file is not touched')
    const reread = await h.call('GET', '/tracks?limit=100')
    assert.equal(reread.body.items.find((t: any) => t.id === one.id).genre, 'Must not be written',
      'the database keeps the value: that is the user\'s choice, not an error')
  } finally { await h.cleanup() }
})

test('a rescan does not re-read what has not changed', { skip }, async () => {
  const h = await harness()
  try {
    const r1 = await h.call('GET', '/tracks?limit=100')
    const rev1 = r1.body.revision

    const relance = await h.call('POST', '/sources/loc/scan')
    assert.notEqual(relance.body.state, 'done', 'a finished scan does not block the next one')
    await settle(h.jobs)

    const r2 = await h.call('GET', '/tracks?limit=100')
    assert.equal(r2.body.items.length, 4, 'no duplicates')
    assert.equal(r2.body.revision, rev1, 'nothing changed on disk: no writes, revision unchanged')
  } finally { await h.cleanup() }
})

test('an unknown route answers in the documented error format', { skip }, async () => {
  const h = await harness()
  try {
    const res = await h.call('GET', '/nonsense')
    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'not_found')
  } finally { await h.cleanup() }
})

test('GET /tracks/:id returns the right track, even past the first page', { skip }, async () => {
  const h = await harness()
  try {
    const { body } = await h.call('GET', '/tracks?limit=100')
    // Every track must be findable by its id. An early version searched inside
    // a bounded page and fell back to the first row: a 200 with the wrong
    // track, which is worse than an error.
    for (const t of body.items) {
      const one = await h.call('GET', `/tracks/${t.id}`)
      assert.equal(one.status, 200)
      assert.equal(one.body.id, t.id)
      assert.equal(one.body.name, t.name)
    }
    const absent = await h.call('GET', '/tracks/does-not-exist')
    assert.equal(absent.status, 404)
    assert.equal(absent.body.error.code, 'not_found')
  } finally { await h.cleanup() }
})

test('the artwork URL has a route behind it', { skip }, async () => {
  const h = await harness()
  try {
    const { body } = await h.call('GET', '/tracks?limit=1')
    const t = body.items[0]
    assert.ok(t.artwork, 'every track carries an artwork URL')

    const res = await h.raw('GET', t.artwork.replace('/api/v1', ''))
    // The ffmpeg fixtures embed no artwork: we want an explicit 404, not a
    // missing route answering "not found".
    assert.equal(res.status, 404)
    const err = await res.json() as any
    assert.equal(err.error.code, 'no_artwork', 'the route exists and knows how to say there is no image')
  } finally { await h.cleanup() }
})
