import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { albumId, artistId, readAlbumId, readArtistId, toXml } from '../src/subsonic.ts'

const FIXTURES = process.env.JUKEBOX_FIXTURES ?? ''
const skip = FIXTURES ? false : 'JUKEBOX_FIXTURES is not set'

test('an id survives the round trip, including the characters in real names', () => {
  for (const name of ['Daft Punk', 'AC/DC', 'Sigur Rós', 'a b', '菊地成孔']) {
    assert.equal(readArtistId(artistId(name)), name)
  }
  // The separator has to survive an album called something with a space in it,
  // which is most of them.
  const id = albumId('Daft Punk', 'Discovery (Deluxe Edition)')
  assert.deepEqual(readAlbumId(id), { artist: 'Daft Punk', album: 'Discovery (Deluxe Edition)' })

  // A kind cannot be mistaken for another: handing back an album id where a
  // song id was meant must not silently work.
  assert.equal(readAlbumId(artistId('x')), null)
  assert.equal(readArtistId(albumId('a', 'b')), null)
  assert.equal(readArtistId('t-whatever'), null)
})

test('scalars become attributes and structures become elements', () => {
  // That is exactly Subsonic XML, which is why one object tree serialises to
  // both formats instead of needing two implementations.
  const xml = toXml('album', { id: 'x', name: 'A & B', songCount: 2, song: [{ id: '1' }, { id: '2' }] })
  assert.match(xml, /<album id="x" name="A &amp; B" songCount="2">/)
  assert.match(xml, /<song id="1"\/><song id="2"\/>/)
  assert.equal(toXml('ping', {}), '<ping/>')
  // Undefined is omitted rather than serialised as the string "undefined".
  assert.equal(toXml('a', { b: undefined, c: 1 }), '<a c="1"/>')
})

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-sub-'))
  const musicDir = join(dir, 'music')
  await cp(FIXTURES, musicDir, { recursive: true })
  const app = createApp(join(dir, 'db.sqlite'))

  const api = async (method: string, path: string, body?: unknown, token?: string) => {
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
    const until = Date.now() + 8000
    while (Date.now() < until) {
      if (!app.jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  await api('POST', '/sources', { id: 'loc', name: 'Music', root: musicDir, writable: true })
  await api('POST', '/sources/loc/scan')
  await settle()

  // A user who opted into Subsonic, which is the only kind that can use it.
  const password = 'hunter2!'
  const setup = (await api('POST', '/auth/setup', { username: 'g', password })).body
  app.db.prepare(`UPDATE users SET subsonicSecret = ? WHERE username = 'g'`)
    .run((await import('../src/auth.ts')).encryptSecret(password, join(dir, 'db.sqlite')))

  /** A call shaped exactly as a client makes it: salt and token in the query. */
  const rest = async (view: string, params: Record<string, string> = {}) => {
    const salt = 'c19b2d'
    const q = new URLSearchParams({
      u: 'g',
      t: createHash('md5').update(password + salt).digest('hex'),
      s: salt, v: '1.16.1', c: 'test-client', f: 'json', ...params,
    })
    const res = await app.app.fetch(new Request(`http://x/rest/${view}?${q}`))
    const text = await res.text()
    return {
      status: res.status,
      headers: res.headers,
      body: text.startsWith('{') ? JSON.parse(text)['subsonic-response'] : text,
    }
  }

  return {
    api, rest, settle, password, token: setup.token, db: app.db, app: app.app,
    cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) },
  }
}

test('a client authenticates with the token scheme and gets a pong', { skip }, async () => {
  const h = await harness()
  try {
    const pong = await h.rest('ping.view')
    assert.equal(pong.status, 200)
    assert.equal(pong.body.status, 'ok')
    assert.equal(pong.body.openSubsonic, true, 'so a modern client knows it may use the extensions')

    const bad = await h.app.fetch(new Request('http://x/rest/ping.view?u=g&p=wrong&f=json'))
    const body = (await bad.json() as any)['subsonic-response']
    // The load-bearing oddity: a failure is still HTTP 200, or the client
    // reports a network error instead of "wrong password".
    assert.equal(bad.status, 200)
    assert.equal(body.status, 'failed')
    assert.equal(body.error.code, 40)
  } finally { await h.cleanup() }
})

test('XML is the default, because a client that does not ask for JSON expects it', { skip }, async () => {
  const h = await harness()
  try {
    const salt = 'abc'
    const q = new URLSearchParams({
      u: 'g', t: createHash('md5').update(h.password + salt).digest('hex'), s: salt,
      v: '1.16.1', c: 'old-client',
    })
    const res = await h.app.fetch(new Request(`http://x/rest/ping.view?${q}`))
    const text = await res.text()
    assert.match(res.headers.get('content-type') ?? '', /xml/)
    assert.match(text, /<subsonic-response[^>]*status="ok"/)
  } finally { await h.cleanup() }
})

