/**
 * Contracts shared between the server and its clients.
 *
 * This package is the single source of truth for the shape of the data. The
 * first-party front end imports it the way any third party would import the
 * OpenAPI spec — it gets no privilege from doing so.
 */

export type TrackKind = 'music' | 'audiobook' | 'podcast'

export type Track = {
  id: string
  sourceId: string
  path: string
  kind: TrackKind
  name: string
  artist: string
  albumArtist: string
  album: string
  genre: string
  composer: string
  year: number
  trackNumber: number
  trackCount: number
  discNumber: number
  /** Seconds. Named `duration`, not `time`: it is a length, not a moment. */
  duration: number
  bitRate: number
  sampleRate: number
  format: string
  size: number
  rating: number
  loved: boolean
  /** The iTunes checkbox: does this track play in this list? */
  enabled: boolean
  comments: string
  grouping: string
  bpm: number
  compilation: boolean
  playCount: number
  skipCount: number
  dateAdded: number
  lastPlayed: number | null
  artwork: string | null
  /** Ids of the devices holding this track. Delivered with the page. */
  devices: string[]
  rev: number
}

/** The fields a client is allowed to change. */
export type TrackPatch = Partial<
  Pick<Track,
    | 'name' | 'artist' | 'albumArtist' | 'album' | 'genre' | 'composer' | 'year'
    | 'trackNumber' | 'discNumber' | 'bpm' | 'comments' | 'grouping'
    | 'rating' | 'loved' | 'enabled' | 'compilation' | 'kind'>
>

export type SmartRule = {
  field: 'rating' | 'playCount' | 'year' | 'genre' | 'artist' | 'albumArtist' | 'album'
       | 'dateAdded' | 'lastPlayed' | 'kind' | 'duration' | 'bpm'
  op: 'is' | 'isNot' | 'contains' | 'gte' | 'lte' | 'inLastDays' | 'isSet' | 'isNotSet'
  value?: string | number
}

export type SmartRules = { all?: SmartRule[]; any?: SmartRule[]; sort?: string; limit?: number }

export type Playlist = {
  id: string
  name: string
  /** Non-null = smart playlist: its contents are a query, not a list. */
  smart: string | null
  rules: SmartRules | null
  trackCount: number
  createdAt: number
  rev: number
}

export type Source = {
  id: string
  kind: 'local' | 'rclone' | 'plex' | 'emby' | 'jellyfin'
  name: string
  root: string
  /** Write capability, denied by default. Without it, no file is ever touched. */
  writable: 0 | 1
  lastScanAt: number | null
  rev: number
}

export type JobKind =
  | 'scan' | 'transcode' | 'fingerprint' | 'podcast' | 'writeback'
  | 'sync' | 'acquire' | 'analyze' | 'relay' | 'move' | 'backup'

export type JobState = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

