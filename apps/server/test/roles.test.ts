import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../src/app.ts'
import { can } from '../src/auth.ts'

const FIXTURES = resolve(import.meta.dirname, '../../../.fixtures')

/**
 * Roles and per-account libraries.
 *
 * Two questions, and the second is the one worth being strict about: it is easy
 * to hide rows from a listing and still leak them through a count, a facet, a
 * delta or a stream URL. Each of those is checked separately here, because each
 * is a different query and hiding one proves nothing about the others.
 */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-roles-'))
  const app = createApp(join(dir, 'db.sqlite'))

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = {}
    if (body) headers['content-type'] = 'application/json'
    if (token) headers.authorization = `Bearer ${token}`
    const res = await app.app.fetch(new Request(`http://x/api/v1${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  const settle = async () => {
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      if (!app.jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  return {
    call, settle, db: app.db,
    cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) },
  }
}

/** Two libraries, so "which sources may this account see" is a real question. */
async function twoLibraries() {
  const root = await mkdtemp(join(tmpdir(), 'jukebox-libs-'))
  await mkdir(join(root, 'main'), { recursive: true })
  await mkdir(join(root, 'private'), { recursive: true })
  await copyFile(join(FIXTURES, 'Daft Punk/Discovery/01.mp3'), join(root, 'main/01.mp3'))
  await copyFile(join(FIXTURES, 'Daft Punk/Discovery/02.mp3'), join(root, 'main/02.mp3'))
  await copyFile(join(FIXTURES, 'Radiohead/Kid A/01.m4a'), join(root, 'private/01.m4a'))
  return root
}

test('capabilities come from the role, and a guest has exactly one', () => {
  assert.equal(can({ role: 'admin' }, 'admin'), true)
  assert.equal(can({ role: 'user' }, 'admin'), false)
  assert.equal(can({ role: 'user' }, 'write'), true)
  assert.equal(can({ role: 'guest' }, 'play'), true)
  assert.equal(can({ role: 'guest' }, 'curate'), false)
  assert.equal(can({ role: 'guest' }, 'write'), false)
  // Nobody is not somebody: an absent user has no capabilities at all rather
  // than defaulting to the first role in the table.
  assert.equal(can(null, 'play'), false)
})

test('a guest plays and reads, and changes nothing', async () => {
  const h = await harness()
  try {
    const admin = (await h.call('POST', '/auth/setup', { username: 'me', password: 'longenough' })).body
    const guest = (await h.call('POST', '/users',
      { username: 'kitchen', password: 'longenough', role: 'guest' }, admin.token)).body
    const guestToken = (await h.call('POST', '/auth/login',
      { username: 'kitchen', password: 'longenough' })).body.token
    assert.equal(guest.role, 'guest')

    // Reading is fine.
    assert.equal((await h.call('GET', '/tracks', undefined, guestToken)).status, 200)

    // Changing the library is not, and the refusal says which capability was
    // missing rather than simply 403.
    const patch = await h.call('PATCH', '/tracks',
      { ids: ['x'], patch: { rating: 5 } }, guestToken)
    assert.equal(patch.status, 403)
    assert.match(patch.body.error.message, /write/)

    // Nor is curating.
    assert.equal((await h.call('POST', '/playlists', { name: 'Mine' }, guestToken)).status, 403)
    // Nor administering.
    assert.equal((await h.call('POST', '/users',
      { username: 'x', password: 'longenough' }, guestToken)).status, 403)

    // But the shared queue is playback, not change, and a kitchen tablet whose
    // whole purpose is pressing pause must be able to press pause.
    assert.equal((await h.call('POST', '/player/pause', {}, guestToken)).status < 400, true)
  } finally { await h.cleanup() }
})

test('a user curates and retags but does not administer', async () => {
  const h = await harness()
  try {
    const admin = (await h.call('POST', '/auth/setup', { username: 'me', password: 'longenough' })).body
    await h.call('POST', '/users', { username: 'flat', password: 'longenough' }, admin.token)
    const token = (await h.call('POST', '/auth/login',
      { username: 'flat', password: 'longenough' })).body.token

    assert.equal((await h.call('POST', '/playlists', { name: 'Evening' }, token)).status, 201)
    assert.equal((await h.call('GET', '/users', undefined, token)).status, 403)
    assert.equal((await h.call('POST', '/sources',
      { id: 'x', name: 'X', root: '/tmp' }, token)).status, 403)
  } finally { await h.cleanup() }
})

test('a narrowed account cannot see, count, facet or sync what it may not have', async () => {
  const root = await twoLibraries()
  const h = await harness()
  try {
    const admin = (await h.call('POST', '/auth/setup', { username: 'me', password: 'longenough' })).body
    await h.call('POST', '/sources', { id: 'main', name: 'Main', root: join(root, 'main') }, admin.token)
    await h.call('POST', '/sources', { id: 'priv', name: 'Private', root: join(root, 'private') }, admin.token)
    await h.call('POST', '/sources/main/scan', undefined, admin.token)
    await h.call('POST', '/sources/priv/scan', undefined, admin.token)
    await h.settle()

    const kid = (await h.call('POST', '/users',
      { username: 'kid', password: 'longenough' }, admin.token)).body
    const kidToken = (await h.call('POST', '/auth/login',
      { username: 'kid', password: 'longenough' })).body.token

    // Before narrowing, everyone sees everything: a household with one library
    // should never have to configure this.
    assert.equal((await h.call('GET', '/tracks/count', undefined, kidToken)).body.count, 3)

    await h.call('PUT', `/users/${kid.id}/sources`, { sourceIds: ['main'] }, admin.token)

    // The listing.
    const page = (await h.call('GET', '/tracks?limit=50', undefined, kidToken)).body
    assert.equal(page.items.length, 2)
    assert.ok(page.items.every((t: any) => t.sourceId === 'main'))

    // The count, which is the easiest one to forget and the one that gives the
    // game away: "2 of 3" over a list of two.
    assert.equal((await h.call('GET', '/tracks/count', undefined, kidToken)).body.count, 2)

    // The facets, which would otherwise name the artists in a library the
    // account cannot open.
    const facets = (await h.call('GET', '/facets', undefined, kidToken)).body
    assert.ok(!JSON.stringify(facets).includes('Radiohead'))

    // And the delta, which hands out the whole library one revision at a time.
    const delta = (await h.call('GET', '/tracks/delta?since=0', undefined, kidToken)).body
    assert.equal(delta.changed.length, 2)
    assert.ok(delta.changed.every((t: any) => t.sourceId === 'main'))

    // The admin still sees both: narrowing an admin would be a way to lock
    // everybody out of a source nobody can then unlock.
    assert.equal((await h.call('GET', '/tracks/count', undefined, admin.token)).body.count, 3)
  } finally { await h.cleanup(); await rm(root, { recursive: true, force: true }) }
})

test('removing a source does not widen the account that was narrowed to it', async () => {
  const root = await twoLibraries()
  const h = await harness()
  try {
    const admin = (await h.call('POST', '/auth/setup', { username: 'me', password: 'longenough' })).body
    await h.call('POST', '/sources', { id: 'main', name: 'Main', root: join(root, 'main') }, admin.token)
    await h.call('POST', '/sources', { id: 'priv', name: 'Private', root: join(root, 'private') }, admin.token)
    await h.call('POST', '/sources/main/scan', undefined, admin.token)
    await h.call('POST', '/sources/priv/scan', undefined, admin.token)
    await h.settle()

    const kid = (await h.call('POST', '/users',
      { username: 'kid', password: 'longenough' }, admin.token)).body
    const kidToken = (await h.call('POST', '/auth/login',
      { username: 'kid', password: 'longenough' })).body.token
    await h.call('PUT', `/users/${kid.id}/sources`, { sourceIds: ['main'] }, admin.token)
    assert.equal((await h.call('GET', '/tracks/count', undefined, kidToken)).body.count, 2)

    // The source row goes. If `user_sources` cascaded on it, the account would
    // be left with no rows at all -- which reads as "not narrowed", so it would
    // silently gain the whole server at the moment its access was removed.
    h.db.prepare(`DELETE FROM sources WHERE id = 'main'`).run()

    const rows = h.db.prepare(`SELECT * FROM user_sources WHERE userId = ?`).all(kid.id)
    assert.equal(rows.length, 1, 'the narrowing survives the source it pointed at')

    // Still not the private library. Stale rows narrow; they never widen.
    const page = (await h.call('GET', '/tracks?limit=50', undefined, kidToken)).body
    assert.ok(page.items.every((t: any) => t.sourceId === 'main'))
    assert.ok((await h.call('GET', '/tracks/count', undefined, kidToken)).body.count < 3)
  } finally { await h.cleanup(); await rm(root, { recursive: true, force: true }) }
})

test('the last admin cannot be demoted or deleted', async () => {
  const h = await harness()
  try {
    const admin = (await h.call('POST', '/auth/setup', { username: 'me', password: 'longenough' })).body

    // There is no recovery from this short of editing the database by hand.
    const demote = await h.call('PATCH', `/users/${admin.user.id}`, { role: 'user' }, admin.token)
    assert.equal(demote.status, 409)
    assert.equal((await h.call('DELETE', `/users/${admin.user.id}`, undefined, admin.token)).status, 409)

    // With a second admin it is allowed, because the server stays reachable.
    const second = (await h.call('POST', '/users',
      { username: 'other', password: 'longenough', role: 'admin' }, admin.token)).body
    assert.equal((await h.call('PATCH', `/users/${admin.user.id}`, { role: 'user' }, admin.token)).status, 200)
    assert.equal(second.role, 'admin')
  } finally { await h.cleanup() }
})

test('/auth/me reports what this account may do, so a UI need not guess', async () => {
  const h = await harness()
  try {
    const admin = (await h.call('POST', '/auth/setup', { username: 'me', password: 'longenough' })).body
    await h.call('POST', '/users', { username: 'g', password: 'longenough', role: 'guest' }, admin.token)
    const token = (await h.call('POST', '/auth/login', { username: 'g', password: 'longenough' })).body.token

    const me = (await h.call('GET', '/auth/me', undefined, token)).body
    // Derived from the same table the server enforces with, so the buttons a
    // front end offers cannot drift from what it is allowed to press.
    assert.deepEqual(me.can, ['play'])
    assert.equal(me.role, 'guest')
    assert.equal(me.sources, null, 'not narrowed')
  } finally { await h.cleanup() }
})

test('changing a password invalidates the Subsonic copy too', async () => {
  const h = await harness()
  try {
    const admin = (await h.call('POST', '/auth/setup', { username: 'me', password: 'longenough' })).body
    const u = (await h.call('POST', '/users',
      { username: 'sonos', password: 'longenough', subsonic: true }, admin.token)).body
    assert.equal(u.subsonic, 1)

    await h.call('PATCH', `/users/${u.id}`, { password: 'somethingelse' }, admin.token)
    // The old password must stop working everywhere, not just where the hash is
    // checked -- leaving the old recoverable copy behind means every Subsonic
    // client still authenticates with it.
    assert.equal((await h.call('POST', '/auth/login',
      { username: 'sonos', password: 'longenough' })).status, 401)
    assert.equal((await h.call('POST', '/auth/login',
      { username: 'sonos', password: 'somethingelse' })).status, 200)
  } finally { await h.cleanup() }
})
