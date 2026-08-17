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
import type {
  Device, DeviceTrack, Episode, Job, MissingTrack, Output, Playlist, Podcast, Radio, Source, Stats, SyncPlan,
  Track, TrackQuery,
} from '@jukebox/api-types'

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

/** The demo's copy of the server's player. Same shape, same rules. */
const player = {
  queue: [] as string[],
  index: -1,
  trackId: null as string | null,
  playing: false,
  position: 0,
  target: { kind: 'local' } as { kind: 'local' } | { kind: 'output'; id: string; name: string },
  repeat: 'off' as 'off' | 'all' | 'one',
  shuffle: false,
  revision: 0,
  by: null as string | null,
}

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
  // `rating=0` filters for never-rated; an absent key filters for nothing. The
  // difference only survives if the check is against undefined, not falsiness.
  if (q.rating !== undefined && t.rating !== Number(q.rating)) return false
  if (q.ratingMin !== undefined && t.rating < Number(q.ratingMin)) return false
  if (q.lossless !== undefined) {
    // A query string is all strings, and "false" is truthy — reading this
    // naively filters for exactly the opposite of what the chip says.
    const want = String(q.lossless) === 'true'
    const isLossless = ['flac', 'alac', 'wav', 'aiff'].includes(t.format.toLowerCase())
    if (isLossless !== want) return false
  }
  if (q.tag && !t.tags.includes(q.tag)) return false
  if (q.folder) {
    // Prefix with the separator forced on, exactly like the server: "Live"
    // must not swallow "Live Sessions".
    const prefix = q.folder.endsWith('/') ? q.folder : `${q.folder}/`
    if (!t.path.startsWith(prefix)) return false
  }
  if (q.missing) {
    // The same rules as the server's, including that `albumartist` is its own
    // gap: browsing by artist reads that column, so a track with an artist and
    // no album artist is in the library and unreachable from the Artists page.
    const gaps: Record<string, boolean> = {
      album: t.album === '',
      artist: t.artist === '' && t.albumArtist === '',
      albumartist: t.artist !== '' && t.albumArtist === '',
      genre: t.genre === '',
      year: t.year === 0,
      track: t.trackNumber === 0,
    }
    const hit = q.missing === 'any' ? Object.values(gaps).some(Boolean) : gaps[q.missing]
    if (!hit) return false
  }
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
  // Scoped by source like the server's, or the folder picker offers folders
  // from a source nobody chose.
  const base = tracks.filter((t) => match(t, { q: q.q, kind: q.kind, sourceId: q.sourceId }))
  const byGenre = base.filter((t) => match(t, { genre: q.genre }))
  const byArtist = byGenre.filter((t) => match(t, { artist: q.artist }))
  return {
    genres: count(base, (t) => t.genre),
    artists: count(byGenre, (t) => t.albumArtist),
    albums: count(byArtist, (t) => t.album),
    // Not cascaded, on purpose: computed through the format filter, picking
    // FLAC would leave FLAC as the only choice.
    formats: count(tracks, (t) => t.format),
    // A track carries several, so this counts pairs rather than tracks — the
    // one facet where a track can appear under more than one value.
    tags: count(tracks.flatMap((t) => t.tags.map((tag) => ({ ...t, tag }))) as (Track & { tag: string })[],
      (t) => (t as Track & { tag: string }).tag),
    // Everything up to the last slash, as the server's SQL does it.
    folders: count(tracks.filter((t) => t.path.includes('/')),
      (t) => t.path.slice(0, t.path.lastIndexOf('/') + 1)),
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

/**
 * What a sync would do, computed once from the fixture.
 *
 * The device holds forty tracks and the playlist it syncs holds twenty-five, so
 * a real plan has both halves: what has to go on, and what no longer belongs
 * there. A demo that only ever added would hide the half people are nervous
 * about.
 */
const PLAN: SyncPlan = (() => {
  const present = new Set(onDevice.map((t) => t.libraryTrackId))
  const add = tracks.filter((t) => !present.has(t.id)).slice(0, 14).map((t) => ({
    trackId: t.id,
    name: t.name,
    artist: t.artist,
    size: t.size,
    // The iPod takes mp3, aac, alac and wav; anything else is converted on the
    // way, and saying so beforehand is the point of a plan.
    transcode: ['mp3', 'aac', 'alac', 'wav'].includes(t.format) ? null : 'aac',
  }))
  const remove = onDevice.slice(30, 33).map((t) => ({
    deviceLocalId: t.deviceLocalId, name: t.name, size: t.size,
  }))
  const bytesAdded = add.reduce((a, t) => a + t.size, 0)
  const bytesFreed = remove.reduce((a, t) => a + t.size, 0)
  const used = Object.values(DEVICE.used).reduce((a, b) => a + b, 0)
  return {
    add, remove, keep: onDevice.length - remove.length, bytesAdded, bytesFreed,
    free: DEVICE.capacity - used,
    shortBy: null,
  }
})()

/**
 * Episodes for the two feeds.
 *
 * Half of the newest ones are downloaded and point at real tracks of this
 * library, so playing one goes through the queue exactly as the app claims;
 * the older ones exist only in the feed and carry a publisher URL. That split
 * is the whole point of the view, so a demo without both halves would show a
 * distinction it never has to make.
 */
/** Two feeds: one healthy, one that has been failing — both states the list must show. */
const FEEDS: Podcast[] = [
  { id: 'pod-vinyl', feedUrl: 'https://example.invalid/vinyl.xml', title: 'The Vinyl Hours',
    description: 'Long-form listening.', author: 'Frulko', imageUrl: null, siteUrl: null,
    cron: '0 7 * * *', keepLast: 10, autoDownload: 1, targetSourceId: 'demo', targetPath: 'Podcasts',
    lastFetchAt: Date.UTC(2026, 7, 16, 7), lastError: null, episodeCount: 128, downloadedCount: 10 },
  { id: 'pod-compression', feedUrl: 'https://example.invalid/compression.xml', title: 'Compression',
    description: 'Audio engineering, weekly.', author: 'anon', imageUrl: null, siteUrl: null,
    cron: '0 8 * * 1', keepLast: 5, autoDownload: 0, targetSourceId: 'demo', targetPath: 'Podcasts',
    lastFetchAt: Date.UTC(2026, 6, 2), lastError: 'Feed answered 404 for the last 6 weeks',
    episodeCount: 41, downloadedCount: 5 },
]

const EPISODES: Episode[] = [
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `ep-vinyl-${i}`,
    podcastId: 'pod-vinyl',
    guid: `vinyl-${i}`,
    title: [
      'Side one, over and over', 'The pressing plant problem', 'What a mastering engineer hears',
      'Two turntables and a phone', 'The record shop that would not close', 'On sleeve notes',
      'A crate in the attic', 'Why nobody agrees about warmth', 'The 45 that started it',
      'Static, and how to live with it', 'Reissues, honestly', 'Everything skips eventually',
    ][i],
    description: '',
    pubDate: Date.UTC(2026, 7, 16) - i * 7 * 864e5,
    duration: 2400 + i * 137,
    episodeNumber: 128 - i,
    season: 3,
    enclosureUrl: `https://example.invalid/vinyl/${i}.mp3`,
    enclosureLength: 42_000_000 + i * 1_100_000,
    enclosureType: 'audio/mpeg',
    imageUrl: null,
    // The ten most recent are on disk, which is what `keepLast: 10` means.
    trackId: i < 10 ? tracks[40 + i]?.id ?? null : null,
    played: (i > 3 ? 1 : 0) as 0 | 1,
    position: i === 3 ? 812 : 0,
  })),
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `ep-comp-${i}`,
    podcastId: 'pod-compression',
    guid: `comp-${i}`,
    title: [
      'Attack and release, again', 'The loudness war is over, we lost', 'Sidechains for people in a hurry',
      'Limiters that lie', 'A parallel chain worth having', 'Metering you can trust',
      'Room correction, cheaply', 'What the mix bus is for',
    ][i],
    description: '',
    pubDate: Date.UTC(2026, 6, 2) - i * 7 * 864e5,
    duration: 1800 + i * 90,
    episodeNumber: 41 - i,
    season: 1,
    enclosureUrl: `https://example.invalid/compression/${i}.mp3`,
    enclosureLength: 28_000_000 + i * 800_000,
    enclosureType: 'audio/mpeg',
    imageUrl: null,
    trackId: i < 5 ? tracks[60 + i]?.id ?? null : null,
    played: 0 as 0 | 1,
    position: 0,
  })),
]

