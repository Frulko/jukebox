import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/**
 * MQTT 3.1.1, the part of it a home automation integration uses.
 *
 * Written out rather than depended on, and this is the third protocol in this
 * project to make that call, so the reasoning is worth stating once properly:
 * MQTT's packet format is a one-byte type, a variable-length integer, and
 * length-prefixed strings. Publishing at QoS 0 and subscribing is about two
 * hundred lines. The popular client is a hundred times that, because it also
 * does QoS 2, session resumption, websockets and a browser build — none of
 * which a plugin publishing "playing / paused" needs.
 *
 * What is *not* skipped: reconnection, and the keepalive. A broker drops a
 * client that stops pinging, and a home integration that silently stops after
 * an hour is worse than one that was never installed.
 */

const CONNECT = 1
const CONNACK = 2
const PUBLISH = 3
const SUBSCRIBE = 8
const SUBACK = 9
const PINGREQ = 12
const PINGRESP = 13
const DISCONNECT = 14

/** The variable-length integer that follows every fixed header. */
function encodeLength(n) {
  const out = []
  do {
    let byte = n % 128
    n = Math.floor(n / 128)
    if (n > 0) byte |= 128
    out.push(byte)
  } while (n > 0)
  return Buffer.from(out)
}

function decodeLength(buf, at) {
  let value = 0
  let multiplier = 1
  let bytes = 0
  while (at + bytes < buf.length) {
    const byte = buf[at + bytes]
    value += (byte & 127) * multiplier
    bytes++
    if ((byte & 128) === 0) return { value, bytes }
    multiplier *= 128
    // Four bytes is the format's own limit; past it the packet is malformed.
    if (bytes > 4) return null
  }
  return null
}

/** Every string on the wire is two bytes of length then the bytes. */
function encodeString(s) {
  const bytes = Buffer.from(s, 'utf8')
  const head = Buffer.alloc(2)
  head.writeUInt16BE(bytes.length, 0)
  return Buffer.concat([head, bytes])
}

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body])
}

export function connectPacket({ clientId, username, password, keepalive = 60, will }) {
  let flags = 0x02 // clean session
  const parts = [encodeString('MQTT'), Buffer.from([4])]

  const tail = []
  if (will) {
    flags |= 0x04
    // Retained, so a dashboard opened after the server died still shows it as
    // offline rather than as whatever it last was.
    flags |= 0x20
    tail.push(encodeString(will.topic), encodeString(will.payload))
  }
  if (username) { flags |= 0x80; tail.push(encodeString(username)) }
  if (password) { flags |= 0x40; tail.push(encodeString(password)) }

  const head = Buffer.alloc(3)
  head.writeUInt8(flags, 0)
  head.writeUInt16BE(keepalive, 1)

  return packet(CONNECT, 0, Buffer.concat([...parts, head, encodeString(clientId), ...tail]))
}

export function publishPacket(topic, payload, { retain = false } = {}) {
  return packet(PUBLISH, retain ? 1 : 0,
    Buffer.concat([encodeString(topic), Buffer.from(String(payload), 'utf8')]))
}

export function subscribePacket(topics, id = 1) {
  const head = Buffer.alloc(2)
  head.writeUInt16BE(id, 0)
  return packet(SUBSCRIBE, 2, Buffer.concat([
    head,
    ...topics.flatMap((t) => [encodeString(t), Buffer.from([0])]),
  ]))
}

/**
 * Splits the stream back into packets.
 *
 * Same reason as every other framer here: TCP delivers bytes, not messages, and
 * a broker sending a retained backlog delivers a dozen publishes in one chunk.
 */
export class Reader {
  #buffer = Buffer.alloc(0)

  push(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk)
    const out = []

    while (this.#buffer.length >= 2) {
      const length = decodeLength(this.#buffer, 1)
      if (!length) break
      const total = 1 + length.bytes + length.value
      if (this.#buffer.length < total) break

      const type = this.#buffer[0] >> 4
      const flags = this.#buffer[0] & 0x0f
      const body = this.#buffer.subarray(1 + length.bytes, total)
      this.#buffer = this.#buffer.subarray(total)

      if (type === PUBLISH) {
        const topicLength = body.readUInt16BE(0)
        out.push({
          type,
          topic: body.subarray(2, 2 + topicLength).toString('utf8'),
          // QoS 0 only, so there is no packet id between the topic and the
          // payload. Subscribing at a higher QoS would put one there.
          payload: body.subarray(2 + topicLength).toString('utf8'),
          retain: Boolean(flags & 1),
        })
      } else {
        out.push({ type, body })
      }
    }
    return out
  }
}

/**
 * A connection that comes back.
 *
 * The reconnect loop is the reason this is a class. A broker restarts, a wifi
 * drops, a container is redeployed; every one of those is normal, and the
 * integration has to survive all of them without anyone noticing.
 */
export class MqttClient {
  #opts
  #socket = null
  #reader = new Reader()
  #ping = null
  #retry = null
  #closed = false
  #handlers = new Map()
  #subscriptions = new Set()
  #onConnect = null

