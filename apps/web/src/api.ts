import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient, useMutation, type QueryClient } from '@tanstack/react-query'
import { createClient, type Job, type Track, type TrackPatch, type TrackQuery } from '@jukebox/client-sdk'

/**
 * Front-end data access.
 *
 * It goes through the public API only, like any third-party client would. The
 * local cache is TanStack Query's; the network cache is the `ETag` handled by
 * the SDK, so a refresh that finds nothing new transfers zero bytes.
 */

export const api = createClient({
  baseUrl: import.meta.env.VITE_API_URL ?? '/api/v1',
})

/** Demo mode drives the Astro site: same components, fabricated data. */
export const DEMO = import.meta.env.VITE_DEMO === '1'

const keys = {
  tracks: (q: TrackQuery) => ['tracks', q] as const,
  count: (q: TrackQuery) => ['tracks', 'count', q] as const,
  playlists: ['playlists'] as const,
  sources: ['sources'] as const,
  devices: ['devices'] as const,
  jobs: ['jobs'] as const,
}

/**
 * One page of tracks.
 *
 * Deliberately **one page**, not the library: the table is virtualised and only
 * shows a window onto it. Loading 100,000 tracks to display thirty is exactly
 * what cursor pagination exists to avoid — and on armhf it would not fit in
 * memory.
 */
export function useTracks(query: TrackQuery, enabled = true) {
  return useQuery({
    queryKey: keys.tracks(query),
    queryFn: () => api.tracks.list(query),
    enabled,
    // Keep the current data on screen while refetching: changing the sort must
    // not flash the list empty.
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  })
}

export function useTrackCount(query: TrackQuery) {
  return useQuery({
    queryKey: keys.count(query),
    queryFn: () => api.tracks.count(query),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  })
}

export const usePlaylists = () =>
  useQuery({ queryKey: ['playlists'], queryFn: () => api.playlists.list() })

/**
 * The contents of a playlist. The column browser filters and the search box do
 * not apply to it server-side yet: a playlist is already a selection.
 */
export function usePlaylistTracks(playlistId: string | null, query: TrackQuery) {
  return useQuery({
    queryKey: ['playlists', playlistId, 'tracks', query.limit],
    queryFn: () => api.playlists.tracks(playlistId!, { limit: query.limit }),
    enabled: Boolean(playlistId),
    placeholderData: (prev) => prev,
  })
}

export const useFacets = (query: TrackQuery) =>
  useQuery({ queryKey: ['facets', query], queryFn: () => api.tracks.facets(query), staleTime: 60_000 })

export const useSources = () =>
  useQuery({ queryKey: keys.sources, queryFn: () => api.sources.list() })

export const useDevices = () =>
  useQuery({ queryKey: keys.devices, queryFn: () => api.devices.list(), staleTime: 10_000 })

/** Library totals, from SQL. The front cannot add these up: it only ever holds a page. */
export const useStats = () => useQuery({ queryKey: ['stats'], queryFn: () => api.stats(), staleTime: 30_000 })

/** Tracks whose file the last complete scan could not find. */
export const useMissing = (enabled = true) =>
  useQuery({ queryKey: ['tracks', 'missing'], queryFn: () => api.tracks.missing(), enabled })

export const useJobs = () =>
  useQuery({
    queryKey: keys.jobs,
    queryFn: () => api.jobs.list({ limit: 20 }),
    // Progress arrives over SSE normally. Demo mode has no server to push it,
    // so that one case polls — it is the only place in the app that does.
    refetchInterval: DEMO ? 1500 : false,
  })

/**
 * Single or multi edit — it is the same call, just as it is on the server. The
 * "Multiple Item Information" modal and the star rating on a row both go
 * through here.
 */
export function useUpdateTracks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ids, patch }: { ids: string[]; patch: TrackPatch }) => api.tracks.patch(ids, patch),
    // Optimistic update: rating a track has to respond instantly, not after a
    // network round trip.
    onMutate: async ({ ids, patch }) => {
      await qc.cancelQueries({ queryKey: ['tracks'] })
      const snapshot = qc.getQueriesData<{ items: Track[] }>({ queryKey: ['tracks'] })
      const set = new Set(ids)
      for (const [key, data] of snapshot) {
        if (!data?.items) continue
        qc.setQueryData(key, {
          ...data,
          items: data.items.map((t) => (set.has(t.id) ? { ...t, ...patch } : t)),
        })
      }
      return { snapshot }
    },
    onError: (_err, _vars, ctx) => {
      // The server refused: put back exactly what was on screen.
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['tracks'] }),
  })
}

export function useScanSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.sources.scan(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.jobs }),
  })
}

/**
 * A single event stream for the whole app.
 *
 * The client never polls: the server pushes. A job making progress refreshes
 * the job list; a finished job invalidates the library, because a scan has
 * probably just added tracks to it.
 */
export function useServerEvents(qc: QueryClient) {
  useEffect(() => {
    if (DEMO) return
    const close = api.events({
      'job.progress': (job: Job) => {
        qc.setQueryData<{ items: Job[] }>(keys.jobs, (old) =>
          old ? { items: [job, ...old.items.filter((j) => j.id !== job.id)].slice(0, 20) } : { items: [job] })
        if (job.state === 'done') {
          qc.invalidateQueries({ queryKey: ['tracks'] })
          qc.invalidateQueries({ queryKey: keys.sources })
        }
      },
      'library.changed': () => qc.invalidateQueries({ queryKey: ['tracks'] }),
      'device.connected': () => qc.invalidateQueries({ queryKey: keys.devices }),
    })
    return close
  }, [qc])
}

/** Is the server answering? Used to show an honest state instead of an empty list. */
export function useServerHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    retry: 1,
    staleTime: 60_000,
    enabled: !DEMO,
  })
}

/** Builds the query from the UI state — once per render. */
export function useTrackQuery(input: {
  view: { kind: string; id: string; smart?: string }
  search: string
  browse: { genre: string | null; artist: string | null; album: string | null }
  format?: string | null
  sort?: TrackQuery['sort']
  deviceFilter?: { deviceId: string; mode: 'on' | 'not' } | null
}): TrackQuery {
  return useMemo(() => {
    const q: TrackQuery = { limit: 300, sort: input.sort ?? 'artist' }
    if (input.search.trim()) q.q = input.search.trim()
    if (input.browse.genre) q.genre = input.browse.genre
    if (input.browse.artist) q.artist = input.browse.artist
    if (input.browse.album) q.album = input.browse.album
    if (input.format) q.format = input.format
    // Only the ids that are actually a kind of track. The library also holds
    // places — albums, artists, playlists, missing — and sending one of those
    // as `kind` would ask the server for a kind of music that does not exist.
    if (input.view.kind === 'library' && (input.view.id === 'podcasts' || input.view.id === 'audiobooks')) {
      q.kind = (input.view.id === 'podcasts' ? 'podcast' : 'audiobook') as never
    }
    if (input.deviceFilter) {
      if (input.deviceFilter.mode === 'on') q.onDevice = input.deviceFilter.deviceId
      else q.notOnDevice = input.deviceFilter.deviceId
    }
    return q
  }, [input.view.kind, input.view.id, input.search, input.browse.genre, input.browse.artist,
      input.browse.album, input.format, input.sort, input.deviceFilter?.deviceId, input.deviceFilter?.mode])
}
