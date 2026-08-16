import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { counts, MIN_LENGTH } from '../src/plays.ts'

const FIXTURES = process.env.JUKEBOX_FIXTURES ?? ''
const skip = FIXTURES ? false : 'JUKEBOX_FIXTURES is not set'

test('a play counts by the same rule every scrobbler uses', () => {
  // Half the length or four minutes, whichever comes first.
  assert.ok(counts(200, 100), 'half of a short track')
  assert.ok(!counts(200, 99))
  assert.ok(counts(3600, 240), 'four minutes is enough however long it is')
  assert.ok(!counts(3600, 239), 'and 1800s is not required')

  // Under thirty seconds never counts, however much of it was played.
  assert.ok(!counts(20, 20))
  assert.ok(!counts(MIN_LENGTH - 1, 1000))
  assert.ok(counts(MIN_LENGTH, MIN_LENGTH / 2))
})

async function harness(pluginConfig?: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-play-'))
  const musicDir = join(dir, 'music')
  await cp(FIXTURES, musicDir, { recursive: true })

  // The real plugin from the repo, copied in so the test drives the shipped one.
  const pluginRoot = join(dir, 'plugins', 'listenbrainz')
  await mkdir(pluginRoot, { recursive: true })
  await cp(new URL('../../../plugins/listenbrainz/', import.meta.url).pathname, pluginRoot, { recursive: true })
  process.env.JUKEBOX_PLUGINS = join(dir, 'plugins')

  const app = createApp(join(dir, 'db.sqlite'))
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.app.fetch(new Request(`http://x/api/v1${path}`, {
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
      const busy = app.jobs.list({}).filter((j: any) => j.state === 'queued' || j.state === 'running')
      if (!busy.length) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  await call('POST', '/sources', { id: 'loc', name: 'Music', root: musicDir, writable: true })
  await call('POST', '/sources/loc/scan')
  await settle()
  await app.plugins.discover()
  if (pluginConfig) {
    app.db.prepare(`UPDATE plugins SET config = ? WHERE id = 'listenbrainz'`)
      .run(JSON.stringify(pluginConfig))
  }
  await app.plugins.activateAll()

  return {
    call, settle, db: app.db, host: app.plugins,
    cleanup: () => {
      app.jobs.stop()
      delete process.env.JUKEBOX_PLUGINS
      return rm(dir, { recursive: true, force: true })
    },
  }
}

test('a play is recorded and the smart playlists finally fill', { skip }, async () => {
  const h = await harness()
  try {
    const track = (await h.call('GET', '/tracks?limit=1')).body.items[0]
    // The fixtures are seconds long, so the duration is forced to something
    // realistic rather than pretending a 3s file can be scrobbled.
    h.db.prepare(`UPDATE tracks SET duration = 300 WHERE id = ?`).run(track.id)

    const res = (await h.call('POST', `/tracks/${track.id}/play`, { played: 150 })).body
    assert.equal(res.counted, true)
    assert.equal(res.playCount, 1)

    const after = (await h.call('GET', `/tracks/${track.id}`)).body
    assert.equal(after.playCount, 1)
    assert.ok(after.lastPlayed, 'and it knows when')

    // These two presets are seeded on first start and, until now, could never
    // contain anything.
    const playlists = (await h.call('GET', '/playlists')).body.items
    const top = playlists.find((p: any) => p.smart === 'top25')
    const recent = playlists.find((p: any) => p.smart === 'recentlyPlayed')
    assert.equal(top.trackCount, 1)
    assert.equal(recent.trackCount, 1)
  } finally { await h.cleanup() }
})

test('a track abandoned early is a skip, not a play', { skip }, async () => {
  const h = await harness()
  try {
    const track = (await h.call('GET', '/tracks?limit=1')).body.items[0]
    h.db.prepare(`UPDATE tracks SET duration = 300 WHERE id = ?`).run(track.id)

    const res = (await h.call('POST', `/tracks/${track.id}/play`, { played: 20 })).body
    assert.equal(res.counted, false)
    assert.match(res.reason, /played 20s of the 150s needed/)

    const after = (await h.call('GET', `/tracks/${track.id}`)).body
    assert.equal(after.playCount, 0)
    assert.equal(after.skipCount, 1, 'what someone abandons is worth knowing too')

    assert.equal((await h.call('POST', '/tracks/no-such-track/play', { played: 100 })).status, 404)
    assert.equal((await h.call('POST', `/tracks/${track.id}/play`, {})).status, 400)
  } finally { await h.cleanup() }
})

test('the scrobbler plugin submits a play it was configured for', { skip }, async () => {
  const received: any[] = []
  const lb = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, payload: JSON.parse(body || '{}') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
    })
  })
  await new Promise<void>((r) => lb.listen(0, '127.0.0.1', r))
  const port = (lb.address() as any).port

  const h = await harness({ token: 'test-token', url: `http://127.0.0.1:${port}` })
  try {
    assert.deepEqual(h.host.active(), ['listenbrainz'], 'the shipped plugin loads as written')

    const track = (await h.call('GET', '/tracks?limit=1')).body.items[0]
    h.db.prepare(`UPDATE tracks SET duration = 300 WHERE id = ?`).run(track.id)
    await h.call('POST', `/tracks/${track.id}/play`, { played: 200, startedAt: 1700000000000 })

    // The whole contract in one assertion: an HTTP call was recorded, a plugin
    // heard the event, read its settings and went out through the host.
    for (let i = 0; i < 40 && !received.length; i++) await new Promise((r) => setTimeout(r, 25))
    assert.equal(received.length, 1)
    assert.equal(received[0].auth, 'Token test-token')
    const listen = received[0].payload.payload[0]
    assert.equal(listen.track_metadata.track_name, track.name)
    assert.equal(listen.listened_at, 1700000000, 'seconds, and the time it actually happened')
  } finally {
    lb.close()
    await h.cleanup()
  }
})

test('an unconfigured scrobbler stays quiet instead of failing', { skip }, async () => {
  const h = await harness()
  try {
    const track = (await h.call('GET', '/tracks?limit=1')).body.items[0]
    h.db.prepare(`UPDATE tracks SET duration = 300 WHERE id = ?`).run(track.id)
    // No token: the play must still be recorded by the server.
    const res = (await h.call('POST', `/tracks/${track.id}/play`, { played: 200 })).body
    assert.equal(res.counted, true)
  } finally { await h.cleanup() }
})

test('a listener does not outlive its plugin', { skip }, async () => {
  const received: any[] = []
  const lb = createServer((req, res) => {
    received.push(1)
    res.writeHead(200); res.end('{}')
  })
  await new Promise<void>((r) => lb.listen(0, '127.0.0.1', r))
  const port = (lb.address() as any).port

  const h = await harness({ token: 't', url: `http://127.0.0.1:${port}` })
  try {
    const track = (await h.call('GET', '/tracks?limit=1')).body.items[0]
    h.db.prepare(`UPDATE tracks SET duration = 300 WHERE id = ?`).run(track.id)

    await h.host.setEnabled('listenbrainz', false)
    await h.call('POST', `/tracks/${track.id}/play`, { played: 200 })
    await new Promise((r) => setTimeout(r, 200))

    // A subscription surviving its plugin fires into code that is gone.
    assert.equal(received.length, 0)
  } finally {
    lb.close()
    await h.cleanup()
  }
})
