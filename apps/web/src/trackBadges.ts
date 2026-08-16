import type { Track } from './data'

/**
 * The little icons that live at the head of a row.
 *
 * A row has one place where state that is neither a value nor a column can
 * show: the file cannot be reached, a transfer finished, a sync is behind. It
 * has to hold several at once and each has to say what it means on hover,
 * because an icon nobody can name is decoration.
 *
 * Built-ins register through the same call a plugin will use. That is the point
 * of the registry — the host has no privileged path into the row, so a plugin
 * that adds "analysed by AudioMuse" is not a special case, it is the second
 * caller of a function the first one already proved.
 */
export type Badge = {
  /** Stable per source, so React can key them and a plugin can replace its own. */
  id: string
  /** A name from Icon.tsx. A plugin ships its own glyph the day plugins can. */
  icon: string
  /** Chooses the colour. `warn` is the only one that pulls the eye. */
  tone: 'warn' | 'ok' | 'info'
  /** Shown on hover. Write it as a sentence, not a label. */
  title: string
}

/** What the row knows besides the track itself. */
export type BadgeContext = {
  /** Sources the server currently reports. Empty means "not loaded yet". */
  sourceIds: string[]
  /** Connected devices, by id. */
  deviceIds: string[]
}

export type BadgeSource = (track: Track, ctx: BadgeContext) => Badge | Badge[] | null

const sources: BadgeSource[] = []

/** Adds a source of badges. Returns the function that takes it back out again. */
export function registerBadges(fn: BadgeSource): () => void {
  sources.push(fn)
  return () => {
    const at = sources.indexOf(fn)
    if (at >= 0) sources.splice(at, 1)
  }
}

export function badgesFor(track: Track, ctx: BadgeContext): Badge[] {
  const out: Badge[] = []
  for (const fn of sources) {
    const got = fn(track, ctx)
    if (Array.isArray(got)) out.push(...got)
    else if (got) out.push(got)
  }
  return out
}

/** True when the track's source is not among the ones the server reports. */
export function isUnavailable(track: Track, ctx: BadgeContext): boolean {
  // An empty list means the sources have not arrived yet. Treating that as
  // "everything is unreachable" would flash a wall of warnings on every load.
  return ctx.sourceIds.length > 0 && !ctx.sourceIds.includes(track.sourceId)
}

// --- the built-ins, registered exactly the way a plugin would ---

registerBadges((track, ctx) =>
  isUnavailable(track, ctx)
    ? {
        id: 'unavailable',
        icon: 'alert',
        tone: 'warn',
        title: 'Its source is not connected — this track cannot play right now',
      }
    : null,
)

// No badge for "unticked". The empty checkbox is three columns to the left,
// saying the same thing in the same row — and a second mark for it turned a
// handful of unticked rows into what looked like a disabled block.

registerBadges((track, ctx) =>
  track.devices.some((id) => ctx.deviceIds.includes(id))
    ? { id: 'on-device', icon: 'ipod', tone: 'ok', title: 'Already on a connected device' }
    : null,
)
