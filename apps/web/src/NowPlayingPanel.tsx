import type { Track } from './data'
import { fmtSize, fmtTime } from './data'
import { Cover } from './Artwork'
import { albumSeed } from './albumSeed'
import { Icon } from './Icon'

/**
 * The cover, big, and what the file actually is.
 *
 * The button that opens this existed since the first commit and did nothing —
 * it was drawn because iTunes had one there. Rather than delete it, it now
 * shows the two things the rest of the interface cannot: the artwork at a size
 * worth looking at, and the *files* behind the track.
 *
 * That second part is not decoration. A track can hold several renditions since
 * conversion landed, and nothing else in the app says which one plays, what the
 * others are, or what they cost on disk.
 */
export function NowPlayingPanel({
  track,
  onClose,
  onOpenAlbum,
}: {
  track: Track
  onClose: () => void
  onOpenAlbum: (album: string, artist: string) => void
}) {
  const renditions = track.renditions ?? []

  return (
    <div className="np-panel">
      <div className="np-head">
        <b>Now playing</b>
        <button className="np-close" onClick={onClose} title="Close">
          <Icon name="close" size={9} />
        </button>
      </div>

      <div className="np-body">
        <Cover seed={albumSeed(track)} size={248} label={track.album} className="np-art" />

        <div className="np-meta">
          <b>{track.name}</b>
          <span>{track.artist}</span>
          <span className="dim">
            {/* The cover is right there, so this is the one place where "and
                what else is on it" is the obvious next question. */}
            {track.album ? (
              <button
                className="np-album"
                title={`Go to ${track.album}`}
                onClick={() => {
                  onOpenAlbum(track.album, track.albumArtist)
                  onClose()
                }}
              >
                {track.album}
              </button>
            ) : (
              track.album
            )}
            {track.year ? ` · ${track.year}` : ''}
          </span>
          <span className="dim">{fmtTime(track.duration)}</span>
        </div>

        <div className="np-files">
          <h4>
            {renditions.length > 1 ? `${renditions.length} files` : 'File'}
          </h4>
          {renditions.length === 0 && <p className="dim">No file information.</p>}
          {renditions.map((r) => (
            <div key={r.id} className={`np-file ${r.preferred ? 'on' : ''}`}>
              <span className="f">{r.format.toUpperCase()}</span>
              <span className="dim">{r.bitRate ? `${r.bitRate} kbps` : '—'}</span>
              <span className="dim">{fmtSize(r.size)}</span>
              {/* Exactly one rendition plays and is what listings show; the
                  others exist for devices that cannot take it. */}
              {r.preferred ? <em>plays</em> : <em className="dim">spare</em>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
