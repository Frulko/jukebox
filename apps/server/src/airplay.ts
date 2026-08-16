import { randomUUID } from 'node:crypto'
import { browse, type Service } from './mdns.ts'

/**
 * AirPlay, over its HTTP interface.
 *
 * There are two AirPlay protocols and only one of them belongs in this project.
 *
 * The audio one, RAOP, expects the *server* to encode ALAC, packetise it into
 * RTP, keep a clock in sync and encrypt the stream. That is a media pipeline
 * living in the controller, and it is the opposite of how everything else here
 * works: this server publishes an intent and the renderer fetches the bytes
 * itself. It would also mean an audio encoder in Node, which this project does
 * not have and will not add.
 *
 * The HTTP one is the same shape as UPnP — `POST /play` with a URL, and the
 * device fetches it — so it costs one small file and fits the architecture
 * exactly. What it covers is Apple TVs and the receivers that implement the
 * video profile, which is most of what people actually own; audio-only speakers
 * that speak nothing but RAOP are out of reach and are reported as such rather
 * than silently failing.
 *
 * Volume is deliberately absent: it lives in RTSP `SET_PARAMETER`, on the
 * protocol this does not speak. Reporting that honestly beats sending a request
 * that returns 200 and changes nothing.
 *
 * **The pairing wall.** Receivers new enough to be AirPlay 2 answer 403 to
 * anything that controls playback until a HomeKit pairing has been done —
 * SRP6a, Curve25519, ChaCha20-Poly1305, and a PIN typed on a television. This
 * finds those devices and names the problem when they refuse; it does not pair
 * with them. Verified against a real receiver, which answers 403 to
 * `/server-info` and 200 to `/info`.
 */

export const SERVICE = '_airplay._tcp.local'

export type AirPlayDevice = {
  /** Their own device id when they publish one, which is stable across renames. */
  id: string
  name: string
  address: string
  port: number
  model: string
}

/** The session a receiver ties its playback state to. One per device, for this process. */
const sessions = new Map<string, string>()

function sessionFor(id: string): string {
  let s = sessions.get(id)
  if (!s) { s = randomUUID().toUpperCase(); sessions.set(id, s) }
  return s
}

export function toDevice(s: Service): AirPlayDevice | null {
  // No address means the responder answered without an A record and we would
  // have nowhere to send the request.
  if (!s.address) return null
  return {
    id: s.txt.deviceid ? `airplay:${s.txt.deviceid}` : `airplay:${s.fqdn}`,
    name: s.name,
    address: s.address,
    port: s.port || 7000,
    model: s.txt.model ?? '',
  }
}

export async function discover(opts: Parameters<typeof browse>[1] = {}): Promise<AirPlayDevice[]> {
  const services = await browse(SERVICE, opts)
  return services.map(toDevice).filter((d): d is AirPlayDevice => d !== null)
}

const base = (d: AirPlayDevice) => `http://${d.address}:${d.port}`

async function call(d: AirPlayDevice, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${base(d)}${path}`, {
    ...init,
    headers: {
      // Both headers are required by real receivers, and a request without the
      // session id is answered with 400 by an Apple TV rather than ignored.
      'user-agent': 'MediaControl/1.0',
      'x-apple-session-id': sessionFor(d.id),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    // 403 is not a refusal of *this* request, it is the device saying it wants
    // to be paired first. Verified against a real receiver on the LAN, which
    // answers 403 to /server-info and /playback-info while answering /info
    // perfectly happily. Saying which one it is matters: "403" sends someone
    // looking for a bug in the request, and there isn't one.
    throw new Error(res.status === 403
      ? `${d.name} requires AirPlay 2 pairing, which this does not do`
      : `${d.name} answered ${res.status} to ${path}`)
  }
  return res
}

/**
 * Points a receiver at a URL.
 *
 * `Start-Position` is a fraction of the whole, not seconds — the one field in
 * this protocol that is easy to read as the other and produces a player that
 * starts three hours in.
 */
export async function play(d: AirPlayDevice, url: string, startFraction = 0): Promise<void> {
  const body = `Content-Location: ${url}\r\nStart-Position: ${startFraction.toFixed(6)}\r\n`
  await call(d, '/play', {
    method: 'POST',
    headers: { 'content-type': 'text/parameters' },
    body,
  })
}

/** 0 pauses, 1 resumes. There is no separate pause verb. */
export const rate = (d: AirPlayDevice, value: number) =>
  call(d, `/rate?value=${value.toFixed(6)}`, { method: 'POST' }).then(() => undefined)

export const pause = (d: AirPlayDevice) => rate(d, 0)
export const resume = (d: AirPlayDevice) => rate(d, 1)

export const stop = (d: AirPlayDevice) =>
  call(d, '/stop', { method: 'POST', headers: { 'content-length': '0' } }).then(() => undefined)

export const seek = (d: AirPlayDevice, seconds: number) =>
  call(d, `/scrub?position=${seconds.toFixed(6)}`, { method: 'POST' }).then(() => undefined)

/**
 * Where it is.
 *
 * `GET /scrub` rather than `/playback-info`: the same two numbers, as two lines
 * of text, instead of an XML property list that would need a plist reader for
 * information already available in a form anyone can parse.
 */
export async function position(d: AirPlayDevice): Promise<{ position: number; duration: number }> {
  const text = await call(d, '/scrub').then((r) => r.text())
  const read = (key: string) => {
    const m = new RegExp(`^${key}:\\s*([0-9.]+)`, 'm').exec(text)
    return m ? Number(m[1]) : 0
  }
  return { position: read('position'), duration: read('duration') }
}

/**
 * Whether the thing at that address is really an AirPlay receiver.
 *
 * `/info` rather than `/server-info`: the older route is answered with 403 by
 * anything recent, so asking it would report every modern receiver as absent.
 * `/info` is answered by both generations without pairing — it is how a device
 * says what it is before anyone has authenticated.
 */
export async function reachable(d: AirPlayDevice): Promise<boolean> {
  try {
    await call(d, '/info')
    return true
  } catch {
    return false
  }
}
