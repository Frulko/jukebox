import type { BadgeContext } from './trackBadges'

export type CellActions = {
  toggleChecked: (id: string) => void
  /** Every row at once, from the box in the column's own header. */
  setChecked: (ids: string[], next: boolean) => void
  /**
   * How many tracks the current filter matches on the server, when that is more
   * than the list is holding. The header box acts on what is shown, and this is
   * what lets it say so instead of implying it did the library.
   */
  total?: number
  rate: (id: string, rating: number) => void
  /** Connected devices, so the presence column can label its dots. */
  devices: { id: string; name: string }[]
  /** What the status column needs besides the track. */
  badgeContext: BadgeContext
}

/** Columns iTunes shows out of the box; everything else lives in View Options. */
export const DEFAULT_VISIBLE = new Set([
  'checked', 'index', 'status', 'name', 'time', 'artist', 'album', 'genre', 'rating', 'playCount',
  // Shown by default, but TrackList hides it while no device is connected —
  // a column that cannot have content is just wasted width.
  'devices',
])

export const NUMERIC = new Set([
  'index', 'time', 'playCount', 'year', 'trackNumber', 'discNumber', 'bpm', 'size',
  'bitRate', 'sampleRate', 'skipCount',
])
