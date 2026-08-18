// The views iTunes 12 introduced and Apple Music kept: browse by Album or by
// Artist instead of one flat song table. Songs stays in TrackList; these two are
// grid-first, which is the whole point of the redesign.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Play } from './App'
import { useRemembered, useScrollMemory } from './viewState'
import { useMenuPosition } from './useMenuPosition'
import { useTrackMenu, type TrackActions } from './TrackMenu'
import { ViewSearch } from './ViewSearch'
import { useViewSearch } from './viewState'
import { Cover } from './Artwork'
import { albumSeed } from './albumSeed'
import { Icon } from './Icon'
import { fmtTime, type Track } from './data'

export type LibraryMode = 'songs' | 'albums' | 'artists'

export type Album = {
  key: string
  album: string
  artist: string
  year: number
  tracks: Track[]
}

function groupAlbums(tracks: Track[]): Album[] {
  const by = new Map<string, Album>()
  for (const t of tracks) {
    const key = albumSeed(t)
    let a = by.get(key)
    if (!a) {
      a = { key, album: t.album, artist: t.albumArtist, year: t.year, tracks: [] }
      by.set(key, a)
    }
    a.tracks.push(t)
  }
  for (const a of by.values())
    a.tracks.sort((x, y) => x.discNumber - y.discNumber || x.trackNumber - y.trackNumber)
  return [...by.values()].sort((x, y) => x.artist.localeCompare(y.artist) || x.year - y.year)
}

/**
 * The right-click menu for a group of tracks — an album tile, an artist.
 *
 * A group is the "folder" of a music library: the thing you point at when you
 * mean "all of that". It offers the same two verbs as a row, because that is
 * what makes a folder feel like one — you can act on it without opening it.
 */
function useGroupMenu(
  onPlay: Play,
  onEnqueue: (ids: string[]) => void,
  onPlayNext: (ids: string[]) => void,
  onOpenAlbum?: (album: string, artist: string) => void,
) {
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[]; label: string; album?: Album } | null>(
    null,
  )
  const position = useMenuPosition(menu)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const open = (e: React.MouseEvent, ids: string[], label: string, album?: Album) => {
    e.preventDefault()
    if (ids.length) setMenu({ x: e.clientX, y: e.clientY, ids, label, album })
  }

  const node = menu ? (
    <div className="ctx" ref={position.setFloating} style={position.floatingStyles} onMouseDown={(e) => e.stopPropagation()}>
      <button onClick={() => (onPlay(menu.ids[0], menu.ids), setMenu(null))}>Play {menu.label}</button>
      <button onClick={() => (onPlayNext(menu.ids), setMenu(null))}>Play Next</button>
      <button onClick={() => (onEnqueue(menu.ids), setMenu(null))}>
        Add {menu.ids.length} to Queue
      </button>
      {/* An artist is a group too, and has no album page to go to. */}
      {menu.album && onOpenAlbum && (
        <button onClick={() => (onOpenAlbum(menu.album!.album, menu.album!.artist), setMenu(null))}>
          Go to Album
        </button>
      )}
    </div>
  ) : null

  return { open, node }
}

/**
 * The tracks of one album, wherever an album is drawn.
 *
 * They are tracks, so they behave like tracks: click selects, cmd and shift do
 * what they do in the library, and a right-click opens the same menu with the
 * same entries. A list of songs you cannot rate or add to a playlist because it
 * happens to be under a cover is a list that has forgotten what it holds.
 */
export function AlbumTracks({
  album,
  nowPlaying,
  onPlay,
  menu,
}: {
  album: Album
  nowPlaying: string | null
  onPlay: Play
  menu?: ReturnType<typeof useTrackMenu>
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchor = useRef<string | null>(null)
  const ids = album.tracks.map((t) => t.id)

  const click = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor.current) {
      const a = ids.indexOf(anchor.current)
      const b = ids.indexOf(id)
      if (a > -1 && b > -1) return setSelected(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)))
    }
    anchor.current = id
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return setSelected(next)
    }
    setSelected(new Set([id]))
  }

  return (
    <ol className="album-tracks">
      {album.tracks.map((t) => (
        <li
          key={t.id}
          className={`${t.id === nowPlaying ? 'playing' : ''} ${selected.has(t.id) ? 'sel' : ''}`}
          onMouseDown={(e) => e.button === 0 && click(e, t.id)}
          onDoubleClick={() => onPlay(t.id, ids)}
          onContextMenu={(e) => {
            if (!menu) return
            const chosen = selected.has(t.id) ? [...selected] : [t.id]
            if (!selected.has(t.id)) setSelected(new Set([t.id]))
            menu.open(e, album.tracks.filter((x) => chosen.includes(x.id)), ids)
          }}
        >
          <span className="n">{t.id === nowPlaying ? <Icon name="volumeHigh" size={10} /> : t.trackNumber}</span>
          <span className="t">{t.name}</span>
          <span className="d">{fmtTime(t.duration)}</span>
        </li>
      ))}
    </ol>
  )
}

