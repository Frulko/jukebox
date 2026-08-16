// The fake back end for the embedded demo.
//
// It answers the public API from a library fabricated in the browser, so the
// site can ship the *real* front end — same components, same queries — with no
// server behind it. It patches `fetch` and nothing else: the day `apps/web`
// serves its own fabricated data in demo mode, the app stops calling the network
// and this file simply never runs. Nothing in `apps/web` is modified for it.
//
// ponytail: one page per query, no cursor. The demo library is ~250 tracks; the
// real pagination is the server's job and is tested there.
import { makeLibrary } from '../../../web/src/data'
import type { Device, DeviceTrack, Job, MissingTrack, Playlist, Source, Stats, Track, TrackQuery } from '@jukebox/api-types'

const all = makeLibrary()

// A handful whose files "went away": the demo has to show the Missing view with
// something in it, and they are excluded from the library exactly as the server
// excludes soft-deleted rows.
const gone = new Set(all.filter((_, i) => i % 47 === 13).map((t) => t.id))
const tracks = all.filter((t) => !gone.has(t.id))

// A second source that is *not* returned by /sources: an external drive that is
// not plugged in. Its tracks are still in the library — with their ratings and
// their place in playlists — but nothing can stream them, which is exactly the
// state the row's warning badge is for.
for (const t of tracks.filter((_, i) => i % 23 === 5)) t.sourceId = 'usb-archive'
let revision = all.length

const norm = (s: string) => s.toLowerCase()

function match(t: Track, q: TrackQuery) {
  if (q.kind && t.kind !== q.kind) return false
  if (q.genre && t.genre !== q.genre) return false
  if (q.artist && t.albumArtist !== q.artist && t.artist !== q.artist) return false
  if (q.album && t.album !== q.album) return false
  if (q.q) {
    const needle = norm(q.q)
    if (![t.name, t.artist, t.album, t.albumArtist, t.genre].some((f) => norm(f).includes(needle))) return false
  }
  return true
}

const SORTS: Record<string, (a: Track, b: Track) => number> = {
  artist: (a, b) =>
    a.albumArtist.localeCompare(b.albumArtist) ||
    a.album.localeCompare(b.album) ||
    a.discNumber - b.discNumber ||
    a.trackNumber - b.trackNumber,
  album: (a, b) => a.album.localeCompare(b.album) || a.discNumber - b.discNumber || a.trackNumber - b.trackNumber,
  name: (a, b) => a.name.localeCompare(b.name),
  added: (a, b) => a.dateAdded - b.dateAdded,
}

function select(q: TrackQuery) {
  const found = tracks.filter((t) => match(t, q))
  const key = (q.sort ?? 'artist').replace(/^-/, '')
  const cmp = SORTS[key] ?? SORTS.artist
  found.sort(q.sort?.startsWith('-') ? (a, b) => cmp(b, a) : cmp)
  return found
}

/** Distinct values, cascading the way the column browser expects. */
function facets(q: TrackQuery) {
  const count = (list: Track[], pick: (t: Track) => string) => {
    const seen = new Map<string, number>()
    for (const t of list) seen.set(pick(t), (seen.get(pick(t)) ?? 0) + 1)
    return [...seen].sort((a, b) => a[0].localeCompare(b[0])).map(([value, n]) => ({ value, count: n }))
  }
  const base = tracks.filter((t) => match(t, { q: q.q, kind: q.kind }))
  const byGenre = base.filter((t) => match(t, { genre: q.genre }))
  const byArtist = byGenre.filter((t) => match(t, { artist: q.artist }))
  return {
    genres: count(base, (t) => t.genre),
    artists: count(byGenre, (t) => t.albumArtist),
    albums: count(byArtist, (t) => t.album),
  }
}

const smart = (name: string, id: string, pick: () => Track[]): [Playlist, () => Track[]] => [
  { id, name, smart: 'rules', rules: null, trackCount: pick().length, createdAt: Date.UTC(2026, 0, 1), rev: 1 },
  pick,
]

