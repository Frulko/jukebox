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

// Some tracks carry a second file: the same song converted for a device that
// cannot take the original. One row, two renditions — the shape the conversion
// dialog produces with "keep both", and the only place the interface shows it.
for (const t of tracks.filter((_, i) => i % 13 === 4)) {
  t.renditions = [
    ...t.renditions,
    {
      id: `${t.id}-aac`,
      format: 'aac',
      bitRate: 256,
      sampleRate: 44100,
      channels: 2,
      size: Math.round(t.size * 0.42),
      lossless: 0,
      preferred: 0,
      path: t.path.replace(/\.[^.]+$/, '.m4a'),
      sourceId: t.sourceId,
    },
  ]
}
let revision = all.length

const norm = (s: string) => s.toLowerCase()

function match(t: Track, q: TrackQuery) {
  if (q.kind && t.kind !== q.kind) return false
  if (q.genre && t.genre !== q.genre) return false
  if (q.artist && t.albumArtist !== q.artist && t.artist !== q.artist) return false
  if (q.album && t.album !== q.album) return false
  if (q.format && t.format.toLowerCase() !== q.format.toLowerCase()) return false
  // "What is already there" and "what is left to sync" — the filter the device
  // chip exists for, and the reason it has to be answered where the whole
  // library is rather than over the page in hand.
  if (q.onDevice && !t.devices.includes(q.onDevice)) return false
  if (q.notOnDevice && t.devices.includes(q.notOnDevice)) return false
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
    // Not cascaded, on purpose: computed through the format filter, picking
    // FLAC would leave FLAC as the only choice.
    formats: count(tracks, (t) => t.format),
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
  // The same rule the server applies, so the demo does not teach a lie: half the
  // track or four minutes, whichever comes first, and never under thirty seconds.
  const play = path.match(/^\/tracks\/([^/]+)\/play$/)
  if (play && method === 'POST') {
    const t = tracks.find((x) => x.id === play[1])
    const { played } = JSON.parse(body ?? '{}') as { played: number }
    if (!t) return { counted: false, reason: 'unknown track' }
    const enough = played >= 30 && played >= Math.min(t.duration / 2, 240)
    if (!enough) return { counted: false, reason: 'not listened to for long enough' }
    t.playCount += 1
    t.lastPlayed = Date.now()
    t.rev = ++revision
    return { counted: true, playCount: t.playCount }
  }
  // Before the single-track lookup below, which would otherwise swallow it.
  if (path === '/tracks/missing') return { items: MISSING }
  // Where a track lives. The smart playlists are evaluated here the same way
  // they are evaluated when opened, so the two cannot disagree.
  const member = path.match(/^\/tracks\/([^/]+)\/memberships$/)
  if (member) {
    const id = member[1]
    const inPlaylists = PLAYLISTS.filter(([, pick]) => pick().some((t) => t.id === id)).map(([pl, pick]) => ({
      id: pl.id,
      name: pl.name,
      smart: pl.smart,
      position: pl.smart ? null : pick().findIndex((t) => t.id === id),
    }))
    const onIt = onDevice.some((t) => t.libraryTrackId === id)
    return {
      playlists: inPlaylists,
      devices: onIt ? [{ id: DEVICE.id, name: DEVICE.name, wanted: true, present: true }] : [],
    }
  }
  if (path === '/stats') return stats()
  // The demo claims ffmpeg the way it claims a library: so the dialog can be
  // opened and read. The conversion itself answers with the job it would have
  // started, and no file is touched — there are no files.
  if (path === '/transcode/capabilities') {
    return { available: true, formats: ['mp3', 'aac', 'opus', 'alac', 'flac', 'wav'], ffmpeg: '/usr/bin/ffmpeg', fpcalc: null, reason: null }
  }
  if (path === '/transcode' && method === 'POST') return scanning()
  // Two plugins so the admin page shows both states it has to explain: one
  // running, one that failed to load and says why.
  // Two kinds of duplicate, because they are resolved differently: the same
  // song in two formats (worth keeping both, as renditions) and the same file
  // scanned twice from two folders.
  if (path === '/duplicates') {
    const pick = (i: number) => tracks[i * 37 + 3]
    const groups = [0, 1, 2].map((i) => {
      const t = pick(i)
      const other = { ...t, id: `${t.id}-dup`, format: i === 2 ? t.format : 'mp3', bitRate: 192,
        size: Math.round(t.size * 0.4), rating: 0, playCount: 0 }
      const row = (x: typeof t) => ({
        id: x.id, name: x.name, artist: x.artist, album: x.album, duration: x.duration,
        format: x.format, size: x.size, bitRate: x.bitRate, rating: x.rating, playCount: x.playCount,
        renditions: 1,
      })
      return { keeperId: t.id, reason: i === 0 ? 'fingerprint' : 'metadata', tracks: [row(t), row(other)] }
    })
    return { groups }
  }
  if (path === '/duplicates/merge' && method === 'POST') {
    const { keeperId, ids } = JSON.parse(body ?? '{}') as { keeperId: string; ids: string[] }
    return { keeperId, merged: ids.length, renditions: ids.length + 1 }
  }
  // Two feeds: one healthy, one that has been failing — the state the home
  // page exists to surface rather than hide behind a count.
  if (path === '/podcasts') {
    return {
      items: [
        { id: 'pod-vinyl', feedUrl: 'https://example.invalid/vinyl.xml', title: 'The Vinyl Hours',
          description: 'Long-form listening.', author: 'Frulko', imageUrl: null, siteUrl: null,
          cron: '0 7 * * *', keepLast: 10, autoDownload: 1, targetSourceId: 'demo', targetPath: 'Podcasts',
          lastFetchAt: Date.UTC(2026, 7, 16, 7), lastError: null, episodeCount: 128, downloadedCount: 10 },
        { id: 'pod-compression', feedUrl: 'https://example.invalid/compression.xml', title: 'Compression',
          description: 'Audio engineering, weekly.', author: 'anon', imageUrl: null, siteUrl: null,
          cron: '0 8 * * 1', keepLast: 5, autoDownload: 0, targetSourceId: 'demo', targetPath: 'Podcasts',
          lastFetchAt: Date.UTC(2026, 6, 2), lastError: 'Feed answered 404 for the last 6 weeks',
          episodeCount: 41, downloadedCount: 5 },
      ],
    }
  }
  const cmd = path.match(/^\/plugins\/([^/]+)\/command$/)
  if (cmd && method === 'POST') {
    const { command, trackIds } = JSON.parse(body ?? '{}') as { command: string; trackIds?: string[] }
    if (command === 'similar') {
      // "More like this" answers with a selection, not a playlist: an
      // exploratory command should not leave something behind to delete.
      const seed = tracks.find((t) => t.id === trackIds?.[0])
      const like = tracks.filter((t) => t.genre === seed?.genre && t.id !== seed?.id).slice(0, 12)
      return { kind: 'tracks', ids: like.map((t) => t.id) }
    }
    if (command === 'playlist') return { kind: 'playlist', id: 'p-top', name: 'Built from your listening' }
    if (command === 'flush') return { kind: 'done', message: '3 listens sent.' }
    return { kind: 'done', message: `${command} done` }
  }
  if (path === '/plugins') {
    return {
      hostApi: '1.0',
      items: [
        { id: 'listenbrainz', name: 'ListenBrainz', version: '0.2.0', author: 'jukebox',
          description: 'Scrobbles what you listen to, hanging off the play event.',
          permissions: ['http:api.listenbrainz.org', 'events:play'],
          contributes: { settings: [], 'track.contextMenu': [
            { id: 'lb.similar', label: 'Find similar tracks', command: 'similar' },
            { id: 'lb.playlist', label: 'Build a playlist from this', command: 'playlist' },
          ] },
          commands: ['similar', 'playlist', 'flush'],
          enabled: 1, state: 'active', error: null, config: {} },
        { id: 'audiomuse', name: 'AudioMuse', version: '0.4.1', author: 'community',
          description: 'Sonic analysis: tempo, key and a similarity map of the library.',
          permissions: ['http:localhost:8008', 'library:read'],
          // Contributes an entry while being unable to run it: the case the menu
          // has to draw greyed rather than silently drop.
          contributes: { 'track.contextMenu': [{ id: 'am.analyse', label: 'Analyse with AudioMuse', command: 'analyse' }] },
          commands: [],
          enabled: 1, state: 'failed', error: 'Sidecar not reachable at http://localhost:8008', config: {} },
      ],
    }
  }
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
