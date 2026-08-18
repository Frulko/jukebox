import type { Playlist } from './data'
import { Icon } from './Icon'
import { PlaylistCover } from './Artwork'
import { useScrollMemory } from './viewState'
import { ViewSearch } from './ViewSearch'
import { useViewSearch } from './viewState'
import { getLocale, t } from './i18n'

/**
 * Every playlist, as a wall rather than a list.
 *
 * The sidebar holds them all already, but a sidebar is a column of text you
 * scroll past — it answers "open this one", never "what do I have". Apple Music
 * puts them on a page for the same reason it puts albums on one: quilts are
 * recognised faster than names.
 */
export function PlaylistsView({
  playlists,
  onOpen,
  onNew,
}: {
  playlists: Playlist[]
  onOpen: (id: string, smart: string | null) => void
  onNew: () => void
}) {
  const pane = useScrollMemory<HTMLDivElement>('playlists')
  const search = useViewSearch()
  const shown = playlists.filter((pl) => search.matches(pl.name))

  return (
    <div className="media" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="pl-head">
        <h2>{t('All Playlists')}</h2>
        <span className="dim">{playlists.length}</span>
        <ViewSearch value={search.query} onChange={search.setQuery} placeholder="Filter playlists" count={shown.length} />
        <button className="prim" onClick={onNew}>
          <Icon name="plus" size={9} /> New Playlist
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="list-empty">
          {playlists.length === 0
            ? 'No playlists yet. The button above makes the first one.'
            : `No playlist matches “${search.query}”.`}
        </div>
      ) : (
        <div className="grid pl-grid">
          {shown.map((pl) => (
            <button key={pl.id} className="tile pl-tile" onDoubleClick={() => onOpen(pl.id, pl.smart)}>
              <PlaylistCover seed={`${pl.id} ${pl.name}`} size={148} label={pl.name} />
              <span className="t">
                {/* A smart playlist is a query, not a list, and the difference
                    decides whether dragging a track onto it does anything. */}
                {pl.smart && <Icon name="gear" size={9} className="dim" />}
                {pl.name}
              </span>
              <span className="s">
                {pl.trackCount.toLocaleString(getLocale())} track{pl.trackCount === 1 ? '' : 's'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
