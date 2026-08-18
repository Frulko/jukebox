import { useState } from 'react'
import type { Play } from './App'
import { useTracks } from './api'
import { Cover } from './Artwork'
import { albumSeed } from './albumSeed'
import { Icon } from './Icon'
import { fmtTime, type Track } from './data'
import { useTrackMenu, type TrackActions } from './TrackMenu'

/** What identifies an album to open. The artist is absent when the place you
 *  clicked from only knew a name — a column-browser row, say. */
export type AlbumRef = { album: string; artist?: string }

/**
 * One album, as a page.
 *
 * The tracks are asked of the server, not grouped out of the list you opened
 * this from. That list is one page of a library that may hold forty thousand
 * rows, so an album read off it would quietly be missing whatever had not
 * loaded yet — and an album page that shows nine of eleven tracks is worse than
 * no album page, because nothing on screen says it is incomplete.
 *
 * Which is also why `artist` is optional rather than assumed: opened from a
 * track it is that track's album artist and the answer is exact; opened from a
 * list that only knows a name, the server answers for the name, and the header
 * says how many artists that turned out to be instead of picking one.
 */
export function AlbumView({
  target,
  nowPlaying,
  onPlay,
  onEnqueue,
  onPlayNext,
  onGetInfo,
  onBack,
  actions,
}: {
  target: AlbumRef
  nowPlaying: string | null
  onPlay: Play
  onEnqueue: (ids: string[]) => void
  onPlayNext: (ids: string[]) => void
  onGetInfo: (ids: string[]) => void
  onBack: () => void
  /** The same menu the library list opens: these are tracks like any others. */
  actions: TrackActions
}) {
  const menu = useTrackMenu(actions)
  const { data, isLoading } = useTracks({
    album: target.album,
    artist: target.artist,
    sort: 'album', // the server orders an album by disc then track number
    limit: 500,
  })
  const tracks: Track[] = data?.items ?? []
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const ids = tracks.map((t) => t.id)
  const artists = [...new Set(tracks.map((t) => t.albumArtist))]
  const discs = [...new Set(tracks.map((t) => t.discNumber))].sort((a, b) => a - b)
  const year = tracks[0]?.year
  const seed = tracks[0] ? albumSeed(tracks[0]) : `${target.artist ?? ''} — ${target.album}`

  return (
    <div className="media">
      {menu.node}
      <div className="album-page-head">
        <button className="back" onClick={onBack}>
          ← Back
        </button>
      </div>

      <div className="album-detail">
        <Cover seed={seed} size={180} label={target.album} />
        <div className="album-meta">
          <h3>{target.album}</h3>
          <p className="dim">
            {/* A compilation is named as one rather than by whichever artist
                happened to be first in the answer. */}
            {artists.length > 1 ? `${artists.length} artists` : (artists[0] ?? target.artist ?? '')}
            {year ? ` · ${year}` : ''} · {tracks.length} song{tracks.length === 1 ? '' : 's'} ·{' '}
            {fmtTime(tracks.reduce((s, t) => s + t.duration, 0))}
          </p>
          <div className="album-actions">
            <button className="prim" disabled={!ids.length} onClick={() => onPlay(ids[0], ids)}>
              <Icon name="play" size={10} /> Play
            </button>
            <button disabled={!ids.length} onClick={() => onPlayNext(ids)}>
              Play Next
            </button>
            <button disabled={!ids.length} onClick={() => onEnqueue(ids)}>
              Add {ids.length} to Queue
            </button>
            <button disabled={!ids.length} onClick={() => onGetInfo(ids)}>
              Get Info
            </button>
          </div>

          {isLoading && <p className="dim">Asking…</p>}
          {!isLoading && !tracks.length && <p className="dim">Nothing under that album.</p>}

          {discs.map((disc) => (
            <div key={disc}>
              {/* Numbering restarts on each disc, so without the heading a
                  two-disc album shows two tracks called 1. */}
              {discs.length > 1 && <h5 className="dim">Disc {disc}</h5>}
              <ol className="album-tracks">
                {tracks
                  .filter((t) => t.discNumber === disc)
                  .map((t) => (
                    <li
                      key={t.id}
                      className={`${t.id === nowPlaying ? 'playing' : ''} ${selected.has(t.id) ? 'sel' : ''}`}
                      onMouseDown={(e) => e.button === 0 && setSelected(new Set([t.id]))}
                      onDoubleClick={() => onPlay(t.id, ids)}
                      onContextMenu={(e) => {
                        const chosen = selected.has(t.id) ? tracks.filter((x) => selected.has(x.id)) : [t]
                        if (!selected.has(t.id)) setSelected(new Set([t.id]))
                        menu.open(e, chosen, ids)
                      }}
                    >
                      <span className="n">
                        {t.id === nowPlaying ? <Icon name="volumeHigh" size={10} /> : t.trackNumber}
                      </span>
                      <span className="t">{t.name}</span>
                      {/* Only when it says something the album title does not. */}
                      {artists.length > 1 && <span className="dim">{t.artist}</span>}
                      <span className="d">{fmtTime(t.duration)}</span>
                    </li>
                  ))}
              </ol>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
