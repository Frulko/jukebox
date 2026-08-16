import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { summarize, type Track } from './data'
import type { Episode, Podcast } from '@jukebox/client-sdk'
import {
  api, useDevices, useFacets, usePlaylists, usePlaylistTracks, useServerEvents, useServerHealth, useSources, useStats,
  usePlayer, usePlayerActions, usePodcasts, useTagTracks, useTrackCount, useTrackQuery, useTracks,
  useUpdateTracks,
} from './api'
import { useAudio } from './audio'
import { Sidebar } from './Sidebar'
import { Player, type Repeat } from './Player'
import { TrackList } from './TrackList'
import type { TrackActions } from './TrackMenu'
import { ColumnBrowser, type Browse } from './ColumnBrowser'
import { InfoModal } from './InfoModal'
import { DeviceView } from './DeviceView'
import { Icon } from './Icon'
import { AppsView, mediaSummary, StoreView } from './MediaViews'
import { RadioView } from './RadioView'
import { AudiobooksView } from './AudiobooksView'
import { episodeAsTrack, hostOf, PodcastsView } from './PodcastsView'
import { MissingView } from './MissingView'
import { QueueView } from './QueueView'
import { AlbumsView, ArtistsView } from './LibraryViews'
import { AlbumView, type AlbumRef } from './AlbumView'
import { PlaylistsView } from './PlaylistsView'
import { ConvertDialog } from './ConvertDialog'
import { AdminView } from './AdminView'
import { SourcesView } from './SourcesView'
import { SharingView } from './SharingView'
import { DuplicatesView } from './DuplicatesView'
import { HomeView, useRecentPlaylists } from './HomeView'
import { usePluginMenu } from './pluginMenu'
import { FilterBar, type FilterChip } from './FilterBar'
import { NowPlayingPanel } from './NowPlayingPanel'
import './itunes.css'

export type View = { kind: 'library' | 'store' | 'playlist' | 'device'; id: string; smart?: string }

/**
 * Start playing a track. The second argument is the list it is being played out
 * of, in the order shown — every view that lists tracks passes its own, so what
 * comes next is decided by where you pressed play, not by where you have since
 * navigated.
 */
export type Play = (id: string, queue?: string[]) => void

export type Theme = 'classic' | 'itunes12' | 'music' | 'studio'
const THEMES: Array<[Theme, string]> = [
  ['classic', 'iTunes 8'],
  ['itunes12', 'iTunes 12'],
  ['music', 'Music'],
  ['studio', 'Studio'],
]
/** Must track --row-h in each theme block; the virtualiser needs the number. */
export const THEME_ROW_H: Record<Theme, number> = { classic: 17, itunes12: 21, music: 26, studio: 30 }

const NO_TRACKS: Track[] = []
const NO_QUEUE: string[] = []

/** Reads after "N tracks have …" on the review page. */
const GAP_PHRASE: Record<string, string> = {
  any: 'a field left empty',
  album: 'no album name',
  artist: 'no artist at all',
  albumartist: 'no album artist, so browsing by artist cannot reach them',
  genre: 'no genre',
  year: 'no year',
  track: 'no track number',
}