const PLAYLISTS: Array<[Playlist, () => Track[]]> = [
  smart('Recently Added', 'p-recent', () => [...tracks].sort((a, b) => b.dateAdded - a.dateAdded).slice(0, 60)),
  smart('Top 25 Most Played', 'p-top', () => [...tracks].sort((a, b) => b.playCount - a.playCount).slice(0, 25)),
  smart('Four stars and up', 'p-loved', () => tracks.filter((t) => t.rating >= 4)),
  [
    { id: 'p-jazz', name: 'Jazz for the evening', smart: null, rules: null,
      trackCount: tracks.filter((t) => t.genre === 'Jazz').length, createdAt: Date.UTC(2026, 2, 4), rev: 1 },
    () => tracks.filter((t) => t.genre === 'Jazz'),
  ],
]

// One iPod, connected, so the demo shows the device half of the app: presence
// column, contents, and the tracks it holds that the library no longer does.
const DEVICE: Device = {
  id: 'dev-classic',
  satelliteId: 'sat-pi',
  name: 'iPod Classic',
  kind: 'ipod-classic',
  model: 'MB147',
  serial: '5K84 2GA',
  firmware: '1.1.2',
  capacity: 160 * 1024 ** 3,
  used: { audio: 41 * 1024 ** 3, video: 0, photos: 2 * 1024 ** 3, apps: 0, other: 1024 ** 3 },
  battery: 72,
  acceptedFormats: ['mp3', 'aac', 'alac', 'wav'],
  autoSync: 1,
  syncMode: 'playlists',
  syncPlaylistIds: ['p-top'],
  charging: false,
  connected: 1,
  lastSync: Date.UTC(2026, 7, 14),
  lastBackup: Date.UTC(2026, 6, 2),
}

/** What the satellite reports off the device: some matched, some orphaned. */
const onDevice: DeviceTrack[] = tracks.slice(0, 40).map((t, i) => ({
  deviceLocalId: `F${String(i).padStart(3, '0')}`,
  libraryTrackId: i % 9 === 0 ? null : t.id,
  name: t.name,
  artist: t.artist,
  album: t.album,
  duration: t.duration,
  size: t.size,
  format: 'mp3',
  sourceUrl: i % 9 === 0 ? `http://sat-pi.local/ipod/F${String(i).padStart(3, '0')}.mp3` : null,
  syncedAt: Date.UTC(2026, 7, 14),
}))

// The library's own view of what the device holds — the presence column and the
// "already on a device" badge read this, not the device listing.
for (const t of onDevice) {
  if (!t.libraryTrackId) continue
  const track = tracks.find((x) => x.id === t.libraryTrackId)
  if (track) track.devices = [DEVICE.id]
}

const SOURCES: Source[] = [
  { id: 'demo', kind: 'local', name: 'Demo library', root: '/music', writable: 0,
    lastScanAt: Date.UTC(2026, 7, 16), rev: 1 },
]

// A scan in flight. The demo needs one so the display has something to cycle to
// besides the music, and a progress bar frozen at 40 % reads as broken, so it
// advances with the clock and starts over.
const openedAt = Date.now()
function scanning(): Job {
  const total = 4200
  const elapsed = (Date.now() - openedAt) / 1000
  const done = Math.round(((elapsed * 40) % (total * 1.15)))
  return {
    id: 'job-scan',
    kind: 'scan',
    state: 'running',
    progress: { done: Math.min(done, total), total, bytes: done * 7_400_000 },
    error: null,
    createdAt: openedAt,
    startedAt: openedAt,
    finishedAt: null,
  }
}

const MISSING: MissingTrack[] = all
  .filter((t) => gone.has(t.id))
  .map((t) => ({
    id: t.id,
    sourceId: 'demo',
    sourceName: 'Demo library',
    path: `/music/${t.path}`,
    name: t.name,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    rating: t.rating,
    playCount: t.playCount,
    deletedAt: Date.UTC(2026, 7, 12),
  }))

