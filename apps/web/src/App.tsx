import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { summarize, type Track } from './data'
import {
  api, useDevices, useFacets, useJobs, usePlaylists, usePlaylistTracks, useServerEvents, useServerHealth, useSources, useStats,
  useTrackQuery, useTracks, useUpdateTracks,
} from './api'
import { useAudio } from './audio'
import { Sidebar } from './Sidebar'
import { Player, type Repeat } from './Player'
import { TrackList } from './TrackList'
import { ColumnBrowser, type Browse } from './ColumnBrowser'
import { InfoModal } from './InfoModal'
import { DeviceView } from './DeviceView'
import { Icon } from './Icon'
import { AppsView, AudiobooksView, mediaSummary, PodcastsView, RadioView, StoreView } from './MediaViews'
import { MissingView } from './MissingView'
import { QueueView } from './QueueView'
import { AlbumsView, ArtistsView } from './LibraryViews'
import { PlaylistsView } from './PlaylistsView'
import { ConvertDialog } from './ConvertDialog'
import { AdminView } from './AdminView'
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

export default function App() {
  const qc = useQueryClient()
  const [view, setView] = useState<View>({ kind: 'library', id: 'music' })
  const [browse, setBrowse] = useState<Browse>({ genre: null, artist: null, album: null })
  const [browserOpen, setBrowserOpen] = useState(true)
  const [format, setFormat] = useState<string | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [converting, setConverting] = useState<string[] | null>(null)
  const [search, setSearch] = useState('')
  const [infoIds, setInfoIds] = useState<string[] | null>(null)
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('itunes.theme') as Theme) || 'classic')
  /** "What is left to put on the iPod" — computed server-side, never on a page. */
  const [deviceFilter, setDeviceFilter] = useState<{ deviceId: string; mode: 'on' | 'not' } | null>(null)
  // A drop on a device moves nothing yet, so it has to say what it did. The
  // status bar already holds a line of text; a toast would be a new component
  // for the same sentence.
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('itunes.theme', theme)
  }, [theme])

  const [nowPlaying, setNowPlaying] = useState<string | null>(null)
  /**
   * What is playing *through*, which is not what the screen is showing.
   *
   * Deriving the next track from the current view meant that walking off to the
   * podcasts — where the track list is not even mounted — silenced the end of
   * the album: the list was empty, so there was nothing to step into. Ids
   * rather than tracks, because the device view can queue what it holds without
   * having to invent Track objects for rows that are only on the iPod.
   */
  const [queue, setQueue] = useState<string[]>([])
  /**
   * Every track the app has had in its hands this session.
   *
   * The queue is ids; the panel that shows it needs names. Rather than one
   * request per queued track, whatever has already been rendered is kept here —
   * a queue built from a list you were looking at costs nothing to display.
   */
  const known = useRef(new Map<string, Track>())
  // The playing track can fall outside the current view, so keep it separately.
  const [nowPlayingTrack, setNowPlayingTrack] = useState<Track | null>(null)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState<Repeat>('off')
  const [volume, setVolume] = useState(75)

  useServerEvents(qc)
  const health = useServerHealth()
  const devices = (useDevices().data?.items ?? []).filter((d) => d.connected)
  const playlists = usePlaylists().data?.items ?? []
  // Only what is still moving: a finished scan is history, and the panel is for
  // what is happening now.
  const jobs = (useJobs().data?.items ?? []).filter((j) => j.state === 'running' || j.state === 'queued' || j.state === 'paused')
  // Counted in SQL over the whole library: the front only ever holds a page, so
  // it cannot know how much is missing by looking at what it has.
  const missing = useStats().data?.missing ?? 0
  // A track whose source the server no longer lists cannot be streamed; the row
  // says so rather than letting the player fail on a double-click.
  const sourceIds = (useSources().data?.items ?? []).map((s) => s.id)

  /**
   * Search, column browser filters and device presence all go to the server —
   * never by filtering a page that has already arrived. A 300-row page filtered
   * locally can end up rendering three, and the UI looks empty while 40,000
   * tracks are still sitting behind it.
   */
  const query = useTrackQuery({ view, search, browse, format, deviceFilter })
  // Which formats the library holds is asked without the format filter applied:
  // computed through it, picking FLAC would leave FLAC as the only choice.
  const formatQuery = useMemo(() => {
    const { format: _skip, ...rest } = query
    return rest
  }, [query])
  const formats = useFacets(formatQuery).data?.formats ?? []
  // Songs, Albums and Artists are three ways of drawing one query: the same
  // page of tracks, grouped differently. Only the drawing changes with the view.
  const isLibraryList =
    view.kind === 'library' && (view.id === 'music' || view.id === 'albums' || view.id === 'artists')
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
      // A view that knows what it is playing out of says so; the queue only
      // changes when playback starts somewhere new.
      if (from) setQueue(from)
      setNowPlaying(id)
      // No "playing" flag to set: the element raises `play` when it actually
      // starts, and that is what the button reads.
      audio.play(id)
      api.tracks.get(id).then(setNowPlayingTrack).catch(() => setNowPlayingTrack(null))
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
      setQueue((q) => [...q, ...ids])
      setNotice(`${ids.length} track${ids.length > 1 ? 's' : ''} added to the queue`)
    },
    [nowPlaying, playTrack],
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
      setQueue((q) => {
        const at = q.indexOf(nowPlaying)
        // Playing something that is not in the queue at all — a track from a
        // view nobody queued — still has an "after this one", and it is the front.
        if (at < 0) return [...ids, ...q]
        return [...q.slice(0, at + 1), ...ids, ...q.slice(at + 1)]
      })
      setNotice(`${ids.length} track${ids.length > 1 ? 's' : ''} playing next`)
    },
    [nowPlaying, playTrack],
  )

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!queue.length) return
      if (shuffle && dir === 1) return playTrack(queue[Math.floor(Math.random() * queue.length)])
      const i = queue.indexOf(nowPlaying ?? '')
      // Falling off the end only wraps when repeat is on. Otherwise the list
      // finishes and stops, which is what "repeat: off" means -- wrapping
      // regardless would leave a playlist looping all night.
      if (repeat === 'off' && i === queue.length - 1 && dir === 1) return audio.pause()
      const next = queue[(i + dir + queue.length) % queue.length]
      if (next) playTrack(next)
    },
    [queue, nowPlaying, shuffle, repeat, playTrack, audio],
  )

  const current = tracks.find((t) => t.id === nowPlaying) ?? nowPlayingTrack

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
  if (loading && tracks.length === 0) return <div className="boot">Loading library…</div>

  const infoTracks = infoIds ? tracks.filter((t) => infoIds.includes(t.id)) : []
  const device = view.kind === 'device' ? devices.find((d) => d.id === view.id) : undefined
  const viewKey = `${view.kind}:${view.id}`
  // Albums and Artists are places in the sidebar now, not a mode inside Songs.
  // One piece of state — the view — with the mode bar as a second control onto
  // it, rather than two that can disagree about where you are.
  const mode = view.kind === 'library' && (view.id === 'albums' || view.id === 'artists') ? view.id : 'songs'

  const MEDIA: Record<string, React.ReactNode> = {
    podcasts: <PodcastsView search={search} />,
    audiobooks: <AudiobooksView search={search} />,
    apps: <AppsView search={search} />,
    radio: <RadioView search={search} />,
    missing: <MissingView />,
    admin: <AdminView />,
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
        position={audio.position}
        duration={audio.duration}
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
        jobs={jobs}
        queueLength={queue.length}
        queueOpen={queueOpen}
        onToggleQueue={() => setQueueOpen((v) => !v)}
        onToggle={toggle}
        onPrev={() => (audio.position > 3 ? audio.seek(0) : step(-1))}
        onNext={() => step(1)}
        onSeek={audio.seek}
        onVolume={setVolume}
        onShuffle={() => setShuffle((v) => !v)}
        onRepeat={() => setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'))}
        onSearch={setSearch}
        onToggleBrowser={() => setBrowserOpen((v) => !v)}
      />

      {queueOpen && (
        <QueueView
          queue={queue}
          nowPlaying={nowPlaying}
          known={known.current}
          onPlay={(id) => playTrack(id)}
          onRemove={(id) => setQueue((q) => q.filter((x) => x !== id))}
          onClear={() => setQueue(nowPlaying ? [nowPlaying] : [])}
          onClose={() => setQueueOpen(false)}
        />
      )}

      <div className="main">
        <Sidebar
          view={view}
          missing={missing}
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
          {device ? (
            <DeviceView
              device={device}
              playlists={playlists}
              onDevices={() => qc.invalidateQueries({ queryKey: ['devices'] })}
              onEject={() => setView({ kind: 'library', id: 'music' })}
              nowPlaying={nowPlaying}
              onPlay={playTrack}
            />
          ) : media ? (
            media
          ) : (
            <>
              {devices.length > 0 && (
                <div className="devicebar">
                  <button
                    className={deviceFilter === null ? 'on' : ''}
                    onClick={() => setDeviceFilter(null)}
                  >
                    All
                  </button>
                  {devices.map((d) => (
                    <span key={d.id} className="devicebar-group">
                      <button
                        className={deviceFilter?.deviceId === d.id && deviceFilter.mode === 'on' ? 'on' : ''}
                        onClick={() => setDeviceFilter({ deviceId: d.id, mode: 'on' })}
                        title={`Tracks already on ${d.name}`}
                      >
                        On {d.name}
                      </button>
                      <button
                        className={deviceFilter?.deviceId === d.id && deviceFilter.mode === 'not' ? 'on' : ''}
                        onClick={() => setDeviceFilter({ deviceId: d.id, mode: 'not' })}
                        title={`Tracks missing from ${d.name}`}
                      >
                        Missing
                      </button>
                    </span>
                  ))}
                </div>
              )}
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
                <ColumnBrowser value={browse} onChange={setBrowse} query={query} />
              )}
              {mode === 'albums' ? (
                <AlbumsView
                  tracks={tracks}
                  nowPlaying={nowPlaying}
                  onPlay={playTrack}
                  onEnqueue={enqueue}
                  onPlayNext={playNext}
                  onGetInfo={setInfoIds}
                />
              ) : mode === 'artists' ? (
                <ArtistsView
                  tracks={tracks}
                  nowPlaying={nowPlaying}
                  onPlay={playTrack}
                  onEnqueue={enqueue}
                  onPlayNext={playNext}
                />
              ) : (
              <TrackList
                key={viewKey}
                viewKey={viewKey}
                sourceIds={sourceIds}
                format={format}
                formats={formats}
                onFormat={setFormat}
                rowHeight={THEME_ROW_H[theme]}
                showArtwork={theme !== 'classic'}
                devices={devices}
                tracks={tracks}
                view={view}
                playlists={playlists}
                nowPlaying={nowPlaying}
                onPlay={playTrack}
                onEnqueue={enqueue}
                onPlayNext={playNext}
                onConvert={setConverting}
                onUpdate={update}
                onDelete={remove}
                onAddToPlaylist={addToPlaylist}
                onAddToDevice={addToDevice}
                onReorder={reorder}
                onGetInfo={setInfoIds}
                onNewPlaylistFrom={(ids) => newPlaylist(ids)}
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
        <button className={`sb-btn ${shuffle ? 'on' : ''}`} onClick={() => setShuffle((v) => !v)} title="Shuffle">
          <Icon name="shuffle" size={10} />
        </button>
        <button className={`sb-btn ${repeat !== 'off' ? 'on' : ''}`} onClick={() => setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'))} title="Repeat">
          <Icon name="repeat" size={10} />
        </button>
        <span className="summary">
          {notice ??
            (view.kind === 'library' && view.id !== 'music'
              ? mediaSummary(view.id)
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
        />
      )}
    </div>
  )
}
