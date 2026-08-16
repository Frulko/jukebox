import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { configOf, items, streamUrl } from '../src/jellyfin.ts'

/**
 * A fake Jellyfin answering the shapes the real one does — ticks for durations,
 * `MediaSources` for size and codec, `TotalRecordCount` for paging. Those are
 * exactly the details a hand-written stub gets wrong, so they are what the
 * tests assert.
 */
const AUDIO = (n: number) => ({
  Id: `jf-${n}`,
  Name: `Track ${n}`,
  Artists: ['Daft Punk'],
  AlbumArtist: 'Daft Punk',
  Album: 'Discovery',
  Genres: ['Electronic'],
  ProductionYear: 2001,
  IndexNumber: n,
  ParentIndexNumber: 1,
  // 100-nanosecond ticks. 200 seconds.
  RunTimeTicks: 2_000_000_000,
  Path: `/music/Daft Punk/Discovery/0${n}.flac`,
  MediaSources: [{
    Size: 30_000_000 + n,
    Container: 'flac',
    MediaStreams: [{ Type: 'Audio', Codec: 'flac', BitRate: 900_000 }],
  }],
})

async function fakeJellyfin(total = 3) {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '')
    if (!req.headers['x-emby-token']) {
      res.writeHead(401); return res.end()
    }
    if (req.url?.startsWith('/System/Info')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ServerName: 'Living Room', Version: '10.9.11', Id: 'abc' }))
    }
    if (req.url?.startsWith('/Items')) {
      const start = Number(new URL(req.url, 'http://x').searchParams.get('StartIndex')) || 0
      const limit = Number(new URL(req.url, 'http://x').searchParams.get('Limit')) || 500
      const page = Array.from({ length: total }, (_, i) => AUDIO(i + 1)).slice(start, start + limit)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ Items: page, TotalRecordCount: total }))
    }
    if (req.url?.includes('/stream')) {
      const body = Buffer.alloc(1000, 7)
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

test('their ticks, sizes and codecs arrive as this library s units', async () => {
  const jf = await fakeJellyfin(1)
  try {
    const cfg = { url: jf.url, token: 'key' }
    const found = []
    for await (const item of items(cfg)) found.push(item)

    assert.equal(found.length, 1)
    const t = found[0]
    // Ticks of 100ns, which is the single most misread field in this API.
    assert.equal(t.duration, 200)
    assert.equal(t.size, 30_000_001)
    assert.equal(t.format, 'flac')
    assert.equal(t.bitRate, 900, 'bits per second become kilobits, as everywhere else here')
    assert.equal(t.albumArtist, 'Daft Punk')
    assert.equal(t.trackNumber, 1)
    assert.equal(t.year, 2001)
  } finally { jf.close() }
})

test('a large library is paged rather than asked for whole', async () => {
  const jf = await fakeJellyfin(7)
  try {
    const found = []
    for await (const item of items({ url: jf.url, token: 'key' }, 3)) found.push(item)
    assert.equal(found.length, 7)
    // Three pages plus the stop, not one enormous response that has to be
    // buffered before it can be parsed.
    assert.ok(jf.requests.filter((r) => r.startsWith('/Items')).length >= 3)
    assert.ok(jf.requests.some((r) => r.includes('MediaSources')), 'or there would be no size or codec')
  } finally { jf.close() }
})

test('a wrong API key says so, rather than looking like an empty library', async () => {
  const jf = await fakeJellyfin(1)
  try {
    await assert.rejects(async () => {
      for await (const _ of items({ url: jf.url, token: '' })) { /* unreachable */ }
    }, /refused the API key/)
  } finally { jf.close() }
})

test('the stream URL asks for the file rather than a conversion', () => {
  const url = streamUrl({ url: 'http://jf:8096', token: 'k e y' }, 'jf-1')
  // Without Static, Jellyfin decides for itself whether to transcode and may
  // burn CPU converting something that was already playable.
  assert.match(url, /Static=true/)
  assert.match(url, /api_key=k%20e%20y/, 'the key is escaped')
})

test('the config comes from root, so one column means the same for every source', () => {
  assert.deepEqual(
    configOf({ root: 'http://jf:8096/', config: '{"token":"k"}' }),
    { url: 'http://jf:8096', token: 'k', parentId: undefined })
  // An explicit url wins, for a source whose root is something else.
  assert.equal(configOf({ root: 'x', config: '{"url":"http://a","token":"k"}' }).url, 'http://a')
})

/* ---- through the server ---- */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-jf-'))
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

test('a Jellyfin library indexes without downloading anything', async () => {
  const jf = await fakeJellyfin(3)
  const h = await harness()
  try {
    await h.call('POST', '/sources', {
      id: 'jf', name: 'Living Room', root: jf.url, kind: 'jellyfin',
      config: { token: 'key' },
    })

    // Answering before a scan beats reading a job's error afterwards.
    const test = (await h.call('POST', '/sources/jf/test')).body
    assert.equal(test.ok, true)
    assert.equal(test.name, 'Living Room')

    await h.call('POST', '/sources/jf/scan')
    await h.settle()

    const items = (await h.call('GET', '/tracks?limit=50')).body.items
    assert.equal(items.length, 3)
    const t = items.find((x: any) => x.name === 'Track 1')
    // All of it from the listing: their scanner already did this work.
    assert.equal(t.artist, 'Daft Punk')
    assert.equal(t.album, 'Discovery')
    assert.equal(t.duration, 200)
    assert.equal(t.format, 'flac')

    // Not one byte of audio was fetched to learn any of that.
    assert.equal(jf.requests.filter((r) => r.includes('/stream')).length, 0)
  } finally { await h.cleanup(); jf.close() }
})

test('and it plays, ranges included', async () => {
  const jf = await fakeJellyfin(1)
  const h = await harness()
  try {
    await h.call('POST', '/sources', {
      id: 'jf', name: 'Living Room', root: jf.url, kind: 'jellyfin', config: { token: 'key' },
    })
    await h.call('POST', '/sources/jf/scan')
    await h.settle()
    const id = (await h.call('GET', '/tracks?limit=1')).body.items[0].id

    const whole = await h.raw('GET', `/stream/${id}`)
    // Their item id, not our file path. Asserting only that the stream answered
    // let this pass while the handler was asking for `/Audio//music/.../01.flac`,
    // which a real Jellyfin answers with a 404.
    assert.ok(jf.requests.some((r) => r.startsWith('/Audio/jf-1/stream')),
      `asked for ${jf.requests.filter((r) => r.includes('/stream')).join(' ')}`)
    assert.equal(whole.status, 200)
    assert.match(whole.headers.get('content-type') ?? '', /^audio\//)
    await whole.body?.cancel()

    // The range goes upstream and the answer comes straight back, so seeking on
    // a remote library costs the range rather than the file.
    const part = await h.raw('GET', `/stream/${id}`, { range: 'bytes=10-59' })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), 'bytes 10-59/1000')
    assert.equal((await part.arrayBuffer()).byteLength, 50)
  } finally { await h.cleanup(); jf.close() }
})

test('a server that has gone away is a 502, not a crash', async () => {
  const h = await harness()
  try {
    await h.call('POST', '/sources', {
      id: 'jf', name: 'Gone', root: 'http://127.0.0.1:1', kind: 'jellyfin', config: { token: 'k' },
    })
    const test = (await h.call('POST', '/sources/jf/test')).body
    assert.equal(test.ok, false)
    assert.ok(test.reason)
  } finally { await h.cleanup() }
})
