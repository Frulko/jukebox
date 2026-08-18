import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { routeTable } from '../src/openapi.ts'

/**
 * Who may call what.
 *
 * Read off the router rather than from a list kept by hand, because the bug
 * this catches is not a wrong rule — it is a route nobody classified. `/restore`
 * was exactly that: `/backup` is admin, and the destructive mirror of it lives
 * at its own path, so the prefix covering the read did not cover the write. Any
 * account that could edit a tag could overwrite the whole library's curation.
 *
 * The table below has to be updated deliberately when a route is added, and the
 * test fails until it is. That is the point: classifying is the work, and this
 * makes skipping it impossible rather than merely inadvisable.
 */

/** Every mutating route, and the lowest role that may call it. */
const EXPECTED: Record<string, 'admin' | 'user' | 'guest'> = {
  'POST /auth/login': 'guest', 'POST /auth/setup': 'guest',
  'POST /auth/tokens': 'guest', 'DELETE /auth/tokens/:id': 'guest',

  'POST /users': 'admin', 'PATCH /users/:id': 'admin', 'DELETE /users/:id': 'admin',
  'PUT /users/:id/sources': 'admin',

  'POST /sources': 'admin',
  // A draft browse carries connection credentials in its body and answers with
  // the machine's folder layout: twice admin.
  'POST /sources/browse': 'admin',
  'POST /sources/:id/scan': 'admin', 'POST /sources/:id/test': 'admin',
  // Same as creating one: a source is where the library comes from, and its
  // config holds the credentials for it.
  'PATCH /sources/:id': 'admin', 'DELETE /sources/:id': 'admin',

  'POST /restore': 'admin',
  'POST /schedules': 'admin', 'PATCH /schedules/:id': 'admin', 'DELETE /schedules/:id': 'admin',
  'POST /schedules/:id/run': 'admin',
  'POST /plugins/scan': 'admin', 'PATCH /plugins/:id': 'admin',
  'POST /plugins/:id/command': 'admin',
  'POST /store/install': 'admin', 'DELETE /store/:id': 'admin',

  // Playback: a kitchen tablet whose whole purpose is pressing pause has to be
  // able to press pause.
  'POST /player/play': 'guest', 'POST /player/pause': 'guest', 'POST /player/next': 'guest',
  'POST /player/previous': 'guest', 'POST /player/seek': 'guest', 'POST /player/goto': 'guest',
  'POST /player/queue': 'guest', 'PUT /player/queue': 'guest', 'DELETE /player/queue': 'guest',
  'PATCH /player': 'guest', 'POST /player/report': 'guest', 'POST /player/stream': 'guest',
  'POST /tracks/:id/play': 'guest',
  'POST /outputs/:id/play': 'guest', 'POST /outputs/:id/pause': 'guest',
  'POST /outputs/:id/stop': 'guest', 'POST /outputs/:id/volume': 'guest',

  // Curation: making the library yours without changing the files.
  'POST /playlists': 'user', 'PATCH /playlists/:id': 'user', 'DELETE /playlists/:id': 'user',
  'POST /playlists/:id/tracks': 'user', 'DELETE /playlists/:id/tracks': 'user',
  'PUT /playlists/:id/order': 'user',

  // Changing the library itself.
  'PATCH /tracks': 'user', 'POST /tracks/tags': 'user', 'POST /transcode': 'user',
  'POST /organize': 'user', 'POST /organize/:jobId/undo': 'user',
  'POST /duplicates/merge': 'user',
  // Same act as a merge: it moves one track's history onto another and folds
  // the first away. Curation of the library, not administration of the server.
  'POST /tracks/missing/substitute': 'user',
  'POST /devices': 'user', 'PATCH /devices/:id': 'user',
  'POST /devices/:id/sync': 'user', 'POST /devices/:id/import': 'user',
  'POST /devices/:id/backup': 'user', 'POST /devices/:id/eject': 'user',
  'PUT /devices/:id/tracks': 'user',
  'POST /devices/:id/wanted': 'user', 'DELETE /devices/:id/wanted': 'user',
  'POST /outputs/register': 'user', 'DELETE /outputs/:id': 'user',
  'POST /radios': 'user', 'PATCH /radios/:id': 'user', 'DELETE /radios/:id': 'user',
  'POST /radios/:id/discover': 'user',
  'POST /podcasts': 'user', 'PATCH /podcasts/:id': 'user', 'DELETE /podcasts/:id': 'user',
  'POST /podcasts/:id/refresh': 'user',
  // Fetching an episode writes a file into the library, like a transcode does.
  'POST /podcasts/:id/episodes/:eid/download': 'user',
  // A dropped file is the library changing; a guest's tablet has no business here.
  'POST /upload': 'user',
  'PATCH /jobs/:id': 'user', 'DELETE /jobs/:id': 'user',
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-authz-'))
  const app = createApp(join(dir, 'db.sqlite'))
  const call = async (method: string, path: string, token?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    return app.app.fetch(new Request(`http://x/api/v1${path}`, { method, headers, body: '{}' }))
  }
  return { app, call, cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

test('every mutating route is classified', async () => {
  const h = await harness()
  try {
    const unclassified = routeTable(h.app.app)
      .filter((r: any) => r.method !== 'GET' && r.method !== 'HEAD')
      .map((r: any) => `${r.method} ${r.path}`)
      .filter((key) => !(key in EXPECTED))

    // A route nobody thought about inherits `write`, which is a decision made
    // by omission. `/restore` was the one that mattered: destructive, global,
    // and reachable by anyone who could edit a tag.
    assert.deepEqual(unclassified, [],
      'these routes have no entry in EXPECTED — decide who may call them')

    // And the reverse, or the table quietly fills with rules for routes that
    // no longer exist, which reads as coverage and is not.
    const served = new Set(routeTable(h.app.app).map((r: any) => `${r.method} ${r.path}`))
    const stale = Object.keys(EXPECTED).filter((key) => !served.has(key))
    assert.deepEqual(stale, [], 'these entries name routes the server does not serve')
  } finally { await h.cleanup() }
})

test('the classification is what the server actually enforces', async () => {
  const h = await harness()
  try {
    const admin = (await (await h.call('POST', '/auth/setup', undefined)).json().catch(() => null)) as any
    // Setup needs a real body, so do it properly.
    const setup = await h.app.app.fetch(new Request('http://x/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'longenough' }),
    }))
    const root = (await setup.json()) as any
    void admin

    const make = async (username: string, role: string) => {
      await h.app.app.fetch(new Request('http://x/api/v1/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${root.token}` },
        body: JSON.stringify({ username, password: 'longenough', role }),
      }))
      const login = await h.app.app.fetch(new Request('http://x/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'longenough' }),
      }))
      return ((await login.json()) as any).token as string
    }

    const tokens = { guest: await make('g', 'guest'), user: await make('u', 'user') }

    const wrong: string[] = []
    for (const [key, needed] of Object.entries(EXPECTED)) {
      if (needed === 'guest') continue
      const [method, path] = key.split(' ')
      // A path with parameters is fine: authorisation is decided before the
      // handler looks anything up, so a 404 still proves it got past the gate.
      const asGuest = await h.call(method, path.replace(/:[^/]+/g, 'x'), tokens.guest)
      if (asGuest.status !== 403) wrong.push(`${key} — a guest got ${asGuest.status}`)

      if (needed === 'admin') {
        const asUser = await h.call(method, path.replace(/:[^/]+/g, 'x'), tokens.user)
        if (asUser.status !== 403) wrong.push(`${key} — a user got ${asUser.status}`)
      }
    }

    assert.deepEqual(wrong, [])
  } finally { await h.cleanup() }
})
