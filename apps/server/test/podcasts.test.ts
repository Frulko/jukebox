import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createApp } from '../src/app.ts'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The feed is served by a real HTTP server rather than a stubbed fetch: the
 * conditional GET is the part worth testing, and it lives in the headers.
 */

const feedXml = (items: string) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test Show</title>
    <description>Testing</description>
    <itunes:author>A Person</itunes:author>
    ${items}
  </channel>
</rss>`

const item = (n: number) => `
  <item>
    <title>Episode ${n}</title>
    <guid>ep-${n}</guid>
    <pubDate>${new Date(Date.UTC(2026, 7, n)).toUTCString()}</pubDate>
    <itunes:duration>${n}:00</itunes:duration>
    <enclosure url="http://127.0.0.1:1/${n}.mp3" length="${n * 1000}" type="audio/mpeg"/>
  </item>`

type Feeder = {
  url: string
  server: Server
  /** How many times the feed was actually sent as a body, 304s excluded. */
  bodies: number
  requests: number
  setItems: (xml: string) => void
}

async function serveFeed(): Promise<Feeder> {
  let items = item(1) + item(2)
  const state = { bodies: 0, requests: 0 } as any
  const etag = () => `"v${items.length}"`

  const server = createServer((req, res) => {
    state.requests++
    if (req.headers['if-none-match'] === etag()) {
      res.writeHead(304, { etag: etag() })
      return res.end()
    }
    state.bodies++
    res.writeHead(200, { 'content-type': 'application/rss+xml', etag: etag() })
    res.end(feedXml(items))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port

  return Object.assign(state, {
    server,
    url: `http://127.0.0.1:${port}/feed.xml`,
    setItems: (xml: string) => { items = xml },
  })
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-pod-'))
  const { app, jobs, db } = createApp(join(dir, 'db.sqlite'))
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(new Request(`http://x/api/v1${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  return { call, jobs, db, cleanup: () => { jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

async function settle(jobs: any, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const busy = jobs.list({}).filter((j: any) => j.state === 'queued' || j.state === 'running')
    if (!busy.length) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('subscribing fetches the feed and lists its episodes', async () => {
  const feed = await serveFeed()
  const h = await harness()
  try {
    const res = await h.call('POST', '/podcasts', { feedUrl: feed.url })
    assert.equal(res.status, 201)
    await settle(h.jobs)

    const p = (await h.call('GET', `/podcasts/${res.body.id}`)).body
    assert.equal(p.title, 'Test Show', 'the channel metadata is taken from the feed')
    assert.equal(p.author, 'A Person')
    assert.equal(p.episodeCount, 2)
    assert.equal(p.lastError, null)

    const eps = (await h.call('GET', `/podcasts/${p.id}/episodes`)).body
    // Newest first: the only order anyone reads a podcast in.
    assert.deepEqual(eps.items.map((e: any) => e.guid), ['ep-2', 'ep-1'])
    assert.equal(eps.items[0].duration, 120)
  } finally { await h.cleanup(); feed.server.close() }
})

test('a refresh that finds nothing new transfers no body', async () => {
  const feed = await serveFeed()
  const h = await harness()
  try {
    const p = (await h.call('POST', '/podcasts', { feedUrl: feed.url })).body
    await settle(h.jobs)
    assert.equal(feed.bodies, 1)

    await h.call('POST', `/podcasts/${p.id}/refresh`)
    await settle(h.jobs)
    // The stored ETag went back out and the server answered 304.
    assert.equal(feed.requests, 2, 'it did ask again')
    assert.equal(feed.bodies, 1, 'but paid for no body')
    assert.equal((await h.call('GET', `/podcasts/${p.id}`)).body.episodeCount, 2)
  } finally { await h.cleanup(); feed.server.close() }
})

test('a new episode is added and the existing ones are not duplicated', async () => {
  const feed = await serveFeed()
  const h = await harness()
  try {
    const p = (await h.call('POST', '/podcasts', { feedUrl: feed.url })).body
    await settle(h.jobs)

    feed.setItems(item(1) + item(2) + item(3))
    await h.call('POST', `/podcasts/${p.id}/refresh`)
    await settle(h.jobs)

    const eps = (await h.call('GET', `/podcasts/${p.id}/episodes`)).body
    assert.equal(eps.items.length, 3, 'one added, none duplicated')
    assert.deepEqual(eps.items.map((e: any) => e.guid), ['ep-3', 'ep-2', 'ep-1'])
  } finally { await h.cleanup(); feed.server.close() }
})

test('a refresh keeps what you listened to', async () => {
  const feed = await serveFeed()
  const h = await harness()
  try {
    const p = (await h.call('POST', '/podcasts', { feedUrl: feed.url })).body
    await settle(h.jobs)
    // Stand in for having listened to half of episode 2.
    h.db.prepare(`UPDATE episodes SET played = 1, position = 61 WHERE guid = 'ep-2'`).run()

    // The upsert refreshes metadata only. Titles get corrected after
    // publication; progress must not be.
    feed.setItems(item(1) + item(2).replace('Episode 2', 'Episode 2 (fixed)'))
    await h.call('POST', `/podcasts/${p.id}/refresh`)
    await settle(h.jobs)

    const eps = (await h.call('GET', `/podcasts/${p.id}/episodes`)).body.items
    const two = eps.find((e: any) => e.guid === 'ep-2')
    assert.equal(two.title, 'Episode 2 (fixed)', 'metadata is refreshed')
    assert.equal(two.played, 1, 'a refresh must not forget what you listened to')
    assert.equal(two.position, 61, 'nor where you stopped')
  } finally { await h.cleanup(); feed.server.close() }
})

test('a dead feed records why instead of failing silently', async () => {
  const h = await harness()
  try {
    // Port 1 refuses instantly on every platform.
    const p = (await h.call('POST', '/podcasts', { feedUrl: 'http://127.0.0.1:1/feed.xml' })).body
    await settle(h.jobs)
    const after = (await h.call('GET', `/podcasts/${p.id}`)).body
    assert.ok(after.lastError, 'the reason is stored, so the UI can show a broken feed as broken')
    assert.ok(after.lastFetchAt)
  } finally { await h.cleanup() }
})

test('a feed URL that is not one is refused at subscribe time', async () => {
  const h = await harness()
  try {
    for (const bad of ['not a url', 'ftp://example.com/feed.xml', 'file:///etc/passwd']) {
      const res = await h.call('POST', '/podcasts', { feedUrl: bad })
      assert.equal(res.status, 400, bad)
    }
    assert.equal((await h.call('POST', '/podcasts', { feedUrl: 'https://e.com/f', cron: 'nope' })).status, 400)
  } finally { await h.cleanup() }
})

test('subscribing twice to the same feed is refused', async () => {
  const feed = await serveFeed()
  const h = await harness()
  try {
    assert.equal((await h.call('POST', '/podcasts', { feedUrl: feed.url })).status, 201)
    await settle(h.jobs)
    const again = await h.call('POST', '/podcasts', { feedUrl: feed.url })
    assert.equal(again.status, 409)
  } finally { await h.cleanup(); feed.server.close() }
})

test('one episode can be downloaded by hand, into the fallback source', async () => {
  // A separate server for the audio: the feeder only speaks RSS.
  const media = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    res.end(Buffer.from('not really an mp3'))
  })
  await new Promise<void>((r) => media.listen(0, '127.0.0.1', r))
  const mediaUrl = `http://127.0.0.1:${(media.address() as any).port}`

  const feed = await serveFeed()
  feed.setItems(`
    <item>
      <title>Fetch Me</title>
      <guid>ep-fetch</guid>
      <pubDate>${new Date(Date.UTC(2026, 7, 1)).toUTCString()}</pubDate>
      <enclosure url="${mediaUrl}/fetch.mp3" length="17" type="audio/mpeg"/>
    </item>`)

  const h = await harness()
  const root = await mkdtemp(join(tmpdir(), 'jukebox-pod-lib-'))
  try {
    const p = (await h.call('POST', '/podcasts', { feedUrl: feed.url })).body
    await settle(h.jobs)
    const ep = (await h.call('GET', `/podcasts/${p.id}/episodes`)).body.items[0]

    // Nowhere to write yet: the click fails now, not silently inside a job.
    const refused = await h.call('POST', `/podcasts/${p.id}/episodes/${ep.id}/download`)
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.code, 'no_writable_source')

    // The podcast names no target; the first local writable source serves.
    await h.call('POST', '/sources', { name: 'lib', root, writable: true })
    const accepted = await h.call('POST', `/podcasts/${p.id}/episodes/${ep.id}/download`)
    assert.equal(accepted.status, 202)
    // Its own kind and a label: what the LCD needs to say more than "busy".
    assert.equal(accepted.body.kind, 'download')
    assert.equal(accepted.body.label, 'Fetch Me')
    await settle(h.jobs)

    // Progress is bytes of the file, told while it streamed.
    const job = (await h.call('GET', '/jobs')).body.items.find((j: any) => j.id === accepted.body.id)
    assert.equal(job.state, 'done')
    assert.equal(job.progress.done, 17, 'the fake mp3 is 17 bytes')
    assert.equal(job.progress.total, 17)

    const after = (await h.call('GET', `/podcasts/${p.id}/episodes`)).body.items[0]
    assert.ok(after.trackId, 'the episode now points at a library track')
    const track = h.db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(after.trackId) as any
    assert.equal(track.kind, 'podcast')
    await stat(join(root, track.path))

    // Already in the library: downloading it again is a conflict, not a re-fetch.
    assert.equal((await h.call('POST', `/podcasts/${p.id}/episodes/${ep.id}/download`)).status, 409)
  } finally {
    await h.cleanup()
    await rm(root, { recursive: true, force: true })
    feed.server.close()
    media.close()
  }
})
