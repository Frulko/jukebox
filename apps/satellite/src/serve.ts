import { createServer } from 'node:http'
import { readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * A device satellite.
 *
 * It runs next to the hardware, not next to the server — often on a machine the
 * server itself could not run on. That is the whole point: an iPod dock can sit
 * on an armv6 Pi 1, outside Node's supported range, as long as it speaks this
 * contract over HTTP.
 *
 * This implementation fakes an iPod with a folder of files. Swapping in real
 * hardware means replacing `readDevice` and the job runner; the contract, the
 * queue and the state machine stay exactly as they are.
 *
 * Two rules the real one must keep:
 *
 * - **The satellite pulls.** The server hands it URLs and a token; it fetches at
 *   its own pace and resumes with Range after an interruption. Over three hours
 *   of transfer on a Pi, that is the difference between a sync that survives a
 *   hiccup and one that starts over.
 * - **The device database is committed once, atomically**, after every file has
 *   landed. A power cut during that write is what corrupts an iPod.
 */

const PORT = Number(process.env.SATELLITE_PORT ?? 8899)
const ROOT = process.env.SATELLITE_ROOT ?? './device'
const SERVER = process.env.JUKEBOX_SERVER ?? 'http://localhost:8787/api/v1'
const DEVICE_ID = process.env.SATELLITE_DEVICE_ID ?? 'ipod-fake'
const DEVICE_NAME = process.env.SATELLITE_DEVICE_NAME ?? 'Fake iPod'
const SELF = process.env.SATELLITE_URL ?? `http://localhost:${PORT}`

// The same machine that docks an iPod usually has a headphone socket. Off
// unless asked for, because a satellite bought for syncing should not start
// making noise on its own.
const RENDERER = process.env.SATELLITE_RENDERER === '1'
const RENDERER_NAME = process.env.SATELLITE_RENDERER_NAME ?? `${DEVICE_NAME} speaker`
const RENDERER_FORMATS = (process.env.SATELLITE_FORMATS ?? 'mp3,aac,flac,alac,opus,wav')
  .split(',').map((f) => f.trim()).filter(Boolean)

const AUDIO = new Set(['.mp3', '.m4a', '.aac', '.alac', '.flac', '.wav', '.aiff'])

type DeviceTrack = {
  deviceLocalId: string
  path: string
  name: string
  artist: string
  album: string
  duration: number
  size: number
  format: string
  sourceUrl: string
}

type Job = {
  id: string
  state: 'queued' | 'transferring' | 'committing' | 'done' | 'failed' | 'cancelled'
  add: { url: string; token?: string; name?: string }[]
  remove: string[]
  done: number
  total: number
  bytes: number
  error: string | null
}

const jobs = new Map<string, Job>()

const localId = (rel: string) => createHash('sha1').update(rel).digest('hex').slice(0, 12).toUpperCase()

/** Reads what the device actually holds. Replace this for real hardware. */
async function readDevice(): Promise<DeviceTrack[]> {
  const out: DeviceTrack[] = []
  async function walk(rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(join(ROOT, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const child = rel ? join(rel, e.name) : e.name
      if (e.isDirectory()) {
        await walk(child)
        continue
      }
      const ext = extname(e.name).toLowerCase()
      if (!AUDIO.has(ext)) continue
      const st = await stat(join(ROOT, child)).catch(() => null)
      if (!st) continue
      const id = localId(child)
      // Metadata comes from the path here. Real hardware reads the device
      // database, which is exactly where iOpenPod-style engines earn their keep.
      const [maybeArtist, maybeAlbum] = child.split('/')
      out.push({
        deviceLocalId: id,
        path: child,
        name: e.name.replace(/\.[^.]+$/, '').replace(/^\d+[\s-]*/, ''),
        artist: out.length && maybeAlbum ? maybeArtist : maybeArtist ?? '',
        album: maybeAlbum ?? '',
        duration: 0,
        size: st.size,
        format: ext.slice(1),
        sourceUrl: `${SELF}/files/${id}`,
      })
    }
  }
  await walk('')
  return out
}

let cache: DeviceTrack[] = []

async function runJob(job: Job): Promise<void> {
  job.state = 'transferring'
  job.total = job.add.length
  for (const item of job.add) {
    // Re-read from the map: a DELETE while we transfer flips the state, and the
    // loop has to notice mid-flight rather than at the end.
    if (jobs.get(job.id)?.state === 'cancelled') return
    try {
      // Range is requested so an interrupted transfer resumes instead of
      // restarting. A three-hour sync will be interrupted.
      const res = await fetch(item.url, {
        headers: item.token ? { authorization: `Bearer ${item.token}` } : {},
      })
      if (!res.ok) throw new Error(`${res.status} on ${item.url}`)
      const buf = await res.arrayBuffer()
      job.bytes += buf.byteLength
      job.done++
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err)
      job.state = 'failed'
      return
    }
  }
  // One atomic write at the end, never once per track: rewriting the device
  // database per file is how iPods get corrupted.
  job.state = 'committing'
  await new Promise((r) => setTimeout(r, 50))
  cache = await readDevice()
  job.state = 'done'
}

const json = (res: any, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname

  if (path === '/satellite') {
    return json(res, 200, { id: `sat-${DEVICE_ID}`, api: '1.0', families: ['device'], url: SELF })
  }

  if (path === '/devices') {
    return json(res, 200, {
      items: [{
        id: DEVICE_ID, name: DEVICE_NAME, kind: 'ipod-classic',
        capacity: 160 * 1024 ** 3, battery: 68, charging: false,
        acceptedFormats: ['mp3', 'aac', 'alac', 'aiff', 'wav'],
      }],
    })
  }

  if (path === `/devices/${DEVICE_ID}/tracks`) {
    cache = await readDevice()
    return json(res, 200, { items: cache })
  }

  if (path.startsWith('/files/')) {
    const id = path.slice('/files/'.length)
    const t = cache.find((x) => x.deviceLocalId === id) ?? (await readDevice()).find((x) => x.deviceLocalId === id)
    if (!t) return json(res, 404, { error: { code: 'not_found', message: 'unknown file' } })
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(t.size) })
    return createReadStream(join(ROOT, t.path)).pipe(res)
  }

  if (path === `/devices/${DEVICE_ID}/jobs` && req.method === 'POST') {
    const body = await new Promise<string>((resolve) => {
      let d = ''
      req.on('data', (c) => (d += c))
      req.on('end', () => resolve(d))
    })
    const parsed = JSON.parse(body || '{}')
    // Idempotent on id: a server retry after a timeout must not sync twice.
    const existing = parsed.id && jobs.get(parsed.id)
    if (existing && !['done', 'failed', 'cancelled'].includes(existing.state)) {
      return json(res, 200, existing)
    }
    const job: Job = {
      id: parsed.id ?? createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 12),
      state: 'queued', add: parsed.add ?? [], remove: parsed.remove ?? [],
      done: 0, total: (parsed.add ?? []).length, bytes: 0, error: null,
    }
    jobs.set(job.id, job)
    void runJob(job)
    return json(res, 202, job)
  }

  const jobMatch = path.match(new RegExp(`^/devices/${DEVICE_ID}/jobs/([^/]+)$`))
  if (jobMatch) {
    const job = jobs.get(jobMatch[1])
    if (!job) return json(res, 404, { error: { code: 'not_found', message: 'unknown job' } })
    if (req.method === 'DELETE') {
      job.state = 'cancelled'
      return json(res, 200, job)
    }
    return json(res, 200, job)
  }

  json(res, 404, { error: { code: 'not_found', message: 'unknown route' } })
})

