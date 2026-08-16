import { EventEmitter } from 'node:events'
import type { DB } from './db.ts'
import { nextRev } from './db.ts'

/**
 * Recording that something was listened to.
 *
 * Playback happens in whatever is rendering — a browser, a satellite, a
 * third-party client — so the server only learns about it because it is told.
 * That call is this, and it is the thing `playCount`, `lastPlayed` and every
 * "Top 25 Most Played" in the app have been waiting for: the columns existed
 * from the start and nothing ever wrote them, so both seeded presets could
 * never fill.
 *
 * The threshold is Last.fm's, and it is worth matching exactly rather than
 * inventing one: a track counts once it has been playing for **half its length
 * or four minutes, whichever comes first**, and anything under thirty seconds
 * never counts. Every scrobbling service in existence has settled on those
 * numbers, so a play recorded here is a play everywhere else too.
 */

export const MIN_LENGTH = 30
export const MIN_PLAYED = 4 * 60

/** Did this count as listened to? */
export function counts(duration: number, played: number): boolean {
  if (duration < MIN_LENGTH) return false
  return played >= Math.min(duration / 2, MIN_PLAYED)
}

export type PlayEvent = {
  trackId: string
  /** Seconds actually listened to. */
  played: number
  /** When it started, which is what a scrobble is timestamped with. */
  startedAt: number
  track: { name: string; artist: string; albumArtist: string; album: string; duration: number; trackNumber: number }
}

/**
 * The server's own event bus.
 *
 * One emitter, so a plugin can react to a play without the play having to know
 * plugins exist. Kept deliberately small: an event is added when something
 * needs to listen to it, not in anticipation.
 */
export class Events extends EventEmitter {
  emitPlay(e: PlayEvent): void {
    // Listeners are plugins, and a plugin that throws must not take down the
    // request that triggered it. `EventEmitter` would propagate synchronously.
    for (const fn of this.listeners('play')) {
      try {
        const r = (fn as (e: PlayEvent) => unknown)(e)
        if (r instanceof Promise) r.catch((err) => console.error('[events] play listener failed:', err))
      } catch (err) {
        console.error('[events] play listener failed:', err instanceof Error ? err.message : err)
      }
    }
  }
}

export type PlayResult =
  | { counted: true; playCount: number; event: PlayEvent }
  | { counted: false; reason: string }

/**
 * Records a play, if it qualifies.
 *
 * A skip is recorded too. Knowing what someone abandons is as useful as knowing
 * what they finish, and a smart playlist can use it; it costs one column that
 * already existed.
 */
export function recordPlay(
  db: DB,
  events: Events,
  trackId: string,
  input: { played: number; startedAt?: number },
): PlayResult | null {
  const t = db.prepare(
    `SELECT id, name, artist, albumArtist, album, duration, trackNumber, playCount
     FROM tracks WHERE id = ? AND deletedAt IS NULL`).get(trackId) as any
  if (!t) return null

  const played = Math.max(0, Math.floor(input.played))
  if (!counts(t.duration, played)) {
    db.prepare(`UPDATE tracks SET skipCount = skipCount + 1, rev = ? WHERE id = ?`)
      .run(nextRev(db), trackId)
    return {
      counted: false,
      reason: t.duration < MIN_LENGTH
        ? `shorter than ${MIN_LENGTH}s`
        : `played ${played}s of the ${Math.ceil(Math.min(t.duration / 2, MIN_PLAYED))}s needed`,
    }
  }

  const rev = nextRev(db)
  // `startedAt`, not now: a satellite that was offline can report yesterday's
  // listening, and the scrobble has to carry the time it happened.
  const startedAt = input.startedAt ?? Date.now() - played * 1000
  db.prepare(`UPDATE tracks SET playCount = playCount + 1, lastPlayed = ?, rev = ? WHERE id = ?`)
    .run(startedAt, rev, trackId)

  const event: PlayEvent = {
    trackId,
    played,
    startedAt,
    track: {
      name: t.name, artist: t.artist, albumArtist: t.albumArtist,
      album: t.album, duration: t.duration, trackNumber: t.trackNumber,
    },
  }
  events.emitPlay(event)
  return { counted: true, playCount: t.playCount + 1, event }
}
