import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { summarize, type Track } from './data'
import {
  api, useDevices, usePlaylists, usePlaylistTracks, useServerEvents, useServerHealth,
  useTrackQuery, useTracks, useUpdateTracks,
} from './api'
import { Sidebar } from './Sidebar'
import { Player, type Repeat } from './Player'
import { TrackList } from './TrackList'
import { ColumnBrowser, type Browse } from './ColumnBrowser'
import { InfoModal } from './InfoModal'
import { DeviceView } from './DeviceView'
import { Icon } from './Icon'
import { AppsView, AudiobooksView, mediaSummary, PodcastsView, RadioView, StoreView } from './MediaViews'
import { AlbumsView, ArtistsView, type LibraryMode } from './LibraryViews'
import './itunes.css'

export type View = { kind: 'library' | 'store' | 'playlist' | 'device'; id: string; smart?: string }

export type Theme = 'classic' | 'itunes12' | 'music'
const THEMES: Array<[Theme, string]> = [
  ['classic', 'iTunes 8'],
  ['itunes12', 'iTunes 12'],
  ['music', 'Music'],
]
/** Must track --row-h in each theme block; the virtualiser needs the number. */
export const THEME_ROW_H: Record<Theme, number> = { classic: 17, itunes12: 21, music: 26 }

const NO_TRACKS: Track[] = []

