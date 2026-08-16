import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { configOf, items, musicSections, streamUrl } from '../src/plex.ts'

/**
 * A fake Plex answering the shapes the real one does.
 *
 * The details asserted here are the ones a hand-written stub gets wrong, and
 * each has cost somebody an afternoon: durations in **milliseconds** rather
 * than Jellyfin's ticks, the file buried in `Media[].Part[]`, `Container-Start`
 * paging rather than a page number, and a server that answers XML to anyone who
 * forgets to ask for JSON.
 */
const TRACK = (n: number) => ({
  ratingKey: `${1000 + n}`,
  title: `Track ${n}`,
  grandparentTitle: 'Air',
  parentTitle: 'Moon Safari',
  parentYear: 1998,
  index: n,
  parentIndex: 1,
  // Milliseconds. 200 seconds.
  duration: 200_000,
  Genre: [{ tag: 'Downtempo' }],
  Media: [{
    audioCodec: 'flac',
    bitrate: 900,
    Part: [{
      key: `/library/parts/${n}/file.flac`,
      file: `/music/Air/Moon Safari/0${n}.flac`,
      size: 30_000_000 + n,
      container: 'flac',
    }],
  }],
})

async function fakePlex(total = 3) {
  const requests: { url: string; accept?: string }[] = []
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', accept: req.headers.accept })
    const u = new URL(req.url ?? '/', 'http://x')

    // Plex checks the token on every route, header or query alike.
    if (!req.headers['x-plex-token'] && !u.searchParams.get('X-Plex-Token')) {
      res.writeHead(401); return res.end()
    }
    // A real Plex answers XML unless JSON is asked for. Answering JSON here
    // regardless would let a client that forgot the header pass the test and
    // then fail against the real thing.
    const wantsJson = (req.headers.accept ?? '').includes('application/json')
    const send = (body: unknown) => {
      if (!wantsJson) {
        res.writeHead(200, { 'content-type': 'text/xml' })
        return res.end('<MediaContainer size="0"/>')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (u.pathname === '/') {
      return send({ MediaContainer: { friendlyName: 'Attic', version: '1.40.2', machineIdentifier: 'm1' } })
    }
    if (u.pathname === '/library/sections') {
      return send({ MediaContainer: { Directory: [
        { key: '1', type: 'movie', title: 'Films' },
        { key: '2', type: 'artist', title: 'Music' },
      ] } })
    }
    if (u.pathname === '/library/sections/2/all') {
      const start = Number(u.searchParams.get('X-Plex-Container-Start')) || 0
      const size = Number(u.searchParams.get('X-Plex-Container-Size')) || 500
      const page = Array.from({ length: total }, (_, i) => TRACK(i + 1)).slice(start, start + size)
      return send({ MediaContainer: { size: page.length, totalSize: total, Metadata: page } })
    }
    if (u.pathname.startsWith('/library/parts/')) {
      const body = Buffer.alloc(1000, 9)
      const range = req.headers.range
      if (range) {
        const [, a, b] = /bytes=(\d+)-(\d*)/.exec(range) ?? []
        const start = Number(a), end = b ? Number(b) : body.length - 1
        res.writeHead(206, {
          'content-type': 'audio/flac',
          'content-range': `bytes ${start}-${end}/${body.length}`,
          'content-length': String(end - start + 1),
        })
        return res.end(body.subarray(start, end + 1))
      }
      res.writeHead(200, { 'content-type': 'audio/flac', 'content-length': String(body.length) })
      return res.end(body)
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    requests,
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    close: () => { server.closeAllConnections(); server.close() },
  }
}

test('milliseconds become seconds, and the file is found three levels down', async () => {
  const plex = await fakePlex(1)
  try {
    const found = []
    for await (const item of items({ url: plex.url, token: 'tok' })) found.push(item)

    assert.equal(found.length, 1)
    const t = found[0]
    // Reading this with Jellyfin's divisor gives 0.00002 seconds, which looks
    // like a bug in the player rather than in the client.
    assert.equal(t.duration, 200)
    assert.equal(t.size, 30_000_001)
    assert.equal(t.format, 'flac')
    assert.equal(t.bitRate, 900)
    assert.equal(t.albumArtist, 'Air')
    assert.equal(t.album, 'Moon Safari')
    assert.equal(t.year, 1998)
    assert.equal(t.path, '/music/Air/Moon Safari/01.flac')
    // The Part key, not the track's ratingKey. Streaming the ratingKey 404s.
    assert.equal(t.itemId, '/library/parts/1/file.flac')
  } finally { plex.close() }
})

test('JSON is asked for, because the default is a wall of XML', async () => {
  const plex = await fakePlex(1)
  try {
    const found = []
    for await (const item of items({ url: plex.url, token: 'tok' })) found.push(item)
    assert.equal(found.length, 1, 'an XML answer would have parsed as nothing')
    assert.ok(plex.requests.every((r) => r.accept?.includes('application/json')))
  } finally { plex.close() }
})

test('only music sections are walked', async () => {
  const plex = await fakePlex(1)
  try {
    const sections = await musicSections({ url: plex.url, token: 'tok' })
    // The films library is somebody else's problem.
    assert.deepEqual(sections, [{ key: '2', title: 'Music' }])
  } finally { plex.close() }
})

test('a large library is paged, by container offsets rather than page numbers', async () => {
  const plex = await fakePlex(7)
  try {
    const found = []
    for await (const item of items({ url: plex.url, token: 'tok' }, 3)) found.push(item)
    assert.equal(found.length, 7)
    const pages = plex.requests.filter((r) => r.url.includes('/all?'))
    assert.ok(pages.length >= 3, 'three pages, not one enormous response')
    assert.ok(pages.some((r) => r.url.includes('X-Plex-Container-Start=3')))
    assert.ok(pages.every((r) => r.url.includes('type=10')), 'type 10 is a track')
  } finally { plex.close() }
})

test('a track with no Part is skipped rather than indexed as unplayable', async () => {
  const plex = await fakePlex(0)
  try {
    // Nothing to stream means nothing worth a row.
    const found = []
    for await (const item of items({ url: plex.url, token: 'tok' })) found.push(item)
    assert.equal(found.length, 0)
  } finally { plex.close() }
})

test('a wrong token says so, rather than looking like an empty library', async () => {
  const plex = await fakePlex(1)
  try {
    await assert.rejects(async () => {
      for await (const _ of items({ url: plex.url, token: '' })) { /* unreachable */ }
    }, /refused the token/)
  } finally { plex.close() }
})

test('the stream URL is the Part key plus an escaped token', () => {
  const url = streamUrl({ url: 'http://plex:32400', token: 't o k' }, '/library/parts/1/file.flac')
  assert.equal(url, 'http://plex:32400/library/parts/1/file.flac?X-Plex-Token=t%20o%20k')
})

test('the config comes from root, so one column means the same for every source', () => {
  assert.deepEqual(
    configOf({ root: 'http://plex:32400/', config: '{"token":"t"}' }),
    { url: 'http://plex:32400', token: 't', section: undefined })
  assert.equal(configOf({ root: 'x', config: '{"url":"http://a","token":"t"}' }).url, 'http://a')
})

/* ---- through the server ---- */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-plex-'))
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
  const raw = (method: string, path: string, headers: Record<string, string> = {}) =>
    app.app.fetch(new Request(`http://x/api/v1${path}`, { method, headers }))
  const settle = async () => {
    const until = Date.now() + 8000
    while (Date.now() < until) {
      if (!app.jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  return { call, raw, settle, cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

test('a Plex library indexes without downloading anything', async () => {
  const plex = await fakePlex(3)
  const h = await harness()
  try {
    await h.call('POST', '/sources', {
      id: 'px', name: 'Attic', root: plex.url, kind: 'plex', config: { token: 'tok' },
    })

    const probe = (await h.call('POST', '/sources/px/test')).body
    assert.equal(probe.ok, true)
    assert.equal(probe.name, 'Attic')

    await h.call('POST', '/sources/px/scan')
    await h.settle()

    const found = (await h.call('GET', '/tracks?limit=50')).body.items
    assert.equal(found.length, 3)
    const t = found.find((x: any) => x.name === 'Track 1')
    assert.equal(t.artist, 'Air')
    assert.equal(t.album, 'Moon Safari')
    assert.equal(t.duration, 200)
    assert.equal(t.format, 'flac')

    // Their scanner already read the tags; this one downloaded no audio at all.
    assert.equal(plex.requests.filter((r) => r.url.includes('/library/parts/')).length, 0)
  } finally { await h.cleanup(); plex.close() }
})

test('and it plays, ranges included', async () => {
  const plex = await fakePlex(1)
  const h = await harness()
  try {
    await h.call('POST', '/sources', {
      id: 'px', name: 'Attic', root: plex.url, kind: 'plex', config: { token: 'tok' },
    })
    await h.call('POST', '/sources/px/scan')
    await h.settle()

    const id = (await h.call('GET', '/tracks?limit=1')).body.items[0].id

    const whole = await h.raw('GET', `/stream/${id}`)
    assert.equal(whole.status, 200)
    assert.equal((await whole.arrayBuffer()).byteLength, 1000)

    // The range has to survive the proxy, or seeking is a re-download.
    const part = await h.raw('GET', `/stream/${id}`, { range: 'bytes=10-19' })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000')
    assert.equal((await part.arrayBuffer()).byteLength, 10)
  } finally { await h.cleanup(); plex.close() }
})

test('an unreachable Plex is a 502 that says so, not a corrupt download', async () => {
  const plex = await fakePlex(1)
  const h = await harness()
  try {
    await h.call('POST', '/sources', {
      id: 'px', name: 'Attic', root: plex.url, kind: 'plex', config: { token: 'tok' },
    })
    await h.call('POST', '/sources/px/scan')
    await h.settle()
    const id = (await h.call('GET', '/tracks?limit=1')).body.items[0].id

    plex.close()
    const res = await h.raw('GET', `/stream/${id}`)
    assert.equal(res.status, 502)
    assert.equal((await res.json() as any).error.code, 'gone')
  } finally { await h.cleanup() }
})