/**
 * A downloaded episode is a track in the library, named after the episode.
 *
 * Pointing `trackId` at some music track instead would have the row say one
 * thing and the player say another, which is exactly the confusion this view
 * exists to remove. They carry `kind: 'podcast'`, so Songs does not list them
 * between two albums.
 */
for (const e of EPISODES) {
  if (!e.trackId) continue
  const show = e.podcastId === 'pod-vinyl' ? 'The Vinyl Hours' : 'Compression'
  const author = e.podcastId === 'pod-vinyl' ? 'Frulko' : 'anon'
  const base = tracks.find((t) => t.id === e.trackId)!
  tracks.push({
    ...base,
    id: `pt-${e.id}`,
    path: `Podcasts/${show}/${e.episodeNumber ?? 0}.mp3`,
    kind: 'podcast',
    name: e.title,
    artist: author,
    albumArtist: author,
    album: show,
    genre: 'Podcast',
    duration: e.duration,
    size: e.enclosureLength,
    devices: [],
    tags: [],
  })
  e.trackId = `pt-${e.id}`
}

/**
 * A handful of tracks with something left out.
 *
 * A fabricated library is perfectly tagged, which would leave the review page
 * empty and the sidebar entry absent — the demo would hide the one thing that
 * page is for. Blanked after generation rather than in the fixture, so the rest
 * of the library is unchanged.
 */
