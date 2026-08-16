/**
 * Contracts shared between the server and its clients.
 *
 * This package is the single source of truth for the shape of the data. The
 * first-party front end imports it the way any third party would import the
 * OpenAPI spec — it gets no privilege from doing so.
 */

export type TrackKind = 'music' | 'audiobook' | 'podcast'

/**
 * One playable file of a track.
 *
 * A track is the song; a rendition is a file of it. The same music can exist as
 * FLAC for listening and AAC for an iPod, and that is one library entry rather
 * than two — a device that takes AAC and a browser that wants Opus are asking
 * for the same song.
 */
export type Rendition = {
  id: string
  format: string
  bitRate: number
  sampleRate: number
  channels: number
  size: number
  lossless: 0 | 1
  /** Exactly one per track: what a player gets and what a listing shows. */
  preferred: 0 | 1
  path: string
  sourceId: string
}

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
  /**
   * Every file of this track, preferred first. Delivered with the page.
   *
   * The flat `format`, `size` and `bitRate` above are the preferred one's, so a
   * client that does not care about renditions never has to look here.
   */
  renditions: Rendition[]
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

export type Radio = {
  id: string
  name: string
  streamUrl: string
  homepageUrl: string | null
  imageUrl: string | null
  genre: string
  country: string
  bitrate: number
  codec: string
  favorite: 0 | 1
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

/**
 * What a reorganisation would do. Returned by `POST /organize` without `apply`,
 * which is the default — the one operation that rewrites a disk is never a
 * single click.
 */
export type OrganizePlan = {
  moves: { trackId: string; from: string; to: string }[]
  /** Destinations two or more tracks both want. Nothing runs while any exist. */
  conflicts: { to: string; trackIds: string[] }[]
  unchanged: number
  /** Tracks the pattern could not render, and which field was empty. */
  skipped: { trackId: string; reason: string }[]
}

/** One file a reorganisation moved. The log, and what makes undo possible. */
export type Move = {
  id: number
  jobId: string
  trackId: string
  sourceId: string
  fromPath: string
  toPath: string
  movedAt: number
  undoneAt: number | null
}

/**
 * A plugin as a store index advertises it. `installable` is false when this
 * host is too old or too new for it, with the reason — better said before the
 * install than after it fails.
 */
export type StoreEntry = {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  hostApi: string
  tarball: string
  /** Checked when present: an index over HTTPS cannot vouch for bytes elsewhere. */
  sha256?: string
  permissions?: string[]
  installable: boolean
  reason?: string
}

/**
 * Rows that look like one song. Proposed, never merged automatically — two
 * different songs sharing a title is ordinary, and a wrong merge loses a
 * recording.
 */
export type DuplicateGroup = {
  /** Suggested keeper: the copy carrying plays and a rating, which cannot be recovered. */
  keeperId: string
  /** `fingerprint` compared the audio; `metadata` compared tags and length. */
  reason: 'fingerprint' | 'metadata'
  tracks: {
    id: string
    name: string
    artist: string
    album: string
    duration: number
    format: string
    size: number
    bitRate: number
    rating: number
    playCount: number
    renditions: number
  }[]
}

/**
 * What a plugin command answers. A closed set, so a menu can act on the result
 * without knowing anything about the plugin.
 *
 * `tracks` is separate from `playlist` because "find me more like this"
 * produces a selection: forcing it into a playlist litters the sidebar with
 * something the user then has to delete, and saving it should be their choice.
 */
export type CommandResult =
  | { kind: 'done'; message?: string }
  | { kind: 'job'; job: Job }
  | { kind: 'playlist'; id: string; name: string }
  | { kind: 'tracks'; ids: string[] }

export type PluginState = 'installed' | 'active' | 'failed' | 'disabled'

/**
 * An installed plugin.
 *
 * `permissions` are declared by the author and shown before install. They are
 * not enforced: a plugin runs in the server's own process and can do anything
 * the server can. That is the same bargain Home Assistant and Volumio make, and
 * the UI should say so plainly rather than imply a sandbox that is not there.
 */
export type Plugin = {
  id: string
  name: string
  version: string
  description: string
  author: string
  permissions: string[]
  /** Where the plugin asks to appear in the UI. */
  contributes: Record<string, unknown>
  enabled: 0 | 1
  state: PluginState
  /** Why it is not running. */
  error: string | null
  config: Record<string, unknown>
  /**
   * What can be invoked right now — not the same as what `contributes`
   * declares. An installed but stopped plugin contributes menu entries that
   * cannot run, and the UI should be able to tell those apart.
   */
  commands?: string[]
}

/** Library totals, computed in SQL over the whole library rather than a page. */
export type Stats = {
  tracks: number
  albums: number
  artists: number
  bytes: number
  seconds: number
  missing: number
  playlists: number
  podcasts: number
  radios: number
  sources: number
  devices: number
  jobs: Partial<Record<JobState, number>>
}

/** What a restore did. It adds, never replaces, so most of it is counts of skips. */
export type RestoreReport = {
  tracks: { matched: number; missing: number }
  playlists: { created: number; skipped: number }
  radios: { created: number; skipped: number }
  podcasts: { created: number; skipped: number }
  schedules: { created: number; skipped: number }
  devices: { updated: number }
}

/** A track whose file the scanner could not find. Soft deleted, never removed. */
export type MissingTrack = {
  id: string
  sourceId: string
  sourceName: string
  path: string
  name: string
  artist: string
  album: string
  duration: number
  rating: number
  playCount: number
  deletedAt: number
}

/** Where the music comes out. `local` means the client that is asking. */
export type PlayerTarget = { kind: 'local' } | { kind: 'output'; id: string; name: string }

/**
 * The shared queue.
 *
 * The server holds the intent — what is queued, which one is current, whether
 * it should be playing, where. A renderer executes it and reports its position
 * back. That separation is what makes controlling playback from one device
 * while it comes out of another work at all.
 */
export type PlayerState = {
  queue: string[]
  /** Index into `queue`. -1 when nothing is loaded. */
  index: number
  trackId: string | null
  playing: boolean
  position: number
  target: PlayerTarget
  repeat: 'off' | 'all' | 'one'
  shuffle: boolean
  /** Bumped on every change, so a client can tell its own echo from someone else's. */
  revision: number
  /** Which controller last changed it, from the `x-jukebox-client` header. */
  by: string | null
}

/**
 * Every playlist and device holding one track.
 *
 * Answered by the server because a client cannot: a smart playlist's membership
 * is a query rather than a stored list, so anything computed client-side would
 * be wrong for exactly the playlists people care most about.
 */
export type Memberships = {
  /** `position` is where it sits in a manual playlist, and null for a smart one. */
  playlists: { id: string; name: string; smart: string | null; position: number | null }[]
  /** `present` is on the device now; `wanted` is picked but not yet synced. */
  devices: { id: string; name: string; wanted: boolean; present: boolean }[]
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
  /**
   * Codec name, as the scanner stores it: `mp3`, `aac`, `alac`, `flac`, `opus`,
   * `vorbis`, `wav`, `aiff`. Not a container — an `.m4a` is `aac` or `alac`,
   * and an `.ogg` is `opus` or `vorbis`. Matched case-insensitively.
   */
  format?: string
  sourceId?: string
  /** Present on these devices. */
  onDevice?: string
  /** Missing from these devices — "what is left to sync". */
  notOnDevice?: string
  /** `all`: on every listed device. `any` by default. */
  match?: 'any' | 'all'
}

export type ApiError = { error: { code: string; message: string; details?: unknown } }
