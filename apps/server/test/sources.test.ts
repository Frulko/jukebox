import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-sources-'))
  const app = createApp(join(dir, 'db.sqlite'))
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.app.fetch(new Request(`http://x/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  return { app, db: app.db, call, cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

const jellyfin = {
  name: 'Attic', root: 'http://jelly.local', kind: 'jellyfin',
  config: { token: 'hunter2', parentId: 'lib-7' },
}

test('a credential never comes back out of the sources listing', async () => {
  // The bug this fixes: the route spread the whole row, so the API key of every
  // remote library reached every account that may list sources — while the
  // backup route, the file most likely to be emailed, redacted the same string.
  const h = await harness()
  try {
    await h.call('POST', '/sources', jellyfin)
    const { body } = await h.call('GET', '/sources')
    assert.ok(!JSON.stringify(body).includes('hunter2'), 'the token must not be in the listing')

    const s = body.items.find((x: any) => x.name === 'Attic')
    assert.deepEqual(s.secrets, ['token'], 'named, so it can be replaced without being read')
    assert.deepEqual(s.config, { parentId: 'lib-7' }, 'what is not a credential stays visible')
  } finally { await h.cleanup() }
})

test('a config that will not parse reads as empty rather than failing the page', async () => {
  const h = await harness()
  try {
    await h.call('POST', '/sources', jellyfin)
    h.db.exec(`UPDATE sources SET config = 'not json'`)
    const { status, body } = await h.call('GET', '/sources')
    assert.equal(status, 200)
    assert.deepEqual(body.items[0].config, {})
  } finally { await h.cleanup() }
})

test('a rotated token replaces one nobody was ever shown', async () => {
  const h = await harness()
  try {
    const made = await h.call('POST', '/sources', jellyfin)
    const { status } = await h.call('PATCH', `/sources/${made.body.id}`, { config: { token: 'new-key' } })
    assert.equal(status, 200)

    const row = h.db.prepare(`SELECT config FROM sources WHERE id = ?`).get(made.body.id) as any
    // Merged, not replaced: the client sent one key and the other survived.
    assert.deepEqual(JSON.parse(row.config), { token: 'new-key', parentId: 'lib-7' })
  } finally { await h.cleanup() }
})

test('an empty string clears a setting, which is how one is removed at all', async () => {
  const h = await harness()
  try {
    const made = await h.call('POST', '/sources', jellyfin)
    await h.call('PATCH', `/sources/${made.body.id}`, { config: { parentId: '' } })
    const row = h.db.prepare(`SELECT config FROM sources WHERE id = ?`).get(made.body.id) as any
    assert.deepEqual(JSON.parse(row.config), { token: 'hunter2' })
  } finally { await h.cleanup() }
})

test('renaming and granting write capability are one call', async () => {
  const h = await harness()
  try {
    const made = await h.call('POST', '/sources', { name: 'Music', root: '/m' })
    const { body } = await h.call('PATCH', `/sources/${made.body.id}`, { name: 'Vinyl rips', writable: true })
    assert.equal(body.name, 'Vinyl rips')
    assert.equal(body.writable, 1)
    assert.ok(body.rev > made.body.rev, 'a change clients can see')
  } finally { await h.cleanup() }
})

test('the root cannot be edited, because every path is relative to it', async () => {
  // Changing it would silently reinterpret every row in the library: the same
  // music pointing somewhere else without a file being touched.
  const h = await harness()
  try {
    const made = await h.call('POST', '/sources', { name: 'Music', root: '/m' })
    const { status, body } = await h.call('PATCH', `/sources/${made.body.id}`, { root: '/other' })
    assert.equal(status, 409)
    assert.equal(body.error.code, 'root_immutable')
    const row = h.db.prepare(`SELECT root FROM sources WHERE id = ?`).get(made.body.id) as any
    assert.equal(row.root, '/m')
  } finally { await h.cleanup() }
})

test('a source that still holds music is not forgotten by accident — missing tracks included', async () => {
  const h = await harness()
  try {
    const made = await h.call('POST', '/sources', { name: 'Music', root: '/m' })
    h.db.prepare(`INSERT INTO tracks (id, sourceId, path, name, artist, albumArtist, album, dateAdded, rev)
                  VALUES ('t1', ?, '/m/a.mp3', 'A', 'B', 'B', 'C', 0, 1)`).run(made.body.id)

    const refused = await h.call('DELETE', `/sources/${made.body.id}`)
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'source_in_use')
    assert.match(refused.body.error.message, /1 track/)

    // Gone from disk is not gone from the library. `sourceId` cascades, so
    // forgetting the source would delete the row that still holds the rating
    // and the place in three playlists — the very thing the Missing page is
    // there to protect while a drive is unplugged.
    h.db.exec(`UPDATE tracks SET deletedAt = 1 WHERE id = 't1'`)
    const stillRefused = await h.call('DELETE', `/sources/${made.body.id}`)
    assert.equal(stillRefused.status, 409)
    assert.match(stillRefused.body.error.message, /1 of them missing/)

    h.db.exec(`DELETE FROM tracks WHERE id = 't1'`)
    const allowed = await h.call('DELETE', `/sources/${made.body.id}`)
    assert.equal(allowed.status, 204)
    assert.equal((h.db.prepare(`SELECT COUNT(*) AS n FROM sources`).get() as any).n, 0)
  } finally { await h.cleanup() }
})

test('an unknown source is a 404 in both directions', async () => {
  const h = await harness()
  try {
    assert.equal((await h.call('PATCH', '/sources/nope', { name: 'x' })).status, 404)
    assert.equal((await h.call('DELETE', '/sources/nope')).status, 404)
  } finally { await h.cleanup() }
})

test('a root is an admin’s to see; a name is everyone’s', async () => {
  // A path names what is mounted where on the machine, and every route that
  // manages a source is admin-gated already — so nobody else can act on it.
  // The name and the kind stay: the rest of the app names sources beside tracks.
  const h = await harness()
  try {
    await h.call('POST', '/sources', { name: 'Music', root: '/srv/media/nas-2/music' })
    await h.call('POST', '/auth/setup', { username: 'boss', password: 'correct horse battery' })
    const login = await h.call('POST', '/auth/login', { username: 'boss', password: 'correct horse battery' })
    const adminToken = login.body.token

    const asAdmin = await (await h.app.app.fetch(new Request('http://x/api/v1/sources', {
      headers: { authorization: `Bearer ${adminToken}` },
    }))).json() as any
    assert.equal(asAdmin.items[0].root, '/srv/media/nas-2/music')

    await h.app.app.fetch(new Request('http://x/api/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ username: 'kid', password: 'another long one here', role: 'guest' }),
    }))
    const guest = await h.call('POST', '/auth/login', { username: 'kid', password: 'another long one here' })
    const asGuest = await (await h.app.app.fetch(new Request('http://x/api/v1/sources', {
      headers: { authorization: `Bearer ${guest.body.token}` },
    }))).json() as any

    assert.equal(asGuest.items[0].name, 'Music', 'the name is how a source is named beside a track')
    assert.equal(asGuest.items[0].root, '', 'the path is not')
  } finally { await h.cleanup() }
})