for (const [i, t] of tracks.entries()) {
  if (i % 47 === 3) t.album = ''
  if (i % 53 === 7) t.genre = ''
  if (i % 61 === 11) t.year = 0
  if (i % 71 === 13) t.trackNumber = 0
  // The rare one worth surfacing: an artist, no album artist.
  if (i % 137 === 19) t.albumArtist = ''
}

/**
 * Two audiobooks, as the library actually holds them: `kind: 'audiobook'`
 * tracks whose album is the book and whose track number is the chapter. Without
 * them the audiobooks page would be empty in the demo, and an empty page cannot
 * show that a chapter plays with the rest of the book behind it.
 */
for (const [book, author, chapters] of [
  ['The Long Way to a Small Angry Room', 'Ada Okonkwo', 11],
  ['Notes on a Quiet Machine', 'Sam Iyer', 7],
] as const) {
  for (let i = 1; i <= chapters; i++) {
    const base = tracks[i * 7]
    tracks.push({
      ...base,
      id: `ab-${book.slice(0, 4)}-${i}`,
      kind: 'audiobook',
      name: `Chapter ${i}`,
      artist: author,
      albumArtist: author,
      album: book,
      genre: 'Audiobook',
      trackNumber: i,
      discNumber: 1,
      duration: 1500 + i * 240,
      size: (1500 + i * 240) * 16000,
      format: 'm4b',
      devices: [],
      tags: [],
      rating: 0,
      playCount: 0,
    })
  }
}

/** A handful of stations, as the server stores them. */
const RADIOS: Radio[] = [
  // One station carries a logo, because that is what the probe returns when the
  // stream or the homepage has one, and the covers view has to be shown doing
  // both things: the real image here, a generated cover for the three below.
  // Inline rather than a remote favicon — the demo fetches nothing off-site.
  { id: 'r-1', name: 'FIP', streamUrl: 'https://icecast.radiofrance.fr/fip-midfi.mp3',
    homepageUrl: 'https://www.fip.fr',
    imageUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#e3253d"/><text x="50" y="62" font-family="Helvetica,Arial,sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">FIP</text></svg>`),
    genre: 'Eclectic', country: 'FR',
    bitrate: 128, codec: 'mp3', favorite: 1 },
  { id: 'r-2', name: 'NTS 1', streamUrl: 'https://stream-relay-geo.ntslive.net/stream',
    homepageUrl: 'https://www.nts.live', imageUrl: null, genre: 'Eclectic', country: 'GB',
    bitrate: 128, codec: 'mp3', favorite: 0 },
  { id: 'r-3', name: 'SomaFM Groove Salad', streamUrl: 'https://ice1.somafm.com/groovesalad-128-mp3',
    homepageUrl: 'https://somafm.com', imageUrl: null, genre: 'Ambient', country: 'US',
    bitrate: 128, codec: 'mp3', favorite: 0 },
  // One with nothing known, which is what a station added from a bare URL that
  // did not answer looks like.
  { id: 'r-4', name: 'http://stream.example.invalid/live', streamUrl: 'http://stream.example.invalid/live',
    homepageUrl: null, imageUrl: null, genre: '', country: '', bitrate: 0, codec: '', favorite: 0 },
]

