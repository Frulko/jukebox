import { useEffect, useMemo } from 'react'
import { t } from './i18n'
import { useQuery, useQueryClient, useMutation, type QueryClient } from '@tanstack/react-query'
import {
  createClient, type Job, type PlayerState, type Track, type TrackPatch, type TrackQuery,
} from '@jukebox/client-sdk'

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
  player: ['player'] as const,
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

export function useTrackCount(query: TrackQuery, enabled = true) {
  return useQuery({
    queryKey: keys.count(query),
    queryFn: () => api.tracks.count(query),
    enabled,
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

/**
 * Tags on a selection.
 *
 * Optimistic like the patch above, and for the same reason: ticking a tag in a
 * menu has to look done before the round trip. The facets go too — a tag that
 * has just appeared in the library belongs in the filter that lists them.
 */
export function useTagTracks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ids, add = [], remove = [] }: { ids: string[]; add?: string[]; remove?: string[] }) =>
      api.tracks.tag(ids, add, remove),
    onMutate: async ({ ids, add = [], remove = [] }) => {
      await qc.cancelQueries({ queryKey: ['tracks'] })
      const snapshot = qc.getQueriesData<{ items: Track[] }>({ queryKey: ['tracks'] })
      const set = new Set(ids)
      // The same cleaning the server does, or the optimistic row shows "Chill"
      // for the second it takes the answer to say "chill".
      const clean = (l: string[]) => l.map((t) => t.trim().toLowerCase()).filter(Boolean)
      const added = clean(add)
      const removed = new Set(clean(remove))
      for (const [key, data] of snapshot) {
        if (!data?.items) continue
        qc.setQueryData(key, {
          ...data,
          items: data.items.map((t) =>
            set.has(t.id)
              ? { ...t, tags: [...new Set([...t.tags.filter((x) => !removed.has(x)), ...added])].sort() }
              : t),
        })
      }
      return { snapshot }
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tracks'] })
      qc.invalidateQueries({ queryKey: ['facets'] })
    },
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
        if (job.state === 'done' || job.state === 'failed') {
          qc.invalidateQueries({ queryKey: ['tracks'] })
          qc.invalidateQueries({ queryKey: keys.sources })
          // A feed that just refused to answer has a `lastError` worth reading,
          // and it only lands on the podcast row — which nothing else refetches.
          qc.invalidateQueries({ queryKey: ['podcasts'] })
          // The sidebar's Missing badge reads these; a scan that just found
          // the files must take the number with it.
          qc.invalidateQueries({ queryKey: ['stats'] })
        }
      },
      'library.changed': () => qc.invalidateQueries({ queryKey: ['tracks'] }),
      // Somebody moved the queue — this window, another window, or a phone.
      // Written straight in rather than invalidated: the event *is* the state,
      // and re-fetching it would be a round trip to learn what we were told.
      player: (state: PlayerState) =>
        qc.setQueryData(keys.player, (old: (PlayerState & { track?: unknown }) | undefined) =>
          ({ ...old, ...state })),
      'device.connected': () => qc.invalidateQueries({ queryKey: keys.devices }),
    })
    return close
  }, [qc])
}

/**
 * The shared queue.
 *
 * The queue is the server's, not this tab's. It was local until now, which made
 * it a lie in three directions at once: a second window disagreed with the
 * first, a phone controlling the same server saw nothing, and closing the tab
 * threw away what was queued. The server already held all of it — what was
 * missing was the front asking.
 *
 * Cached under one key and written by both the mutations here and the `player`
 * event, so a change made in another window lands the same way as one made in
 * this one.
 */
export const usePlayer = () =>
  useQuery({
    queryKey: keys.player,
    queryFn: () => api.player.get(),
    // The SSE stream is the update path; polling would only ever race it.
    staleTime: Infinity,
    retry: 1,
  })

/**
 * The queue's verbs.
 *
 * Every one answers with the whole new state, so the cache is written from the
 * server's reply rather than guessed at — the queue is the one piece of state
 * where two windows disagreeing is immediately obvious.
 */
