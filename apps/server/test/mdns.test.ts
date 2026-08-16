import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { browse, parse, question } from '../src/mdns.ts'

/**
 * Building a response by hand, because that is the only way to prove the reader
 * handles the two things real packets are full of and hand-written parsers get
 * wrong: **compression pointers**, and a TXT record that is a list of
 * length-prefixed strings rather than a string.
 */
function name(n: string): Buffer {
  const labels = n.split('.').filter(Boolean)
  const parts = labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]))
  return Buffer.concat([...parts, Buffer.from([0])])
}

function record(nameBytes: Buffer, type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(1, 2)
  head.writeUInt32BE(120, 4)
  head.writeUInt16BE(data.length, 8)
  return Buffer.concat([nameBytes, head, data])
}

/** A pointer to an absolute offset, which is how every real responder saves space. */
const pointer = (offset: number) => Buffer.from([0xc0 | (offset >> 8), offset & 0xff])

function airplayResponse() {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(4, 6) // four answers

  // Offsets are taken from the buffer as it is built rather than worked out on
  // paper. A pointer is an absolute byte offset into the packet, so arithmetic
  // that is one byte out produces a packet that parses into plausible nonsense.
  const parts: Buffer[] = [header]
  const at = () => parts.reduce((n, b) => n + b.length, 0)

  const service = '_airplay._tcp.local'
  const serviceAt = at()
  const serviceName = name(service)

  // The PTR's data is the instance name: its own label, then a pointer at the
  // service type already in the packet. That is what every responder sends.
  const instance = 'Salon'
  const ptrData = Buffer.concat([
    Buffer.from([instance.length]), Buffer.from(instance), pointer(serviceAt),
  ])
  parts.push(record(serviceName, 12, ptrData))
  // Where that instance name landed, so the SRV and TXT can point at it.
  const fqdnAt = at() - ptrData.length

  const host = 'salon.local'
  const hostBytes = name(host)
  const port = Buffer.alloc(2)
  port.writeUInt16BE(7000, 0)
  parts.push(record(pointer(fqdnAt), 33, Buffer.concat([
    Buffer.from([0, 0, 0, 0]), port, hostBytes,
  ])))
  const hostAt = at() - hostBytes.length

  const pairs = ['deviceid=AA:BB:CC:DD:EE:FF', 'model=AppleTV3,2', 'features=0x5A7FFFF7']
  parts.push(record(pointer(fqdnAt), 16,
    Buffer.concat(pairs.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])))))

  // Even the A record's own name is a pointer, at the host inside the SRV.
  parts.push(record(pointer(hostAt), 1, Buffer.from([192, 168, 1, 42])))

  return Buffer.concat(parts)
}

test('a response is read through its compression pointers', () => {
  const found = parse(airplayResponse(), '_airplay._tcp.local')

  assert.equal(found.length, 1)
  const s = found[0]
  // Every one of these fields is behind a pointer in the packet. A reader that
  // skips them finds a service with no name, no port and no address.
  assert.equal(s.name, 'Salon')
  assert.equal(s.fqdn, 'Salon._airplay._tcp.local')
  assert.equal(s.host, 'salon.local')
  assert.equal(s.port, 7000)
  assert.equal(s.address, '192.168.1.42')
})

test('TXT is a list of pairs, not a string', () => {
  const s = parse(airplayResponse(), '_airplay._tcp.local')[0]
  // This is where AirPlay hides everything worth knowing, so reading it as one
  // string means finding a device and learning nothing about it.
  assert.equal(s.txt.deviceid, 'AA:BB:CC:DD:EE:FF')
  assert.equal(s.txt.model, 'AppleTV3,2')
  assert.equal(s.txt.features, '0x5A7FFFF7')
})

test('another service type in the same packet is not ours', () => {
  assert.deepEqual(parse(airplayResponse(), '_googlecast._tcp.local'), [])
})

test('a truncated or hostile packet returns nothing rather than throwing', () => {
  const whole = airplayResponse()
  for (const cut of [0, 5, 12, 20, 40, whole.length - 3]) {
    assert.doesNotThrow(() => parse(whole.subarray(0, cut), '_airplay._tcp.local'))
  }
  // A pointer to itself is the classic mDNS denial of service. It must
  // terminate, which is what the hop limit is for.
  const loop = Buffer.from(whole)
  loop[12] = 0xc0
  loop[13] = 12
  assert.doesNotThrow(() => parse(loop, '_airplay._tcp.local'))
})

test('the question asks for a PTR and asks to be answered directly', () => {
  const q = question('_airplay._tcp.local')
  assert.equal(q.readUInt16BE(4), 1, 'one question')
  const qtype = q.readUInt16BE(q.length - 4)
  const qclass = q.readUInt16BE(q.length - 2)
  assert.equal(qtype, 12, 'PTR: who offers this service')
  // The top bit is QU. Without it the answer goes to the multicast group on
  // port 5353 and a socket on an ephemeral port never sees it.
  assert.equal(qclass, 0x8001)
  assert.equal(question('_airplay._tcp.local', false).readUInt16BE(q.length - 2), 0x0001)
})

test('browse asks, listens, and gives up on its own', async () => {
  // A responder on loopback: the whole exchange, without needing a network or a
  // real Apple TV in the room.
  const responder = createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise<void>((r) => responder.bind(0, '127.0.0.1', () => r()))
  const port = responder.address().port

  responder.on('message', (msg, rinfo) => {
    // Only answer an actual question, which is what proves the query is
    // well-formed enough for something else to parse.
    if (msg.readUInt16BE(4) !== 1) return
    const answer = airplayResponse()
    responder.send(answer, 0, answer.length, rinfo.port, rinfo.address)
  })

  try {
    // Listening on an ephemeral port is also the fallback path on a machine
    // where mDNSResponder holds 5353 exclusively, so this exercises it.
    const found = await browse('_airplay._tcp.local',
      { timeout: 700, port, address: '127.0.0.1', bindPort: 0 })
    assert.equal(found.length, 1)
    assert.equal(found[0].name, 'Salon')
    assert.equal(found[0].port, 7000)
  } finally {
    responder.close()
  }
})

test('silence is an empty list after the timeout, not a hang', async () => {
  const quiet = createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise<void>((r) => quiet.bind(0, '127.0.0.1', () => r()))
  const port = quiet.address().port
  try {
    const started = Date.now()
    const found = await browse('_airplay._tcp.local',
      { timeout: 300, port, address: '127.0.0.1', bindPort: 0 })
    assert.deepEqual(found, [])
    assert.ok(Date.now() - started < 3000, 'it gave up rather than waiting for ever')
  } finally {
    quiet.close()
  }
})