  constructor(opts) {
    this.#opts = { keepalive: 60, ...opts }
  }

  get connected() {
    return Boolean(this.#socket && !this.#socket.destroyed)
  }

  onConnect(fn) { this.#onConnect = fn }

  /** Handlers are per topic filter, matched with MQTT's own wildcards. */
  on(filter, handler) {
    this.#handlers.set(filter, handler)
    this.#subscriptions.add(filter)
    if (this.connected) this.#write(subscribePacket([filter]))
  }

  connect() {
    if (this.#closed) return
    const { url, username, password, clientId } = this.#opts
    const parsed = new URL(url)
    const secure = parsed.protocol === 'mqtts:'
    const port = Number(parsed.port) || (secure ? 8883 : 1883)

    const socket = (secure ? tlsConnect : netConnect)(
      secure
        ? { host: parsed.hostname, port, rejectUnauthorized: this.#opts.rejectUnauthorized !== false }
        : { host: parsed.hostname, port },
    )

    socket.on(secure ? 'secureConnect' : 'connect', () => {
      this.#socket = socket
      this.#reader = new Reader()
      socket.write(connectPacket({
        clientId, username, password,
        keepalive: this.#opts.keepalive,
        will: this.#opts.will,
      }))
    })

    socket.on('data', (chunk) => {
      for (const p of this.#reader.push(chunk)) this.#handle(p)
    })

    // Both paths lead to the same place, and it is the same place a broker
    // restart leads to.
    socket.on('error', () => this.#down())
    socket.on('close', () => this.#down())
  }

  #handle(p) {
    if (p.type === CONNACK) {
      for (const filter of this.#subscriptions) this.#write(subscribePacket([filter]))
      this.#ping = setInterval(() => this.#write(packet(PINGREQ, 0, Buffer.alloc(0))),
        this.#opts.keepalive * 500)
      this.#ping.unref?.()
      this.#onConnect?.()
      return
    }
    if (p.type === PINGRESP || p.type === SUBACK) return

    if (p.type === PUBLISH) {
      for (const [filter, handler] of this.#handlers) {
        if (matches(filter, p.topic)) {
          try {
            handler(p.payload, p.topic)
          } catch (err) {
            // One bad message must not take the connection down with it.
            this.#opts.log?.(`handler for ${filter} threw: ${err.message}`)
          }
        }
      }
    }
  }

  #down() {
    if (this.#ping) clearInterval(this.#ping)
    this.#ping = null
    this.#socket = null
    if (this.#closed || this.#retry) return
    this.#retry = setTimeout(() => {
      this.#retry = null
      this.connect()
    }, this.#opts.retryMs ?? 5000)
    this.#retry.unref?.()
  }

  #write(buf) {
    try {
      this.#socket?.write(buf)
    } catch {
      // Writing to a socket that just died is the disconnect handler's problem.
    }
  }

  publish(topic, payload, opts) {
    this.#write(publishPacket(topic, payload, opts))
  }

  close() {
    this.#closed = true
    if (this.#ping) clearInterval(this.#ping)
    if (this.#retry) clearTimeout(this.#retry)
    this.#ping = this.#retry = null
    try {
      this.#write(packet(DISCONNECT, 0, Buffer.alloc(0)))
      this.#socket?.end()
    } catch { /* already gone */ }
    this.#socket = null
  }
}

/**
 * MQTT's wildcards: `+` is one level, `#` is the rest.
 *
 * Level-aware, because a plain string prefix would make `home/player` match
 * `home/players/other` — subscribing to one device and receiving another's
 * commands.
 */
export function matches(filter, topic) {
  const f = filter.split('/')
  const t = topic.split('/')

  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true
    if (i >= t.length) return false
    if (f[i] !== '+' && f[i] !== t[i]) return false
  }
  return f.length === t.length
}
