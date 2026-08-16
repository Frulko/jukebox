import type {
  Device, DeviceKind, DeviceStats, DeviceTrack, Job, Page, Playlist, SmartRules,
  Episode, JobItem, JobItemsPage, JobItemState, JobKind, JobState, MissingTrack, Podcast, Radio,
  Move, OrganizePlan, Plugin, PluginState, RestoreReport, Schedule, Source, Stats,
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
  fetch?: typeof globalThis.fetch
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

    tracks: {
      list: (q: TrackQuery = {}) => request<Page<Track>>(`/tracks${qs(q)}`, {}, true),
      /** Distinct values for the column browser, cascading. */
      facets: (q: TrackQuery = {}) =>
        request<{ genres: Facet[]; artists: Facet[]; albums: Facet[] }>(`/facets${qs(q)}`, {}, true),
      count: (q: TrackQuery = {}) => request<{ count: number }>(`/tracks/count${qs(q)}`, {}, true),
      /** Fetches only what changed since `since`. The main network win. */
      delta: (since: number, limit = 500) => request<TracksDelta>(`/tracks/delta${qs({ since, limit })}`),
      get: (id: string) => request<Track>(`/tracks/${id}`),
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
      /** Tracks whose file has gone. They keep their ratings and come back on rescan. */
      missing: (limit = 200) => request<{ items: MissingTrack[] }>(`/tracks/missing?limit=${limit}`),
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
      configure: (id: string, config: Record<string, unknown>) =>
        request<Plugin>(`/plugins/${id}`, { method: 'PATCH', body: JSON.stringify({ config }) }),
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

    sources: {
      list: () => request<{ items: Source[] }>('/sources', {}, true),
      create: (s: { id?: string; name: string; root: string; kind?: string; writable?: boolean }) =>
        request<Source>('/sources', { method: 'POST', body: JSON.stringify(s) }),
      /** `full` re-reads every file instead of trusting mtime and size. */
      scan: (id: string, full = false) =>
        request<Job>(`/sources/${id}/scan${full ? '?full=true' : ''}`, { method: 'POST' }),
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
     */
    events(handlers: { [event: string]: (data: any) => void }, topics?: string[]): () => void {
      const url = `${base}/events${topics?.length ? qs({ topics: topics.join(',') }) : ''}`
      const es = new EventSource(url)
      for (const [name, fn] of Object.entries(handlers)) {
        es.addEventListener(name, (e) => {
          try { fn(JSON.parse((e as MessageEvent).data)) } catch { /* partial frame: ignore */ }
        })
      }
      return () => es.close()
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
  Device, DeviceKind, DeviceStats, DeviceTrack, Job, Page, Playlist, SmartRules,
  Episode, JobItem, JobItemsPage, JobItemState, JobKind, JobState, MissingTrack, Podcast, Radio,
  Move, OrganizePlan, Plugin, PluginState, RestoreReport, Schedule, Source, Stats,
  StoreEntry, SyncPlan,
  Track, TrackPatch, TrackQuery,
  TracksDelta, WantResult,
}