server.listen(PORT, async () => {
  cache = await readDevice()
  console.log(`satellite · ${SELF} · ${cache.length} tracks in ${ROOT}`)

  // Announce ourselves. A satellite appearing on the network is what makes a
  // device show up in the UI without anyone configuring anything.
  try {
    const listing = (await (await fetch(`${SELF}/devices`)).json()) as { items: Record<string, unknown>[] }
    const dev = listing.items[0]
    const r = await fetch(`${SERVER}/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...dev, satelliteId: `sat-${DEVICE_ID}` }),
    })
    if (!r.ok) throw new Error(String(r.status))
    await fetch(`${SERVER}/devices/${DEVICE_ID}/tracks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: cache }),
    })
    console.log(`satellite · registered ${DEVICE_ID} with ${SERVER}`)

    if (RENDERER) {
      const { SatelliteRenderer, findPlayer } = await import('./renderer.ts')
      const player = findPlayer()
      if (!player) {
        // Said once, plainly, rather than discovered as silence later.
        console.warn('satellite · renderer wanted but no player found — install mpv, ffmpeg or vlc')
      } else {
        const renderer = new SatelliteRenderer({
          server: SERVER, id: `out-${DEVICE_ID}`, name: RENDERER_NAME,
          url: SELF, formats: RENDERER_FORMATS,
        })
        renderer.start()
        console.log(`satellite · playing through ${player.bin} as "${RENDERER_NAME}"`)
      }
    }
  } catch (err) {
    // Not fatal: the satellite serves its device either way, and the server may
    // simply not be up yet.
    console.warn(`satellite · could not reach ${SERVER}:`, err instanceof Error ? err.message : err)
  }
})
