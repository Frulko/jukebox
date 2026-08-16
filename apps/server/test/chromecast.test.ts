import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import { connect } from 'node:net'
import { decode, encode, Framer, NS } from '../src/castv2.ts'
import { CastSession, toDevice } from '../src/chromecast.ts'

test('a message survives the round trip', () => {
  const m = {
    source: 'client-1', destination: 'receiver-0',
    namespace: NS.receiver, data: JSON.stringify({ type: 'LAUNCH', appId: 'CC1AD845', requestId: 7 }),
  }
  const wire = encode(m)
  // The four-byte prefix is the framing; the rest is the message itself.
  assert.equal(wire.readUInt32BE(0), wire.length - 4)
  assert.deepEqual(decode(wire.subarray(4)), m)
})

test('a payload past 127 bytes still round-trips', () => {
  // The length is a varint, so 127 to 128 is where a naive single-byte
  // implementation starts writing garbage.
  for (const size of [126, 127, 128, 129, 300, 5000]) {
    const data = JSON.stringify({ type: 'LOAD', title: 'x'.repeat(size) })
    const back = decode(encode({ source: 'a', destination: 'b', namespace: NS.media, data }).subarray(4))
    assert.equal(back.data, data, `at ${size} bytes`)
  }
})

test('TCP delivering half a message is still one message', () => {
  const whole = encode({ source: 'a', destination: 'b', namespace: NS.media, data: '{"type":"PING"}' })

  // Every split point, including inside the four-byte length prefix. This is
  // the bug that works perfectly on a desk and appears the first time a status
  // payload gets long.
  for (let cut = 1; cut < whole.length; cut++) {
    const framer = new Framer()
    const first = framer.push(whole.subarray(0, cut))
    const second = framer.push(whole.subarray(cut))
    assert.equal(first.length + second.length, 1, `split at ${cut}`)
    assert.equal([...first, ...second][0].data, '{"type":"PING"}')
  }
})

test('two messages in one chunk are two messages', () => {
  const a = encode({ source: 'a', destination: 'b', namespace: NS.media, data: '{"n":1}' })
  const b = encode({ source: 'a', destination: 'b', namespace: NS.media, data: '{"n":2}' })
  const out = new Framer().push(Buffer.concat([a, b]))
  assert.deepEqual(out.map((m) => m.data), ['{"n":1}', '{"n":2}'])
})

/**
 * A fake cast device over a plain socket.
 *
 * The transport is injected rather than mocked out: this runs the real framing,
 * the real protobuf and the real request/response matching, over TCP instead of
 * TLS. The only thing not exercised is the certificate that cannot be verified
 * anyway.
 */