export function AlbumsView({
  tracks,
  nowPlaying,
  onPlay,
  onEnqueue,
  onPlayNext,
  onGetInfo,
  onOpenAlbum,
  actions,
}: {
  tracks: Track[]
  nowPlaying: string | null
  onPlay: Play
  onEnqueue: (ids: string[]) => void
  onPlayNext: (ids: string[]) => void
  onGetInfo: (ids: string[]) => void
  onOpenAlbum: (album: string, artist: string) => void
  /** The same menu the library list opens, on the tracks under a cover. */
  actions: TrackActions
}) {
  const albums = useMemo(() => groupAlbums(tracks), [tracks])
  const [open, setOpen] = useRemembered<string | null>('albums.open', null)
  const pane = useScrollMemory<HTMLDivElement>('albums')
  const menu = useGroupMenu(onPlay, onEnqueue, onPlayNext, onOpenAlbum)
  const trackMenu = useTrackMenu(actions)
  const search = useViewSearch()
  const shown = albums.filter((a) => search.matches(a.album, a.artist))
  const current = albums.find((a) => a.key === open)

  return (
    <div className="media" ref={pane.ref} onScroll={pane.onScroll}>
      {menu.node}
      {trackMenu.node}
      <div className="view-head">
        <ViewSearch value={search.query} onChange={search.setQuery} placeholder="Filter albums" count={shown.length} />
      </div>
      <div className="grid">
        {shown.map((a) => (
          <div
            key={a.key}
            className={`tile ${open === a.key ? 'on' : ''}`}
            onContextMenu={(e) => menu.open(e, a.tracks.map((t) => t.id), a.album, a)}
            // Click opens the album under the grid, double-click opens its
            // page: the same two verbs a folder has, and the reason the inline
            // panel stays — it is the one you want when comparing albums.
            onDoubleClick={() => onOpenAlbum(a.album, a.artist)}
          >
            <button className="tile-art" onClick={() => setOpen(open === a.key ? null : a.key)}>
              <Cover seed={a.key} size={148} label={a.album} />
              <span
                className="hover-play"
                onClick={(e) => {
                  e.stopPropagation()
                  onPlay(a.tracks[0].id, a.tracks.map((t) => t.id))
                }}
              >
                <Icon name="play" size={13} />
              </span>
            </button>
            <span className="tile-t">{a.album}</span>
            <span className="tile-s">{a.artist}</span>
          </div>
        ))}
      </div>

      {current && (
        <div className="album-detail">
          <Cover seed={current.key} size={132} label={current.album} />
          <div className="album-meta">
            <h3>{current.album}</h3>
            <p className="dim">
              {current.artist} · {current.year} · {current.tracks.length} songs ·{' '}
              {fmtTime(current.tracks.reduce((s, t) => s + t.duration, 0))}
            </p>
            <div className="album-actions">
              <button className="prim" onClick={() => onPlay(current.tracks[0].id, current.tracks.map((t) => t.id))}>
                <Icon name="play" size={10} /> Play
              </button>
              <button onClick={() => onGetInfo(current.tracks.map((t) => t.id))}>Get Info</button>
            </div>
            <AlbumTracks album={current} nowPlaying={nowPlaying} onPlay={onPlay} menu={trackMenu} />
          </div>
        </div>
      )}
    </div>
  )
}

export function ArtistsView({
  tracks,
  nowPlaying,
  onPlay,
  onEnqueue,
  onPlayNext,
  onOpenAlbum,
  actions,
}: {
  tracks: Track[]
  nowPlaying: string | null
  onPlay: Play
  onEnqueue: (ids: string[]) => void
  onPlayNext: (ids: string[]) => void
  onOpenAlbum: (album: string, artist: string) => void
  actions: TrackActions
}) {
  const albums = useMemo(() => groupAlbums(tracks), [tracks])
  const artists = useMemo(() => {
    const by = new Map<string, Album[]>()
    for (const a of albums) by.set(a.artist, [...(by.get(a.artist) ?? []), a])
    return [...by.entries()].sort((x, y) => x[0].localeCompare(y[0]))
  }, [albums])

  const menu = useGroupMenu(onPlay, onEnqueue, onPlayNext, onOpenAlbum)
  const trackMenu = useTrackMenu(actions)
  const search = useViewSearch()
  const [sel, setSel] = useRemembered<string | null>('artists.sel', null)
  const list = useScrollMemory<HTMLDivElement>('artists.list')
  const body = useScrollMemory<HTMLDivElement>('artists.body')
  const active = sel ?? artists[0]?.[0]
  const mine = artists.find(([name]) => name === active)?.[1] ?? []

  return (
    <div className="media split">
      {menu.node}
      {trackMenu.node}
      <div className="artist-list" ref={list.ref} onScroll={list.onScroll}>
        <ViewSearch value={search.query} onChange={search.setQuery} placeholder="Filter artists" />
        {artists.filter(([name]) => search.matches(name)).map(([name, list]) => (
          <button
            key={name}
            className={`artist ${name === active ? 'on' : ''}`}
            onClick={() => setSel(name)}
            onContextMenu={(e) => menu.open(e, list.flatMap((a) => a.tracks.map((t) => t.id)), name)}
          >
            <Cover seed={list[0].key} size={30} className="round" />
            <span className="meta">
              <span className="t">{name}</span>
              <span className="s">
                {list.length} album{list.length > 1 ? 's' : ''}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="artist-body" ref={body.ref} onScroll={body.onScroll}>
        <h2>{active}</h2>
        {mine.map((a) => (
          <div
            key={a.key}
            className="artist-album"
            onContextMenu={(e) => menu.open(e, a.tracks.map((t) => t.id), a.album, a)}
          >
            <div className="aa-art" onDoubleClick={() => onOpenAlbum(a.album, a.artist)}>
              <Cover seed={a.key} size={110} label={a.album} />
            </div>
            <div className="aa-meta">
              <h4>
                {a.album} <em className="dim">{a.year}</em>
              </h4>
              <AlbumTracks album={a} nowPlaying={nowPlaying} onPlay={onPlay} menu={trackMenu} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
