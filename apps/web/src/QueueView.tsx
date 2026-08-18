import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { fmtTime, type Track } from './data'
import { Icon } from './Icon'
import { Cover } from './Artwork'
import { albumSeed } from './albumSeed'
import { getLocale } from './i18n'

/**
 * What is going to play, in order.
 *
 * The queue has been real since playback stopped following the view, but it was
 * only ever visible through what happened next — you could add forty tracks to
 * it and have nothing to look at. This is that list.
 *
 * It holds ids rather than tracks, because the device view can queue what an
 * iPod holds without inventing Track objects for it. So rows resolve against
 * what is already on screen first, and only what is left over costs a request —
 * which in practice is nothing, since a queue almost always comes from the list
 * you were looking at.
 */
function QueueRow({
  id,
  known,
  current,
  onPlay,
  onRemove,
}: {
  id: string
  known: Track | undefined
  current: boolean
  onPlay: () => void
  onRemove: () => void
}) {
  // Only for ids the page cannot already name. Cached for the session: a queue
  // scrolled twice must not ask twice.
  const fetched = useQuery({
    queryKey: ['tracks', id],
    queryFn: () => api.tracks.get(id),
    enabled: !known,
    staleTime: Infinity,
  })
  const track = known ?? fetched.data

  return (
    <li className={`q-row ${current ? 'on' : ''}`} onDoubleClick={onPlay}>
      {track ? <Cover seed={albumSeed(track)} size={24} className="q-art" /> : <span className="q-art empty" />}
      <span className="q-meta">
        <span className="q-name">{track?.name ?? '…'}</span>
        <span className="q-sub">{track ? `${track.artist} — ${track.album}` : id}</span>
      </span>
      {track && <span className="q-time num">{fmtTime(track.duration)}</span>}
      <button className="q-remove" title="Take out of the queue" onClick={onRemove}>
        <Icon name="close" size={8} />
      </button>
    </li>
  )
}

export function QueueView({
  queue,
  nowPlaying,
  known,
  onPlay,
  onRemove,
  onClear,
  onClose,
}: {
  queue: string[]
  nowPlaying: string | null
  /** Tracks the page can already name, so most rows cost nothing. */
  known: Map<string, Track>
  onPlay: (id: string) => void
  /** By position, not by id: a queue may legitimately hold the same track twice. */
  onRemove: (index: number) => void
  onClear: () => void
  onClose: () => void
}) {
  const at = nowPlaying ? queue.indexOf(nowPlaying) : -1
  // Everything before the current track has been played; the panel is about
  // what is coming, and history belongs in a different list than this one.
  const upcoming = at >= 0 ? queue.slice(at) : queue
  // Playing from the library queues the library, so this list can be thousands
  // long. Rendering the first hundred keeps it a panel rather than a second
  // track list — and the count below says what is not drawn, because a cap
  // nobody is told about is a lie about the queue's length.
  const shown = upcoming.slice(0, 100)
  const hidden = upcoming.length - shown.length

  return (
    <div className="queue-panel">
      <div className="q-head">
        <b>Playing next</b>
        <span className="dim">{upcoming.length ? `${upcoming.length - (at >= 0 ? 1 : 0)} to come` : 'nothing queued'}</span>
        <button className="q-clear" onClick={onClear} disabled={!queue.length}>
          Clear
        </button>
        <button className="q-close" onClick={onClose} title="Close">
          <Icon name="close" size={9} />
        </button>
      </div>

      {upcoming.length === 0 ? (
        <p className="q-empty">
          Play something, or right-click a track, an album or an artist and add it to the queue.
        </p>
      ) : (
        <ul className="q-list">
          {shown.map((id, i) => (
            <QueueRow
              key={`${id}-${i}`}
              id={id}
              known={known.get(id)}
              current={id === nowPlaying}
              onPlay={() => onPlay(id)}
              onRemove={() => onRemove((at >= 0 ? at : 0) + i)}
            />
          ))}
          {hidden > 0 && (
            <li className="q-more">and {hidden.toLocaleString(getLocale())} more after that</li>
          )}
        </ul>
      )}
    </div>
  )
}
