import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { SatelliteRenderer } from '../src/renderer.ts'

/**
 * A fake server holding a player state, and a "player" that is `sleep`.
 *
 * What is worth testing is *when* the subprocess is restarted, not what it
 * sounds like — every interesting failure is either a song that stutters
 * because something unrelated changed, or silence because nothing did.
 */
const sleeper = { bin: 'sleep', args: () => ['30'] }

async function fakeServer(state: Record<string, unknown>) {
  const registered: any[] = []
  const reports: any[] = []
  let current = state

  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.url === '/outputs/register') registered.push(JSON.parse(body || '{}'))
      else if (req.url === '/player/report') reports.push(JSON.parse(body || '{}'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(req.url === '/player' ? JSON.stringify(current) : '{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    registered, reports,
    set: (next: Record<string, unknown>) => { current = next },
    // `closeAllConnections` as well as `close`: fetch keeps its sockets alive,
    // and `close` alone waits for them to time out -- which is thirty seconds
    // of a test suite doing nothing.
    close: () => { server.closeAllConnections(); server.close() },
  }
}

const playing = (trackId: string | null, targetId: string | null, isPlaying = true) => ({
  trackId, playing: isPlaying, position: 0,
  target: targetId ? { kind: 'output', id: targetId } : { kind: 'local' },
})

test('a satellite announces itself, with what it can decode', async () => {
  const s = await fakeServer(playing(null, null))
  const r = new SatelliteRenderer({
    server: s.url, id: 'out-pi', name: 'Hallway', url: 'http://pi:8899',
    formats: ['mp3', 'flac'], player: sleeper,
  })
  try {
    assert.equal(await r.register(), true)
    assert.equal(s.registered[0].id, 'out-pi')
    assert.equal(s.registered[0].kind, 'satellite')
    // So the server can hand it a rendition it already plays rather than one
    // that needs converting.
    assert.deepEqual(s.registered[0].formats, ['mp3', 'flac'])
  } finally { await r.close(); s.close() }
})

test('it plays only what is aimed at it', async () => {
  const s = await fakeServer(playing('t1', 'someone-else'))
  const r = new SatelliteRenderer({ server: s.url, id: 'out-pi', name: 'Hallway', url: 'x', player: sleeper })
  try {
    await r.poll()
    assert.equal(r.playing, null, 'music going to another room is not this one\'s business')

    s.set(playing('t1', 'out-pi'))
    await r.poll()
    assert.equal(r.playing, 't1')
  } finally { await r.close(); s.close() }
})

test('polling again does not restart a song that is already playing', async () => {
  const s = await fakeServer(playing('t1', 'out-pi'))
  const r = new SatelliteRenderer({ server: s.url, id: 'out-pi', name: 'Hallway', url: 'x', player: sleeper })
  try {
    await r.poll()
    const first = r.playing
    // The bug that makes a song stutter every time anyone touches anything: the
    // queue is polled every second, and nothing changed.
    for (let i = 0; i < 5; i++) await r.poll()
    assert.equal(r.playing, first)
  } finally { await r.close(); s.close() }
})

test('a track change restarts it, and a pause silences it immediately', async () => {
  const s = await fakeServer(playing('t1', 'out-pi'))
  const r = new SatelliteRenderer({ server: s.url, id: 'out-pi', name: 'Hallway', url: 'x', player: sleeper })
  try {
    await r.poll()
    s.set(playing('t2', 'out-pi'))
    await r.poll()
    assert.equal(r.playing, 't2')

    // Waiting for the track to end before honouring a pause would be surreal.
    s.set(playing('t2', 'out-pi', false))
    await r.poll()
    assert.equal(r.playing, null)
  } finally { await r.close(); s.close() }
})

test('the music moving to another room stops it here', async () => {
  const s = await fakeServer(playing('t1', 'out-pi'))
  const r = new SatelliteRenderer({ server: s.url, id: 'out-pi', name: 'Hallway', url: 'x', player: sleeper })
  try {
    await r.poll()
    assert.equal(r.playing, 't1')
    s.set(playing('t1', 'the-sonos'))
    await r.poll()
    assert.equal(r.playing, null)
  } finally { await r.close(); s.close() }
})

test('it reports where it is, and only while it is playing', async () => {
  const s = await fakeServer(playing('t1', 'out-pi'))
  const r = new SatelliteRenderer({ server: s.url, id: 'out-pi', name: 'Hallway', url: 'x', player: sleeper })
  try {
    await r.report()
    assert.equal(s.reports.length, 0, 'nothing to report when nothing is playing')

    await r.poll()
    await r.report()
    assert.equal(s.reports.length, 1)
    assert.equal(typeof s.reports[0].position, 'number')
    assert.equal(s.reports[0].playing, true)
  } finally { await r.close(); s.close() }
})

test('a server that is not there is the normal case on a Pi that boots first', async () => {
  const r = new SatelliteRenderer({
    server: 'http://127.0.0.1:1', id: 'out-pi', name: 'Hallway', url: 'x', player: sleeper,
  })
  try {
    // None of these may throw: the satellite has to survive booting before the
    // server and simply catch up.
    assert.equal(await r.register(), false)
    assert.equal(await r.poll(), null)
    await r.report()
  } finally { await r.close() }
})
