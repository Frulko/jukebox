import { createSocket } from 'node:dgram'

/**
 * Finding renderers on the network.
 *
 * SSDP is HTTP-shaped text over UDP multicast: shout `M-SEARCH` at
 * 239.255.255.250:1900 and every device that matches answers directly with a
 * `LOCATION` pointing at its description. Sonos, most AV receivers, smart TVs
 * and every DLNA speaker made in the last fifteen years speak it.
 *
 * Three things that are easy to get wrong and are the whole reason this is not
 * ten lines:
 *
 * - **Devices answer more than once.** The spec tells them to spread replies
 *   over `MX` seconds to avoid a stampede, and many send two or three anyway.
 *   Deduplicated by `USN`, which is the one field that identifies a device
 *   rather than a moment.
 * - **The socket must be closed.** A bound multicast socket keeps the process
 *   alive and quietly receives every announcement on the network for ever.
 * - **`MX` is a promise.** A device may legitimately wait that long before
 *   answering, so the search window has to outlast it or half the network goes
 *   missing on every scan.
 */

const MULTICAST = '239.255.255.250'
const PORT = 1900

export type SsdpResponse = {
  /** Unique Service Name — the device's identity, and the dedupe key. */
  usn: string
  /** Where its description XML lives. */
  location: string
  /** The service type that matched, e.g. `urn:schemas-upnp-org:device:MediaRenderer:1`. */
  st: string
  server: string
  address: string
}

/** Parses one M-SEARCH reply. Returns `null` when it is not a usable one. */
export function parseResponse(text: string, address: string): SsdpResponse | null {
  const lines = text.split(/\r?\n/)
  if (!/^HTTP\/1\.1 200/i.test(lines[0] ?? '')) return null

  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const cut = line.indexOf(':')
    if (cut < 1) continue
    // Header names are case-insensitive and devices disagree wildly about it:
    // LOCATION, Location and location all appear in the wild.
    headers[line.slice(0, cut).trim().toLowerCase()] = line.slice(cut + 1).trim()
  }

  if (!headers.location || !headers.usn) return null
  return {
    usn: headers.usn,
    location: headers.location,
    st: headers.st ?? headers.nt ?? '',
    server: headers.server ?? '',
    address,
  }
}

export function searchMessage(st: string, mx: number): string {
  // CRLF throughout and a blank line at the end. Devices that hand-roll their
  // parser -- most of them -- drop a message that gets this wrong.
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${MULTICAST}:${PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${st}`,
    '', '',
  ].join('\r\n')
}

export type SearchOptions = {
  st?: string
  /** How long devices may wait before answering, in seconds. */
  mx?: number
  /** How long to listen. Defaults to comfortably past `mx`. */
  timeoutMs?: number
  /** Where to send. Overridden by the tests; there is no reason to change it otherwise. */
  address?: string
  port?: number
}

/**
 * Sends an M-SEARCH and collects what answers.
 *
 * Always resolves — a network with no renderers on it is the normal case, not
 * an error, and so is a host with multicast firewalled off.
 */
export function search(opts: SearchOptions = {}): Promise<SsdpResponse[]> {
  const st = opts.st ?? 'urn:schemas-upnp-org:device:MediaRenderer:1'
  const mx = opts.mx ?? 2
  // Past MX, not at it: a device answering on the last permitted second would
  // otherwise be cut off exactly when it was being polite.
  const timeoutMs = opts.timeoutMs ?? mx * 1000 + 1500

  return new Promise((resolve) => {
    const found = new Map<string, SsdpResponse>()
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    let done = false

    const finish = () => {
      if (done) return
      done = true
      try { socket.close() } catch { /* already closed */ }
      resolve([...found.values()])
    }

    socket.on('message', (msg, rinfo) => {
      const parsed = parseResponse(msg.toString('utf8'), rinfo.address)
      // Same device, several replies: keep the first, which is the one that
      // arrived while we were definitely still listening.
      if (parsed && !found.has(parsed.usn)) found.set(parsed.usn, parsed)
    })

    socket.on('error', finish)

    socket.bind(() => {
      try {
        socket.setBroadcast(true)
        socket.setMulticastTTL(2)
      } catch { /* not permitted here; the send below may still work */ }

      const message = Buffer.from(searchMessage(st, mx))
      socket.send(message, opts.port ?? PORT, opts.address ?? MULTICAST, (err) => {
        // A refused send is a network without multicast, which is a legitimate
        // answer of "nothing found" rather than a failure to report.
        if (err) finish()
      })

      const timer = setTimeout(finish, timeoutMs)
      timer.unref?.()
    })
  })
}
