import { connect as tlsConnect } from 'node:tls'
import type { Duplex } from 'node:stream'
import { EventEmitter } from 'node:events'

/**
 * The Chromecast wire protocol, by hand.
 *
 * A cast device speaks protobuf over TLS. That sounds like a reason to take a
 * dependency until you look at the message: **seven fields**, five of them
 * strings, and the only protobuf features involved are varints and
 * length-delimited bytes. The generated-code toolchain for that is larger than
 * the protocol.
 *
 *     message CastMessage {
 *       protocol_version = 1;  source_id       = 2;  destination_id = 3;
 *       namespace        = 4;  payload_type    = 5;  payload_utf8   = 6;
 *       payload_binary   = 7;
 *     }
 *
 * Each message is framed by a four-byte big-endian length. TLS hands over a
 * stream, not messages, so the framing is the part that has to be right: a
 * reader that assumes one chunk is one message works perfectly on a desk and
 * falls apart on the first song whose metadata pushes the status past the MTU.
 *
 * The certificate is self-signed by the device and cannot be verified — there
 * is no CA for a Chromecast on a shelf — so verification is off, deliberately
 * and only here. The connection carries playback commands on a home network,
 * not credentials.
 */

export const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
} as const

export type CastMessage = {
  source: string
  destination: string
  namespace: string
  /** Always a JSON string in practice; the binary form exists and is unused. */
  data: string
}

/* ---------------- protobuf, the two rules of it ---------------- */

function varint(n: number): Buffer {
  const bytes: number[] = []
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  bytes.push(n)
  return Buffer.from(bytes)
}

function readVarint(buf: Buffer, at: number): { value: number; offset: number } {
  let value = 0
  let shift = 0
  while (at < buf.length) {
    const byte = buf[at++]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
    // Beyond this a number stops being exact in JavaScript. Nothing in this
    // protocol is that large, so it is a malformed message rather than a big one.
    if (shift > 35) break
  }
  return { value: value >>> 0, offset: at }
}

const field = (num: number, wire: number) => varint((num << 3) | wire)

function stringField(num: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([field(num, 2), varint(bytes.length), bytes])
}

export function encode(m: CastMessage): Buffer {
  const body = Buffer.concat([
    // protocol_version 0 is CASTV2_1_0, the only one anything speaks.
    Buffer.concat([field(1, 0), varint(0)]),
    stringField(2, m.source),
    stringField(3, m.destination),
    stringField(4, m.namespace),
    // payload_type 0 is STRING. The binary form exists for app payloads that
    // nothing in this project sends.
    Buffer.concat([field(5, 0), varint(0)]),
    stringField(6, m.data),
  ])

  const framed = Buffer.alloc(4)
  framed.writeUInt32BE(body.length, 0)
  return Buffer.concat([framed, body])
}

export function decode(body: Buffer): CastMessage {
  const out: CastMessage = { source: '', destination: '', namespace: '', data: '' }
  let at = 0

  while (at < body.length) {
    const tag = readVarint(body, at)
    at = tag.offset
    const num = tag.value >>> 3
    const wire = tag.value & 7

    if (wire === 0) {
      at = readVarint(body, at).offset
      continue
    }
    if (wire !== 2) {
      // No other wire type appears in this message. Skipping rather than
      // throwing keeps a device that adds a field from breaking playback.
      break
    }

    const len = readVarint(body, at)
    const start = len.offset
    const end = start + len.value
    if (end > body.length) break
    const value = body.subarray(start, end).toString('utf8')
    at = end

    if (num === 2) out.source = value
    else if (num === 3) out.destination = value
    else if (num === 4) out.namespace = value
    else if (num === 6) out.data = value
  }

  return out
}

/**
 * Splits a stream back into messages.
 *
 * Held as a class because the leftover between chunks *is* the state: TCP is
 * free to deliver half a length prefix, and a decoder that forgets that is one
 * that works until the day a payload gets long.
 */
export class Framer {
  #buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): CastMessage[] {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk)
    const out: CastMessage[] = []

    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0)
      if (this.#buffer.length < 4 + length) break
      out.push(decode(this.#buffer.subarray(4, 4 + length)))
      this.#buffer = this.#buffer.subarray(4 + length)
    }
    return out
  }
}

/* ---------------- the channel ---------------- */

export type ChannelOptions = {
  host: string
  port?: number
  /** Overridden by the tests, which run the same protocol over a plain socket. */
  connect?: (host: string, port: number) => Duplex | Promise<Duplex>
}

/**
 * One connection to one device.
 *
 * Emits `message` for everything that arrives and answers heartbeats itself,
 * because a device that stops hearing PING closes the connection after about
 * ten seconds — which looks exactly like a network fault and is not one.
 */
export class CastChannel extends EventEmitter {
  #socket: Duplex | null = null
  #framer = new Framer()
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #source = `client-${Math.floor(Math.random() * 100000)}`
  #opts: ChannelOptions

  constructor(opts: ChannelOptions) {
    super()
    this.#opts = opts
  }

  get source(): string {
    return this.#source
  }

  async open(): Promise<void> {
    const port = this.#opts.port ?? 8009
    const socket = await (this.#opts.connect
      ? this.#opts.connect(this.#opts.host, port)
      : new Promise<Duplex>((resolve, reject) => {
        // Self-signed by the device, with no CA that could vouch for it.
        const s = tlsConnect({ host: this.#opts.host, port, rejectUnauthorized: false }, () => resolve(s))
        s.once('error', reject)
      }))

    this.#socket = socket
    socket.on('data', (chunk: Buffer) => {
      for (const m of this.#framer.push(chunk)) {
        // Answered here rather than surfaced: nothing above this cares, and
        // forgetting to reply costs the connection.
        if (m.namespace === NS.heartbeat && m.data.includes('"PING"')) {
          this.send(NS.heartbeat, { type: 'PONG' }, m.source)
        }
        this.emit('message', m)
      }
    })
    socket.on('error', (err: Error) => this.emit('error', err))
    socket.on('close', () => this.emit('close'))

    // The virtual connection, which is separate from the TCP one: a device
    // ignores everything sent before it.
    this.send(NS.connection, { type: 'CONNECT' })

    this.#heartbeat = setInterval(() => this.send(NS.heartbeat, { type: 'PING' }), 5000)
    this.#heartbeat.unref?.()
  }

  send(namespace: string, payload: unknown, destination = 'receiver-0'): void {
    if (!this.#socket) throw new Error('not connected')
    this.#socket.write(encode({
      source: this.#source,
      destination,
      namespace,
      data: JSON.stringify(payload),
    }))
  }

  /** Sends something with a request id and waits for the answer carrying it back. */
  request(namespace: string, payload: Record<string, unknown>, destination = 'receiver-0', timeout = 10_000): Promise<any> {
    const requestId = Math.floor(Math.random() * 1e9)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', onMessage)
        reject(new Error(`${namespace} timed out`))
      }, timeout)
      timer.unref?.()

      const onMessage = (m: CastMessage) => {
        let data: any
        try { data = JSON.parse(m.data) } catch { return }
        // Matched on the id rather than on order: status messages arrive
        // unprompted, and a reply is only ours if it says so.
        if (data?.requestId !== requestId) return
        clearTimeout(timer)
        this.off('message', onMessage)
        resolve(data)
      }

      this.on('message', onMessage)
      this.send(namespace, { ...payload, requestId }, destination)
    })
  }

  close(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
    try {
      if (this.#socket) {
        this.send(NS.connection, { type: 'CLOSE' })
        this.#socket.end()
      }
    } catch {
      // Already gone, which is the same outcome.
    }
    this.#socket = null
  }
}
