import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { createServer, type Server } from 'node:http'
import { advertisedBase, didl, parseDescription, playUrl, setVolume, soap, soapBody } from '../src/upnp.ts'
import { parseResponse, search, searchMessage } from '../src/ssdp.ts'

/**
 * A fake renderer: a UDP socket that answers M-SEARCH the way a speaker does,
 * and an HTTP server that serves a description and accepts SOAP. Everything
 * here is protocol detail, and protocol detail is exactly what a mock would let
 * me get wrong quietly.
 */

const DESCRIPTION = (port: number) => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Kitchen Speaker</friendlyName>
    <manufacturer>Sonos, Inc.</manufacturer>
    <modelName>Play:1</modelName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/MediaRenderer/RenderingControl/Control</controlURL>
      </service>
    </serviceList>
    <deviceList>
      <device>
        <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
        <serviceList>
          <service>
            <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
            <controlURL>/MediaRenderer/AVTransport/Control</controlURL>
          </service>
        </serviceList>
      </device>
    </deviceList>
  </device>
</root>`

/* ---- the pieces, on their own ---- */

test('an M-SEARCH reply is read whatever case the headers came in', () => {
  // LOCATION, Location and location all appear in the wild.
  const reply = [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    'Location: http://192.168.1.40:1400/xml/device_description.xml',
    'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
    'usn: uuid:RINCON_000E58::urn:schemas-upnp-org:device:MediaRenderer:1',
    'SERVER: Linux UPnP/1.0 Sonos/70.3',
    '', '',
  ].join('\r\n')

  const parsed = parseResponse(reply, '192.168.1.40')
  assert.ok(parsed)
  assert.equal(parsed.location, 'http://192.168.1.40:1400/xml/device_description.xml')
  assert.match(parsed.usn, /RINCON_000E58/)
  assert.equal(parsed.address, '192.168.1.40')

  assert.equal(parseResponse('NOTIFY * HTTP/1.1\r\n\r\n', 'x'), null, 'an announcement is not a reply')
  assert.equal(parseResponse('HTTP/1.1 200 OK\r\nST: x\r\n\r\n', 'x'), null, 'no LOCATION is unusable')
})

test('the search message is the shape a hand-rolled parser will accept', () => {
  const msg = searchMessage('urn:schemas-upnp-org:device:MediaRenderer:1', 2)
  assert.ok(msg.startsWith('M-SEARCH * HTTP/1.1\r\n'))
  assert.match(msg, /MAN: "ssdp:discover"/, 'the quotes are part of it')
  assert.match(msg, /MX: 2/)
  assert.ok(msg.endsWith('\r\n\r\n'), 'a blank line ends it')
})

test('a description yields absolute control URLs, however deeply nested', () => {
  const r = parseDescription(
    DESCRIPTION(1400),
    'http://192.168.1.40:1400/xml/device_description.xml',
    'uuid:RINCON_000E58::urn:schemas-upnp-org:device:MediaRenderer:1',
    '192.168.1.40',
  )
  assert.ok(r)
  assert.equal(r.name, 'Kitchen Speaker')
  assert.equal(r.manufacturer, 'Sonos, Inc.')
  // AVTransport is inside a nested deviceList here, exactly as Sonos ships it.
  assert.equal(r.controlUrl, 'http://192.168.1.40:1400/MediaRenderer/AVTransport/Control')
  assert.equal(r.volumeUrl, 'http://192.168.1.40:1400/MediaRenderer/RenderingControl/Control')
  // The uuid alone: the service suffix depends on what was searched for, and
  // the same speaker must not appear twice.
  assert.equal(r.id, 'RINCON_000E58')

  assert.equal(parseDescription('<root><device><friendlyName>x</friendlyName></device></root>', 'http://h/d.xml', 'uuid:1', 'h'),
    null, 'a device with no AVTransport cannot be played to')
  assert.equal(parseDescription('not xml <<', 'http://h/d.xml', 'uuid:1', 'h'), null)
})

test('a relative control URL resolves against the description, not the host root', () => {
  // The bug that makes half the devices on a network unreachable.
  const xml = DESCRIPTION(1400).replace('/MediaRenderer/AVTransport/Control', 'Control')
  const r = parseDescription(xml, 'http://192.168.1.40:1400/xml/desc.xml', 'uuid:a', '192.168.1.40')
  assert.equal(r!.controlUrl, 'http://192.168.1.40:1400/xml/Control')
})

test('SOAP bodies and DIDL escape what would otherwise break the XML', () => {
  const body = soapBody('urn:x', 'Play', { InstanceID: '0', Speed: '1' })
  assert.match(body, /<u:Play xmlns:u="urn:x"><InstanceID>0<\/InstanceID><Speed>1<\/Speed><\/u:Play>/)

  // A track called `Rock & Roll <Live>` must not produce invalid XML, and the
  // metadata is itself escaped because it travels inside an XML element.
  const meta = didl({ name: 'Rock & Roll <Live>', artist: 'A "B"', album: 'C', url: 'http://h/s?a=1&b=2' })
  assert.ok(!meta.includes('<dc:title>'), 'the whole document is escaped for embedding')
  assert.match(meta, /Rock &amp;amp; Roll/)
  assert.ok(!/[^&]&(?!amp;|lt;|gt;|quot;)/.test(meta), 'no bare ampersand survives')
})

test('the advertised base is never localhost unless there is nothing else', () => {
  // What a renderer fetches is fetched by the renderer: `localhost` means the
  // speaker, and the speaker has no music on it.
  const base = advertisedBase(8787)
  assert.match(base, /^http:\/\/\d+\.\d+\.\d+\.\d+:8787$/)

  process.env.JUKEBOX_ADVERTISE = 'https://music.example/'
  assert.equal(advertisedBase(8787), 'https://music.example')
  delete process.env.JUKEBOX_ADVERTISE
})

/* ---- against a device that actually answers ---- */

async function fakeRenderer() {
  const calls: { action: string; body: string }[] = []
  let http: Server
  http = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const port = (http.address() as any).port
      if (req.url?.includes('description')) {
        res.writeHead(200, { 'content-type': 'text/xml' })
        return res.end(DESCRIPTION(port))
      }
      const action = /#(\w+)"/.exec(String(req.headers.soapaction ?? ''))?.[1] ?? ''
      calls.push({ action, body })
      if (action === 'SetVolume' && !body.includes('<DesiredVolume>')) {
        res.writeHead(500, { 'content-type': 'text/xml' })
        return res.end('<s:Envelope><errorDescription>Invalid Args</errorDescription></s:Envelope>')
      }
      res.writeHead(200, { 'content-type': 'text/xml' })
      res.end('<s:Envelope><s:Body/></s:Envelope>')
    })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  const httpPort = (http.address() as any).port

  // The SSDP side: a socket that answers M-SEARCH like a speaker.
  const udp = createSocket({ type: 'udp4', reuseAddr: true })
  udp.on('message', (msg, rinfo) => {
    if (!msg.toString().startsWith('M-SEARCH')) return
    const reply = [
      'HTTP/1.1 200 OK',
      `LOCATION: http://127.0.0.1:${httpPort}/xml/description.xml`,
      'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
      'USN: uuid:FAKE-1::urn:schemas-upnp-org:device:MediaRenderer:1',
      'SERVER: Test/1.0',
      '', '',
    ].join('\r\n')
    // Twice, as real devices do. The dedupe is the thing being tested.
    udp.send(reply, rinfo.port, rinfo.address)
    udp.send(reply, rinfo.port, rinfo.address)
  })
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r))

  return {
    calls,
    udpPort: (udp.address() as any).port,
    descriptionUrl: `http://127.0.0.1:${httpPort}/xml/description.xml`,
    close: () => { udp.close(); http.close() },
  }
}

