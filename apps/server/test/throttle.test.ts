import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { callerKey, Throttle } from '../src/throttle.ts'

/**
 * The brake on password guessing.
 *
 * The property that matters is not "an attacker is stopped" — they are slowed.
 * It is that the expensive work is refused *before* it happens: scrypt is
 * memory-hard, so a login route that verifies every guess and then says no is
 * a denial of service against a Raspberry Pi.
 */

test('failures accumulate, and the brake comes on at the limit', () => {
  let clock = 1_000_000
  const t = new Throttle({ limit: 3, windowMs: 60_000, blockMs: 30_000, now: () => clock })

  assert.equal(t.retryAfter('a@1'), 0)
  assert.equal(t.fail('a@1'), false)
  assert.equal(t.fail('a@1'), false)
  assert.equal(t.retryAfter('a@1'), 0, 'still allowed below the limit')

  assert.equal(t.fail('a@1'), true, 'the third trips it')
  assert.equal(t.retryAfter('a@1'), 30)

  // Time passes; the block lifts on its own. Nothing is ever locked for good.
  clock += 30_001
  assert.equal(t.retryAfter('a@1'), 0)
})

test('a success clears the record', () => {
  let clock = 0
  const t = new Throttle({ limit: 3, now: () => clock })
  t.fail('a@1'); t.fail('a@1')
  t.succeed('a@1')
  // Somebody who mistypes twice and then gets it right is not one failure away
  // from being throttled for the rest of the window.
  assert.equal(t.fail('a@1'), false)
  assert.equal(t.fail('a@1'), false)
  assert.equal(t.retryAfter('a@1'), 0)
})

test('old failures do not count towards tonight', () => {
  let clock = 0
  const t = new Throttle({ limit: 3, windowMs: 60_000, now: () => clock })
  t.fail('a@1'); t.fail('a@1')

  clock += 60_001
  // Two typos an hour ago plus one now is not an attack.
  assert.equal(t.fail('a@1'), false)
  assert.equal(t.retryAfter('a@1'), 0)
})

test('one person cannot lock another out', () => {
  let clock = 0
  const t = new Throttle({ limit: 2, now: () => clock })
  t.fail('alice@1.1.1.1')
  t.fail('alice@1.1.1.1')
  assert.ok(t.retryAfter('alice@1.1.1.1') > 0)

  // Keyed on username *and* address. Username alone would let anyone lock a
  // household out of their own server on purpose, which turns the protection
  // into the attack; address alone would punish everyone behind one NAT.
  assert.equal(t.retryAfter('alice@2.2.2.2'), 0, 'alice from home still gets in')
  assert.equal(t.retryAfter('bob@1.1.1.1'), 0, 'and so does bob from the same office')
})

test('the map does not grow without bound', () => {
  let clock = 0
  const t = new Throttle({ limit: 5, windowMs: 1_000, now: () => clock })
  for (let i = 0; i < 500; i++) t.fail(`user@${i}`)
  assert.equal(t.size, 500)

  clock += 2_000
  // Keyed partly on a caller-supplied address, so an attacker varying it would
  // otherwise grow this for ever — a memory exhaustion introduced by the thing
  // meant to prevent one.
  assert.equal(t.prune(), 500)
  assert.equal(t.size, 0)
})

test('the caller key survives a reverse proxy', () => {
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })

  assert.equal(callerKey('Alice', headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' })), 'alice@9.9.9.9')
  assert.equal(callerKey('alice', headers({ 'x-real-ip': '8.8.8.8' })), 'alice@8.8.8.8')
  assert.equal(callerKey('alice', headers({})), 'alice@local')
  // Case-folded, or `Alice` and `alice` are two budgets for one account.
  assert.equal(callerKey('ALICE', headers({})), callerKey('alice', headers({})))
})

/* ---- through the server ---- */

test('the login route refuses before doing the expensive work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-throttle-'))
  const app = createApp(join(dir, 'db.sqlite'))
  const login = (password: string) =>
    app.app.fetch(new Request('http://x/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '5.5.5.5' },
      body: JSON.stringify({ username: 'root', password }),
    }))

  try {
    await app.app.fetch(new Request('http://x/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'correcthorse' }),
    }))

    // The default limit is deliberately generous — a household server where
    // somebody mistypes five times is a Tuesday.
    let status = 0
    for (let i = 0; i < 12; i++) status = (await login('wrong')).status
    assert.equal(status, 429, 'the brake came on')

    const blocked = await login('wrong')
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'and says how long')

    // Even the right password waits: the refusal happens before the check, or
    // the expensive work is exactly what an attacker gets for free.
    assert.equal((await login('correcthorse')).status, 429)

    // A different address is unaffected, so one attacker cannot lock the
    // household out of its own server.
    const elsewhere = await app.app.fetch(new Request('http://x/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '6.6.6.6' },
      body: JSON.stringify({ username: 'root', password: 'correcthorse' }),
    }))
    assert.equal(elsewhere.status, 200)
  } finally {
    app.closeOutputs()
    app.jobs.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
