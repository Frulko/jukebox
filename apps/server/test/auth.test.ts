import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { open } from '../src/db.ts'
import {
  createUser, decryptSecret, encryptSecret, hashPassword, verifyPassword, verifySubsonic,
} from '../src/auth.ts'

test('a password is stored as a hash it cannot be read back out of', async () => {
  const stored = await hashPassword('hunter2')
  assert.match(stored, /^scrypt\$/)
  assert.ok(!stored.includes('hunter2'))
  assert.ok(await verifyPassword('hunter2', stored))
  assert.ok(!(await verifyPassword('hunter3', stored)))

  // Salted: the same password twice gives two different rows, so a stolen
  // database cannot be attacked once for every account at a time.
  assert.notEqual(await hashPassword('hunter2'), stored)
  assert.ok(!(await verifyPassword('x', 'not-a-hash')))
  assert.ok(!(await verifyPassword('x', 'md5$a$b')))
})

test('the recoverable copy is encrypted and tamper-evident', () => {
  const sealed = encryptSecret('hunter2', '/db/x.sqlite')
  assert.ok(!sealed.includes('hunter2'))
  assert.equal(decryptSecret(sealed, '/db/x.sqlite'), 'hunter2')

  // A different key cannot read it, and a changed byte fails the auth tag
  // rather than decrypting to rubbish.
  assert.equal(decryptSecret(sealed, '/db/other.sqlite'), null)
  assert.equal(decryptSecret(sealed.slice(0, -3) + 'AAA', '/db/x.sqlite'), null)
})

test('a Subsonic client authenticates with a salt it chose', async () => {
  const db = open(':memory:')
  await createUser(db, { username: 'g', password: 'hunter2', subsonic: true }, '/db/x.sqlite')

  const salt = 'c19b2d'
  const token = createHash('md5').update('hunter2' + salt).digest('hex')
  assert.equal(verifySubsonic(db, 'g', token, salt, '/db/x.sqlite')?.username, 'g')
  assert.equal(verifySubsonic(db, 'g', token, 'different-salt', '/db/x.sqlite'), null)
  assert.equal(verifySubsonic(db, 'g', 'f'.repeat(32), salt, '/db/x.sqlite'), null)
})

test('a user who did not ask for Subsonic cannot be authenticated that way', async () => {
  const db = open(':memory:')
  await createUser(db, { username: 'g', password: 'hunter2' }, '/db/x.sqlite')
  const salt = 'abc'
  const token = createHash('md5').update('hunter2' + salt).digest('hex')
  // Correct password, correct salt, and still refused: there is no recoverable
  // copy to check it against, which is the point of it being opt-in.
  assert.equal(verifySubsonic(db, 'g', token, salt, '/db/x.sqlite'), null)
})

/* ---- the server ---- */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-auth-'))
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
  return { call, cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

test('a fresh install answers everything until it is claimed', async () => {
  const h = await harness()
  try {
    assert.equal((await h.call('GET', '/auth/state')).body.open, true)
    // Nobody should be locked out of their own library by a setup step they
    // have not reached yet.
    assert.equal((await h.call('GET', '/tracks')).status, 200)

    const setup = await h.call('POST', '/auth/setup', { username: 'g', password: 'hunter2!' })
    assert.equal(setup.status, 201)
    assert.equal(setup.body.user.role, 'admin')
    assert.ok(setup.body.token)

    // Claimed: the door closes behind it.
    assert.equal((await h.call('GET', '/auth/state')).body.open, false)
    assert.equal((await h.call('GET', '/tracks')).status, 401)
    assert.equal((await h.call('GET', '/tracks', undefined, setup.body.token)).status, 200)

    // And it cannot be claimed twice, or it would mint an admin on a server
    // that is already someone else's.
    assert.equal((await h.call('POST', '/auth/setup', { username: 'x', password: 'password1' })).status, 409)
  } finally { await h.cleanup() }
})

test('health stays open, because a container probe has no credentials', async () => {
  const h = await harness()
  try {
    await h.call('POST', '/auth/setup', { username: 'g', password: 'hunter2!' })
    assert.equal((await h.call('GET', '/health')).status, 200)
    assert.equal((await h.call('GET', '/stats')).status, 401, 'everything else does not')
  } finally { await h.cleanup() }
})

test('logging in is one answer for a wrong name and a wrong password', async () => {
  const h = await harness()
  try {
    await h.call('POST', '/auth/setup', { username: 'g', password: 'hunter2!' })

    const wrongUser = await h.call('POST', '/auth/login', { username: 'nobody', password: 'hunter2!' })
    const wrongPass = await h.call('POST', '/auth/login', { username: 'g', password: 'wrong' })
    assert.equal(wrongUser.status, 401)
    assert.equal(wrongPass.status, 401)
    // Telling them apart tells an attacker which half to keep.
    assert.equal(wrongUser.body.error.message, wrongPass.body.error.message)

    const ok = await h.call('POST', '/auth/login', { username: 'g', password: 'hunter2!' })
    assert.equal(ok.status, 200)
    assert.equal((await h.call('GET', '/auth/me', undefined, ok.body.token)).body.username, 'g')
  } finally { await h.cleanup() }
})

test('a token can be revoked, and a revoked one stops working', async () => {
  const h = await harness()
  try {
    const admin = (await h.call('POST', '/auth/setup', { username: 'g', password: 'hunter2!' })).body
    const extra = (await h.call('POST', '/auth/tokens', { name: 'iPhone' }, admin.token)).body
    assert.ok(extra.token)
    assert.equal((await h.call('GET', '/tracks', undefined, extra.token)).status, 200)

    const listed = (await h.call('GET', '/auth/tokens', undefined, admin.token)).body.items
    assert.equal(listed.length, 2)
    // Only the hash is kept, so the secret must not come back out of a listing.
    assert.ok(!JSON.stringify(listed).includes(extra.token.split('.')[1]))

    assert.equal((await h.call('DELETE', `/auth/tokens/${extra.id}`, undefined, admin.token)).status, 204)
    assert.equal((await h.call('GET', '/tracks', undefined, extra.token)).status, 401)
    assert.equal((await h.call('GET', '/tracks', undefined, admin.token)).status, 200, 'the other one still works')
  } finally { await h.cleanup() }
})

test('a token works in the query string, because an audio element cannot set a header', async () => {
  const h = await harness()
  try {
    const admin = (await h.call('POST', '/auth/setup', { username: 'g', password: 'hunter2!' })).body
    assert.equal((await h.call('GET', `/tracks?token=${encodeURIComponent(admin.token)}`)).status, 200)
    assert.equal((await h.call('GET', '/tracks?token=nonsense')).status, 401)
  } finally { await h.cleanup() }
})
