import { networkInterfaces } from 'node:os'
import { XMLParser } from 'fast-xml-parser'
import { search, type SsdpResponse } from './ssdp.ts'

/**
 * Driving a UPnP renderer.
 *
 * Two steps after discovery: read the device's description to find its
 * AVTransport control URL, then post SOAP at it. Sonos speaks exactly this, as
 * does every DLNA speaker, so one implementation covers the lot; the
 * Sonos-specific parts (grouping, its own queue) sit on top later.
 *
 * The part that catches everyone: **the URL handed to a renderer is fetched by
 * the renderer**, not by this server. `http://localhost:8787/...` is a valid
 * URL that means something different on the speaker, and it means nothing at
 * all. The advertised base has to be an address the device can reach, which is
 * why `advertisedBase` exists rather than reusing whatever the request came in
 * on.
 */

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false })

export type Renderer = {
  /** Stable across restarts: the device's own UUID from its USN. */
  id: string
  name: string
  manufacturer: string
  model: string
  /** Absolute URL of the AVTransport control endpoint. */
  controlUrl: string
  /** Absolute URL of RenderingControl, when the device has one. */
  volumeUrl: string | null
  address: string
  location: string
}

const text = (v: unknown): string =>
  v == null ? '' : typeof v === 'object' ? String((v as any)['#text'] ?? '') : String(v)

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])

/** Every service in a description, flattened out of however it was nested. */
function services(device: any): any[] {
  const own = asArray(device?.serviceList?.service)
  const nested = asArray(device?.deviceList?.device).flatMap(services)
  return [...own, ...nested]
}

/**
 * Reads a device description into something usable.
 *
 * Control URLs in a description are usually relative, and relative to the
 * *description's* URL rather than the host root — resolving them against the
 * host is the bug that makes half the devices on a network unreachable.
 */
export function parseDescription(xml: string, location: string, usn: string, address: string): Renderer | null {
  let doc: any
  try {
    doc = parser.parse(xml)
  } catch {
    return null
  }
  const device = doc?.root?.device
  if (!device) return null

  const found = services(device)
  const avTransport = found.find((s) => String(text(s.serviceType)).includes('AVTransport'))
  if (!avTransport) return null // not something that can be played to
  const rendering = found.find((s) => String(text(s.serviceType)).includes('RenderingControl'))

  const resolve = (path: string) => {
    try {
      return new URL(text(path), location).href
    } catch {
      return ''
    }
  }

  return {
    // The uuid, not the whole USN: the service suffix changes with what was
    // searched for, and the same speaker must not appear twice.
    id: (/uuid:([^:]+)/.exec(usn)?.[1] ?? usn).trim(),
    name: text(device.friendlyName) || 'Unknown renderer',
    manufacturer: text(device.manufacturer),
    model: text(device.modelName),
    controlUrl: resolve(avTransport.controlURL),
    volumeUrl: rendering ? resolve(rendering.controlURL) : null,
    address,
    location,
  }
}

/** Searches, then describes whatever answered. */
export async function discover(opts: Parameters<typeof search>[0] = {}): Promise<Renderer[]> {
  const responses = await search(opts)
  const described = await Promise.all(responses.map((r) => describe(r)))
  return described.filter((r): r is Renderer => r !== null)
}

export async function describe(res: SsdpResponse): Promise<Renderer | null> {
  try {
    const doc = await fetch(res.location, { signal: AbortSignal.timeout(5000) })
    if (!doc.ok) return null
    return parseDescription(await doc.text(), res.location, res.usn, res.address)
  } catch {
    // A device that answered SSDP and then refused its own description is
    // broken, not fatal. It simply does not appear.
    return null
  }
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * DIDL-Lite metadata.
 *
 * Optional in the protocol and required in practice: without it many renderers
 * play the stream but display nothing, and Sonos shows "Unknown" where the
 * title should be.
 */
export function didl(track: { name: string; artist: string; album: string; url: string; duration?: number }): string {
  return escape(
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">` +
    `<item id="0" parentID="-1" restricted="1">` +
    `<dc:title>${escape(track.name)}</dc:title>` +
    `<upnp:artist>${escape(track.artist)}</upnp:artist>` +
    `<upnp:album>${escape(track.album)}</upnp:album>` +
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
    `<res protocolInfo="http-get:*:audio/mpeg:*">${escape(track.url)}</res>` +
    `</item></DIDL-Lite>`,
  )
}

export function soapBody(service: string, action: string, args: Record<string, string>): string {
  const inner = Object.entries(args)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('')
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${service}">${inner}</u:${action}></s:Body></s:Envelope>`
}

const AV = 'urn:schemas-upnp-org:service:AVTransport:1'
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1'

/** One SOAP call. Throws with the device's own fault string when it refuses. */
export async function soap(url: string, service: string, action: string, args: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      // The quotes are part of the header value. Devices reject it without them.
      soapaction: `"${service}#${action}"`,
      'content-type': 'text/xml; charset="utf-8"',
    },
    body: soapBody(service, action, args),
    signal: AbortSignal.timeout(10_000),
  })

  const body = await res.text()
  if (!res.ok) {
    // UPnP faults are a nested XML element, and the useful part is the code and
    // description inside it rather than the 500 the transport reports.
    const detail = /<errorDescription>([^<]*)<\/errorDescription>/.exec(body)?.[1]
    throw new Error(detail ? `${action} refused: ${detail}` : `${action} answered ${res.status}`)
  }
  return body
}

export const play = (r: Renderer) => soap(r.controlUrl, AV, 'Play', { InstanceID: '0', Speed: '1' })
export const pause = (r: Renderer) => soap(r.controlUrl, AV, 'Pause', { InstanceID: '0' })
export const stop = (r: Renderer) => soap(r.controlUrl, AV, 'Stop', { InstanceID: '0' })

export const setVolume = (r: Renderer, percent: number) =>
  r.volumeUrl
    ? soap(r.volumeUrl, RC, 'SetVolume', {
        InstanceID: '0', Channel: 'Master',
        DesiredVolume: String(Math.round(Math.min(100, Math.max(0, percent)))),
      })
    : Promise.reject(new Error(`${r.name} has no volume control`))

/** Points the renderer at a URL and starts it. */
export async function playUrl(
  r: Renderer,
  track: { name: string; artist: string; album: string; url: string; duration?: number },
): Promise<void> {
  await soap(r.controlUrl, AV, 'SetAVTransportURI', {
    InstanceID: '0',
    CurrentURI: escape(track.url),
    CurrentURIMetaData: didl(track),
  })
  // Separate call, and required: SetAVTransportURI loads, it does not start.
  await play(r)
}

/**
 * The base URL a device on the LAN should use to reach this server.
 *
 * Not derived from the incoming request: that would be `localhost` whenever the
 * UI and the server are on the same machine, which is the normal case and
 * exactly when it silently breaks. The first non-internal IPv4 address is the
 * right guess for a home network, and `JUKEBOX_ADVERTISE` overrides it for
 * everything else — a container with several interfaces, a reverse proxy.
 */
export function advertisedBase(port: number): string {
  const override = process.env.JUKEBOX_ADVERTISE
  if (override) return override.replace(/\/$/, '')

  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return `http://${a.address}:${port}`
    }
  }
  // Nothing better to offer. A renderer will fail to fetch it, which is more
  // honest than pretending the address is right.
  return `http://127.0.0.1:${port}`
}
