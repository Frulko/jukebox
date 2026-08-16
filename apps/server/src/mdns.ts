import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

/**
 * Multicast DNS, enough of it to find things.
 *
 * SSDP already finds UPnP renderers, but AirPlay and Chromecast do not speak
 * it — they announce themselves over Bonjour, which is DNS over multicast. So
 * this is the second discovery protocol, and like the first it is hand-written:
 * every mDNS package on npm either ships a native module or brings a dependency
 * tree larger than this file for a wire format that is forty lines of parsing.
 *
 * What it does *not* do is respond. This asks questions and reads answers; it
 * never announces anything, so it cannot collide with the mDNSResponder or
 * avahi already running on the machine.
 */

const MULTICAST = '224.0.0.251'
const PORT = 5353

/** One service instance, as the network described it. */
export type Service = {
  /** The instance name, human-readable: `Living Room`, not `Living%20Room._airplay._tcp.local`. */
  name: string
  /** The full instance name, which is the identity — two rooms can share a nickname. */
  fqdn: string
  type: string
  host: string
  port: number
  /** Resolved from the A record in the same packet when there is one. */
  address: string | null
  /** The TXT record, which is where every one of these protocols hides its details. */
  txt: Record<string, string>
}

/* ---------------- the wire format ---------------- */

const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 } as const

/**
 * A name, following compression pointers.
 *
 * Responses are dense with them — a packet listing four AirPlay devices repeats
 * `_airplay._tcp.local` once and points at it eleven times — so a reader that
 * skips this understands almost nothing. Returns the offset *after* the name as
 * read, which for a pointer is two bytes, not wherever the pointer led.
 */
function readName(buf: Buffer, offset: number): { name: string; offset: number } {
  const parts: string[] = []
  let at = offset
  let after = -1
  // A malformed packet can point at itself. Bounded rather than trusted.
  let hops = 0

  while (at < buf.length && hops++ < 64) {
    const len = buf[at]
    if (len === 0) { at += 1; break }

    if ((len & 0xc0) === 0xc0) {
      if (after === -1) after = at + 2
      at = ((len & 0x3f) << 8) | buf[at + 1]
      continue
    }

    parts.push(buf.subarray(at + 1, at + 1 + len).toString('utf8'))
    at += 1 + len
  }

  return { name: parts.join('.'), offset: after === -1 ? at : after }
}

function writeName(name: string): Buffer {
  const labels = name.split('.').filter(Boolean)
  const out = Buffer.alloc(name.length + 2)
  let at = 0
  for (const label of labels) {
    out[at] = label.length
    out.write(label, at + 1)
    at += 1 + label.length
  }
  out[at] = 0
  return out.subarray(0, at + 1)
}

/** A PTR query for a service type — `_airplay._tcp.local`, and who is out there. */
export function question(service: string, unicast = true): Buffer {
  const name = writeName(service)
  const buf = Buffer.alloc(12 + name.length + 4)
  // id 0: mDNS answers are matched by question, not by id.
  buf.writeUInt16BE(0, 0)
  buf.writeUInt16BE(0, 2)
  buf.writeUInt16BE(1, 4)
  name.copy(buf, 12)
  buf.writeUInt16BE(TYPE.PTR, 12 + name.length)
  // The top bit of the class is QU: "answer me directly". Without it the reply
  // goes to the multicast group on port 5353, which a socket on an ephemeral
  // port never sees.
  buf.writeUInt16BE(unicast ? 0x8001 : 0x0001, 14 + name.length)
  return buf
}

/** Every record in a response, flat. Which section it came from does not matter here. */
function records(buf: Buffer): { name: string; type: number; data: Buffer; offset: number }[] {
  if (buf.length < 12) return []
  const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)]
  let at = 12

  // Questions carry no data, but they have to be walked past.
  for (let i = 0; i < counts[0] && at < buf.length; i++) {
    at = readName(buf, at).offset + 4
  }

  const out = []
  for (let i = 0; i < counts[1] + counts[2] + counts[3] && at < buf.length; i++) {
    const { name, offset } = readName(buf, at)
    if (offset + 10 > buf.length) break
    const type = buf.readUInt16BE(offset)
    const length = buf.readUInt16BE(offset + 8)
    const start = offset + 10
    if (start + length > buf.length) break
    out.push({ name, type, data: buf.subarray(start, start + length), offset: start })
    at = start + length
  }
  return out
}

/**
 * TXT is a sequence of length-prefixed `key=value` strings, not a string.
 *
 * This is where AirPlay puts its device id and feature flags and Chromecast
 * puts its friendly name, so reading it wrong means finding a device and
 * knowing nothing useful about it.
 */
function parseTxt(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let at = 0
  while (at < data.length) {
    const len = data[at]
    if (len === 0 || at + 1 + len > data.length) break
    const entry = data.subarray(at + 1, at + 1 + len).toString('utf8')
    const eq = entry.indexOf('=')
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1)
    else if (entry) out[entry] = ''
    at += 1 + len
  }
  return out
}

