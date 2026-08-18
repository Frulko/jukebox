import type {
  Account, Role,
  Device, DeviceKind, DeviceStats, DeviceTrack, Job, Page, Playlist, SmartRules,
  Episode, JobItem, JobItemsPage, JobItemState, JobKind, JobState, MissingTrack, Output, Podcast, Radio,
  RadioHit,
  CommandResult, DuplicateGroup, Memberships, Move, OrganizePlan, PlayerState, PlayerStream, PlayerTarget, Plugin,
  PluginState, Rendition,
  RestoreReport, Schedule,
  Source, SourceBrowse, SourceFavorite, Stats,
  StoreEntry, SyncPlan,
  Track, TrackPatch, TrackQuery,
  TracksDelta, WantResult,
} from '@jukebox/api-types'

/**
 * Client SDK.
 *
 * It uses nothing but the public API — that is the guarantee a third-party front
 * end can do exactly the same. If it needed one privileged route, the API's
 * openness would be a fiction.
 */

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  // No parameter properties (`constructor(readonly x)`): the project runs under
  // `--experimental-strip-types`, which erases types without emitting code.
  // Anything requiring a transform — parameter properties, enums, namespaces,
  // decorators — is forbidden here.
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type ApiErrorBody = { error?: { code?: string; message?: string } }

export type Facet = { value: string; count: number }

export type ClientOptions = {
  baseUrl?: string
  token?: string
  /** Names this controller in the shared player, e.g. "iPhone". */
  client?: string
  fetch?: typeof globalThis.fetch
  /**
   * How to open the event stream.
   *
   * A browser has `EventSource` and needs nothing here. Node does not — not in
   * every version, and not without a flag — so a server-side consumer of this
   * SDK could call `events()` and get "EventSource is not defined", which reads
   * as a bug in the SDK rather than a missing global. Passing one in is the
   * answer, and it is also how this gets tested.
   */
  eventSource?: (url: string) => EventSourceLike
}

/** The part of `EventSource` this uses, so a small shim satisfies it. */
export type EventSourceLike = {
  addEventListener: (type: string, listener: (e: { data: string }) => void) => void
  close: () => void
}