export function usePlayerActions() {
  const qc = useQueryClient()
  return useMemo(() => {
    const land = (p: Promise<PlayerState>) =>
      p.then((state) => {
        // The cache holds what `get` returned — the state plus its resolved
        // `track` — and a verb's answer is only the state, so merge over it.
        qc.setQueryData(keys.player, (old: (PlayerState & { track?: Track | null }) | undefined) =>
          ({ ...old, ...state }))
        return state
      })
    return {
      setQueue: (ids: string[], startAt = 0) => land(api.player.setQueue(ids, startAt)),
      enqueue: (ids: string[]) => land(api.player.enqueue(ids)),
      playNext: (ids: string[]) => land(api.player.enqueue(ids, true)),
      goTo: (id: string) => land(api.player.goTo(id)),
      next: () => land(api.player.next()),
      previous: () => land(api.player.previous()),
      clear: () => land(api.player.clear()),
      pause: () => land(api.player.pause()),
      play: () => land(api.player.play()),
      set: (patch: { repeat?: PlayerState['repeat']; shuffle?: boolean }) => land(api.player.set(patch)),
      /**
       * Where the music comes out.
       *
       * The server does the driving once the target is a speaker — it starts
       * the renderer on the current track and keeps it in step — so this is one
       * call and not a protocol.
       */
      setTarget: (target: PlayerState['target']) => land(api.player.set({ target })),
    }
  }, [qc])
}

/**
 * The speakers on the network.
 *
 * Only asked for while the picker is open: discovery is a live SSDP search that
 * costs seconds, and a list nobody is reading is not worth a search.
 */
export const useOutputs = (enabled: boolean) =>
  useQuery({
    queryKey: ['outputs'],
    queryFn: () => api.outputs.list(),
    enabled,
    staleTime: 30_000,
  })

/** The feeds. One key, so the view and the status line ask once between them. */
export const usePodcasts = (enabled = true) =>
  useQuery({ queryKey: ['podcasts'], queryFn: () => api.podcasts.list(), staleTime: 60_000, enabled })

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
  /** '0'..'5' exact, '4+' for four and up, null for no filter. */
  rating?: string | null
  lossless?: string | null
  /** One of the listener's own tags, or null. */
  tag?: string | null
  /** A field left empty — the review page's whole question. */
  missing?: string | null
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
    // `rating=0` is "never rated", which is a different question from "no
    // filter" — so the two have to stay distinguishable all the way down.
    if (input.rating) {
      if (input.rating.endsWith('+')) q.ratingMin = Number(input.rating.slice(0, -1))
      else q.rating = Number(input.rating)
    }
    if (input.lossless) q.lossless = input.lossless === 'yes'
    if (input.tag) q.tag = input.tag
    if (input.missing) {
      // SAFETY: the only writer of `missing` is the review page's gap chips,
      // whose values are exactly the fields the query accepts — the wide
      // string type is the chip state's, not evidence of a wider range.
      q.missing = input.missing as TrackQuery['missing']
    }
    // Only the ids that are actually a kind of track. The library also holds
    // places — albums, artists, playlists, missing — and sending one of those
    // as `kind` would ask the server for a kind of music that does not exist.
    if (input.view.kind === 'library' && (input.view.id === 'podcasts' || input.view.id === 'audiobooks')) {
      q.kind = input.view.id === 'podcasts' ? 'podcast' : 'audiobook'
    }
    // Songs, Albums and Artists are about music. A downloaded podcast episode
    // is a track like any other and would otherwise turn up between two albums
    // — which is why iTunes had a Media Kind at all. Only the library's own
    // listings narrow this way: a playlist holding an episode still shows it,
    // because someone put it there on purpose.
    if (input.view.kind === 'library' && ['music', 'albums', 'artists'].includes(input.view.id)) {
      q.kind = 'music'
    }
    if (input.deviceFilter) {
      if (input.deviceFilter.mode === 'on') q.onDevice = input.deviceFilter.deviceId
      else q.notOnDevice = input.deviceFilter.deviceId
    }
    return q
  }, [input.view.kind, input.view.id, input.search, input.browse.genre, input.browse.artist,
      input.browse.album, input.format, input.rating, input.lossless, input.tag, input.missing, input.sort, input.deviceFilter])
}

/**
 * The volume of whatever is actually making the sound.
 *
 * A slider that moves this tab's volume while the music comes out of a speaker
 * in another room is a control that does nothing, which is worse than one that
 * is not there. So it drives the speaker — and when the speaker cannot be
 * driven it says so instead of failing in silence: AirPlay keeps its volume in
 * RTSP, a protocol this server deliberately does not speak, and answers 501.
 *
 * Trailing edge only. A range input fires on every pixel of a drag, and a
 * request per pixel would reach the speaker as a stutter, out of order.
 */
let pending: ReturnType<typeof setTimeout> | undefined

export function setOutputVolume(
  target: PlayerState['target'],
  volume: number,
  onRefused: (reason: string) => void,
) {
  if (target.kind !== 'output') return
  clearTimeout(pending)
  pending = setTimeout(() => {
    void api.outputs.volume(target.id, volume).catch((err) => {
      onRefused(err instanceof Error ? err.message : t('That speaker did not take the volume'))
    })
  }, 150)
}
