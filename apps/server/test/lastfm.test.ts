import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'

const plugin: any = await import(new URL('../../../plugins/lastfm/index.mjs', import.meta.url).href)
const { activate, sign } = plugin

/**
 * Last.fm, whose whole difficulty is one MD5.
 *
 * Every expected signature here was computed outside this code — `md5` on the
 * command line over the string the specification describes — so the test is
 * checking the implementation against Last.fm's rule rather than against
 * itself, which is the only version of this test worth having.
 */

test('the signature matches an independently computed one', () => {
  assert.equal(
    sign({ method: 'track.scrobble', api_key: 'KEY123', sk: 'SESSION', track: 'Café' }, 'SECRET'),
    '33c68c878876006d61e338bd9f821f62')

  assert.equal(
    sign({ method: 'auth.getMobileSession', api_key: 'KEY123', username: 'user', password: 'pw' }, 'SECRET'),
    'd94a1086893925e4a288fa6dc6dc9787')
})

test('format and api_sig are excluded from what is signed', () => {
  const base = { method: 'track.scrobble', api_key: 'KEY123', sk: 'SESSION', track: 'Café' }
  // Including either produces "Invalid method signature supplied", which says
  // nothing about which of the two it was.
  assert.equal(sign({ ...base, format: 'json' }, 'SECRET'), '33c68c878876006d61e338bd9f821f62')
  assert.equal(sign({ ...base, api_sig: 'whatever' }, 'SECRET'), '33c68c878876006d61e338bd9f821f62')
})

test('parameters are sorted by name, not by the order they were written', () => {
  const a = sign({ method: 'track.scrobble', api_key: 'KEY123', sk: 'SESSION', track: 'Café' }, 'SECRET')
  const b = sign({ track: 'Café', sk: 'SESSION', api_key: 'KEY123', method: 'track.scrobble' }, 'SECRET')
  assert.equal(a, b)
  assert.equal(a, '33c68c878876006d61e338bd9f821f62')
})

test('it is the raw UTF-8 that is hashed, not the encoded form', () => {
  // Signing the percent-encoded value is the classic mistake, and it only shows
  // up for people whose music is not exclusively ASCII.
  const raw = sign({ method: 'm', track: 'Café' }, 'S')
  const encoded = sign({ method: 'm', track: encodeURIComponent('Café') }, 'S')
  assert.notEqual(raw, encoded)
})

/* ---- against a fake Last.fm ---- */

async function fakeLastfm({ fail = 0 } = {}) {
  const requests: Record<string, string>[] = []
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const params = Object.fromEntries(new URLSearchParams(chunks.join('')))
    requests.push(params)

    if (fail) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: fail, message: `error ${fail}` }))
    }
    if (params.method === 'auth.getMobileSession') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ session: { key: 'SESSIONKEY', name: params.username } }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    requests,
    url: `http://127.0.0.1:${(server.address() as any).port}/`,
    close: () => { server.closeAllConnections(); server.close() },
  }
}

function fakeHost(config: Record<string, unknown>, url: string) {
  const listeners: any[] = []
  const commands = new Map<string, any>()
  const timers = new Set<any>()
  const logs: string[] = []
  const host = {
    apiVersion: '1.2.0',
    pluginId: 'lastfm',
    log: (...a: unknown[]) => logs.push(a.join(' ')),
    config,
    setConfig: (next: any) => { host.config = next },
    // Every request is redirected at the fake, since the endpoint is a constant
    // in the plugin — which is right: it is not a setting anyone should change.
    net: {
      fetch: (_input: string, init: any) => fetch(url, init),
      setInterval: (fn: any, ms: number) => { const t = setInterval(fn, ms); t.unref?.(); timers.add(t); return t },
      clearInterval: (t: any) => { clearInterval(t); timers.delete(t) },
    },
    on: (_e: string, handler: any) => { listeners.push(handler); return () => {} },
    registerCommand: (name: string, handler: any) => commands.set(name, handler),
  } as any
  return {
    host, logs, commands,
    play: (e: any) => listeners.forEach((l) => l(e)),
    stopTimers: () => { for (const t of timers) clearInterval(t) },
  }
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))