test('a device that answers twice is discovered once', async () => {
  const device = await fakeRenderer()
  try {
    const found = await search({ address: '127.0.0.1', port: device.udpPort, mx: 1, timeoutMs: 700 })
    assert.equal(found.length, 1, 'deduplicated by USN')
    assert.equal(found[0].location, device.descriptionUrl)
  } finally { device.close() }
})

test('a network with nothing on it resolves empty rather than hanging', async () => {
  // Port 1 refuses. This is the normal case on most home networks.
  const found = await search({ address: '127.0.0.1', port: 1, mx: 1, timeoutMs: 500 })
  assert.deepEqual(found, [])
})

test('playing sends the URI and then a separate Play', async () => {
  const device = await fakeRenderer()
  try {
    const found = await search({ address: '127.0.0.1', port: device.udpPort, mx: 1, timeoutMs: 700 })
    const { describe } = await import('../src/upnp.ts')
    const renderer = await describe(found[0])
    assert.ok(renderer)

    await playUrl(renderer, {
      name: 'One More Time', artist: 'Daft Punk', album: 'Discovery',
      url: 'http://192.168.1.10:8787/api/v1/stream/abc',
    })

    // SetAVTransportURI loads; it does not start. Both calls, in order.
    assert.deepEqual(device.calls.map((c) => c.action), ['SetAVTransportURI', 'Play'])
    assert.match(device.calls[0].body, /One More Time/, 'the metadata travels with it')
    assert.match(device.calls[0].body, /stream\/abc/)
  } finally { device.close() }
})

test('a refusal reports the device s own reason', async () => {
  const device = await fakeRenderer()
  try {
    const found = await search({ address: '127.0.0.1', port: device.udpPort, mx: 1, timeoutMs: 700 })
    const { describe } = await import('../src/upnp.ts')
    const renderer = (await describe(found[0]))!

    // The fake refuses a SetVolume with no DesiredVolume, the way a real one does.
    await assert.rejects(
      () => soap(renderer.volumeUrl!, 'urn:schemas-upnp-org:service:RenderingControl:1', 'SetVolume', { InstanceID: '0' }),
      /Invalid Args/,
    )
    // And a well-formed one goes through.
    await setVolume(renderer, 42)
    assert.match(device.calls.at(-1)!.body, /<DesiredVolume>42<\/DesiredVolume>/)
  } finally { device.close() }
})
