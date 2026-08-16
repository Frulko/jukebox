import { useState } from 'react'
import { Icon } from './Icon'

/**
 * A search box that belongs to one view.
 *
 * The box in the player bar asks the server, across a whole source. This one
 * filters what the page is already holding — the albums it drew, the missing
 * files it listed, the playlists it has — which is honest precisely because
 * those views hold all of their rows. It would be a lie in the track list,
 * where the page is a window onto a hundred thousand rows, and that is the one
 * place it is not offered.
 *
 * Deliberately not remembered between visits. A filter you forgot you set is
 * indistinguishable from a view that has gone empty, and the whole point of
 * these pages is to answer "what have I got".
 */
export function useViewSearch() {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const matches = (...fields: Array<string | null | undefined>) =>
    !needle || fields.some((f) => f?.toLowerCase().includes(needle))
  return { query, setQuery, needle, matches }
}

export function ViewSearch({
  value,
  onChange,
  placeholder = 'Filter this list',
  count,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** What the filter left, so an empty result is explained rather than blank. */
  count?: number
}) {
  return (
    <div className="view-search">
      <Icon name="search" size={10} />
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('')
        }}
      />
      {value && (
        <>
          {count !== undefined && <span className="dim">{count}</span>}
          <button className="clear" onClick={() => onChange('')} title="Clear (Esc)">
            <Icon name="close" size={9} />
          </button>
        </>
      )}
    </div>
  )
}
