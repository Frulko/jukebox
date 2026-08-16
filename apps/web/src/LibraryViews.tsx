// The views iTunes 12 introduced and Apple Music kept: browse by Album or by
// Artist instead of one flat song table. Songs stays in TrackList; these two are
// grid-first, which is the whole point of the redesign.

import { useMemo } from 'react'
import { useRemembered, useScrollMemory } from './viewState'
import { albumSeed, Cover } from './Artwork'
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

export function groupAlbums(tracks: Track[]): Album[] {
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

function AlbumTracks({ album, nowPlaying, onPlay }: { album: Album; nowPlaying: string | null; onPlay: (id: string) => void }) {
  return (
    <ol className="album-tracks">
      {album.tracks.map((t) => (
        <li
          key={t.id}
          className={t.id === nowPlaying ? 'playing' : ''}
          onDoubleClick={() => onPlay(t.id)}
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
  onGetInfo,
}: {
  tracks: Track[]
  nowPlaying: string | null
  onPlay: (id: string) => void
  onGetInfo: (ids: string[]) => void
}) {
  const albums = useMemo(() => groupAlbums(tracks), [tracks])
  const [open, setOpen] = useRemembered<string | null>('albums.open', null)
  const pane = useScrollMemory<HTMLDivElement>('albums')
  const current = albums.find((a) => a.key === open)

  return (
    <div className="media" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="grid">
        {albums.map((a) => (
          <div key={a.key} className={`tile ${open === a.key ? 'on' : ''}`}>
            <button className="tile-art" onClick={() => setOpen(open === a.key ? null : a.key)}>
              <Cover seed={a.key} size={148} label={a.album} />
              <span
                className="hover-play"
                onClick={(e) => {
                  e.stopPropagation()
                  onPlay(a.tracks[0].id)
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
              <button className="prim" onClick={() => onPlay(current.tracks[0].id)}>
                <Icon name="play" size={10} /> Play
              </button>
              <button onClick={() => onGetInfo(current.tracks.map((t) => t.id))}>Get Info</button>
            </div>
            <AlbumTracks album={current} nowPlaying={nowPlaying} onPlay={onPlay} />
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
}: {
  tracks: Track[]
  nowPlaying: string | null
  onPlay: (id: string) => void
}) {
  const albums = useMemo(() => groupAlbums(tracks), [tracks])
  const artists = useMemo(() => {
    const by = new Map<string, Album[]>()
    for (const a of albums) by.set(a.artist, [...(by.get(a.artist) ?? []), a])
    return [...by.entries()].sort((x, y) => x[0].localeCompare(y[0]))
  }, [albums])

  const [sel, setSel] = useRemembered<string | null>('artists.sel', null)
  const list = useScrollMemory<HTMLDivElement>('artists.list')
  const body = useScrollMemory<HTMLDivElement>('artists.body')
  const active = sel ?? artists[0]?.[0]
  const mine = artists.find(([name]) => name === active)?.[1] ?? []

  return (
    <div className="media split">
      <div className="artist-list" ref={list.ref} onScroll={list.onScroll}>
        {artists.map(([name, list]) => (
          <button key={name} className={`artist ${name === active ? 'on' : ''}`} onClick={() => setSel(name)}>
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
          <div key={a.key} className="artist-album">
            <div className="aa-art">
              <Cover seed={a.key} size={110} label={a.album} />
            </div>
            <div className="aa-meta">
              <h4>
                {a.album} <em className="dim">{a.year}</em>
              </h4>
              <AlbumTracks album={a} nowPlaying={nowPlaying} onPlay={onPlay} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
