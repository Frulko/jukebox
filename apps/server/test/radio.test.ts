import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { discover, probeStream, searchDirectory } from '../src/radio.ts'

/**
 * The station is a real server, because the thing worth testing is that we read
 * the headers and then stop — a radio stream never ends on its own.
 */
async function station(opts: { headers?: Record<string, string>; status?: number; html?: string } = {}) {
  let sent = 0
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') {
      res.writeHead(200, { 'content-type': 'image/x-icon' })
      return res.end('icon')
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(opts.html ?? '<html><head><link rel="icon" href="/logo.png"></head></html>')
    }
    if (opts.status && opts.status !== 200) {
      res.writeHead(opts.status)
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg', ...(opts.headers ?? {}) })
    // Audio, for ever, exactly like the real thing.
    timer = setInterval(() => {
      if (!res.write(Buffer.alloc(8192))) return
      sent += 8192
    }, 5)
    res.on('close', () => {
      stopped = true
      if (timer) clearInterval(timer)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  return {
    server,
    url: `http://127.0.0.1:${port}/stream`,
    home: `http://127.0.0.1:${port}/`,
    get sent() { return sent },
    get stopped() { return stopped },
    close: () => { if (timer) clearInterval(timer); server.close() },
  }
}

test('a probe reads the ICY headers and stops the stream', async () => {
  const s = await station({
    headers: {
      'icy-name': 'Radio Nova',
      'icy-genre': 'Eclectic',
      'icy-br': '128',
      'icy-url': 'https://nova.example',
    },
  })
  try {
    const p = await probeStream(s.url)
    assert.equal(p.error, null)
    assert.equal(p.name, 'Radio Nova')
    assert.equal(p.genre, 'Eclectic')
    assert.equal(p.bitrate, 128)
    assert.equal(p.codec, 'mp3')
    assert.equal(p.homepageUrl, 'https://nova.example')

    // The whole point. Left open, this downloads until the disk fills.
    await new Promise((r) => setTimeout(r, 120))
    assert.ok(s.stopped, 'the connection was closed after the headers')
    assert.ok(s.sent < 2_000_000, `only ${s.sent} bytes crossed the wire`)
  } finally { s.close() }
})

test('a station that refuses says so instead of hanging', async () => {
  const s = await station({ status: 404 })
  try {
    const p = await probeStream(s.url)
    assert.match(p.error ?? '', /404/)
  } finally { s.close() }
})

test('a host that does not answer at all is an error, not a wait', async () => {
  // Port 1 refuses instantly.
  const p = await probeStream('http://127.0.0.1:1/stream')
  assert.ok(p.error)
  assert.equal(p.name, '')
})

test('discovery fills the blanks and never overwrites what was given', async () => {
  const s = await station({
    headers: { 'icy-name': 'Radio Nova', 'icy-genre': 'Eclectic', 'icy-br': '128' },
  })
  try {
    const found = await discover(s.url, { name: 'My Name For It' }, { directory: false })
    assert.equal(found.name, 'My Name For It', 'a chosen name survives a probe')
    assert.equal(found.genre, 'Eclectic', 'a blank is filled from the stream')
  } finally { s.close() }
})

test('a nameless stream falls back to its host rather than to nothing', async () => {
  const s = await station()
  try {
    const found = await discover(s.url, {}, { directory: false })
    assert.equal(found.name, '127.0.0.1')
  } finally { s.close() }
})

/* ---- the API ---- */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-radio-'))
  const { app, jobs } = createApp(join(dir, 'db.sqlite'))
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(new Request(`http://x/api/v1${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  return { call, cleanup: () => { jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

test('a station is created, edited, favourited and removed', async () => {
  const h = await harness()
  try {
    const made = await h.call('POST', '/radios', {
      streamUrl: 'http://example.com/stream', name: 'FIP', discover: false,
    })
    assert.equal(made.status, 201)
    assert.equal(made.body.name, 'FIP')

    const id = made.body.id
    assert.equal((await h.call('PATCH', `/radios/${id}`, { favorite: true, genre: 'Jazz' })).body.favorite, 1)
    assert.equal((await h.call('GET', `/radios/${id}`)).body.genre, 'Jazz')
    assert.equal((await h.call('GET', '/radios')).body.items.length, 1)

    assert.equal((await h.call('DELETE', `/radios/${id}`)).status, 204)
    assert.equal((await h.call('GET', '/radios')).body.items.length, 0)
    assert.equal((await h.call('GET', `/radios/${id}`)).status, 404)
  } finally { await h.cleanup() }
})

test('a stream URL that is not one is refused', async () => {
  const h = await harness()
  try {
    for (const bad of ['nope', 'file:///etc/passwd', 'rtsp://x/y']) {
      assert.equal((await h.call('POST', '/radios', { streamUrl: bad })).status, 400, bad)
    }
  } finally { await h.cleanup() }
})

test('a station whose stream is asleep is still added', async () => {
  const h = await harness()
  try {
    const res = await h.call('POST', '/radios', { streamUrl: 'http://127.0.0.1:1/stream', directory: false })
    // The probe failing is reported, not fatal: the station is worth keeping.
    assert.equal(res.status, 201)
    assert.ok(res.body.probeError)
    assert.equal(res.body.name, '127.0.0.1', 'named from the URL rather than left blank')
  } finally { await h.cleanup() }
})

/* ---- the directory search ---- */

test('a directory search maps its hits and drops the unplayable', async () => {
  const dir = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([
      {
        name: ' FIP ', url: 'http://x/fip.m3u', url_resolved: 'http://x/fip.aac',
        favicon: 'http://x/logo.png', tags: 'jazz,public radio', country: 'France',
        codec: 'AAC', bitrate: 192, votes: 43000, homepage: 'https://fip.fr',
      },
      // A directory row with no playable URL proposes nothing.
      { name: 'ghost station', url: '', url_resolved: '', votes: 9 },
    ]))
  })
  await new Promise<void>((r) => dir.listen(0, '127.0.0.1', r))
  process.env.JUKEBOX_RADIO_DIRECTORY = `http://127.0.0.1:${(dir.address() as any).port}`
  try {
    const hits = await searchDirectory('fip')
    assert.ok(hits, 'the directory answered')
    assert.equal(hits.length, 1)
    assert.deepEqual(hits[0], {
      name: 'FIP', streamUrl: 'http://x/fip.aac', homepageUrl: 'https://fip.fr',
      imageUrl: 'http://x/logo.png', genre: 'jazz,public radio', country: 'France',
      bitrate: 192, codec: 'aac', votes: 43000,
    })
  } finally {
    delete process.env.JUKEBOX_RADIO_DIRECTORY
    dir.close()
  }
})

test('a directory that does not answer is null, never an empty result', async () => {
  process.env.JUKEBOX_RADIO_DIRECTORY = 'http://127.0.0.1:1'
  try {
    assert.equal(await searchDirectory('fip'), null)
  } finally { delete process.env.JUKEBOX_RADIO_DIRECTORY }
})

test('the search route refuses a blank query and says when nobody answered', async () => {
  const h = await harness()
  process.env.JUKEBOX_RADIO_DIRECTORY = 'http://127.0.0.1:1'
  try {
    assert.equal((await h.call('GET', '/radios/search')).status, 400)
    const down = await h.call('GET', '/radios/search?q=fip')
    assert.equal(down.status, 502, '"could not ask" is not "no results"')
  } finally {
    delete process.env.JUKEBOX_RADIO_DIRECTORY
    await h.cleanup()
  }
})