function stats(): Stats {
  const albums = new Set(tracks.map((t) => `${t.albumArtist} — ${t.album}`))
  const artists = new Set(tracks.map((t) => t.albumArtist))
  return {
    tracks: tracks.length,
    albums: albums.size,
    artists: artists.size,
    bytes: tracks.reduce((a, t) => a + t.size, 0),
    seconds: tracks.reduce((a, t) => a + t.duration, 0),
    missing: MISSING.length,
    playlists: PLAYLISTS.length,
    podcasts: 0,
    radios: 0,
    sources: SOURCES.length,
    devices: 1,
    jobs: { running: 1 },
  }
}

/** Returns the body for a route, or `undefined` when the demo has nothing to say. */
function route(path: string, params: URLSearchParams, method: string, body: string | null): unknown {
  const q = Object.fromEntries(params) as TrackQuery

  if (path === '/tracks' && method === 'GET') {
    const found = select(q)
    return { items: found.slice(0, Number(q.limit ?? 300)), next: null, revision }
  }
  if (path === '/tracks' && method === 'PATCH') {
    const { ids, patch } = JSON.parse(body ?? '{}') as { ids: string[]; patch: Record<string, unknown> }
    const set = new Set(ids)
    let updated = 0
    for (const t of tracks) {
      if (!set.has(t.id)) continue
      Object.assign(t, patch, { rev: ++revision })
      updated++
    }
    return { updated, revision, job: null }
  }
  if (path === '/tracks/count') return { count: select(q).length }
  // Before the single-track lookup below, which would otherwise swallow it.
  if (path === '/tracks/missing') return { items: MISSING }
  if (path === '/stats') return stats()
  if (path === '/facets') return facets(q)
  if (path.startsWith('/tracks/')) return tracks.find((t) => t.id === path.slice(8))
  if (path === '/playlists') return { items: PLAYLISTS.map(([p]) => p) }
  if (path === '/sources') return { items: SOURCES }
  // A rescan in the demo has nothing to walk, so it answers with the job it
  // would have started and the scan job already on display keeps running.
  if (path.startsWith('/sources/') && path.endsWith('/scan') && method === 'POST') return scanning()
  if (path === '/devices') return { items: [DEVICE] }
  if (path === '/jobs') return { items: [scanning()] }
  if (path === `/devices/${DEVICE.id}/tracks`) {
    const items = params.get('orphansOnly') === 'true' ? onDevice.filter((t) => !t.libraryTrackId) : onDevice
    return { items, next: null }
  }
  if (path === `/devices/${DEVICE.id}/stats`) {
    return {
      tracks: onDevice.length,
      orphans: onDevice.filter((t) => !t.libraryTrackId).length,
      bytes: onDevice.reduce((a, t) => a + t.size, 0),
      seconds: onDevice.reduce((a, t) => a + t.duration, 0),
    }
  }

  const pl = path.match(/^\/playlists\/([^/]+)\/tracks$/)
  if (pl) {
    const entry = PLAYLISTS.find(([p]) => p.id === pl[1])
    return entry ? { items: entry[1](), next: null, revision } : undefined
  }
  return undefined
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

/** Patches `fetch` for `/api/v1` only. Everything else goes to the network untouched. */
export function installDemoApi() {
  const real = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href, location.href)
    const at = url.pathname.indexOf('/api/v1')
    if (at === -1) return real(input, init)

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const payload = typeof init?.body === 'string' ? init.body : null
    const data = route(url.pathname.slice(at + 7), url.searchParams, method, payload)
    return data === undefined
      ? json({ error: { code: 'not_in_demo', message: `${method} ${url.pathname} is not part of the demo` } }, 404)
      : json(data)
  }
}