export default function App() {
  const qc = useQueryClient()
  const [view, setView] = useState<View>({ kind: 'library', id: 'music' })
  const [browse, setBrowse] = useState<Browse>({ genre: null, artist: null, album: null })
  const [browserOpen, setBrowserOpen] = useState(true)
  const [search, setSearch] = useState('')
  const [infoIds, setInfoIds] = useState<string[] | null>(null)
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('itunes.theme') as Theme) || 'classic')
  const [mode, setMode] = useState<LibraryMode>('songs')
  /** "What is left to put on the iPod" — computed server-side, never on a page. */
  const [deviceFilter, setDeviceFilter] = useState<{ deviceId: string; mode: 'on' | 'not' } | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('itunes.theme', theme)
  }, [theme])

  const [nowPlaying, setNowPlaying] = useState<string | null>(null)
  // The playing track can fall outside the current view, so keep it separately.
  const [nowPlayingTrack, setNowPlayingTrack] = useState<Track | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState<Repeat>('off')
  const [volume, setVolume] = useState(75)

  useServerEvents(qc)
  const health = useServerHealth()
  const devices = useDevices().data?.items ?? []
  const playlists = usePlaylists().data?.items ?? []

  /**
   * Search, column browser filters and device presence all go to the server —
   * never by filtering a page that has already arrived. A 300-row page filtered
   * locally can end up rendering three, and the UI looks empty while 40,000
   * tracks are still sitting behind it.
   */
  const query = useTrackQuery({ view, search, browse, deviceFilter })
  const libraryPage = useTracks(query, view.kind === 'library' && view.id === 'music')
  const playlistPage = usePlaylistTracks(view.kind === 'playlist' ? view.id : null, query)

  const tracks: Track[] =
    view.kind === 'playlist'
      ? playlistPage.data?.items ?? NO_TRACKS
      : view.kind === 'library' && view.id === 'music'
        ? libraryPage.data?.items ?? NO_TRACKS
        : NO_TRACKS

  const loading = libraryPage.isPending || playlistPage.isPending

  const patchTracks = useUpdateTracks()
  const update = useCallback(
    (ids: string[], patch: Partial<Track>) => patchTracks.mutate({ ids, patch }),
    [patchTracks],
  )

  /* ---- playback (fake, but it ticks) ---- */
  const playTrack = useCallback(
    (id: string) => {
      setNowPlaying(id)
      setPosition(0)
      setPlaying(true)
      api.tracks.get(id).then(setNowPlayingTrack).catch(() => setNowPlayingTrack(null))
    },
    [],
  )

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!tracks.length) return
      if (shuffle && dir === 1) return playTrack(tracks[Math.floor(Math.random() * tracks.length)].id)
      const i = tracks.findIndex((t) => t.id === nowPlaying)
      const next = tracks[(i + dir + tracks.length) % tracks.length]
      if (next) playTrack(next.id)
    },
    [tracks, nowPlaying, shuffle, playTrack],
  )

  const current = tracks.find((t) => t.id === nowPlaying) ?? nowPlayingTrack

  useEffect(() => {
    if (!playing || !current) return
    const id = setInterval(() => {
      setPosition((s) => {
        if (s + 0.5 < current.duration) return s + 0.5
        if (repeat === 'one') return 0
        if (repeat === 'all' || tracks.length > 1) step(1)
        else setPlaying(false)
        return 0
      })
    }, 500)
    return () => clearInterval(id)
  }, [playing, current, repeat, step, tracks.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.code === 'Space' && !/INPUT|TEXTAREA/.test(el.tagName)) {
        e.preventDefault()
        if (current) setPlaying((v) => !v)
        else if (tracks[0]) playTrack(tracks[0].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, tracks, playTrack])

  /* ---- playlist mutations ---- */
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['playlists'] })
    qc.invalidateQueries({ queryKey: ['tracks'] })
  }

  const addToPlaylist = (playlistId: string, ids: string[]) =>
    api.playlists.addTracks(playlistId, ids).then(refresh)

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

  const MEDIA: Record<string, React.ReactNode> = {
    podcasts: <PodcastsView />,
    audiobooks: <AudiobooksView />,
    apps: <AppsView />,
    radio: <RadioView />,
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
        playing={playing}
        position={position}
        shuffle={shuffle}
        repeat={repeat}
        volume={volume}
        search={search}
        browserOpen={browserOpen}
        onToggle={() => (current ? setPlaying((v) => !v) : tracks[0] && playTrack(tracks[0].id))}
        onPrev={() => (position > 3 ? setPosition(0) : step(-1))}
        onNext={() => step(1)}
        onSeek={setPosition}
        onVolume={setVolume}
        onShuffle={() => setShuffle((v) => !v)}
        onRepeat={() => setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'))}
        onSearch={setSearch}
        onToggleBrowser={() => setBrowserOpen((v) => !v)}
      />

      <div className="main">
        <Sidebar
          view={view}
          playlists={playlists}
          playlistArt={theme === 'music'}
          devices={devices}
          onSelect={(v) => {
            setView(v)
            setBrowse({ genre: null, artist: null, album: null })
          }}
          onDropTracks={addToPlaylist}
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
            <DeviceView device={device} playlists={playlists} onDevices={() => qc.invalidateQueries({ queryKey: ['devices'] })} />
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
                  {(['songs', 'albums', 'artists'] as LibraryMode[]).map((m) => (
                    <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                      {m[0].toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
              )}
              {theme === 'classic' && browserOpen && (
                <ColumnBrowser value={browse} onChange={setBrowse} query={query} />
              )}
              {theme !== 'classic' && mode === 'albums' ? (
                <AlbumsView tracks={tracks} nowPlaying={nowPlaying} onPlay={playTrack} onGetInfo={setInfoIds} />
              ) : theme !== 'classic' && mode === 'artists' ? (
                <ArtistsView tracks={tracks} nowPlaying={nowPlaying} onPlay={playTrack} />
              ) : (
              <TrackList
                key={viewKey}
                viewKey={viewKey}
                rowHeight={THEME_ROW_H[theme]}
                showArtwork={theme !== 'classic'}
                devices={devices}
                tracks={tracks}
                view={view}
                playlists={playlists}
                nowPlaying={nowPlaying}
                onPlay={playTrack}
                onUpdate={update}
                onDelete={remove}
                onAddToPlaylist={addToPlaylist}
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
          {view.kind === 'library' && view.id !== 'music' ? mediaSummary(view.id) : media ? '' : summarize(tracks)}
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
