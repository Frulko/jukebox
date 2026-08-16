import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'

const FIXTURES = process.env.JUKEBOX_FIXTURES ?? ''
const skip = FIXTURES ? false : 'JUKEBOX_FIXTURES is not set'

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-bk-'))
  const musicDir = join(dir, 'music')
  await cp(FIXTURES, musicDir, { recursive: true })
  const { app, jobs, db } = createApp(join(dir, 'db.sqlite'))

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(new Request(`http://x/api/v1${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  const settle = async (ms = 6000) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const busy = jobs.list({}).filter((j: any) => j.state === 'queued' || j.state === 'running')
      if (!busy.length) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  await call('POST', '/sources', { id: 'loc', name: 'Music', root: musicDir, writable: true })
  await call('POST', '/sources/loc/scan')
  await settle()

  return { call, settle, db, jobs, musicDir, cleanup: () => { jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

test('a backup carries the curation and not the library', { skip }, async () => {
  const h = await harness()
  try {
    const before = (await h.call('GET', '/backup')).body
    // Nothing has been rated, so nothing about the tracks is worth saving —
    // a scan rebuilds all of it.
    assert.equal(before.tracks.length, 0, 'an untouched library backs up as empty')

    const ids = (await h.call('GET', '/tracks?limit=3')).body.items.map((t: any) => t.id)
    await h.call('PATCH', '/tracks', { ids: [ids[0]], patch: { rating: 5 }, writeToFiles: false })
    await h.call('POST', '/playlists', { name: 'Roadtrip', trackIds: ids })
    await h.call('POST', '/radios', { streamUrl: 'http://example.com/s', name: 'FIP', discover: false })

    const backup = (await h.call('GET', '/backup')).body
    assert.equal(backup.tracks.length, 1, 'only the rated one')
    assert.equal(backup.tracks[0].rating, 5)
    assert.ok(backup.tracks[0].path, 'referenced by path, not by internal id alone')
    assert.ok(backup.tracks[0].artist, 'and by metadata, for a library whose files moved')
    assert.equal(backup.playlists.find((p: any) => p.name === 'Roadtrip').tracks.length, 3)
    assert.equal(backup.radios.length, 1)
  } finally { await h.cleanup() }
})

test('credentials stay out unless asked for', { skip }, async () => {
  const h = await harness()
  try {
    h.db.prepare(`UPDATE sources SET config = ? WHERE id = 'loc'`)
      .run(JSON.stringify({ url: 'http://rc:5572', user: 'me', pass: 'hunter2' }))

    const plain = (await h.call('GET', '/backup')).body
    assert.equal(plain.redacted, true)
    assert.equal(plain.sources[0].config, '{}')
    assert.ok(!JSON.stringify(plain).includes('hunter2'), 'a backup is the file most likely to be emailed')

    const withSecrets = (await h.call('GET', '/backup?secrets=true')).body
    assert.equal(withSecrets.redacted, false)
    assert.match(withSecrets.sources[0].config, /hunter2/)
  } finally { await h.cleanup() }
})

test('a restore puts the ratings and playlists back on a rebuilt library', { skip }, async () => {
  const first = await harness()
  let backup: any
  try {
    const ids = (await first.call('GET', '/tracks?limit=3')).body.items.map((t: any) => t.id)
    await first.call('PATCH', '/tracks', { ids: [ids[0]], patch: { rating: 4 }, writeToFiles: false })
    await first.call('POST', '/playlists', { name: 'Roadtrip', trackIds: ids })
    backup = (await first.call('GET', '/backup')).body
  } finally { await first.cleanup() }

  // A different machine: new database, same files rescanned from scratch.
  const second = await harness()
  try {
    assert.equal((await second.call('GET', '/playlists')).body.items.some((p: any) => p.name === 'Roadtrip'),
      false, 'the fresh library really is fresh')

    const report = (await second.call('POST', '/restore', backup)).body
    assert.equal(report.tracks.matched, 1)
    assert.equal(report.tracks.missing, 0)
    // Only Roadtrip. The five seeded presets already exist in the fresh
    // library under different ids, and restoring must not double them.
    assert.equal(report.playlists.created, 1)
    assert.equal(report.playlists.skipped, 5)

    const restored = (await second.call('GET', '/playlists')).body.items.find((p: any) => p.name === 'Roadtrip')
    assert.equal(restored.trackCount, 3, 'the playlist points at the rebuilt library, not at dead ids')
    const rated = (await second.call('GET', '/tracks?limit=100')).body.items.filter((t: any) => t.rating === 4)
    assert.equal(rated.length, 1)
  } finally { await second.cleanup() }
})

test('restoring twice does not duplicate anything', { skip }, async () => {
  const h = await harness()
  try {
    await h.call('POST', '/playlists', { name: 'Roadtrip' })
    await h.call('POST', '/radios', { streamUrl: 'http://example.com/s', name: 'FIP', discover: false })
    const backup = (await h.call('GET', '/backup')).body

    const again = (await h.call('POST', '/restore', backup)).body
    assert.equal(again.playlists.created, 0)
    // Roadtrip and the five presets: everything in the backup was already there.
    assert.equal(again.playlists.skipped, 6)
    assert.equal(again.radios.skipped, 1)
    assert.equal((await h.call('GET', '/radios')).body.items.length, 1)
  } finally { await h.cleanup() }
})

test('a backup from another version is refused rather than half applied', { skip }, async () => {
  const h = await harness()
  try {
    const res = await h.call('POST', '/restore', { version: 99, playlists: [{ id: 'x', name: 'Nope' }] })
    assert.equal(res.status, 400)
    assert.equal((await h.call('GET', '/playlists')).body.items.some((p: any) => p.name === 'Nope'), false)
  } finally { await h.cleanup() }
})

/* ---- what the scanner does with files that vanish ---- */

test('a file that disappears is marked missing, and comes back on rescan', { skip }, async () => {
  const h = await harness()
  try {
    const before = (await h.call('GET', '/tracks?limit=100')).body.items
    const victim = before.find((t: any) => t.path.endsWith('.flac')) ?? before[0]

    // Rate it first: the whole reason the row is kept rather than deleted.
    await h.call('PATCH', '/tracks', { ids: [victim.id], patch: { rating: 3 }, writeToFiles: false })
    const removed = join(h.musicDir, victim.path)
    const kept = `${removed}.away`
    await cp(removed, kept)
    await unlink(removed)

    await h.call('POST', '/sources/loc/scan')
    await h.settle()

    const after = (await h.call('GET', '/tracks?limit=100')).body.items
    assert.equal(after.length, before.length - 1, 'it left the library listing')
    const missing = (await h.call('GET', '/tracks/missing')).body.items
    assert.equal(missing.length, 1)
    assert.equal(missing[0].path, victim.path)
    assert.equal(missing[0].rating, 3, 'the rating survived, which is why it is a soft delete')
    assert.equal((await h.call('GET', '/stats')).body.missing, 1)

    // Plugging the share back in restores it, ratings and all.
    await cp(kept, removed)
    await unlink(kept)
    await h.call('POST', '/sources/loc/scan')
    await h.settle()

    assert.equal((await h.call('GET', '/tracks/missing')).body.items.length, 0)
    const back = (await h.call('GET', '/tracks?limit=100')).body.items.find((t: any) => t.path === victim.path)
    assert.equal(back.rating, 3)
  } finally { await h.cleanup() }
})

test('a cancelled scan does not mark the rest of the library missing', { skip }, async () => {
  const h = await harness()
  try {
    const total = (await h.call('GET', '/tracks?limit=100')).body.items.length
    const job = (await h.call('POST', '/sources/loc/scan')).body
    await h.call('DELETE', `/jobs/${job.id}`)
    await h.settle()

    // A cancelled pass has seen only part of the source; sweeping there would
    // delete everything it had not reached yet.
    assert.equal((await h.call('GET', '/tracks/missing')).body.items.length, 0)
    assert.equal((await h.call('GET', '/tracks?limit=100')).body.items.length, total)
  } finally { await h.cleanup() }
})

test('the totals are computed over the library, not over a page', { skip }, async () => {
  const h = await harness()
  try {
    const stats = (await h.call('GET', '/stats')).body
    const all = (await h.call('GET', '/tracks?limit=200')).body.items
    assert.equal(stats.tracks, all.length)
    assert.ok(stats.bytes > 0)
    assert.ok(stats.seconds > 0)
    assert.ok(stats.artists > 0 && stats.albums > 0)
    assert.equal(stats.sources, 1)
    // One page holds two rows; the totals must not.
    const page = (await h.call('GET', '/tracks?limit=2')).body
    assert.equal(page.items.length, 2)
    assert.ok(stats.tracks > 2, 'this is exactly what the front end cannot work out for itself')
  } finally { await h.cleanup() }
})