test('the library browses as artists, albums and songs', { skip }, async () => {
  const h = await harness()
  try {
    const artists = (await h.rest('getArtists.view')).body.artists
    assert.ok(artists.index.length > 0)
    const daft = artists.index.flatMap((i: any) => i.artist).find((a: any) => a.name === 'Daft Punk')
    assert.ok(daft, 'the fixtures include Daft Punk')
    assert.ok(daft.albumCount > 0)

    const artist = (await h.rest('getArtist.view', { id: daft.id })).body.artist
    assert.equal(artist.name, 'Daft Punk')
    const discovery = artist.album.find((a: any) => a.name === 'Discovery')
    assert.ok(discovery)

    const album = (await h.rest('getAlbum.view', { id: discovery.id })).body.album
    assert.equal(album.artist, 'Daft Punk')
    assert.ok(album.song.length > 0)
    const first = album.song[0]
    // The fields a client needs to draw a row and play it.
    assert.ok(first.title && first.duration >= 0 && first.suffix && first.contentType)
    assert.equal(first.albumId, discovery.id)

    const one = (await h.rest('getSong.view', { id: first.id })).body.song
    assert.equal(one.id, first.id)
    assert.equal((await h.rest('getSong.view', { id: 'nope' })).body.error.code, 70)
  } finally { await h.cleanup() }
})

test('a client can search, and list albums the ways it offers', { skip }, async () => {
  const h = await harness()
  try {
    const found = (await h.rest('search3.view', { query: 'Daft' })).body.searchResult3
    assert.ok(found.song.length > 0)
    assert.ok(found.artist.some((a: any) => a.name === 'Daft Punk'))

    for (const type of ['newest', 'alphabeticalByName', 'random', 'frequent']) {
      const list = (await h.rest('getAlbumList2.view', { type, size: '10' })).body.albumList2
      assert.ok(Array.isArray(list.album), type)
    }
    // An empty query is an empty result, not an error or the whole library.
    assert.deepEqual((await h.rest('search3.view', { query: '' })).body.searchResult3, {})
  } finally { await h.cleanup() }
})

test('starring and rating from a phone reach the library', { skip }, async () => {
  const h = await harness()
  try {
    const id = (await h.api('GET', '/tracks?limit=1', undefined, h.token)).body.items[0].id

    await h.rest('star.view', { id })
    await h.rest('setRating.view', { id, rating: '4' })
    const t = (await h.api('GET', `/tracks/${id}`, undefined, h.token)).body
    assert.equal(t.loved, true)
    assert.equal(t.rating, 4)

    const starred = (await h.rest('getStarred2.view')).body.starred2
    assert.ok(starred.song.some((s: any) => s.id === id))
    assert.equal(starred.song.find((s: any) => s.id === id).userRating, 4)

    await h.rest('unstar.view', { id })
    assert.equal((await h.api('GET', `/tracks/${id}`, undefined, h.token)).body.loved, false)
    assert.equal((await h.rest('setRating.view', { id, rating: '9' })).body.error.code, 10)
  } finally { await h.cleanup() }
})

test('streaming goes through the endpoint that already handles ranges', { skip }, async () => {
  const h = await harness()
  try {
    const id = (await h.api('GET', '/tracks?limit=1', undefined, h.token)).body.items[0].id
    const salt = 'abc'
    const q = new URLSearchParams({
      u: 'g', t: createHash('md5').update(h.password + salt).digest('hex'), s: salt,
      v: '1.16.1', c: 'test', id,
    })

    const res = await h.app.fetch(new Request(`http://x/rest/stream.view?${q}`))
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^audio\//)
    assert.equal(res.headers.get('accept-ranges'), 'bytes', 'seeking works, because it is the same endpoint')
    await res.body?.cancel()

    const part = await h.app.fetch(new Request(`http://x/rest/stream.view?${q}`, { headers: { range: 'bytes=0-49' } }))
    assert.equal(part.status, 206)
    assert.equal((await part.arrayBuffer()).byteLength, 50)
  } finally { await h.cleanup() }
})

test('a scrobble counts a play, and a now-playing ping does not', { skip }, async () => {
  const h = await harness()
  try {
    const id = (await h.api('GET', '/tracks?limit=1', undefined, h.token)).body.items[0].id
    h.db.prepare(`UPDATE tracks SET duration = 300 WHERE id = ?`).run(id)

    // `submission=false` is "I have started this", not "I have heard it".
    // Counting it would give a play to every track someone skips through.
    await h.rest('scrobble.view', { id, submission: 'false' })
    assert.equal((await h.api('GET', `/tracks/${id}`, undefined, h.token)).body.playCount, 0)

    await h.rest('scrobble.view', { id, submission: 'true' })
    assert.equal((await h.api('GET', `/tracks/${id}`, undefined, h.token)).body.playCount, 1)
  } finally { await h.cleanup() }
})

test('playlists are visible and readable', { skip }, async () => {
  const h = await harness()
  try {
    const ids = (await h.api('GET', '/tracks?limit=2', undefined, h.token)).body.items.map((t: any) => t.id)
    const pl = (await h.api('POST', '/playlists', { name: 'Roadtrip', trackIds: ids }, h.token)).body

    const lists = (await h.rest('getPlaylists.view')).body.playlists.playlist
    const mine = lists.find((p: any) => p.name === 'Roadtrip')
    assert.ok(mine)
    assert.equal(mine.songCount, 2)

    const full = (await h.rest('getPlaylist.view', { id: pl.id })).body.playlist
    assert.equal(full.entry.length, 2)
    assert.equal((await h.rest('getPlaylist.view', { id: 'nope' })).body.error.code, 70)
  } finally { await h.cleanup() }
})