export function createClient(opts: ClientOptions = {}) {
  const base = (opts.baseUrl ?? '/api/v1').replace(/\/$/, '')
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)

  /** ETag remembered per resource: a 304 hands back the cached body, for free. */
  const etags = new Map<string, { etag: string; body: unknown }>()

  async function request<T>(path: string, init: RequestInit = {}, cacheable = false): Promise<T> {
    const url = base + path
    const headers = new Headers(init.headers)
    if (opts.token) headers.set('authorization', `Bearer ${opts.token}`)
    if (opts.client) headers.set('x-jukebox-client', opts.client)
    if (init.body) headers.set('content-type', 'application/json')

    const cached = cacheable ? etags.get(url) : undefined
    if (cached) headers.set('if-none-match', cached.etag)

    const res = await doFetch(url, { ...init, headers })

    // 304: the server says nothing moved. Zero bytes transferred.
    if (res.status === 304 && cached) return cached.body as T

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiErrorBody | null
      throw new ApiError(res.status, body?.error?.code ?? 'unknown', body?.error?.message ?? res.statusText)
    }

    const body = (await res.json()) as T
    const etag = res.headers.get('etag')
    if (cacheable && etag) etags.set(url, { etag, body })
    return body
  }

  const qs = (params: Record<string, unknown>) => {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
    }
    const s = sp.toString()
    return s ? `?${s}` : ''
  }

  return {
    health: () => request<{ ok: boolean; revision: number }>('/health'),
    /** The API described, generated from the router. Readable without a token. */
    openapi: () => request<Record<string, unknown>>('/openapi.json'),

    auth: {
      /** Whether this install has been claimed. Always answerable, signed in or not. */
      state: () => request<{ open: boolean; users: number }>('/auth/state'),
      /** Claims a fresh install. Refused once anyone exists. */
      setup: (username: string, password: string) =>
        request<{ user: unknown; token: string; id: string }>('/auth/setup', {
          method: 'POST', body: JSON.stringify({ username, password }),
        }),
      login: (username: string, password: string) =>
        request<{ user: unknown; token: string; id: string }>('/auth/login', {
          method: 'POST', body: JSON.stringify({ username, password }),
        }),
      me: () => request<unknown>('/auth/me'),
      tokens: () => request<{ items: unknown[] }>('/auth/tokens'),
      /** The secret is returned once and only its hash is kept. */
      createToken: (name: string) =>
        request<{ token: string; id: string }>('/auth/tokens', {
          method: 'POST', body: JSON.stringify({ name }),
        }),
      revoke: (id: string) => request<void>(`/auth/tokens/${id}`, { method: 'DELETE' }),
    },

    tracks: {
      list: (q: TrackQuery = {}) => request<Page<Track>>(`/tracks${qs(q)}`, {}, true),
      /** Distinct values for the column browser, cascading. */
      facets: (q: TrackQuery = {}) =>
        request<{
          genres: Facet[]; artists: Facet[]; albums: Facet[]; formats: Facet[]
          tags: Facet[]; folders: Facet[]
        }>(`/facets${qs(q)}`, {}, true),
      count: (q: TrackQuery = {}) => request<{ count: number }>(`/tracks/count${qs(q)}`, {}, true),
      /** Fetches only what changed since `since`. The main network win. */
      delta: (since: number, limit = 500) => request<TracksDelta>(`/tracks/delta${qs({ since, limit })}`),
      get: (id: string) => request<Track>(`/tracks/${id}`),
      /**
       * Adds and removes the listener's own tags on a set of tracks.
       *
       * Both in one call, and never "here are the tags now": this is offered on
       * a selection, and replacing would take every tag the selected tracks did
       * not have in common.
       */
      tag: (ids: string[], add: string[] = [], remove: string[] = []) =>
        request<{ tagged: number; untagged: number; revision: number }>('/tracks/tags', {
          method: 'POST', body: JSON.stringify({ ids, add, remove }),
        }),
      /**
       * Records that a track was listened to. Half its length or four minutes,
       * whichever comes first, and never under thirty seconds — anything less
       * is recorded as a skip. `startedAt` matters for a client that was
       * offline: the scrobble carries the time it actually happened.
       */
      play: (id: string, played: number, startedAt?: number) =>
        request<{ counted: boolean; playCount?: number; reason?: string }>(`/tracks/${id}/play`, {
          method: 'POST', body: JSON.stringify({ played, startedAt }),
        }),
      /**
       * Every playlist and device holding this track.
       *
       * Smart playlists are asked rather than read, so the answer matches what
       * the playlist would actually show.
       */
      memberships: (id: string) => request<Memberships>(`/tracks/${id}/memberships`),
      /** Tracks whose file has gone. They keep their ratings and come back on rescan. */
      missing: (limit = 200) => request<{ items: MissingTrack[] }>(`/tracks/missing?limit=${limit}`),
      /**
       * "That file is gone; this one is the same song."
       *
       * The missing row's rating, plays and playlist places move to the track
       * that still has a file. Not a merge: the missing file never crosses
       * over, because there is no file.
       */
      substitute: (keeperId: string, missingIds: string[]) =>
        request<{ keeperId: string; merged: number; renditions: number }>('/tracks/missing/substitute', {
          method: 'POST', body: JSON.stringify({ keeperId, missingIds }),
        }),
      /**
       * Single or bulk edit — same call either way. The database answers at
       * once; if tags go to disk, a job is returned.
       */
      patch: (ids: string[], patch: TrackPatch, writeToFiles = true) =>
        request<{ updated: number; revision: number; job: Job | null }>('/tracks', {
          method: 'PATCH',
          body: JSON.stringify({ ids, patch, writeToFiles }),
        }),
    },

    duplicates: {
      /** Proposes groups. Nothing merges until asked. */
      find: (limit = 200) => request<{ groups: DuplicateGroup[] }>(`/duplicates?limit=${limit}`),
      /** Folds `ids` into `keeperId`, moving their files across as renditions. */
      merge: (keeperId: string, ids: string[]) =>
        request<{ keeperId: string; merged: number; renditions: number }>('/duplicates/merge', {
          method: 'POST', body: JSON.stringify({ keeperId, ids }),
        }),
    },

    transcode: {
      /**
       * Whether this server can convert at all. ffmpeg is a binary on PATH, not
       * a dependency, so it may simply be absent — and a UI that offers
       * conversion anyway queues a job that fails once per track.
       */
      capabilities: () => request<{
        available: boolean; formats: string[]; ffmpeg: string | null
        fpcalc: string | null; reason: string | null
      }>('/transcode/capabilities'),
      /**
       * `replace: false` keeps both files as two renditions of one track, which
       * is the case worth having: an iPod that takes AAC and a browser that
       * wants the FLAC are the same song.
       */
      run: (p: { ids: string[]; format: string; quality?: string; replace?: boolean }) =>
        request<Job>('/transcode', { method: 'POST', body: JSON.stringify(p) }),
    },

    store: {
      /**
       * Browses an index. The URL is passed every time and there is no default:
       * installing from a store runs someone else's code as the server, so
       * which store is a deliberate choice rather than an inherited one.
       */
      browse: (index: string) =>
        request<{ items: StoreEntry[]; hostApi: string }>(`/store?index=${encodeURIComponent(index)}`),
      install: (index: string, id: string) =>
        request<{ id: string; version: string; files: number; plugin: Plugin }>('/store/install', {
          method: 'POST', body: JSON.stringify({ index, id }),
        }),
      uninstall: (id: string) => request<void>(`/store/${id}`, { method: 'DELETE' }),
    },

    plugins: {
      /** `hostApi` is the version a plugin must declare compatibility with. */
      list: () => request<{ items: Plugin[]; hostApi: string }>('/plugins', {}, true),
      get: (id: string) => request<Plugin>(`/plugins/${id}`),
      /** Re-reads the plugin folder. What fails to load is listed with the reason. */
      scan: () => request<{ items: Plugin[] }>('/plugins/scan', { method: 'POST' }),
      setEnabled: (id: string, enabled: boolean) =>
        request<Plugin>(`/plugins/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
      /**
       * Runs something a plugin contributed. Failures are 4xx with a reason:
       * 409 disabled, 404 unknown command, 504 timed out, 400 it threw.
       */
      command: (id: string, command: string, trackIds?: string[]) =>
        request<CommandResult>(`/plugins/${id}/command`, {
          method: 'POST', body: JSON.stringify({ command, trackIds }),
        }),
      configure: (id: string, config: Record<string, unknown>) =>
        request<Plugin>(`/plugins/${id}`, { method: 'PATCH', body: JSON.stringify({ config }) }),
    },

    /**
     * The shared queue. Every controller sees the same one.
     *
     * Send `x-jukebox-client` (via `createClient({ client })`) and the state
     * reports who last changed it, so a UI can say "paused from iPhone".
     */
    player: {
      get: () => request<PlayerState & { track: Track | null }>('/player'),
      setQueue: (trackIds: string[], startAt = 0) =>
        request<PlayerState>('/player/queue', { method: 'PUT', body: JSON.stringify({ trackIds, startAt }) }),
      /** `next: true` puts them after the current track rather than at the end. */
      enqueue: (trackIds: string[], next = false) =>
        request<PlayerState>('/player/queue', { method: 'POST', body: JSON.stringify({ trackIds, next }) }),
      clear: () => request<PlayerState>('/player/queue', { method: 'DELETE' }),
      play: () => request<PlayerState>('/player/play', { method: 'POST' }),
      pause: () => request<PlayerState>('/player/pause', { method: 'POST' }),
      next: () => request<PlayerState>('/player/next', { method: 'POST' }),
      previous: () => request<PlayerState>('/player/previous', { method: 'POST' }),
      seek: (position: number) =>
        request<PlayerState>('/player/seek', { method: 'POST', body: JSON.stringify({ position }) }),
      goTo: (trackId: string) =>
        request<PlayerState>('/player/goto', { method: 'POST', body: JSON.stringify({ trackId }) }),
      set: (patch: { target?: PlayerTarget; repeat?: PlayerState['repeat']; shuffle?: boolean }) =>
        request<PlayerState>('/player', { method: 'PATCH', body: JSON.stringify(patch) }),
      /** For a renderer: where it actually got to. It may not reorder anything. */
      report: (position: number, playing?: boolean) =>
        request<PlayerState>('/player/report', { method: 'POST', body: JSON.stringify({ position, playing }) }),
      /** A non-library stream — radio, feed episode — became what is playing. */
      stream: (stream: PlayerStream) =>
        request<PlayerState>('/player/stream', { method: 'POST', body: JSON.stringify({ stream }) }),
    },

    outputs: {
      /**
       * Where the music could come out, right now.
       *
       * Discovery is a live search, so this is a question about this moment
       * rather than a stored list — `refresh` forces a new one instead of the
       * server's 30-second cache. `advertising` is the address a renderer will
       * be told to fetch from, and it is here because when it is wrong every
       * play fails silently and that number is the explanation.
       */
      list: (refresh = false) =>
        request<{ items: Output[]; advertising: string }>(`/outputs${refresh ? '?refresh=true' : ''}`),
      volume: (id: string, volume: number) =>
        request<unknown>(`/outputs/${id}/volume`, { method: 'POST', body: JSON.stringify({ volume }) }),
    },

    organize: {
      /**
       * What it would do. Dry by default and by design: pass `apply` only once
       * the plan has been looked at, and it is refused outright while any two
       * tracks want the same destination.
       */
      plan: (sourceId: string, pattern: string) =>
        request<OrganizePlan>('/organize', { method: 'POST', body: JSON.stringify({ sourceId, pattern }) }),
      apply: (sourceId: string, pattern: string) =>
        request<Job & { plan: OrganizePlan }>('/organize', {
          method: 'POST', body: JSON.stringify({ sourceId, pattern, apply: true }),
        }),
      undo: (jobId: string) => request<Job>(`/organize/${jobId}/undo`, { method: 'POST' }),
      log: (limit = 200) => request<{ items: Move[] }>(`/organize/log?limit=${limit}`),
    },

    /** Totals over the whole library — never derivable from a page. */
    stats: () => request<Stats>('/stats', {}, true),

    /** Everything a rescan cannot rebuild. Credentials are excluded by default. */
    backup: (secrets = false) => request<unknown>(`/backup${secrets ? '?secrets=true' : ''}`),
    restore: (backup: unknown) =>
      request<RestoreReport>('/restore', { method: 'POST', body: JSON.stringify(backup) }),

    playlists: {
      list: () => request<{ items: Playlist[] }>('/playlists', {}, true),
      get: (id: string) => request<Playlist>(`/playlists/${id}`),
      tracks: (id: string, q: { cursor?: string; limit?: number } = {}) =>
        request<Page<Track>>(`/playlists/${id}/tracks${qs(q)}`),
      create: (p: { name: string; smart?: string; rules?: SmartRules; trackIds?: string[] }) =>
        request<Playlist>('/playlists', { method: 'POST', body: JSON.stringify(p) }),
      rename: (id: string, name: string) =>
        request<Playlist>(`/playlists/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
      remove: (id: string) => request<void>(`/playlists/${id}`, { method: 'DELETE' }),
      addTracks: (id: string, ids: string[], position?: number) =>
        request<{ added: number }>(`/playlists/${id}/tracks`, {
          method: 'POST', body: JSON.stringify({ ids, position }),
        }),
      removeTracks: (id: string, ids: string[]) =>
        request<{ removed: number }>(`/playlists/${id}/tracks`, {
          method: 'DELETE', body: JSON.stringify({ ids }),
        }),
      /** Moves a batch preserving its relative order — multi-selection drag and drop. */
      reorder: (id: string, ids: string[], toIndex: number) =>
        request<void>(`/playlists/${id}/order`, { method: 'PUT', body: JSON.stringify({ ids, toIndex }) }),
    },

    /**
     * Accounts. Admin only, and the server answers `403` rather than an empty
     * list to anyone else — which is the honest shape: "you may not see this"
     * and "there is nothing" are different answers.
     */
    users: {
      list: () => request<{ items: Account[] }>('/users', {}, true),
      create: (u: { username: string; password: string; role?: Role }) =>
        request<Account>('/users', { method: 'POST', body: JSON.stringify(u) }),
      update: (id: string, patch: { role?: Role; password?: string; subsonic?: boolean }) =>
        request<Account>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      remove: (id: string) => request<void>(`/users/${id}`, { method: 'DELETE' }),
      /** `null` means every source — an account that has never been narrowed. */
      sources: (id: string) => request<{ sourceIds: string[] | null }>(`/users/${id}/sources`),
      setSources: (id: string, sourceIds: string[]) =>
        request<{ sourceIds: string[] | null }>(`/users/${id}/sources`, {
          method: 'PUT', body: JSON.stringify({ sourceIds }),
        }),
    },

    sources: {
      list: () => request<{ items: Source[] }>('/sources', {}, true),
      // `config` is what a source needs beyond its root — an rclone daemon URL,
      // a Jellyfin API key. The route has always taken it; leaving it out of the
      // client meant no remote source could be created except by hand.
      create: (s: {
        id?: string; name: string; root: string; kind?: string
        writable?: boolean; config?: Record<string, unknown>
      }) =>
        request<Source>('/sources', { method: 'POST', body: JSON.stringify(s) }),
      /**
       * Rename it, let it be written to, or fix the settings it opens with.
       *
       * `config` merges key by key, so a client that was shown `secrets:
       * ['token']` rather than the token itself can change the port beside it
       * without echoing a credential it never had. An empty string clears a key.
       */
      update: (id: string, patch: {
        name?: string; writable?: boolean; config?: Record<string, unknown>
        /**
         * Replaced whole, unlike `config`: an emptied list has to be sayable.
         * A bare string is accepted and means a bookmark with no kind.
         */
        favorites?: Array<string | SourceFavorite>
      }) => request<Source>(`/sources/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      /**
       * One level of the source's folders — or, for the API-backed kinds, the
       * server's libraries. What proves a connection actually holds the music.
       */
      browse: (id: string, path = '') =>
        request<SourceBrowse>(`/sources/${id}/browse${qs({ path: path || undefined })}`),
      /**
       * The same look inside before the source exists. The root is immutable
       * once created, so this is the only moment it can be picked by walking;
       * the settings travel in the body, where a password belongs.
       */
      browseDraft: (draft: { root: string; kind?: string; config?: Record<string, unknown>; path?: string }) =>
        request<SourceBrowse>('/sources/browse', { method: 'POST', body: JSON.stringify(draft) }),
      /** Refused while the source still holds tracks: that is a different request. */
      remove: (id: string) => request<void>(`/sources/${id}`, { method: 'DELETE' }),
      /** `full` re-reads every file instead of trusting mtime and size. */
      scan: (id: string, full = false) =>
        request<Job>(`/sources/${id}/scan${full ? '?full=true' : ''}`, { method: 'POST' }),
      /**
       * Is it reachable *now*?
       *
       * Answers `200` either way: "the share is down" is an answer about the
       * source, not a failure of the request, and a client that has to catch an
       * exception to read it ends up unable to tell it from a server that is
       * itself unwell.
       */
      test: (id: string) =>
        request<{ ok: true; kind: string; name: string; version: string | null } | { ok: false; reason: string }>(
          `/sources/${id}/test`, { method: 'POST' }),
    },

    jobs: {
      list: (q: { state?: string; kind?: string; limit?: number } = {}) =>
        request<{ items: Job[] }>(`/jobs${qs(q)}`),
      get: (id: string) => request<Job>(`/jobs/${id}`),
      pause: (id: string) => request<Job>(`/jobs/${id}`, { method: 'PATCH', body: JSON.stringify({ action: 'pause' }) }),
      resume: (id: string) => request<Job>(`/jobs/${id}`, { method: 'PATCH', body: JSON.stringify({ action: 'resume' }) }),
      cancel: (id: string) => request<Job>(`/jobs/${id}`, { method: 'DELETE' }),
      /** What the job did, item by item — which tracks failed, not just how many. */
      items: (id: string, q: { cursor?: string; limit?: number; state?: JobItemState } = {}) =>
        request<JobItemsPage>(`/jobs/${id}/items${qs(q)}`),
    },

    radios: {
      list: () => request<{ items: Radio[] }>('/radios', {}, true),
      /** Stations the community directory proposes for a name, best-voted first. */
      search: (q: string) => request<{ items: RadioHit[] }>(`/radios/search${qs({ q })}`),
      get: (id: string) => request<Radio>(`/radios/${id}`),
      /**
       * Paste a URL, get a name, a genre and a logo. Pass `discover: false` to
       * skip the probe, `directory: false` to keep it off third-party servers.
       */
      create: (r: Partial<Radio> & { streamUrl: string; discover?: boolean; directory?: boolean }) =>
        request<Radio & { probeError: string | null }>('/radios', { method: 'POST', body: JSON.stringify(r) }),
      update: (id: string, patch: Partial<Radio>) =>
        request<Radio>(`/radios/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      remove: (id: string) => request<void>(`/radios/${id}`, { method: 'DELETE' }),
      /** Re-runs discovery, filling blanks only — it never undoes a rename. */
      discover: (id: string) =>
        request<Radio & { probeError: string | null }>(`/radios/${id}/discover`, { method: 'POST' }),
    },

    podcasts: {
      list: () => request<{ items: Podcast[] }>('/podcasts', {}, true),
      get: (id: string) => request<Podcast>(`/podcasts/${id}`),
      /** Subscribes and fetches straight away — a feed showing nothing looks broken. */
      subscribe: (p: { feedUrl: string; cron?: string | null; keepLast?: number; autoDownload?: boolean; targetSourceId?: string; targetPath?: string }) =>
        request<Podcast & { job: Job }>('/podcasts', { method: 'POST', body: JSON.stringify(p) }),
      update: (id: string, patch: Partial<Pick<Podcast, 'title' | 'cron' | 'keepLast' | 'targetSourceId' | 'targetPath'>> & { autoDownload?: boolean }) =>
        request<Podcast>(`/podcasts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      unsubscribe: (id: string) => request<void>(`/podcasts/${id}`, { method: 'DELETE' }),
      episodes: (id: string, q: { cursor?: string; limit?: number } = {}) =>
        request<Page<Episode>>(`/podcasts/${id}/episodes${qs(q)}`),
      refresh: (id: string) => request<Job>(`/podcasts/${id}/refresh`, { method: 'POST' }),
      /** Downloads one episode into the library, as a job. */
      download: (id: string, episodeId: string) =>
        request<Job>(`/podcasts/${id}/episodes/${episodeId}/download`, { method: 'POST' }),
    },

    schedules: {
      list: () => request<{ items: Schedule[] }>('/schedules', {}, true),
      create: (s: { name: string; cron: string; kind: JobKind; payload?: unknown; enabled?: boolean }) =>
        request<Schedule>('/schedules', { method: 'POST', body: JSON.stringify(s) }),
      update: (id: string, patch: Partial<Pick<Schedule, 'name' | 'cron' | 'payload'>> & { enabled?: boolean }) =>
        request<Schedule>(`/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      remove: (id: string) => request<void>(`/schedules/${id}`, { method: 'DELETE' }),
      /** Runs it now, without moving its next occurrence. */
      run: (id: string) => request<Job>(`/schedules/${id}/run`, { method: 'POST' }),
    },

    devices: {
      list: () => request<{ items: Device[] }>('/devices', {}, true),
      /** What is actually on the device, without going through the library. */
      tracks: (id: string, q: { cursor?: string; limit?: number; orphansOnly?: boolean } = {}) =>
        request<Page<DeviceTrack>>(`/devices/${id}/tracks${qs(q)}`),
      /** Satellite registration. Idempotent on the device id. */
      register: (d: Partial<Device> & { id: string; name: string; kind: string }) =>
        request<Device>('/devices', { method: 'POST', body: JSON.stringify(d) }),
      /** The satellite reports the device's real contents; the server matches. */
      report: (id: string, items: unknown[]) =>
        request<{ received: number; matched: number; orphans: number }>(`/devices/${id}/tracks`, {
          method: 'PUT', body: JSON.stringify({ items }),
        }),
      /** Pulls tracks the device has and the library does not. */
      importTracks: (id: string, deviceLocalIds: string[], targetSourceId: string, targetPath?: string) =>
        request<Job>(`/devices/${id}/import`, {
          method: 'POST',
          body: JSON.stringify({ deviceLocalIds, targetSourceId, targetPath }),
        }),
      stats: (id: string) => request<DeviceStats>(`/devices/${id}/stats`, {}, true),
      /** Hand-picks tracks for a device. They join the sync rules; the sync moves them. */
      want: (id: string, trackIds: string[]) =>
        request<WantResult>(`/devices/${id}/wanted`, {
          method: 'POST', body: JSON.stringify({ trackIds }),
        }),
      unwant: (id: string, trackIds: string[]) =>
        request<{ removed: number }>(`/devices/${id}/wanted`, {
          method: 'DELETE', body: JSON.stringify({ trackIds }),
        }),
      update: (id: string, patch: Partial<Pick<Device, 'name' | 'autoSync' | 'syncMode' | 'syncPlaylistIds'>>) =>
        request<Device>(`/devices/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      sync: (id: string) => request<Job>(`/devices/${id}/sync`, { method: 'POST', body: '{}' }),
      /** What the sync would do, without doing it. */
      syncPlan: (id: string) =>
        request<SyncPlan>(`/devices/${id}/sync`, { method: 'POST', body: JSON.stringify({ dryRun: true }) }),
      backup: (id: string) => request<Job>(`/devices/${id}/backup`, { method: 'POST', body: '{}' }),
      /** Disconnects without forgetting: contents, rules and picks all survive. */
      eject: (id: string) => request<{ ejected: boolean }>(`/devices/${id}/eject`, { method: 'POST' }),
    },

    /**
     * Event stream. One, filterable — the client never polls in a loop. Returns
     * a close function.
     *
     * The events a server sends: `hello` on connect (the revision and the
     * player, so a client that reconnects mid-song is not blank), `library`
     * when anything in the library changes, `player` for the shared queue,
     * `play` when a listen is recorded, and `job.progress`.
     *
     * `library` carries only a revision, deliberately. What to do with one is
     * `tracks.delta`, and `sync()` below is that loop written once.
     */
    events(handlers: { [event: string]: (data: any) => void }, topics?: string[]): () => void {
      const url = `${base}/events${topics?.length ? qs({ topics: topics.join(',') }) : ''}`
      const open = opts.eventSource
        ?? ((u: string) => {
          const Impl = (globalThis as any).EventSource
          if (!Impl) {
            throw new Error(
              'no EventSource in this runtime — pass one to createClient({ eventSource })')
          }
          return new Impl(u) as EventSourceLike
        })

      const es = open(url)
      for (const [name, fn] of Object.entries(handlers)) {
        es.addEventListener(name, (e) => {
          try { fn(JSON.parse(e.data)) } catch { /* partial frame: ignore */ }
        })
      }
      return () => es.close()
    },

    /**
     * Keeps a local copy of the library in step with the server.
     *
     * This is the five network rules used rather than described, and it exists
     * because every client otherwise writes it again: catch up with
     * `delta?since=`, then wait to be told rather than asking. A client that
     * polls a page is the thing the whole design was arranged to avoid.
     *
     * Two details are the difference between this working and appearing to:
     *
     * - **The catch-up loops.** A delta is capped, so a client resuming after a
     *   large import gets the cap, not everything. Stopping after one response
     *   leaves it quietly behind for ever, which looks like a server that
     *   dropped changes.
     * - **`deleted` is applied.** A soft-deleted track keeps its row on the
     *   server and vanishes from the page; a client that only merges `changed`
     *   goes on showing music that is gone.
     */
    sync(opts: {
      /** Called after every catch-up, with everything currently known. */
      onChange: (state: { tracks: Map<string, Track>; revision: number }) => void
      /** Resume from a revision held across a restart. `0` fetches everything. */
      since?: number
      /** Rows per request while catching up. */
      pageSize?: number
    }): { close: () => void; revision: () => number } {
      const tracks = new Map<string, Track>()
      const limit = opts.pageSize ?? 500
      let revision = opts.since ?? 0
      let running = false
      let again = false

      const catchUp = async () => {
        // One at a time: an event arriving mid-catch-up sets a flag rather than
        // starting a second overlapping walk of the same revisions.
        if (running) { again = true; return }
        running = true
        try {
          for (;;) {
            const delta = await request<TracksDelta>(`/tracks/delta${qs({ since: revision, limit })}`)
            for (const t of delta.changed) tracks.set(t.id, t)
            for (const id of delta.deleted) tracks.delete(id)

            const highest = delta.changed.reduce((n, t) => Math.max(n, t.rev ?? 0), revision)
            const done = delta.changed.length < limit && delta.deleted.length < limit
            revision = done ? delta.revision : Math.max(highest, revision)
            if (done) break
          }
          opts.onChange({ tracks, revision })
        } finally {
          running = false
          if (again) { again = false; void catchUp() }
        }
      }

      const close = this.events({
        // The revision in the event is not trusted as a cursor: it says
        // something moved, and the catch-up decides what.
        hello: () => void catchUp(),
        library: () => void catchUp(),
      })

      return { close, revision: () => revision }
    },

    /** Walks every page of a query. Reserve this for exports. */
    async *paginate(q: TrackQuery = {}): AsyncGenerator<Track[]> {
      let cursor: string | undefined
      for (;;) {
        const page = await request<Page<Track>>(`/tracks${qs({ ...q, cursor })}`)
        if (page.items.length) yield page.items
        if (!page.next) return
        cursor = page.next
      }
    },
  }
}

export type Client = ReturnType<typeof createClient>
export type {
  Account, Role,
  Device, DeviceKind, DeviceStats, DeviceTrack, Job, Page, Playlist, SmartRules,
  Episode, JobItem, JobItemsPage, JobItemState, JobKind, JobState, MissingTrack, Output, Podcast, Radio,
  RadioHit,
  CommandResult, DuplicateGroup, Memberships, Move, OrganizePlan, PlayerState, PlayerStream, PlayerTarget, Plugin,
  PluginState, Rendition,
  RestoreReport, Schedule,
  Source, SourceBrowse, SourceFavorite, Stats,
  StoreEntry, SyncPlan,
  Track, TrackPatch, TrackQuery,
  TracksDelta, WantResult,
}
