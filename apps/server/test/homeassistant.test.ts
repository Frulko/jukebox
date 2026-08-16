import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
// Imported through a computed URL because a plugin is plain JavaScript with no
// declaration file — it is loaded by the host at runtime, not compiled with the
// server. A static import would be a type error for a module that is not meant
// to have types.
const plugin: any = await import(new URL('../../../plugins/homeassistant/index.mjs', import.meta.url).href)
const mqtt: any = await import(new URL('../../../plugins/homeassistant/mqtt.mjs', import.meta.url).href)

const { activate } = plugin
const { connectPacket, matches, publishPacket, Reader } = mqtt

/**
 * The Home Assistant plugin, against a broker that is real enough.
 *
 * A fake broker over TCP rather than a mocked client: the framing, the packet
 * encoding and the reconnect are the parts that break, and a mock would test
 * none of them.
 */

test('a packet survives the round trip, at every length', () => {
  const reader = new Reader()
  // 127 to 128 is where the variable-length integer grows a second byte, which
  // is where a naive single-byte implementation starts writing garbage.
  for (const size of [0, 1, 126, 127, 128, 129, 16383, 16384]) {
    const out = reader.push(publishPacket('a/b', 'x'.repeat(size)))
    assert.equal(out.length, 1, `at ${size}`)
    assert.equal(out[0].payload.length, size, `at ${size}`)
    assert.equal(out[0].topic, 'a/b')
  }
})

test('TCP delivering half a packet is still one packet', () => {
  const whole = publishPacket('jukebox/x/state', 'playing', { retain: true })
  for (let cut = 1; cut < whole.length; cut++) {
    const reader = new Reader()
    const found = [...reader.push(whole.subarray(0, cut)), ...reader.push(whole.subarray(cut))]
    assert.equal(found.length, 1, `split at ${cut}`)
    assert.equal(found[0].payload, 'playing')
    assert.equal(found[0].retain, true)
  }
})

test('a retained backlog arriving in one chunk is every message', () => {
  const reader = new Reader()
  const found = reader.push(Buffer.concat([
    publishPacket('a', '1'), publishPacket('b', '2'), publishPacket('c', '3'),
  ]))
  assert.deepEqual(found.map((p: any) => p.payload), ['1', '2', '3'])
})

test('wildcards are level-aware, or one device receives another one commands', () => {
  assert.equal(matches('jukebox/+/command', 'jukebox/kitchen/command'), true)
  assert.equal(matches('jukebox/#', 'jukebox/kitchen/command'), true)
  assert.equal(matches('jukebox/kitchen/command', 'jukebox/kitchen/command'), true)

  // A plain string prefix would match this, and the kitchen would start
  // obeying the living room.
  assert.equal(matches('jukebox/kitchen', 'jukebox/kitchener/command'), false)
  assert.equal(matches('jukebox/+/command', 'jukebox/a/b/command'), false)
  assert.equal(matches('jukebox/+', 'jukebox'), false)
})

test('the CONNECT packet says MQTT 3.1.1 and carries the will', () => {
  const buf = connectPacket({ clientId: 'x', username: 'u', password: 'p',
    will: { topic: 'a/availability', payload: 'offline' } })
  assert.equal(buf[0] >> 4, 1, 'CONNECT')
  assert.equal(buf.subarray(4, 8).toString(), 'MQTT')
  assert.equal(buf[8], 4, 'protocol level 4 is 3.1.1')

  const flags = buf[9]
  assert.ok(flags & 0x80, 'username')
  assert.ok(flags & 0x40, 'password')
  assert.ok(flags & 0x04, 'will')
  // Retained: a dashboard opened after the server died must still see it as
  // offline rather than as whatever it was last doing.
  assert.ok(flags & 0x20, 'will retained')
})

/* ---- against a broker ---- */