/**
 * Speakers, as a network would answer.
 *
 * One of each kind the server knows how to drive, because the picker's whole
 * job is telling them apart — and one satellite gone quiet, which is the state
 * that has to be shown rather than hidden: somebody's Pi, unplugged, still
 * worth listing.
 */
const OUTPUTS: Output[] = [
  { id: 'ap-living', name: 'Living Room', kind: 'airplay', manufacturer: 'Apple', model: 'HomePod',
    address: '192.168.1.24:7000', formats: [], stale: false, volume: false },
  { id: 'upnp-kitchen', name: 'Kitchen', kind: 'upnp', manufacturer: 'Sonos', model: 'Play:1',
    address: 'http://192.168.1.31:1400', formats: [], stale: false, volume: true },
  { id: 'cast-desk', name: 'Desk', kind: 'cast', manufacturer: 'Google', model: 'Chromecast Audio',
    address: '192.168.1.44:8009', formats: [], stale: false, volume: true },
  { id: 'sat-attic', name: 'Attic Pi', kind: 'satellite', manufacturer: '', model: '',
    address: 'http://192.168.1.57:8788', formats: ['flac', 'mp3'], stale: true },
]

const SOURCES: Source[] = [
  // With its mount, as the real route reports it: a UI that can say "this share
  // is not mounted" instead of showing an empty library needs the answer to
  // exist even when it is the reassuring one.
  // Writable, so importing off the iPod is something the demo can actually
  // show: with no writable source the page can only explain why the button is
  // not there, which is the one thing the page is for.
  // Somebody else's server, which is what "a library shared with you" is until
  // the peer-to-peer version exists.
  { id: 'friend', kind: 'jellyfin', name: "Camille's Jellyfin", root: 'https://jelly.camille.invalid',
    writable: 0, lastScanAt: Date.UTC(2026, 7, 15), rev: 1,
    config: { url: 'https://jelly.camille.invalid' } } as Source,
  { id: 'demo', kind: 'local', name: 'Demo library', root: '/music', writable: 1,
    lastScanAt: Date.UTC(2026, 7, 16), rev: 1,
    mount: { device: '/dev/disk3s5', type: 'apfs', network: false, readOnly: false, point: '/' } } as Source,
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

/**
 * A sync in flight, when one has been started.
 *
 * The scan above is scenery — it runs for ever so the display has something to
 * cycle to. This one is the opposite: it exists only because somebody pressed
 * the button, it takes about as long as a real transfer looks like it should,
 * and it ends. Without it the demo would show a task list that never changes
 * whatever you do to it, which is the sort of thing that reads as broken.
 */
let syncStartedAt: number | null = null

function syncing(): Job | null {
  if (syncStartedAt === null) return null
  const total = PLAN.add.length + PLAN.remove.length
  const elapsed = (Date.now() - syncStartedAt) / 1000
  const done = Math.min(total, Math.floor(elapsed * 1.4))
  const finished = done >= total
  // Kept for a few seconds after the last track so the panel can say it
  // finished; a job that vanishes at 100 % looks like one that was cancelled.
  if (finished && elapsed > total / 1.4 + 4) {
    syncStartedAt = null
    return null
  }
  return {
    id: 'job-sync',
    kind: 'sync',
    state: finished ? 'done' : 'running',
    progress: { done, total, bytes: PLAN.bytesAdded * (total ? done / total : 0) },
    error: null,
    createdAt: syncStartedAt,
    startedAt: syncStartedAt,
    finishedAt: finished ? syncStartedAt + (total / 1.4) * 1000 : null,
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

/**
 * A refusal the demo makes on purpose.
 *
 * The two the podcast field can provoke — a URL that is not one, and a feed
 * already subscribed to — are the server's own, and a demo that accepted
 * everything would teach that the field cannot be got wrong.
 */
class DemoError extends Error {
  // Longhand rather than parameter properties: those *emit* assignments, and
  // this repository's guardrail refuses any TypeScript that is more than types.
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Returns the body for a route, or `undefined` when the demo has nothing to say. */
function route(path: string, params: URLSearchParams, method: string, body: string | null): unknown {
  const q = Object.fromEntries(params) as TrackQuery

  /* ---- the shared queue ----
     The server holds the queue; the front is one controller among several. The
     demo therefore has to hold one too, with the same rules — otherwise the
     demo would teach that "add to queue" is a local array, which is exactly
     what it stopped being. Same semantics as `apps/server/src/player.ts`:
     repeat one is the renderer's business, shuffle picks at random, and the end
     of the list only wraps when repeat is `all`. */
  if (path.startsWith('/player')) {
    const b = JSON.parse(body ?? '{}') as Record<string, any>
    const at = (i: number) => {
      player.index = i
      player.trackId = player.queue[i] ?? null
      player.position = 0
    }
    if (path === '/player' && method === 'GET') {
      return { ...player, track: tracks.find((t) => t.id === player.trackId) ?? null }
    }
    if (path === '/player' && method === 'PATCH') {
      if (b.repeat !== undefined) player.repeat = b.repeat
      if (b.shuffle !== undefined) player.shuffle = b.shuffle
      // Where the music comes out. The real server refuses an id it cannot
      // find on the network, which is the case a picker has to survive.
      if (b.target !== undefined) {
        if (b.target.kind === 'output' && !OUTPUTS.some((o) => o.id === b.target.id)) {
          throw new DemoError(404, 'not_found', 'unknown output; try GET /outputs?refresh=true')
        }
        player.target = b.target.kind === 'output'
          ? { kind: 'output', id: b.target.id, name: b.target.name }
          : { kind: 'local' }
      }
    }
    if (path === '/player/queue' && method === 'PUT') {
      player.queue = [...(b.trackIds ?? [])]
      at(Number(b.startAt) || 0)
      player.playing = player.queue.length > 0
    }
    if (path === '/player/queue' && method === 'POST') {
      const ids: string[] = b.trackIds ?? []
      if (player.index < 0) {
        player.queue = [...ids]
        at(0)
      } else if (b.next) {
        player.queue = [
          ...player.queue.slice(0, player.index + 1), ...ids, ...player.queue.slice(player.index + 1),
        ]
      } else {
        player.queue = [...player.queue, ...ids]
      }
    }
    if (path === '/player/queue' && method === 'DELETE') {
      player.queue = []
      player.index = -1
      player.trackId = null
      player.playing = false
    }
    if (path === '/player/play') player.playing = player.index >= 0
    if (path === '/player/pause') player.playing = false
    if (path === '/player/seek') player.position = Math.max(0, Number(b.position) || 0)
    if (path === '/player/goto') {
      const i = player.queue.indexOf(String(b.trackId))
      if (i >= 0) { at(i); player.playing = true }
    }
    if (path === '/player/next' || path === '/player/previous') {
      const dir = path.endsWith('next') ? 1 : -1
      if (player.queue.length) {
        if (player.shuffle && dir === 1) {
          at(Math.floor(Math.random() * player.queue.length))
          player.playing = true
        } else {
          const next = player.index + dir
          if (next >= player.queue.length) {
            if (player.repeat === 'all') { at(0); player.playing = true }
            else { player.playing = false; player.position = 0 }
          } else if (next < 0) {
            // Back from the first track restarts it rather than wrapping.
            player.position = 0
          } else {
            at(next)
            player.playing = true
          }
        }
      }
    }
    player.revision++
    return { ...player, track: tracks.find((t) => t.id === player.trackId) ?? null }
  }

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
  if (path.startsWith('/outputs') && method === 'GET') {
    return { items: OUTPUTS, advertising: 'http://192.168.1.10:8787' }
  }
  const outVolume = path.match(/^\/outputs\/([^/]+)\/volume$/)
  if (outVolume && method === 'POST') {
    const out = OUTPUTS.find((o) => o.id === outVolume[1])
    // The real refusal, kept: AirPlay's volume lives in RTSP, which the server
    // deliberately does not speak, and a demo that quietly accepted it would
    // teach the interface a lie.
    if (out && out.volume === false) {
      throw new DemoError(501, 'not_supported', 'AirPlay volume is not available over its HTTP interface')
    }
    return null
  }
  if (path === '/tracks/missing') return { items: MISSING }
  if (path === '/tracks/missing/substitute' && method === 'POST') {
    // The same rules as the server's: the keeper must still have a file, the
    // row being answered must be one of the missing ones, and the history
    // crosses over. The row then leaves this list — it is no longer a question.
    const b = JSON.parse(body ?? '{}') as { keeperId?: string; missingIds?: string[] }
    const keeper = tracks.find((t) => t.id === b.keeperId)
    if (!keeper) throw new DemoError(404, 'not_found', 'unknown or deleted keeper track')
    let merged = 0
    for (const id of b.missingIds ?? []) {
      const i = MISSING.findIndex((m) => m.id === id)
      if (i < 0) continue
      const [row] = MISSING.splice(i, 1)
      keeper.playCount += row.playCount
      keeper.rating = Math.max(keeper.rating, row.rating)
      merged++
    }
    return { keeperId: b.keeperId, merged, renditions: 0 }
  }
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
  const eps = path.match(/^\/podcasts\/([^/]+)\/episodes$/)
  if (eps) return { items: EPISODES.filter((e) => e.podcastId === eps[1]), next: null }
  if (path === '/podcasts' && method === 'POST') {
    const b = JSON.parse(body ?? '{}') as { feedUrl?: string }
    const url = (b.feedUrl ?? '').trim()
    // The same two refusals the server makes, in the same order: a bad URL is
    // an error when it is typed, and subscribing twice is not a subscription.
    let host = ''
    try {
      const u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme')
      host = u.hostname
    } catch {
      throw new DemoError(400, 'bad_feed_url', 'expected an http or https URL')
    }
    if (FEEDS.some((f) => f.feedUrl === url)) {
      throw new DemoError(409, 'already_subscribed', 'already subscribed to this feed')
    }
    const added = {
      ...FEEDS[0],
      id: `pod-${FEEDS.length + 1}`,
      feedUrl: url,
      title: host.replace(/^www\./, ''),
      description: '',
      author: host,
      cron: '0 7 * * *',
      lastFetchAt: Date.now(),
      lastError: null,
      episodeCount: 0,
      downloadedCount: 0,
    }
    FEEDS.push(added)
    return { ...added, job: scanning() }
  }
  const podRefresh = path.match(/^\/podcasts\/([^/]+)\/refresh$/)
  if (podRefresh && method === 'POST') {
    const f = FEEDS.find((x) => x.id === podRefresh[1])
    if (f) f.lastFetchAt = Date.now()
    return scanning()
  }
  const pod = path.match(/^\/podcasts\/([^/]+)$/)
  if (pod && method === 'DELETE') {
    const i = FEEDS.findIndex((x) => x.id === pod[1])
    if (i >= 0) FEEDS.splice(i, 1)
    return null
  }
  if (pod && method === 'PATCH') {
    const f = FEEDS.find((x) => x.id === pod[1])
    if (!f) return undefined
    const b = JSON.parse(body ?? '{}') as Record<string, unknown>
    if (b.autoDownload !== undefined) f.autoDownload = (b.autoDownload ? 1 : 0) as 0 | 1
    if (typeof b.keepLast === 'number') f.keepLast = b.keepLast
    if (b.cron !== undefined) f.cron = b.cron as string | null
    return f
  }
  const srcTest = path.match(/^\/sources\/([^/]+)\/test$/)
  if (srcTest && method === 'POST') {
    const src = SOURCES.find((x) => x.id === srcTest[1])
    // Answers 200 either way, like the server: "the share is down" is an answer
    // about the source, not a failure of the request.
    if (!src) return { ok: false, reason: 'unknown source' }
    // A remote kind answers with a server name and a version, as a real Plex or
    // Jellyfin does; a folder answers with its path.
    return src.kind === 'local'
      ? { ok: true, kind: src.kind, name: src.root, version: null }
      : { ok: true, kind: src.kind, name: `${src.kind} at ${src.root}`, version: '10.9.0' }
  }
  if (path === '/sources' && method === 'POST') {
    // The kind and the write capability come from the body, as the real route
    // takes them: a demo that filed every source under "local" could not show
    // the one thing the dialog is for.
    const b = JSON.parse(body ?? '{}') as
      { name?: string; root?: string; kind?: Source['kind']; writable?: boolean }
    if (!b.name || !b.root) throw new DemoError(400, 'bad_body', 'expected { name, root }')
    const added: Source = {
      id: `src-${SOURCES.length + 1}`, kind: b.kind ?? 'local', name: b.name, root: b.root,
      writable: b.writable ? 1 : 0, lastScanAt: null, rev: 1,
    }
    SOURCES.push(added)
    return added
  }
  if (path === '/radios' && method === 'GET') return { items: RADIOS }
  if (path === '/radios' && method === 'POST') {
    const b = JSON.parse(body ?? '{}') as { streamUrl?: string }
    let host = ''
    try {
      host = new URL(b.streamUrl ?? '').hostname
    } catch {
      throw new DemoError(400, 'bad_stream_url', 'expected an http or https URL')
    }
    // The server probes the stream and fills what it learns; the demo invents
    // the same shape, including the case where nothing answered.
    const answered = !host.includes('invalid')
    const made = {
      id: `r-${RADIOS.length + 1}`,
      name: answered ? host.replace(/^www\./, '') : (b.streamUrl ?? ''),
      streamUrl: b.streamUrl ?? '',
      homepageUrl: answered ? `https://${host}` : null,
      imageUrl: null,
      genre: answered ? 'Unfiled' : '',
      country: answered ? 'FR' : '',
      bitrate: answered ? 128 : 0,
      codec: answered ? 'mp3' : '',
      favorite: 0 as 0 | 1,
    }
    RADIOS.push(made)
    return { ...made, probeError: answered ? null : 'the stream did not answer' }
  }
  const radio = path.match(/^\/radios\/([^/]+)$/)
  if (radio && method === 'PATCH') {
    const r = RADIOS.find((x) => x.id === radio[1])
    if (!r) return undefined
    Object.assign(r, JSON.parse(body ?? '{}'))
    return r
  }
  if (radio && method === 'DELETE') {
    const i = RADIOS.findIndex((x) => x.id === radio[1])
    if (i >= 0) RADIOS.splice(i, 1)
    return null
  }
  const radioProbe = path.match(/^\/radios\/([^/]+)\/discover$/)
  if (radioProbe && method === 'POST') {
    const r = RADIOS.find((x) => x.id === radioProbe[1])
    if (!r) return undefined
    // Fills blanks only, like the real one: it never undoes a rename.
    if (!r.genre) r.genre = 'Unfiled'
    if (!r.bitrate) r.bitrate = 128
    return { ...r, probeError: null }
  }
  if (path === '/podcasts') return { items: FEEDS }
  if (path === '/tracks/tags' && method === 'POST') {
    const b = JSON.parse(body ?? '{}') as { ids?: string[]; add?: string[]; remove?: string[] }
    const clean = (l: string[] = []) => [...new Set(l.map((t) => t.trim().toLowerCase()).filter(Boolean))]
    const add = clean(b.add)
    const remove = new Set(clean(b.remove))
    let tagged = 0
    let untagged = 0
    for (const id of b.ids ?? []) {
      const t = tracks.find((x) => x.id === id)
      if (!t) continue
      const before = t.tags.length
      t.tags = t.tags.filter((x) => !remove.has(x))
      untagged += before - t.tags.length
      for (const tag of add) {
        if (!t.tags.includes(tag)) { t.tags.push(tag); tagged++ }
      }
      t.tags.sort()
    }
    return { tagged, untagged, revision: ++revision }
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
    if (command === 'words') {
      // The words are invented, like everything else in this library: the real
      // plugin fetches them from LRCLIB, which has nothing to say about songs
      // that do not exist.
      const t = tracks.find((x) => x.id === trackIds?.[0])
      if (!t) return { kind: 'text', body: 'No track.' }
      return {
        kind: 'text',
        title: `${t.name} — ${t.artist}`,
        body: [
          'The needle finds the groove again,', 'and the room is a little warmer.',
          '', 'Nothing here was ever filed,', 'nothing here was ever lost.',
          '', '(instrumental break)', '',
          'Play it once and play it twice,', 'the second time it means something else.',
        ].join('\n'),
      }
    }
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
        // Contributes a *place* rather than an action: the information window
        // grows a tab, and the host draws whatever the command answers.
        { id: 'lyrics', name: 'Lyrics', version: '1.0.0', author: 'jukebox',
          description: 'Shows the words of a track, fetched from LRCLIB.',
          permissions: ['network:lrclib.net'],
          contributes: { 'track.tab': [{ id: 'lyrics.words', label: 'Lyrics', command: 'words' }] },
          commands: ['words'],
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
  if (path === '/users') {
    return {
      items: [
        { id: 'u1', username: 'mowmow', role: 'admin', subsonic: 1,
          createdAt: Date.UTC(2026, 0, 4), lastSeenAt: Date.now() - 3600_000 },
        // Someone the library is shared *with*: narrowed, read-only, and using
        // a Subsonic client rather than this interface.
        { id: 'u2', username: 'camille', role: 'guest', subsonic: 1,
          createdAt: Date.UTC(2026, 5, 12), lastSeenAt: Date.now() - 4 * 864e5 },
      ],
    }
  }
  if (path === '/sources') return { items: SOURCES }
  // A rescan in the demo has nothing to walk, so it answers with the job it
  // would have started and the scan job already on display keeps running.
  if (path.startsWith('/sources/') && path.endsWith('/scan') && method === 'POST') return scanning()
  if (path === '/devices') return { items: [DEVICE] }
  if (path === '/jobs') {
    // What the queue has done lately, not only what is moving: the failed one
    // is the row this tab exists for.
    const past: Job[] = [
      { id: 'job-writeback', kind: 'writeback', state: 'done',
        progress: { done: 42, total: 42, bytes: 0 }, error: null,
        createdAt: Date.now() - 3600_000, startedAt: Date.now() - 3590_000, finishedAt: Date.now() - 3300_000 },
      { id: 'job-transcode', kind: 'transcode', state: 'failed',
        progress: { done: 7, total: 19, bytes: 0 }, error: 'ffmpeg is not installed on this machine',
        createdAt: Date.now() - 7200_000, startedAt: Date.now() - 7190_000, finishedAt: Date.now() - 7100_000 },
      { id: 'job-podcast', kind: 'podcast', state: 'done',
        progress: { done: 3, total: 3, bytes: 0 }, error: null,
        createdAt: Date.now() - 86400_000, startedAt: Date.now() - 86390_000, finishedAt: Date.now() - 86300_000 },
    ]
    return { items: [syncing(), scanning(), ...past].filter(Boolean) }
  }
  if (path === `/devices/${DEVICE.id}/import` && method === 'POST') {
    const b = JSON.parse(body ?? '{}') as { deviceLocalIds?: string[] }
    // Importing off a device is a job like any other — the satellite serves the
    // bytes and the library gains a track when it lands.
    for (const localId of b.deviceLocalIds ?? []) {
      const row = onDevice.find((t) => t.deviceLocalId === localId)
      if (!row || row.libraryTrackId) continue
      const id = `imp-${localId}`
      tracks.push({
        ...tracks[0], id, name: row.name, artist: row.artist, albumArtist: row.artist,
        album: row.album, duration: row.duration, size: row.size, format: row.format,
        devices: [DEVICE.id], tags: [], rating: 0, playCount: 0, dateAdded: Date.now(),
      })
      row.libraryTrackId = id
    }
    return scanning()
  }
  if (path === `/devices/${DEVICE.id}/sync` && method === 'POST') {
    const b = JSON.parse(body ?? '{}') as { dryRun?: boolean }
    // Asking is free and acting is not: the plan is what the first click gets.
    if (b.dryRun) return PLAN
    syncStartedAt = Date.now()
    return syncing()
  }
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
    let data: unknown
    try {
      data = route(url.pathname.slice(at + 7), url.searchParams, method, payload)
    } catch (err) {
      if (!(err instanceof DemoError)) throw err
      return json({ error: { code: err.code, message: err.message } }, err.status)
    }
    return data === undefined
      ? json({ error: { code: 'not_in_demo', message: `${method} ${url.pathname} is not part of the demo` } }, 404)
      : json(data)
  }
}
