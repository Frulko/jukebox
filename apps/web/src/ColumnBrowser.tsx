import type { TrackQuery } from '@jukebox/client-sdk'
import { useFacets } from './api'

export type Browse = { genre: string | null; artist: string | null; album: string | null }

// ponytail: single-select per pane. iTunes allows cmd-click multi-select —
// widen `Browse` to string[] if that becomes a requirement.
type Facet = { value: string; count: number }

function Pane({
  title,
  values,
  selected,
  onSelect,
  onOpen,
}: {
  title: string
  values: Facet[]
  selected: string | null
  onSelect: (v: string | null) => void
  /** Double-click, where the value names something openable. */
  onOpen?: (v: string) => void
}) {
  return (
    <div className="cb-pane">
      <div className="cb-head">{title}</div>
      <ul>
        <li className={selected === null ? 'on' : ''} onClick={() => onSelect(null)}>
          All ({values.length} {title.toLowerCase()})
        </li>
        {values.map((v) => (
          <li
            key={v.value}
            className={selected === v.value ? 'on' : ''}
            onClick={() => onSelect(v.value)}
            onDoubleClick={onOpen && (() => onOpen(v.value))}
          >
            {v.value}
          </li>
        ))}
      </ul>
    </div>
  )
}

const EMPTY: Facet[] = []

/**
 * The values come from the server, not from the page on screen: otherwise the
 * browser would only offer the genres of the 300 loaded tracks. They cascade —
 * picking a genre narrows the artists, the way iTunes does it.
 */
export function ColumnBrowser({
  value,
  onChange,
  query,
  onOpenAlbum,
}: {
  value: Browse
  onChange: (b: Browse) => void
  query: TrackQuery
  /** A pane row knows a name and nothing else — hence no artist. */
  onOpenAlbum: (album: string) => void
}) {
  const { data } = useFacets(query)

  return (
    <div className="colbrowser">
      <Pane
        title="Genres"
        values={data?.genres ?? EMPTY}
        selected={value.genre}
        onSelect={(genre) => onChange({ genre, artist: null, album: null })}
      />
      <Pane
        title="Artists"
        values={data?.artists ?? EMPTY}
        selected={value.artist}
        onSelect={(artist) => onChange({ ...value, artist, album: null })}
      />
      <Pane
        title="Albums"
        values={data?.albums ?? EMPTY}
        selected={value.album}
        onSelect={(album) => onChange({ ...value, album })}
        onOpen={onOpenAlbum}
      />
    </div>
  )
}