async function fakeBroker() {
  const published: { topic: string; payload: string; retain: boolean }[] = []
  const subscribed: string[] = []
  let client: Socket | null = null

  const server: Server = createServer((socket) => {
    client = socket
    const reader = new Reader()
    socket.on('data', (chunk) => {
      for (const p of reader.push(chunk) as any[]) {
        if (p.type === 1) {
          // CONNACK: session present 0, return code 0.
          socket.write(Buffer.from([0x20, 2, 0, 0]))
        } else if (p.type === 3) {
          published.push({ topic: p.topic, payload: p.payload, retain: p.retain })
        } else if (p.type === 8) {
          // The topic filter follows the two-byte packet id.
          const len = p.body.readUInt16BE(2)
          subscribed.push(p.body.subarray(4, 4 + len).toString())
          socket.write(Buffer.from([0x90, 3, p.body[0], p.body[1], 0]))
        } else if (p.type === 12) {
          socket.write(Buffer.from([0xd0, 0]))
        }
      }
    })
    socket.on('error', () => { /* the test tearing down */ })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port

  return {
    published, subscribed,
    url: `mqtt://127.0.0.1:${port}`,
    /** Sends a command as Home Assistant would. */
    send: (topic: string, payload: string) => client?.write(publishPacket(topic, payload)),
    close: () => { client?.destroy(); server.close() },
  }
}

/** A host with just enough of the real one, and a player that records calls. */
function fakeHost(url: string) {
  const calls: string[] = []
  let state: any = { trackId: null, playing: false, position: 0, queue: [], index: -1, repeat: 'off', shuffle: false, revision: 1 }
  const listeners: ((s: any) => void)[] = []

  return {
    calls,
    emit: (next: any) => { state = next; listeners.forEach((l) => l(next)) },
    host: {
      apiVersion: '1.1.0',
      pluginId: 'homeassistant',
      log: () => {},
      config: { url, id: 'test', name: 'Test Jukebox' },
      setConfig: () => {},
      on: (_event: string, handler: (s: any) => void) => { listeners.push(handler); return () => {} },
      player: {
        state: () => state,
        play: () => { calls.push('play'); state = { ...state, playing: true }; return state },
        pause: () => { calls.push('pause'); state = { ...state, playing: false }; return state },
        next: () => { calls.push('next'); return state },
        previous: () => { calls.push('previous'); return state },
        seek: () => state,
        enqueue: () => state,
        set: (patch: any) => { calls.push(`set:${JSON.stringify(patch)}`); state = { ...state, ...patch }; return state },
      },
    },
  }
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))

test('the entity configures itself, retained, and says it is online', async () => {
  const broker = await fakeBroker()
  const { host } = fakeHost(broker.url)
  const stop = activate(host as any)
  try {
    await settle()

    const config = broker.published.find((p) => p.topic === 'homeassistant/media_player/test/config')
    assert.ok(config, 'discovery published')
    // Retained is what makes the entity survive a restart of either side: Home
    // Assistant asks the broker for these when it starts.
    assert.equal(config!.retain, true)

    const doc = JSON.parse(config!.payload)
    assert.equal(doc.name, 'Test Jukebox')
    assert.equal(doc.unique_id, 'jukebox_test')
    assert.equal(doc.state_topic, 'jukebox/test/state')
    assert.equal(doc.command_topic, 'jukebox/test/command')
    assert.equal(doc.availability_topic, 'jukebox/test/availability')
    assert.equal(doc.device.identifiers[0], 'jukebox_test')

    assert.ok(broker.published.some((p) => p.topic === 'jukebox/test/availability' && p.payload === 'online'))
    assert.ok(broker.subscribed.includes('jukebox/test/command'))
  } finally { stop?.(); broker.close() }
})

test('a queue with nothing in it is off, not idle-looking-like-paused', async () => {
  const broker = await fakeBroker()
  const fake = fakeHost(broker.url)
  const stop = activate(fake.host as any)
  try {
    await settle()
    const stateOf = () => broker.published.filter((p) => p.topic === 'jukebox/test/state').at(-1)?.payload

    assert.equal(stateOf(), 'off', 'nothing queued')

    fake.emit({ trackId: 't1', playing: true, position: 3, queue: ['t1', 't2'], index: 0, repeat: 'off', shuffle: false, revision: 2 })
    await settle(30)
    assert.equal(stateOf(), 'playing')

    fake.emit({ trackId: 't1', playing: false, position: 9, queue: ['t1', 't2'], index: 0, repeat: 'off', shuffle: false, revision: 3 })
    await settle(30)
    // Paused is not off: an automation asking "is music playing" must be able
    // to tell a paused player from an empty one.
    assert.equal(stateOf(), 'paused')

    const attrs = JSON.parse(broker.published.filter((p) => p.topic === 'jukebox/test/attributes').at(-1)!.payload)
    assert.equal(attrs.queue_length, 2)
    assert.equal(attrs.position, 9)
    assert.equal(attrs.track_id, 't1')
  } finally { stop?.(); broker.close() }
})

test('Home Assistant commands reach the shared queue', async () => {
  const broker = await fakeBroker()
  const fake = fakeHost(broker.url)
  const stop = activate(fake.host as any)
  try {
    await settle()

    for (const [payload, expected] of [
      ['play', 'play'], ['pause', 'pause'], ['next_track', 'next'], ['previous_track', 'previous'],
    ] as const) {
      broker.send('jukebox/test/command', payload)
      await settle(40)
      assert.equal(fake.calls.at(-1), expected, payload)
    }

    // play_pause is what a dashboard card sends, and it has to look at the
    // current state rather than assume one.
    broker.send('jukebox/test/command', 'play_pause')
    await settle(40)
    assert.equal(fake.calls.at(-1), 'play', 'it was paused, so play')

    broker.send('jukebox/test/command', 'shuffle_on')
    await settle(40)
    assert.match(fake.calls.at(-1)!, /set:.*shuffle.*true/)
  } finally { stop?.(); broker.close() }
})

test('an unknown command is ignored rather than throwing into the socket', async () => {
  const broker = await fakeBroker()
  const fake = fakeHost(broker.url)
  const stop = activate(fake.host as any)
  try {
    await settle()
    const before = fake.calls.length
    broker.send('jukebox/test/command', 'self_destruct')
    await settle(40)
    assert.equal(fake.calls.length, before)

    // And the connection still works afterwards.
    broker.send('jukebox/test/command', 'play')
    await settle(40)
    assert.equal(fake.calls.at(-1), 'play')
  } finally { stop?.(); broker.close() }
})

test('stopping the plugin says goodbye rather than going quiet', async () => {
  const broker = await fakeBroker()
  const { host } = fakeHost(broker.url)
  const stop = activate(host as any)
  await settle()
  try {
    stop?.()
    await settle(40)
    const last = broker.published.filter((p) => p.topic === 'jukebox/test/availability').at(-1)
    // Without this the dashboard keeps showing the last state until the broker
    // notices the socket is gone, which can be a keepalive interval away.
    assert.equal(last?.payload, 'offline')
    assert.equal(last?.retain, true)
  } finally { broker.close() }
})

test('with no broker configured it does nothing at all', () => {
  const { host } = fakeHost('')
  host.config = { id: 'test', name: 'Test' } as any
  // Not an error and not a connection attempt to a default that is probably
  // wrong: a plugin installed but not configured should be inert.
  assert.doesNotThrow(() => activate(host as any))
})