test('a listen is scrobbled, signed, with the moment it started', async () => {
  const lastfm = await fakeLastfm()
  const h = fakeHost({ apiKey: 'KEY', apiSecret: 'SECRET', sessionKey: 'SK' }, lastfm.url)
  const stop = activate(h.host)
  try {
    h.play({ artist: 'Air', name: 'La Femme d\'Argent', album: 'Moon Safari', duration: 429, startedAt: 1_700_000_000_000 })
    await settle()

    assert.equal(lastfm.requests.length, 1)
    const req = lastfm.requests[0]
    assert.equal(req.method, 'track.scrobble')
    assert.equal(req['artist[0]'], 'Air')
    assert.equal(req['track[0]'], "La Femme d'Argent")
    // Seconds, and the *start* of the track: it is what Last.fm orders a
    // listening history by, so sending the end reorders the evening.
    assert.equal(req['timestamp[0]'], '1700000000')

    // And it is really signed, with the signature the parameters imply.
    const { api_sig, format, ...signed } = req
    assert.equal(api_sig, sign(signed, 'SECRET'))
  } finally { stop?.(); h.stopTimers(); lastfm.close() }
})

test('a dead network queues rather than loses, and the batch goes out together', async () => {
  const lastfm = await fakeLastfm()
  const h = fakeHost({ apiKey: 'KEY', apiSecret: 'SECRET' }, lastfm.url)
  const stop = activate(h.host)
  try {
    // No session key yet: nothing can be sent, and nothing may be dropped.
    for (let i = 0; i < 3; i++) {
      h.play({ artist: 'Air', name: `Track ${i}`, startedAt: 1_700_000_000_000 + i * 1000 })
    }
    await settle()
    assert.equal(lastfm.requests.length, 0, 'nothing sent without a session')

    h.host.config = { ...h.host.config, sessionKey: 'SK' }
    await h.commands.get('flush')({ trackIds: [], tracks: [] })
    await settle()

    // Anyone who has lost a week of scrobbles to a flaky connection knows why
    // this matters, and one request rather than three is the other half.
    assert.equal(lastfm.requests.length, 1)
    assert.equal(lastfm.requests[0]['track[0]'], 'Track 0')
    assert.equal(lastfm.requests[0]['track[2]'], 'Track 2')
  } finally { stop?.(); h.stopTimers(); lastfm.close() }
})

test('a dead session is dropped rather than retried for ever', async () => {
  // Error 9 is "invalid session key". Retrying it blocks every scrobble behind
  // it until someone notices, which is the failure this distinction prevents.
  const lastfm = await fakeLastfm({ fail: 9 })
  const h = fakeHost({ apiKey: 'KEY', apiSecret: 'SECRET', sessionKey: 'STALE' }, lastfm.url)
  const stop = activate(h.host)
  try {
    h.play({ artist: 'Air', name: 'Sexy Boy', startedAt: 1_700_000_000_000 })
    await settle()
    assert.ok(h.logs.some((l) => l.includes('dropping')), h.logs.join(' | '))

    // A later listen is attempted rather than stuck behind the dead one.
    h.play({ artist: 'Air', name: 'Kelly Watch the Stars', startedAt: 1_700_000_100_000 })
    await settle()
    assert.equal(lastfm.requests.length, 2)
  } finally { stop?.(); h.stopTimers(); lastfm.close() }
})

test('a rate limit is retried, not discarded', async () => {
  const lastfm = await fakeLastfm({ fail: 16 })
  const h = fakeHost({ apiKey: 'KEY', apiSecret: 'SECRET', sessionKey: 'SK' }, lastfm.url)
  const stop = activate(h.host)
  try {
    h.play({ artist: 'Air', name: 'Sexy Boy', startedAt: 1_700_000_000_000 })
    await settle()
    // 16 is "the service is temporarily unavailable" — the listen is still good.
    assert.ok(h.logs.some((l) => l.includes('will retry')), h.logs.join(' | '))
    assert.ok(!h.logs.some((l) => l.includes('dropping')))
  } finally { stop?.(); h.stopTimers(); lastfm.close() }
})

test('connecting exchanges the password for a session key and forgets it', async () => {
  const lastfm = await fakeLastfm()
  const h = fakeHost({ apiKey: 'KEY', apiSecret: 'SECRET', username: 'me', password: 'hunter2' }, lastfm.url)
  const stop = activate(h.host)
  try {
    const result = await h.commands.get('connect')({ trackIds: [], tracks: [] })
    assert.match(result.body, /Connected as me/)

    assert.equal(h.host.config.sessionKey, 'SESSIONKEY')
    // Kept beside the session key it produced, the password would be a second
    // credential to leak for no additional capability.
    assert.equal(h.host.config.password, '')
    assert.equal(lastfm.requests[0].method, 'auth.getMobileSession')
  } finally { stop?.(); h.stopTimers(); lastfm.close() }
})
