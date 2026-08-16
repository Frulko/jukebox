import type {
  Device, DeviceKind, DeviceStats, DeviceTrack, Job, Page, Playlist, SmartRules,
  Source, Track, TrackPatch, TrackQuery, TracksDelta,
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
       * Single or bulk edit — same call either way. The database answers at
       * once; if tags go to disk, a job is returned.
       */
      patch: (ids: string[], patch: TrackPatch, writeToFiles = true) =>
        request<{ updated: number; revision: number; job: Job | null }>('/tracks', {
          method: 'PATCH',
          body: JSON.stringify({ ids, patch, writeToFiles }),
        }),
    },

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
      scan: (id: string) => request<Job>(`/sources/${id}/scan`, { method: 'POST' }),
    },

    jobs: {
      list: (q: { state?: string; kind?: string; limit?: number } = {}) =>
        request<{ items: Job[] }>(`/jobs${qs(q)}`),
      get: (id: string) => request<Job>(`/jobs/${id}`),
      pause: (id: string) => request<Job>(`/jobs/${id}`, { method: 'PATCH', body: JSON.stringify({ action: 'pause' }) }),
      resume: (id: string) => request<Job>(`/jobs/${id}`, { method: 'PATCH', body: JSON.stringify({ action: 'resume' }) }),
      cancel: (id: string) => request<Job>(`/jobs/${id}`, { method: 'DELETE' }),
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
      update: (id: string, patch: Partial<Pick<Device, 'name' | 'autoSync' | 'syncMode' | 'syncPlaylistIds'>>) =>
        request<Device>(`/devices/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      sync: (id: string, opts: { dryRun?: boolean } = {}) =>
        request<Job>(`/devices/${id}/sync`, { method: 'POST', body: JSON.stringify(opts) }),
      backup: (id: string) => request<Job>(`/devices/${id}/backup`, { method: 'POST', body: '{}' }),
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
  Source, Track, TrackPatch, TrackQuery, TracksDelta,
}