async function fakeCastDevice() {
  const received: { namespace: string; data: any; destination: string }[] = []
  let sessionCounter = 0

  const sockets: Socket[] = []
  const server: Server = createServer((socket: Socket) => {
    sockets.push(socket)
    const framer = new Framer()
    const reply = (namespace: string, payload: unknown, destination: string) =>
      socket.write(encode({
        source: destination === 'receiver-0' ? 'receiver-0' : 'transport-1',
        destination: 'client', namespace, data: JSON.stringify(payload),
      }))

    socket.on('data', (chunk) => {
      for (const m of framer.push(chunk)) {
        const data = JSON.parse(m.data || '{}')
        received.push({ namespace: m.namespace, data, destination: m.destination })

        if (m.namespace === NS.receiver && data.type === 'LAUNCH') {
          reply(NS.receiver, {
            requestId: data.requestId,
            type: 'RECEIVER_STATUS',
            status: { applications: [{ appId: data.appId, transportId: 'transport-1', sessionId: 's1' }] },
          }, m.destination)
        } else if (m.namespace === NS.media && data.type === 'LOAD') {
          reply(NS.media, {
            requestId: data.requestId,
            type: 'MEDIA_STATUS',
            status: [{ mediaSessionId: ++sessionCounter, playerState: 'PLAYING' }],
          }, m.destination)
        } else if (m.namespace === NS.media && data.requestId) {
          reply(NS.media, {
            requestId: data.requestId, type: 'MEDIA_STATUS',
            status: [{ mediaSessionId: data.mediaSessionId, playerState: data.type === 'PAUSE' ? 'PAUSED' : 'PLAYING' }],
          }, m.destination)
        } else if (m.namespace === NS.receiver && data.requestId) {
          reply(NS.receiver, { requestId: data.requestId, type: 'RECEIVER_STATUS', status: {} }, m.destination)
        }
      }
    })
    socket.on('error', () => { /* the test closing underneath it */ })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port

  return {
    received,
    options: {
      host: '127.0.0.1',
      port,
      connect: (host: string, p: number) => new Promise<Socket>((resolve) => {
        const s = connect(p, host, () => resolve(s))
      }),
    },
    // Sockets destroyed as well as the server closed: `server.close()` stops
    // it accepting and leaves open connections alone, which keeps handles --
    // and this file's event loop -- alive after the test that made them.
    close: () => { for (const s of sockets) s.destroy(); server.close() },
  }
}

test('a track is loaded in the order the protocol requires', async () => {
  const device = await fakeCastDevice()
  const session = new CastSession(device.options)
  try {
    await session.open()
    await session.load({
      url: 'http://jukebox.local:8787/api/v1/stream/t1',
      contentType: 'audio/flac',
      title: 'Dreams', artist: 'Fleetwood Mac', album: 'Rumours', duration: 257,
    })

    const order = device.received.map((r) => `${r.data.type}@${r.destination}`)
    // CONNECT to the device, LAUNCH the receiver app, CONNECT again to the app
    // at the transport id it reported, then LOAD. Skipping the second connect
    // is the mistake that fails silently: the LOAD is simply dropped.
    assert.deepEqual(order.filter((o) => !o.startsWith('PING')), [
      'CONNECT@receiver-0',
      'LAUNCH@receiver-0',
      'CONNECT@transport-1',
      'LOAD@transport-1',
    ])

    const load = device.received.find((r) => r.data.type === 'LOAD')!.data
    assert.equal(load.media.contentId, 'http://jukebox.local:8787/api/v1/stream/t1')
    assert.equal(load.media.streamType, 'BUFFERED')
    // metadataType 3 is a music track: without it a Chromecast shows a filename
    // where the artist should be.
    assert.equal(load.media.metadata.metadataType, 3)
    assert.equal(load.media.metadata.artist, 'Fleetwood Mac')
    assert.equal(load.media.duration, 257)

    assert.equal(session.mediaSessionId, 1)
  } finally { session.close(); device.close() }
})

test('every command afterwards quotes the media session', async () => {
  const device = await fakeCastDevice()
  const session = new CastSession(device.options)
  try {
    await session.open()
    await session.load({ url: 'http://x/1', contentType: 'audio/mpeg' })
    await session.pause()
    await session.resume()
    await session.seek(42)

    for (const type of ['PAUSE', 'PLAY', 'SEEK']) {
      const sent = device.received.find((r) => r.data.type === type)!
      // A command without it is accepted and ignored, which is indistinguishable
      // from a broken speaker.
      assert.equal(sent.data.mediaSessionId, 1, type)
      assert.equal(sent.destination, 'transport-1', type)
    }
    assert.equal(device.received.find((r) => r.data.type === 'SEEK')!.data.currentTime, 42)
  } finally { session.close(); device.close() }
})

test('commanding before anything is loaded says so rather than doing nothing', async () => {
  const device = await fakeCastDevice()
  const session = new CastSession(device.options)
  try {
    await session.open()
    // It has to *reject*, not throw synchronously: a caller writing
    // `.catch()` around an async API would otherwise never see it.
    await assert.rejects(() => session.pause(), /nothing is loaded/)
    await assert.rejects(() => session.seek(10), /nothing is loaded/)
  } finally { session.close(); device.close() }
})

test('volume is a receiver command, not a media one', async () => {
  const device = await fakeCastDevice()
  const session = new CastSession(device.options)
  try {
    await session.open()
    await session.setVolume(40)
    const sent = device.received.find((r) => r.data.type === 'SET_VOLUME')!
    // Percent here, 0 to 1 on the wire, and on the device rather than on
    // whatever it happens to be playing.
    assert.equal(sent.data.volume.level, 0.4)
    assert.equal(sent.destination, 'receiver-0')
  } finally { session.close(); device.close() }
})

test('a PING is answered, or the device hangs up ten seconds later', async () => {
  const device = await fakeCastDevice()
  const session = new CastSession(device.options)
  try {
    await session.open()
    // The device pings; nothing above this layer should have to care.
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(device.received.some((r) => r.namespace === NS.connection))
  } finally { session.close(); device.close() }
})

test('the TXT is what names a device, not the escaped instance label', () => {
  const service = {
    name: 'Salon\\032TV', fqdn: 'abc._googlecast._tcp.local', type: SERVICE_TYPE,
    host: 'abc.local', port: 8009, address: '192.168.1.30',
    txt: { id: 'e5f6', fn: 'Salon TV', md: 'Chromecast Ultra' },
  }
  const d = toDevice(service)!
  assert.equal(d.name, 'Salon TV')
  // The uuid, so renaming the device in the Google app does not create a
  // second output next to the first.
  assert.equal(d.id, 'cast:e5f6')
  assert.equal(d.model, 'Chromecast Ultra')
  assert.equal(toDevice({ ...service, address: null }), null)
})

const SERVICE_TYPE = '_googlecast._tcp.local'

test('a device dropping off the network does not take the server with it', async () => {
  // The failure this file found by being flaky. CastChannel is an EventEmitter,
  // and an EventEmitter that emits `error` with nobody listening *throws* --
  // asynchronously, so it surfaces as an uncaught exception rather than
  // something a caller could catch. A speaker losing wifi would have crashed
  // the process.
  const device = await fakeCastDevice()
  const session = new CastSession(device.options)
  try {
    await session.open()
    await session.load({ url: 'http://x/1', contentType: 'audio/mpeg' })

    const uncaught: Error[] = []
    const onUncaught = (err: Error) => uncaught.push(err)
    process.on('uncaughtException', onUncaught)

    // The speaker vanishes mid-song, the rude way: a reset, not a goodbye.
    device.close()
    await new Promise((r) => setTimeout(r, 120))
    process.off('uncaughtException', onUncaught)

    assert.deepEqual(uncaught.map((e) => e.message), [])

    // And the next command is a rejection rather than a crash.
    await assert.rejects(() => session.pause())
  } finally { session.close(); device.close() }
})
