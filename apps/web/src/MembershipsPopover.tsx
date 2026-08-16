import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { Icon } from './Icon'
import { useMenuPosition } from './useMenuPosition'

/**
 * Where a track lives: which playlists hold it, which devices have or want it.
 *
 * The playlists half has to come from the server. A manual playlist is a list
 * and could be read here; a smart one is a *query*, and "does this track match"
 * is the rules engine's question. The route runs the playlist's own query with
 * the track pinned, so the answer cannot drift from what clicking the playlist
 * would show — which is exactly the case a client-side guess would get wrong.
 */
export function MembershipsPopover({
  trackId,
  point,
  onClose,
}: {
  trackId: string
  point: { x: number; y: number }
  onClose: () => void
}) {
  const position = useMenuPosition(point)
  const { data, isPending } = useQuery({
    queryKey: ['tracks', trackId, 'memberships'],
    queryFn: () => api.tracks.memberships(trackId),
    staleTime: 30_000,
  })

  const playlists = data?.playlists ?? []
  const devices = data?.devices ?? []

  return (
    <div
      className="ctx where"
      ref={position.setFloating}
      style={position.floatingStyles}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="ctx-title">
        Where is this track
        <button className="where-close" onClick={onClose} title="Close">
          <Icon name="close" size={8} />
        </button>
      </div>

      {isPending && <div className="where-empty">Asking…</div>}

      {!isPending && (
        <>
          <h5>Playlists</h5>
          {playlists.length === 0 && <div className="where-empty">In none.</div>}
          {playlists.map((pl) => (
            <div key={pl.id} className="where-row">
              <Icon name={pl.smart ? 'gear' : 'music'} size={9} />
              <span className="n">{pl.name}</span>
              {/* A smart playlist has matches, not positions. Saying nothing is
                  more honest than inventing an index for it. */}
              <em className="dim">{pl.position !== null ? `#${pl.position + 1}` : 'matches'}</em>
            </div>
          ))}

          <h5>Devices</h5>
          {/* A device with no relationship to the track is not listed at all,
              so an empty list means "on none, picked for none". */}
          {devices.length === 0 && <div className="where-empty">On none, picked for none.</div>}
          {devices.map((d) => (
            <div key={d.id} className="where-row">
              <Icon name="ipod" size={9} />
              <span className="n">{d.name}</span>
              <em className={d.present ? 'dim' : ''}>
                {d.present && d.wanted
                  ? 'on it'
                  : d.present
                    ? 'on it'
                    : // Picked but not yet transferred: the state the menu is
                      // most often opened to check.
                      'waiting for sync'}
              </em>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