export default function App() {
  const qc = useQueryClient()
  const [view, setViewState] = useState<View>({ kind: 'library', id: 'music' })
  const [browse, setBrowse] = useState<Browse>({ genre: null, artist: null, album: null })
  const [browserOpen, setBrowserOpen] = useState(true)
  const [format, setFormat] = useState<string | null>(null)
  const [rating, setRating] = useState<string | null>(null)
  const [lossless, setLossless] = useState<string | null>(null)
  /** One of the listener's own tags. A query parameter, like every other chip. */
  const [tag, setTag] = useState<string | null>(null)
  /** Which gap the review page is looking at. `any` is what it opens on. */
  const [gap, setGap] = useState<string>('any')
  const [queueOpen, setQueueOpen] = useState(false)
  const [artOpen, setArtOpen] = useState(false)
  /**
   * The album being looked at, if any. Deliberately not a `View`: you are still
   * in the library, or in the playlist, or wherever you right-clicked — the
   * album is a detour, and making it a source would have lit up the sidebar as
   * if you had left. Closing it therefore needs no history: the view underneath
   * never changed.
   */
  const [albumOpen, setAlbumOpen] = useState<AlbumRef | null>(null)
  const [recentPlaylists, rememberPlaylist] = useRecentPlaylists()
  const [converting, setConverting] = useState<string[] | null>(null)
  const [selectIds, setSelectIds] = useState<string[] | null>(null)
  const [search, setSearch] = useState('')
  const [infoIds, setInfoIds] = useState<string[] | null>(null)
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('itunes.theme') as Theme) || 'classic')
  /** "What is left to put on the iPod" — computed server-side, never on a page. */
  const [deviceFilter, setDeviceFilter] = useState<{ deviceId: string; mode: 'on' | 'not' } | null>(null)
  // A drop on a device moves nothing yet, so it has to say what it did. The
  // status bar already holds a line of text; a toast would be a new component
  // for the same sentence.
  const [notice, showNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /**
   * Say something in the status bar for five seconds.
   *
   * The clearing belongs to the act of saying it, not to an effect watching the
   * value afterwards: two notices in a row have to restart the clock rather
   * than let the first one's timer cut the second one short, and that is a
   * property of *this* call, which an effect keyed on the message cannot see —
   * the same message twice does not even re-run it.
   */
  const setNotice = useCallback((message: string | null) => {
    clearTimeout(noticeTimer.current)
    showNotice(message)
    if (message) noticeTimer.current = setTimeout(() => showNotice(null), 5000)
  }, [])


  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('itunes.theme', theme)
  }, [theme])

  /**
   * Going somewhere, with everything that means.
   *
   * There are a dozen doors into a source — the sidebar, the playlists wall,
   * the home strip, a plugin answering with tracks — and what has to happen on
   * arrival was previously two effects watching `view` afterwards. An effect
   * that watches state to react to the *action* that set it is a detour: it
   * runs after the render, cannot see what the old view was without keeping a
   * copy, and is invisible from the call site. One function does it in the
   * order it happens.
   */
  const setView = useCallback(
    (next: View) => {
      setViewState(next)
      // Leaving the album detour: the album is not a source, so nothing else
      // would close it.
      setAlbumOpen(null)
      if (next.kind === 'playlist') rememberPlaylist(next.id)
    },
    [rememberPlaylist],
  )

  const openAlbum = (album: string, artist?: string) => setAlbumOpen({ album, artist })

  // Only asked for while the podcasts view is the one on screen; the query is
  // shared with the view itself, so this costs no second request.
  const podcasts = usePodcasts(view.kind === 'library' && view.id === 'podcasts')
  // Counted from what the library holds, not from a fabricated shelf.
  const audiobookTracks = useTracks(
    { kind: 'audiobook', limit: 500 },
    view.kind === 'library' && view.id === 'audiobooks',
  ).data?.items ?? []
  const audiobookCount = {
    books: new Set(audiobookTracks.map((t) => `${t.albumArtist} — ${t.album}`)).size,
    chapters: audiobookTracks.length,
  }
  const podcastCount = {
    shows: podcasts.data?.items.length ?? 0,
    episodes: (podcasts.data?.items ?? []).reduce((a, p) => a + p.episodeCount, 0),
  }

  const [nowPlaying, setNowPlaying] = useState<string | null>(null)
  /**
   * What is playing *through*, which is not what the screen is showing — and
   * which belongs to the server rather than to this tab.
   *
   * Deriving the next track from the current view meant that walking off to the
   * podcasts silenced the end of the album: the list was not even mounted, so
   * there was nothing to step into. Holding it locally instead fixed that and
   * left three smaller lies in place — a second window disagreed with the
   * first, a phone controlling the same server saw nothing, and closing the tab
   * threw the queue away. The server has held the intent all along; this is the
   * front finally asking. Playback stays here: `target: local` means this
   * browser is the renderer, so the element plays whatever the shared state
   * says is current.
   */
  const player = usePlayer().data
  const queue = player?.queue ?? NO_QUEUE
  const control = usePlayerActions()
  /**
   * Every track the app has had in its hands this session.
   *
   * The queue is ids; the panel that shows it needs names. Rather than one
   * request per queued track, whatever has already been rendered is kept here —
   * a queue built from a list you were looking at costs nothing to display.
   */
  const known = useRef(new Map<string, Track>())
  /**
   * A podcast episode that is only in its feed, dressed as a track.
   *
   * The one thing the server cannot be asked for: it is not in the library, so
   * there is no id to fetch. Everything else that plays is a library track and
   * is looked up with a query rather than kept here — see `current`.
   */
  const [playingEpisode, setPlayingEpisode] = useState<Track | null>(null)
  const shuffle = player?.shuffle ?? false
  const repeat = (player?.repeat ?? 'off') as Repeat
  const [volume, setVolume] = useState(75)

  useServerEvents(qc)
  const health = useServerHealth()
  const devices = (useDevices().data?.items ?? []).filter((d) => d.connected)
  const playlists = usePlaylists().data?.items ?? []
  // Only what is still moving: a finished scan is history, and the panel is for
  // what is happening now.
  // Counted in SQL over the whole library: the front only ever holds a page, so
  // it cannot know how much is missing by looking at what it has.
  const missing = useStats().data?.missing ?? 0
  // Counted in SQL over the whole library, for the same reason as `missing`:
  // the front holds one page, and "how much is incomplete" is a question about
  // all of it. One request, not one per field.
  const incomplete = useTrackCount({ missing: 'any', limit: 1 }).data?.count ?? 0
  // A track whose source the server no longer lists cannot be streamed; the row
  // says so rather than letting the player fail on a double-click.
  const sourceIds = (useSources().data?.items ?? []).map((s) => s.id)

  /**
   * Search, column browser filters and device presence all go to the server —
   * never by filtering a page that has already arrived. A 300-row page filtered
   * locally can end up rendering three, and the UI looks empty while 40,000
   * tracks are still sitting behind it.
   */
  // Review is the library list with one more question asked of the server, not
  // a page of its own: the same table, the same multi-edit, the same paging —
  // which is the point, since fixing what it finds *is* editing the library.
  const reviewing = view.kind === 'library' && view.id === 'review'
  const query = useTrackQuery({
    view, search, browse, format, rating, lossless, tag, deviceFilter,
    missing: reviewing ? gap : null,
  })
  // The page's own number, which is not the page in hand: with a chip on, the
  // heading has to say how many carry *that* gap, not how many were loaded.
  const reviewCount = useTrackCount(query, reviewing).data?.count ?? 0
  // Which formats the library holds is asked without the format filter applied:
  // computed through it, picking FLAC would leave FLAC as the only choice.
  const formatQuery = useMemo(() => {
    const { format: _skip, ...rest } = query
    return rest
  }, [query])
  const allFacets = useFacets(formatQuery).data
  const formats = allFacets?.formats ?? []
  // Asked without the tag filter applied, for the same reason as formats:
  // computed through it, picking "chill" would leave "chill" as the only tag
  // left to pick.
  const tags = allFacets?.tags ?? []
  // Songs, Albums and Artists are three ways of drawing one query: the same
  // page of tracks, grouped differently. Only the drawing changes with the view.
  const isLibraryList =
    view.kind === 'library' &&
    (view.id === 'music' || view.id === 'albums' || view.id === 'artists' || reviewing)
  const libraryPage = useTracks(query, isLibraryList)
  const playlistPage = usePlaylistTracks(view.kind === 'playlist' ? view.id : null, query)

  const tracks: Track[] =
    view.kind === 'playlist'
      ? playlistPage.data?.items ?? NO_TRACKS
      : isLibraryList
        ? libraryPage.data?.items ?? NO_TRACKS
        : NO_TRACKS

  // `isPending` stays true forever on a disabled query, so a device view would
  // sit on the loading screen for good. `isLoading` is pending *and* fetching,
  // which is what "we are actually waiting" means.
  const loading = libraryPage.isLoading || playlistPage.isLoading

  for (const t of tracks) known.current.set(t.id, t)

  const pluginMenu = usePluginMenu({
    notice: setNotice,
    openPlaylist: (id) => setView({ kind: 'playlist', id }),
    select: (ids) => {
      setView({ kind: 'library', id: 'music' })
      setSelectIds(ids)
    },
  })

  /**
   * The library's filters, as chips. Every one of them is a query parameter —
   * the page in hand is a window onto the library, so a filter it applied
   * itself would answer with a number that is not the library's.
   */
  const libraryFilters: FilterChip[] = [
    {
      id: 'format',
      label: 'Format',
      value: format,
      options: formats.map((f) => ({ value: f.value, label: f.value.toUpperCase(), count: f.count })),
      onChange: setFormat,
      emptyHint: 'Nothing scanned yet',
    },
    {
      id: 'rating',
      label: 'Rating',
      value: rating,
      options: [
        { value: '5', label: '★★★★★' },
        { value: '4+', label: '★★★★ and up' },
        { value: '3+', label: '★★★ and up' },
        // Not the same question as "no filter", and the one you ask when
        // tidying: what have I never got round to rating.
        { value: '0', label: 'Never rated' },
      ],
      onChange: setRating,
    },
    {
      id: 'quality',
      label: 'Quality',
      value: lossless,
      options: [
        { value: 'yes', label: 'Lossless' },
        { value: 'no', label: 'Lossy' },
      ],
      onChange: setLossless,
    },
    // Only on the review page: everywhere else "what is empty" is not the
    // question being asked, and a chip that is nearly always off is furniture.
    ...(reviewing
      ? [{
          id: 'gap',
          label: 'Missing',
          value: gap === 'any' ? null : gap,
          options: [
            { value: 'album', label: 'No album' },
            { value: 'artist', label: 'No artist at all' },
            // Its own entry because of what it breaks rather than what it is:
            // browsing by artist reads the album artist, so these are in the
            // library and unreachable from the Artists page.
            { value: 'albumartist', label: 'No album artist' },
            { value: 'genre', label: 'No genre' },
            { value: 'year', label: 'No year' },
            { value: 'track', label: 'No track number' },
          ],
          onChange: (v: string | null) => setGap(v ?? 'any'),
        }]
      : []),
    {
      id: 'tag',
      label: 'Tag',
      value: tag,
      // The counts come from the server: "chill (38)" is the library's answer,
      // not this page's.
      options: tags.map((t) => ({ value: t.value, label: t.value, count: t.count })),
      onChange: setTag,
      emptyHint: 'Nothing tagged yet',
    },
    {
      id: 'device',
      label: 'Device',
      value: deviceFilter ? `${deviceFilter.mode}:${deviceFilter.deviceId}` : null,
      options: devices.flatMap((d) => [
        { value: `on:${d.id}`, label: `On ${d.name}` },
        // "What is left to sync" is the question people actually open this for.
        { value: `not:${d.id}`, label: `Missing from ${d.name}` },
      ]),
      onChange: (v) => {
        if (!v) return setDeviceFilter(null)
        const [mode, deviceId] = v.split(':')
        setDeviceFilter({ deviceId, mode: mode as 'on' | 'not' })
      },
      emptyHint: 'No device connected',
    },
  ]

  const clearFilters = () => {
    setFormat(null)
    setRating(null)
    setLossless(null)
    setTag(null)
    setDeviceFilter(null)
  }

  const tagTracks = useTagTracks()
  const applyTags = useCallback(
    (ids: string[], add: string[] = [], remove: string[] = []) => {
      tagTracks.mutate({ ids, add, remove })
      // The Tags column is off by default, so without this the only feedback
      // for tagging a row would be a tick in a menu that has already closed.
      // Quoted as it will be stored, not as it was typed: the row is about to
      // show "late night" and the line saying "Late Night" would look like a
      // different tag.
      const what = [...add, ...remove][0]?.trim().toLowerCase()
      const n = ids.length > 1 ? `${ids.length} tracks` : 'track'
      setNotice(add.length ? `Tagged ${n} “${what}”` : `Removed “${what}” from ${n}`)
    },
    [tagTracks],
  )
  const patchTracks = useUpdateTracks()
  const update = useCallback(
    (ids: string[], patch: Partial<Track>) => patchTracks.mutate({ ids, patch }),
    [patchTracks],
  )

  /* ---- playback ---- */
  // `step` is defined below and closes over the queue; the ref lets the audio
  // element call whatever the current one is without re-attaching its listeners.
  const stepRef = useRef<(dir: 1 | -1) => void>(() => {})
  const audio = useAudio({
    base: import.meta.env.VITE_API_URL ?? '/api/v1',
    volume,
    onEnded: () => {
      if (repeat === 'one') return audio.seek(0), audio.resume()
      stepRef.current(1)
    },
    // The server decides whether this counts — half the track or four minutes,
    // whichever comes first, never under thirty seconds. The front only reports
    // what was heard; a play count that the client could set is not a fact.
    onPlayed: (id, seconds, startedAt) => {
      // A podcast episode that is only in its feed, or a radio station, has no
      // track behind it — there is nothing to count a play against. The server
      // would refuse the id anyway; not asking is the honest version of the
      // same answer.
      if (id.startsWith('ep:') || id.startsWith('radio:')) return
      api.tracks
        .play(id, seconds, startedAt)
        .then((r) => {
          if (!r.counted) return
          qc.invalidateQueries({ queryKey: ['tracks'] })
          qc.invalidateQueries({ queryKey: ['playlists'] })
        })
        // A play that could not be reported is not worth interrupting anyone
        // over: the music is still playing and nothing on screen is wrong.
        .catch(() => {})
    },
  })

  const playTrack = useCallback(
    (id: string, from?: string[]) => {
      setNowPlaying(id)
      setPlayingEpisode(null)
      // Started before the round trip, and deliberately: the element must be
      // told inside the click's own call stack or the browser stops counting it
      // as the gesture that authorises playback.
      audio.play(id)
      // A view that knows what it is playing out of says so; the queue only
      // changes when playback starts somewhere new.
      if (from) void control.setQueue(from, Math.max(0, from.indexOf(id)))
      else void control.goTo(id)
    },
    [audio, control],
  )

  /**
   * A podcast episode.
   *
   * Downloaded, it is a track like any other and goes through the queue with
   * the rest of the show behind it. Only in the feed, it is a URL at the
   * publisher: it plays, but it cannot be queued — the queue is a list of
   * library tracks and inventing an id for something the library does not hold
   * would make every other part of the app wrong about it. The status line says
   * which of the two just happened, because on a train it is the difference
   * between music and silence.
   */
  const playEpisode = useCallback(
    (ep: Episode, show: Podcast, downloaded: string[]) => {
      if (ep.trackId) return playTrack(ep.trackId, downloaded)
      if (!ep.enclosureUrl) return setNotice(`“${ep.title}” has no file to play.`)
      const id = `ep:${ep.id}`
      audio.play(id, ep.enclosureUrl)
      setNowPlaying(id)
      setPlayingEpisode(episodeAsTrack(ep, show))
      setNotice(`Streaming “${ep.title}” from ${hostOf(ep.enclosureUrl)} — it is not in your library`)
    },
    [audio, playTrack],
  )

  /**
   * A radio station.
   *
   * Like an undownloaded episode: a URL rather than a library track, so it
   * plays outside the queue — and unlike everything else here it has no end, so
   * nothing steps to a next. The id is prefixed for the same reason: anything
   * tempted to send it to the server has to notice it is not a track.
   */
  const playStation = useCallback(
    (station: { id: string; name: string; streamUrl: string; genre: string; imageUrl: string | null }) => {
      const id = `radio:${station.id}`
      audio.play(id, station.streamUrl)
      setNowPlaying(id)
      setPlayingEpisode({
        ...episodeAsTrack(
          {
            id: station.id, podcastId: '', guid: '', title: station.name, description: '',
            pubDate: null, duration: 0, episodeNumber: null, season: null,
            enclosureUrl: station.streamUrl, enclosureLength: 0, enclosureType: '',
            imageUrl: station.imageUrl, trackId: null, played: 0, position: 0,
          },
          { title: station.genre || 'Radio', author: 'Live', imageUrl: station.imageUrl } as never,
        ),
        id,
        kind: 'music',
        album: station.genre || 'Radio',
      })
      setNotice(`Tuned to ${station.name} — it plays until you stop it`)
    },
    [audio],
  )

  /**
   * Put tracks at the end of what is playing.
   *
   * With nothing playing there is nothing to queue *behind*, so this becomes
   * the queue and starts it — an "add to queue" that silently does nothing on
   * an idle player is the kind of button people press three times.
   */
  const enqueue = useCallback(
    (ids: string[]) => {
      if (!ids.length) return
      if (!nowPlaying) return playTrack(ids[0], ids)
      void control.enqueue(ids)
      setNotice(`${ids.length} track${ids.length > 1 ? 's' : ''} added to the queue`)
    },
    [nowPlaying, playTrack, control],
  )

  /**
   * Put tracks immediately after the one playing.
   *
   * The difference with the queue's end is the whole point of the verb: "next"
   * is a decision about the song after this one, and a queue three hundred long
   * makes "add to queue" indistinguishable from doing nothing.
   */
  const playNext = useCallback(
    (ids: string[]) => {
      if (!ids.length) return
      if (!nowPlaying) return playTrack(ids[0], ids)
      // The insertion point is the server's `index`, not a search for the
      // current id: a queue can hold the same track twice, and "after this one"
      // means after *this* one.
      void control.playNext(ids)
      setNotice(`${ids.length} track${ids.length > 1 ? 's' : ''} playing next`)
    },
    [nowPlaying, playTrack, control],
  )

  /**
   * Move through the queue — asked of the server, which owns the rules.
   *
   * Shuffle, repeat and "does it wrap at the end" were duplicated here and in
   * the server's player, which is one copy too many: the answer has to be the
   * same whether the button pressed was in this tab, in another one, or on a
   * phone. The server answers with the new state; if it did not advance — the
   * end of a list with repeat off — nothing new is current and the element
   * stops.
   */
  const step = useCallback(
    (dir: 1 | -1) => {
      if (!queue.length) return
      void (dir === 1 ? control.next() : control.previous()).then((state) => {
        if (!state.playing || !state.trackId) return audio.pause()
        if (state.trackId !== nowPlaying) playTrack(state.trackId)
        // Same track, moved to its start: going back from the first one.
        else audio.seek(0)
      })
    },
    [queue.length, nowPlaying, playTrack, audio, control],
  )

  /**
   * The shared queue moved somewhere this tab did not move it.
   *
   * What is current always follows — the queue moved on, so the track it is on
   * moved on, and a window showing the old one is a window telling a small lie.
   * What does *not* follow is the sound: the element is only started if it was
   * already playing. A page that begins making noise because a phone did
   * something is a page nobody asked to hear, and on load the browser would
   * refuse it anyway.
   */
  useEffect(() => {
    const id = player?.trackId ?? null
    if (!id || id === nowPlaying) return
    setNowPlaying(id)
    setPlayingEpisode(null)
    if (audio.playing) audio.play(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player?.trackId])

  /**
   * What is playing, as something to display.
   *
   * Three sources, in order of how little they cost. The page in hand almost
   * always holds it — you pressed play on a row that is right there. A podcast
   * episode outside the library is the only thing that has to be carried in
   * state. Everything else is one query, keyed the same way the queue panel
   * keys its rows, so walking away from the list that started a track does not
   * cost a second request for it.
   */
  const fetched = useQuery({
    queryKey: ['tracks', nowPlaying],
    queryFn: () => api.tracks.get(nowPlaying!),
    enabled: !!nowPlaying && !nowPlaying.startsWith('ep:') && !tracks.some((t) => t.id === nowPlaying),
    staleTime: 60_000,
    retry: 1,
  })
  const current = tracks.find((t) => t.id === nowPlaying) ?? playingEpisode ?? fetched.data ?? null
  const toggleShuffle = () => void control.set({ shuffle: !shuffle })
  const cycleRepeat = () => void control.set({ repeat: repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off' })

  useEffect(() => { stepRef.current = step }, [step])

  // Toggling goes straight to the element, inside the click's own call stack.
  // Routing it through a state flag first put the decision one task later, past
  // the point where the browser still counts the click as the gesture that
  // authorises playback.
  const toggle = useCallback(() => {
    if (!current) return tracks[0] && playTrack(tracks[0].id, tracks.map((t) => t.id))
    audio.playing ? audio.pause() : audio.resume()
  }, [current, tracks, playTrack, audio])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.code === 'Space' && !/INPUT|TEXTAREA/.test(el.tagName)) {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  /* ---- playlist mutations ---- */
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['playlists'] })
    qc.invalidateQueries({ queryKey: ['tracks'] })
  }

  const addToPlaylist = (playlistId: string, ids: string[]) =>
    api.playlists.addTracks(playlistId, ids).then(refresh)

  /**
   * Hand-picking tracks for a device: right-click, or dropping a selection on
   * it in the sidebar. Nothing is transferred here — the picks join the sync
   * rules, and the sync moves the bytes.
   */
  const addToDevice = (deviceId: string, ids: string[]) =>
    api.devices.want(deviceId, ids).then((r) => {
      const name = devices.find((d) => d.id === deviceId)?.name ?? 'the device'
      setNotice(
        r.added === 0
          ? `Already waiting for ${name}`
          : `${r.added} track${r.added > 1 ? 's' : ''} waiting for ${name} — sync to transfer`,
      )
      qc.invalidateQueries({ queryKey: ['devices'] })
    })

  const reorder = (playlistId: string, ids: string[], toIndex: number) =>
    api.playlists.reorder(playlistId, ids, toIndex).then(refresh)

  /** Inside a playlist we remove from the playlist; anywhere else, from the library. */
  const remove = (ids: string[]) => {
    if (view.kind !== 'playlist') return // deleting from the library: not exposed yet
    return api.playlists.removeTracks(view.id, ids).then(refresh)
  }

  const newPlaylist = (trackIds: string[] = []) =>
    api.playlists.create({ name: 'untitled playlist', trackIds }).then((pl) => {
      refresh()
      setView({ kind: 'playlist', id: pl.id })
    })

  // An unreachable server says so, rather than letting the user believe the
  // library is empty.
  if (health.isError) {
    return (
      <div className="boot">
        Server unreachable. Run <code>npm run dev:server</code>, then reload.
      </div>
    )
  }
  // No full-screen loading state. It used to replace the *entire app* — sidebar,
  // player and all — whenever a track query was in flight with nothing yet in
  // hand, which is exactly what going from Admin to a playlist is: the admin
  // page holds no tracks, so the first click on a playlist blanked the window
  // for one round trip and read as a full page refresh. A view that is waiting
  // says so where that view is; the shell it sits in never goes away.

  const infoTracks = infoIds ? tracks.filter((t) => infoIds.includes(t.id)) : []
  const device = view.kind === 'device' ? devices.find((d) => d.id === view.id) : undefined
  const viewKey = `${view.kind}:${view.id}`
  // Albums and Artists are places in the sidebar now, not a mode inside Songs.
  // One piece of state — the view — with the mode bar as a second control onto
  // it, rather than two that can disagree about where you are.
  const mode = view.kind === 'library' && (view.id === 'albums' || view.id === 'artists') ? view.id : 'songs'

  /**
   * What a track can be told to do, in one place.
   *
   * The library list, an album's track list and an artist's each right-click
   * into the same menu, and the only way to keep it the same menu is to hand
   * them the same handlers rather than eighteen props threaded four ways.
   */
  const trackActions: TrackActions = useMemo(
    () => ({
      onPlay: playTrack,
      onEnqueue: enqueue,
      onPlayNext: playNext,
      onConvert: setConverting,
      onGetInfo: setInfoIds,
      onOpenAlbum: openAlbum,
      onUpdate: update,
      onDelete: remove,
      onAddToPlaylist: addToPlaylist,
      onAddToDevice: addToDevice,
      onNewPlaylistFrom: (ids: string[]) => void newPlaylist(ids),
      onTag: applyTags,
      playlists,
      devices,
      tags,
      pluginEntries: pluginMenu.entries,
      onPluginCommand: pluginMenu.run,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playTrack, enqueue, playNext, update, applyTags, playlists, devices, tags, pluginMenu.entries],
  )

  const MEDIA: Record<string, React.ReactNode> = {
    podcasts: <PodcastsView
        search={search}
        nowPlaying={nowPlaying}
        onPlayEpisode={playEpisode}
        onNotice={setNotice}
      />,
    audiobooks: (
      <AudiobooksView search={search} nowPlaying={nowPlaying} onPlay={playTrack} actions={trackActions} />
    ),
    apps: <AppsView search={search} />,
    radio: (
      <RadioView
        search={search}
        nowPlaying={nowPlaying}
        onPlayStream={playStation}
        onNotice={setNotice}
      />
    ),
    missing: <MissingView />,
    admin: <AdminView />,
    sources: <SourcesView onNotice={setNotice} />,
    sharing: <SharingView onGoToSources={() => setView({ kind: 'library', id: 'sources' })} />,
    duplicates: <DuplicatesView onNotice={setNotice} />,
    home: (
      <HomeView
        playlists={playlists}
        recent={recentPlaylists}
        onOpenPlaylist={(id, smart) => setView({ kind: 'playlist', id, smart: smart ?? undefined })}
        onGo={(id) => setView({ kind: 'library', id })}
      />
    ),
    playlists: (
      <PlaylistsView
        playlists={playlists}
        onOpen={(id, smart) => setView({ kind: 'playlist', id, smart: smart ?? undefined })}
        onNew={() => newPlaylist()}
      />
    ),
  }
  const media =
    view.kind === 'store'
      ? <StoreView purchased={view.id === 'purchased'} />
      : view.kind === 'library' && view.id !== 'music'
        ? MEDIA[view.id]
        : null

  return (
    <div className="itunes">
      <Player
        track={current}
        playing={audio.playing}
        audio={audio}
        shuffle={shuffle}
        repeat={repeat}
        volume={volume}
        search={search}
        // The scope is not a fourth piece of state: it *is* the source being
        // browsed. Picking one in the search box goes there and keeps what was
        // typed, which is the same as saying "search over there instead".
        scope={view.kind === 'library' ? view.id : 'music'}
        onScope={(id) => setView({ kind: 'library', id })}
        browserOpen={browserOpen}
        queueLength={queue.length}
        queueOpen={queueOpen}
        artOpen={artOpen}
        onToggleQueue={() => setQueueOpen((v) => !v)}
        onToggleArt={() => setArtOpen((v) => !v)}
        onToggle={toggle}
        // Read at the click rather than subscribed to: this decides between
        // "restart the track" and "go back one", and it needs the number once.
        onPrev={() => (audio.time.get().position > 3 ? audio.seek(0) : step(-1))}
        onNext={() => step(1)}
        onSeek={audio.seek}
        onVolume={setVolume}
        onShuffle={toggleShuffle}
        onRepeat={cycleRepeat}
        onSearch={setSearch}
        onToggleBrowser={() => setBrowserOpen((v) => !v)}
      />

      {artOpen && current && (
        <NowPlayingPanel track={current} onClose={() => setArtOpen(false)} onOpenAlbum={openAlbum} />
      )}

      {queueOpen && (
        <QueueView
          queue={queue}
          nowPlaying={nowPlaying}
          known={known.current}
          onPlay={(id) => playTrack(id)}
          // No "remove one" route, and it does not need one: a queue minus a
          // row is a queue, sent whole with the current track kept where it is
          // so taking something out from under the player does not restart it.
          onRemove={(index) => {
            // By position: the queue can hold the same track twice, and taking
            // out "the second one" must not take out the first as well.
            const next = queue.filter((_, i) => i !== index)
            const keep = nowPlaying ? next.indexOf(nowPlaying) : -1
            void control.setQueue(next, Math.max(0, keep))
          }}
          onClear={() => {
            const keep = nowPlaying ? [nowPlaying] : []
            void control.setQueue(keep, 0)
          }}
          onClose={() => setQueueOpen(false)}
        />
      )}

      <div className="main">
        <Sidebar
          view={view}
          missing={missing}
          incomplete={incomplete}
          playlists={playlists}
          playlistArt={theme === 'music'}
          devices={devices}
          onSelect={(v) => {
            setView(v)
            setBrowse({ genre: null, artist: null, album: null })
          }}
          onDropTracks={addToPlaylist}
          onDropOnDevice={addToDevice}
          onRename={(id, name) =>
            api.playlists.rename(id, name).then(refresh)
          }
          onDelete={(id) => {
            api.playlists.remove(id).then(refresh)
            if (view.id === id) setView({ kind: 'library', id: 'music' })
          }}
          onNew={() => newPlaylist()}
        />

        <div className="content">
          {albumOpen ? (
            <AlbumView
              target={albumOpen}
              nowPlaying={nowPlaying}
              onPlay={playTrack}
              onEnqueue={enqueue}
              onPlayNext={playNext}
              onGetInfo={setInfoIds}
              onBack={() => setAlbumOpen(null)}
              actions={trackActions}
            />
          ) : device ? (
            <DeviceView
              device={device}
              playlists={playlists}
              onDevices={() => qc.invalidateQueries({ queryKey: ['devices'] })}
              onEject={() => setView({ kind: 'library', id: 'music' })}
              // The same door a plugin's "found these tracks" uses: go to the
              // library and select it, rather than describing where it is.
              onReveal={(trackId) => {
                setView({ kind: 'library', id: 'music' })
                setSelectIds([trackId])
              }}
              nowPlaying={nowPlaying}
              onPlay={playTrack}
            />
          ) : media ? (
            media
          ) : (
            <>
              {/* One filter control rather than a bespoke bar per dimension: the
                  device buttons were the only filter with their own furniture,
                  and a second one would have needed its own again. */}
              {reviewing && (
                <p className="review-lead">
                  <b>{reviewCount.toLocaleString('en-US')}</b> track{reviewCount === 1 ? '' : 's'}{' '}
                  {reviewCount === 1 ? 'has' : 'have'}{' '}
                  {/* The sentence follows the chip: with one chosen, "a field
                      left empty" is vaguer than what the page is showing. */}
                  {GAP_PHRASE[gap] ?? 'a field left empty'}. Nothing is wrong with them — they play — but
                  an album with no album name cannot be browsed to, and a track with no year cannot be
                  found by one. Select several and press <b>Get Info</b> to fill the same field on all of
                  them at once.
                </p>
              )}

              <FilterBar chips={libraryFilters} onClear={clearFilters} />

              {theme !== 'classic' && (
                <div className="modebar">
                  {(['songs', 'albums', 'artists'] as const).map((m) => (
                    <button
                      key={m}
                      className={mode === m ? 'on' : ''}
                      onClick={() => setView({ kind: 'library', id: m === 'songs' ? 'music' : m })}
                    >
                      {m[0].toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
              )}
              {theme === 'classic' && browserOpen && (
                <ColumnBrowser value={browse} onChange={setBrowse} query={query} onOpenAlbum={openAlbum} />
              )}
              {mode === 'albums' ? (
                <AlbumsView
                  tracks={tracks}
                  nowPlaying={nowPlaying}
                  onPlay={playTrack}
                  onEnqueue={enqueue}
                  onPlayNext={playNext}
                  onGetInfo={setInfoIds}
                  onOpenAlbum={openAlbum}
                  actions={trackActions}
                />
              ) : mode === 'artists' ? (
                <ArtistsView
                  tracks={tracks}
                  nowPlaying={nowPlaying}
                  onPlay={playTrack}
                  onEnqueue={enqueue}
                  onPlayNext={playNext}
                  onOpenAlbum={openAlbum}
                  actions={trackActions}
                />
              ) : (
              <TrackList
                // No `key` on purpose: keying the list on the view remounted
                // the whole table on every navigation — header, columns,
                // virtualiser and all — and that remount is the flash. What it
                // was buying is smaller than what it cost: the scroll position,
                // which viewState keys itself, and the selection, which the
                // list now clears when the view changes.
                viewKey={viewKey}
                sourceIds={sourceIds}
                format={format}
                formats={formats}
                onFormat={setFormat}
                rowHeight={THEME_ROW_H[theme]}
                showArtwork={theme !== 'classic'}
                devices={devices}
                tracks={tracks}
                loading={loading}
                view={view}
                playlists={playlists}
                nowPlaying={nowPlaying}
                selectIds={selectIds}
                onReorder={reorder}
                actions={trackActions}
              />
              )}
            </>
          )}
        </div>
      </div>

      <div className="statusbar">
        <button className="sb-btn" onClick={() => newPlaylist()} title="New playlist">
          <Icon name="plus" size={9} />
        </button>
        <button className={`sb-btn ${shuffle ? 'on' : ''}`} onClick={toggleShuffle} title="Shuffle">
          <Icon name="shuffle" size={10} />
        </button>
        <button className={`sb-btn ${repeat !== 'off' ? 'on' : ''}`} onClick={cycleRepeat} title="Repeat">
          <Icon name="repeat" size={10} />
        </button>
        <span className="summary">
          {notice ??
            (view.kind === 'library' && view.id !== 'music'
              ? view.id === 'audiobooks'
                ? `${audiobookCount.books} audiobook${audiobookCount.books === 1 ? '' : 's'}, ${audiobookCount.chapters.toLocaleString('en-US')} chapters`
                : view.id === 'podcasts'
                // Counted from the feeds themselves: the fabricated list this
                // replaced would have gone on saying "4 podcasts" to someone
                // subscribed to one.
                ? `${podcastCount.shows} podcast${podcastCount.shows === 1 ? '' : 's'}, ${podcastCount.episodes.toLocaleString('en-US')} episodes`
                : mediaSummary(view.id)
              : media ? '' : summarize(tracks))}
        </span>
        <div className="theme-picker">
          {THEMES.map(([id, label]) => (
            <button key={id} className={theme === id ? 'on' : ''} onClick={() => setTheme(id)}>
              {label}
            </button>
          ))}
        </div>
        <button className="sb-btn right" onClick={() => qc.invalidateQueries()} title="Refresh">
          <Icon name="sync" size={10} />
        </button>
      </div>

      {converting && (
        <ConvertDialog ids={converting} onClose={() => setConverting(null)} onStarted={setNotice} />
      )}

      {infoIds && infoTracks.length > 0 && (
        <InfoModal
          tracks={infoTracks}
          onClose={() => setInfoIds(null)}
          onApply={(patch) => update(infoIds, patch)}
          pluginTabs={pluginMenu.tabs}
        />
      )}
    </div>
  )
}