/** Public view of a job: aggregates. Per-item detail is paginated separately. */
export type Job = {
  id: string
  kind: JobKind
  state: JobState
  progress: { done: number; total: number; bytes: number }
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type DeviceKind = 'ipod-classic' | 'ipod-nano' | 'ipod-shuffle' | 'iphone' | 'ipad'

export type Device = {
  id: string
  satelliteId: string | null
  name: string
  kind: DeviceKind
  model: string
  serial: string
  firmware: string
  capacity: number
  used: { audio: number; video: number; photos: number; apps: number; other: number }
  battery: number | null
  acceptedFormats: string[]
  autoSync: 0 | 1
  syncMode: 'all' | 'playlists'
  syncPlaylistIds: string[]
  charging: boolean
  connected: 0 | 1
  lastSync: number | null
  lastBackup: number | null
}

/** A track as it actually exists on the device. */
export type DeviceTrack = {
  deviceLocalId: string
  /** `null` = on the device but not in the library. Importable. */
  libraryTrackId: string | null
  name: string
  artist: string
  album: string
  duration: number
  size: number
  format: string
  /** Where the satellite will serve the bytes. Null means it cannot be imported. */
  sourceUrl: string | null
  syncedAt: number | null
}

/** What a sync would do. Returned by `POST /devices/:id/sync` with `dryRun`. */
export type SyncPlan = {
  add: { trackId: string; name: string; artist: string; size: number; transcode: string | null }[]
  remove: { deviceLocalId: string; name: string; size: number }[]
  keep: number
  bytesAdded: number
  bytesFreed: number
  free: number
  /** Non-null when the plan does not fit: how many bytes short it is. */
  shortBy: number | null
}

/** One unit of work inside a job — a track written, fetched or refused. */
export type JobItemState = 'pending' | 'done' | 'failed' | 'skipped'

export type JobItem = {
  idx: number
  ref: string
  state: JobItemState
  bytes: number
  error: string | null
}

/**
 * A page of job items, with totals over the *whole* job. Counting the page
 * would answer "3 of the 200 shown" when the question is "3 of 40000".
 */
export type JobItemsPage = {
  items: JobItem[]
  next: string | null
  counts: Record<JobItemState, number>
}

export type DeviceStats = { tracks: number; orphans: number; bytes: number; seconds: number }

/**
 * The outcome of hand-picking tracks for a device. Split three ways because a
 * drop of 200 tracks onto an iPod that already holds 180 of them should say so,
 * rather than claim it added 200.
 */
export type WantResult = { added: number; alreadyWanted: number; unknown: number }

/**
 * A recurring job. The cron expression is stored as written, not as a computed
 * next-fire time: that is what makes a schedule mean the same thing across a
 * restart and across a DST boundary.
 */
export type Schedule = {
  id: string
  name: string
  /** Five fields, local time: minute hour day-of-month month day-of-week. */
  cron: string
  kind: JobKind
  payload: unknown
  enabled: 0 | 1
  lastRunAt: number | null
  /** Local wall-clock minute of the last run — the identity of an occurrence. */
  lastRunKey: string | null
  lastJobId: string | null
}

export type Podcast = {
  id: string
  feedUrl: string
  title: string
  description: string
  author: string
  imageUrl: string | null
  siteUrl: string | null
  /** Per-feed refresh. `null` means manual only. */
  cron: string | null
  /** Newest N downloaded episodes kept on disk. 0 keeps every one. */
  keepLast: number
  autoDownload: 0 | 1
  targetSourceId: string | null
  targetPath: string
  lastFetchAt: number | null
  /** Why the last refresh failed. A feed dead for a month should say so. */
  lastError: string | null
  episodeCount: number
  downloadedCount: number
}

export type Episode = {
  id: string
  podcastId: string
  /** The feed's identity for this episode. Never the URL — those get rewritten. */
  guid: string
  title: string
  description: string
  pubDate: number | null
  duration: number
  episodeNumber: number | null
  season: number | null
  enclosureUrl: string | null
  enclosureLength: number
  enclosureType: string
  imageUrl: string | null
  /** Set once downloaded into the library. */
  trackId: string | null
  played: 0 | 1
  /** Resume point in seconds. */
  position: number
}

/** Cursor pagination. `next` of `null` means: last page. */
export type Page<T> = { items: T[]; next: string | null; revision?: number }

export type TracksDelta = { revision: number; changed: Track[]; deleted: string[] }

export type TrackQuery = {
  sort?: 'artist' | 'album' | 'name' | 'added' | '-artist' | '-album' | '-name' | '-added'
  cursor?: string
  limit?: number
  kind?: TrackKind
  q?: string
  genre?: string
  artist?: string
  album?: string
  sourceId?: string
  /** Present on these devices. */
  onDevice?: string
  /** Missing from these devices — "what is left to sync". */
  notOnDevice?: string
  /** `all`: on every listed device. `any` by default. */
  match?: 'any' | 'all'
}

export type ApiError = { error: { code: string; message: string; details?: unknown } }
