import { type Track } from './data'
import { Icon } from './Icon'
import { badgesFor, type BadgeContext } from './trackBadges'
import { Tooltip } from './Tooltip'

/**
 * Device presence.
 *
 * One dot per device holding the track, with the device's initial. This answers
 * "where is this track?" — a passive question you glance at. "What do I still
 * need to sync?" is the filter's job, and that one runs in SQL.
 */
export function Presence({ ids, devices }: { ids: string[]; devices: { id: string; name: string }[] }) {
  if (ids.length === 0) return null
  return (
    <span className="presence">
      {ids.map((id) => {
        const d = devices.find((x) => x.id === id)
        return (
          <i key={id} title={d?.name ?? id}>
            {(d?.name ?? '?').trim()[0]?.toUpperCase()}
          </i>
        )
      })}
    </span>
  )
}

/**
 * The status zone: none, one or several icons, each with its own sentence.
 *
 * It sits early in the row because it is scanned rather than read — the eye
 * runs down it looking for the one that is orange.
 */
export function Status({ track, ctx }: { track: Track; ctx: BadgeContext }) {
  const badges = badgesFor(track, ctx)
  if (!badges.length) return null
  return (
    <span className="badges">
      {badges.map((b) => (
        <Tooltip key={b.id} label={b.title}>
          <i className={`badge ${b.tone}`}>
            <Icon name={b.icon} size={9} />
          </i>
        </Tooltip>
      ))}
    </span>
  )
}

export function Stars({ value, onRate }: { value: number; onRate: (n: number) => void }) {
  return (
    <span className="stars" onMouseDown={(e) => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map((n) => (
        <i key={n} className={n <= value ? 'on' : 'off'} onClick={() => onRate(value === n && n === 1 ? 0 : n)}>
          <Icon name="star" size={10} />
        </i>
      ))}
    </span>
  )
}

