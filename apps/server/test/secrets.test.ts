import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { routeTable } from '../src/openapi.ts'

/**
 * No secret leaves by any door.
 *
 * The authorisation table covers routes that *change* things, on the grounds
 * that a route nobody classified inherits `write`. This is the other half, and
 * it was missing: `GET /sources` returned the whole row, so a Jellyfin API key,
 * a Plex token or an rclone password reached every account that could list
 * sources. The backup code had the rule right — credentials stay out unless
 * asked for — and the same secret walked out of the front door.
 *
 * So this does not check a rule. It plants distinctive values in every place a
 * credential is stored, asks the server for **everything it will answer**, and
 * fails if any of them comes back. A route added tomorrow is covered without
 * anyone remembering, which is the only kind of guard worth having for this.
 */

/** Values that must never appear in a response body. */
const SENTINELS = {
  sourceToken: 'SENTINEL-SOURCE-TOKEN-9f3a',
  sourcePassword: 'SENTINEL-RCLONE-PASS-1c7d',
  userPassword: 'SENTINEL-USER-PASSWORD-4e2b',
  pluginKey: 'SENTINEL-PLUGIN-APIKEY-8a55',
}

async function seeded() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-secrets-'))
  const app = createApp(join(dir, 'db.sqlite'))

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = {}
    if (body) headers['content-type'] = 'application/json'
    if (token) headers.authorization = `Bearer ${token}`
    const res = await app.app.fetch(new Request(`http://x/api/v1${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, text, body: text ? JSON.parse(text) : null }
  }

  const admin = (await call('POST', '/auth/setup',
    { username: 'root', password: SENTINELS.userPassword })).body

  // A remote source, whose config is where third-party credentials live.
  await call('POST', '/sources', {
    id: 'jf', name: 'Attic', root: 'http://jf:8096', kind: 'jellyfin',
    config: { token: SENTINELS.sourceToken, parentId: 'lib-7' },
  }, admin.token)

  await call('POST', '/sources', {
    id: 'rc', name: 'Remote', root: 'gdrive:music', kind: 'rclone',
    config: { url: 'http://127.0.0.1:5572', password: SENTINELS.sourcePassword },
  }, admin.token)

  // A plugin's stored settings: the same shape of secret, kept elsewhere.
  await call('PATCH', '/plugins/lyrics', { config: { apiKey: SENTINELS.pluginKey } }, admin.token)

  // An ordinary account, because the interesting question is what a *guest*
  // and a *user* can read, not what an admin can.
  await call('POST', '/users',
    { username: 'kid', password: 'longenoughpassword', role: 'guest' }, admin.token)
  const guest = (await call('POST', '/auth/login',
    { username: 'kid', password: 'longenoughpassword' })).body

  return {
    app, call,
    tokens: { admin: admin.token as string, guest: guest.token as string },
    cleanup: () => {
      app.closeOutputs()
      app.jobs.stop()
      return rm(dir, { recursive: true, force: true })
    },
  }
}

/** Routes that cannot be swept: one never ends, one waits on the network. */
const UNSWEEPABLE = new Set(['/events', '/outputs'])

/** Fills `:id` style parameters with something seeded, so the route answers. */
const fill = (path: string) =>
  path
    .replace(':id', 'jf')
    .replace(':jobId', 'none')
    .replace(/:[^/]+/g, 'x')

test('no GET route hands a stored credential to anybody', async () => {
  const h = await seeded()
  try {
    const gets = routeTable(h.app.app)
      .filter((r: any) => r.method === 'GET' && !UNSWEEPABLE.has(r.path))

    const leaks: string[] = []
    for (const role of ['admin', 'guest'] as const) {
      for (const route of gets) {
        const path = fill(route.path)
        const res = await h.call('GET', path, undefined, h.tokens[role])
        // A 401/403/404 is a fine answer; it just carries nothing to leak.
        if (!res.text) continue

        for (const [name, value] of Object.entries(SENTINELS)) {
          if (res.text.includes(value)) leaks.push(`${role} · GET ${path} · ${name}`)
        }
      }
    }

    // An admin is not exempt. A credential that can be read back is one that
    // can be exfiltrated by anything holding an admin token — a stolen browser
    // session, a malicious plugin, a screenshot in a bug report.
    assert.deepEqual(leaks, [], 'these responses contained a stored secret')

    /*
     * And the sweep is not passing vacuously.
     *
     * Two ways it could: the secrets were never stored, or the search does not
     * work. The first is not hypothetical — `POST /sources` silently dropped
     * `config` until it was fixed earlier, and had that regressed, every
     * assertion above would be green because there was nothing to leak.
     */
    const stored = h.app.db
      .prepare(`SELECT config FROM sources WHERE id = 'jf'`).get() as { config: string }
    assert.ok(stored.config.includes(SENTINELS.sourceToken),
      'the secret is really in the database, so finding none in the responses means something')

    // And the detector detects: the same search over the raw row does fire.
    assert.ok(JSON.stringify(stored).includes(SENTINELS.sourceToken))
  } finally { await h.cleanup() }
})

test('the sources listing says a secret is set without saying what it is', async () => {
  const h = await seeded()
  try {
    const sources = (await h.call('GET', '/sources', undefined, h.tokens.admin)).body.items
    const jellyfin = sources.find((s: any) => s.id === 'jf')

    // Withholding the value while hiding that it exists would make an editing
    // UI impossible: it could not tell "no token" from "a token you may not
    // read", and would clear the field on every save.
    assert.deepEqual(jellyfin.secrets, ['token'])
    assert.equal(jellyfin.config.token, undefined)

    // Non-secret configuration stays visible, or the same UI cannot show or
    // edit the library id it needs.
    assert.equal(jellyfin.config.parentId, 'lib-7')
  } finally { await h.cleanup() }
})

test('a password is not readable anywhere, by anyone', async () => {
  const h = await seeded()
  try {
    // The account's own view of itself is the most tempting place to leak one.
    const me = await h.call('GET', '/auth/me', undefined, h.tokens.admin)
    assert.ok(!me.text.includes(SENTINELS.userPassword))

    const users = await h.call('GET', '/users', undefined, h.tokens.admin)
    assert.ok(!users.text.includes(SENTINELS.userPassword))
    // Nor the hash, which is not a password but is worth just as much offline.
    assert.ok(!users.text.includes('passwordHash'))
  } finally { await h.cleanup() }
})

test('an issued token is shown once and never again', async () => {
  const h = await seeded()
  try {
    const created = (await h.call('POST', '/auth/tokens', { name: 'phone' }, h.tokens.admin)).body
    assert.ok(created.token, 'the secret is returned at creation, which is the point')

    // And never afterwards: only its hash is kept, so a listing that could show
    // it would mean the hash was not the only thing stored.
    const listed = await h.call('GET', '/auth/tokens', undefined, h.tokens.admin)
    assert.ok(!listed.text.includes(created.token), 'the token came back in a listing')
  } finally { await h.cleanup() }
})