/**
 * Everything a response says about one service type.
 *
 * A well-behaved responder answers a PTR question with the SRV, TXT and A
 * records too — the whole point of the format — so one packet is usually one
 * complete answer. Packets that leave something out simply produce fewer
 * fields rather than nothing.
 */
export function parse(buf: Buffer, service: string): Service[] {
  const all = records(buf)
  const addresses = new Map<string, string>()
  const srv = new Map<string, { host: string; port: number }>()
  const txt = new Map<string, Record<string, string>>()

  for (const r of all) {
    if (r.type === TYPE.A && r.data.length === 4) {
      addresses.set(r.name, [...r.data].join('.'))
    } else if (r.type === TYPE.SRV && r.data.length >= 7) {
      srv.set(r.name, {
        port: r.data.readUInt16BE(4),
        // The target is a name in the packet, so it can be a compression
        // pointer like any other and has to be read from the whole buffer.
        host: readName(buf, r.offset + 6).name,
      })
    } else if (r.type === TYPE.TXT) {
      txt.set(r.name, parseTxt(r.data))
    }
  }

  const out: Service[] = []
  for (const r of all) {
    if (r.type !== TYPE.PTR || r.name !== service) continue
    const fqdn = readName(buf, r.offset).name
    const s = srv.get(fqdn)
    if (!s) continue

    out.push({
      fqdn,
      // The instance label, with the service type stripped back off.
      name: fqdn.slice(0, Math.max(0, fqdn.length - service.length - 1)) || fqdn,
      type: service,
      host: s.host,
      port: s.port,
      address: addresses.get(s.host) ?? null,
      txt: txt.get(fqdn) ?? {},
    })
  }
  return out
}

/* ---------------- asking ---------------- */

export type BrowseOptions = {
  /** How long to listen. Devices answer in tens of milliseconds; sleeping ones do not. */
  timeout?: number
  /** Where to ask. Overridden by the tests, which run the whole thing on loopback. */
  port?: number
  address?: string
  /**
   * Which port to listen on, when it should not be the one being asked.
   *
   * On a real network these are both 5353 — that is what makes multicast
   * replies arrive. A test talking to a responder on loopback needs them apart,
   * or the two sockets fight over the same port and the answer lands in
   * whichever won.
   */
  bindPort?: number
}

/**
 * Asks who offers a service, and collects the answers.
 *
 * Binding to 5353 is what lets multicast replies arrive, and the reuse flag is
 * what makes that possible at all while the system responder holds the port.
 * When it cannot be had — a locked-down host, another process without the flag
 * — this falls back to an ephemeral port and relies on the unicast-response
 * bit, which most devices honour and some ignore. Discovering fewer devices
 * beats throwing on a machine where the port is taken.
 */
export async function browse(service: string, opts: BrowseOptions = {}): Promise<Service[]> {
  const timeout = opts.timeout ?? 1500
  const port = opts.port ?? PORT
  const group = opts.address ?? MULTICAST

  const found = new Map<string, Service>()

  const socket = await bind(opts.bindPort ?? port)
  const listening = socket.address().port

  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closing */ }
      resolve([...found.values()])
    }

    socket.on('message', (msg) => {
      try {
        for (const s of parse(msg, service)) {
          // Keyed on the full instance name: two speakers called "Kitchen" in
          // one house is a real thing, and dropping one of them silently is
          // worse than showing both.
          const previous = found.get(s.fqdn)
          // Later packets can fill in an address the first one lacked.
          found.set(s.fqdn, previous && !s.address ? previous : s)
        }
      } catch {
        // A malformed packet from something else on the network is not this
        // discovery's problem.
      }
    })
    socket.on('error', finish)

    const timer = setTimeout(finish, timeout)
    timer.unref?.()

    const q = question(service, listening !== PORT)
    socket.send(q, 0, q.length, port, group, (err) => {
      if (err) finish()
    })
  })
}

function bind(port: number): Promise<Socket> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    socket.once('error', () => {
      // The port is held by something that did not share it. An ephemeral one
      // still works for unicast answers.
      socket.removeAllListeners('listening')
      const fallback = createSocket({ type: 'udp4', reuseAddr: true })
      fallback.bind(0, () => resolve(fallback))
    })
    socket.bind(port, () => {
      try {
        socket.addMembership(MULTICAST)
      } catch {
        // No route to the multicast group — a container without host
        // networking, usually. Unicast answers still arrive.
      }
      resolve(socket)
    })
  })
}

/** Whether this machine is on a network where any of this can work at all. */
export function hasNetwork(): boolean {
  return Object.values(networkInterfaces())
    .flat()
    .some((i) => i && !i.internal && i.family === 'IPv4')
}
