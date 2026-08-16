import type { DB } from './db.ts'
import type { Events } from './plays.ts'

/**
 * One queue, several controllers.
 *
 * Until now every client had its own idea of what was playing: the browser, a
 * Subsonic app and a speaker on the landing would each have answered
 * differently. That is fine for one person at one screen and useless the moment
 * outputs exist — "pause it from my phone while it plays on the Sonos" is the
 * entire point of having found that Sonos.
 *
 * So the server holds the **intent**: what is queued, which one is current,
 * whether it should be playing, where. A renderer executes that intent and
 * reports back where it actually got to. Controllers change it. The two are
 * deliberately separate, because a browser tab can be closed mid-song and the
 * queue should not die with it.
 *
 * Kept in memory. A queue is a thing you are doing, not a thing you own — after
 * a server restart the right answer is silence, not resuming something from
 * last week.
 */

export type PlayerTarget =
  /** The client that is asking. Every browser plays for itself. */
  | { kind: 'local' }
  /** A renderer on the network, driven by the server. */
  | { kind: 'output'; id: string; name: string }

export type PlayerState = {
  queue: string[]
  /** Index into `queue`. -1 when nothing is loaded. */
  index: number
  trackId: string | null
  playing: boolean
  /** Seconds, as last reported by whatever is actually playing. */
  position: number
  target: PlayerTarget
  repeat: 'off' | 'all' | 'one'
  shuffle: boolean
  /** Bumped on every change, so a client can tell its own echo from someone else's. */
  revision: number
  /** Who last changed it, for a UI that wants to say "paused from iPhone". */
  by: string | null
}

const EMPTY: PlayerState = {
  queue: [], index: -1, trackId: null, playing: false, position: 0,
  target: { kind: 'local' }, repeat: 'off', shuffle: false, revision: 0, by: null,
}

export class Player {
  #state: PlayerState = { ...EMPTY }
  #events: Events
  #db: DB

  constructor(db: DB, events: Events) {
    this.#db = db
    this.#events = events
  }

  get state(): PlayerState {
    return { ...this.#state }
  }

  /**
   * Applies a change and tells everyone.
   *
   * The revision is what lets a controller ignore its own echo: it made the
   * change, it already drew it, and re-drawing from the event would fight the
   * user's next click.
   */
  #set(patch: Partial<PlayerState>, by?: string): PlayerState {
    this.#state = { ...this.#state, ...patch, revision: this.#state.revision + 1, by: by ?? null }
    this.#events.emit('player', this.#state)
    return this.state
  }

  /** Replaces the queue and starts at `startAt`, which is what pressing play on a list means. */
  setQueue(trackIds: string[], startAt = 0, by?: string): PlayerState {
    const index = trackIds.length ? Math.min(Math.max(startAt, 0), trackIds.length - 1) : -1
    return this.#set({
      queue: trackIds,
      index,
      trackId: index >= 0 ? trackIds[index] : null,
      position: 0,
      playing: index >= 0,
    }, by)
  }

  /** Adds without disturbing what is playing. */
  enqueue(trackIds: string[], by?: string): PlayerState {
    const queue = [...this.#state.queue, ...trackIds]
    // An empty player that is given tracks should start, not sit there.
    return this.#state.index < 0
      ? this.setQueue(queue, 0, by)
      : this.#set({ queue }, by)
  }

  /** Puts tracks next, which is the one queue operation people actually miss. */
  playNext(trackIds: string[], by?: string): PlayerState {
    const { queue, index } = this.#state
    if (index < 0) return this.setQueue(trackIds, 0, by)
    return this.#set({
      queue: [...queue.slice(0, index + 1), ...trackIds, ...queue.slice(index + 1)],
    }, by)
  }

  play(by?: string): PlayerState {
    if (this.#state.index < 0) return this.state
    return this.#set({ playing: true }, by)
  }

  pause(by?: string): PlayerState {
    return this.#set({ playing: false }, by)
  }

  seek(seconds: number, by?: string): PlayerState {
    return this.#set({ position: Math.max(0, seconds) }, by)
  }

  /**
   * Moves through the queue.
   *
   * Falling off the end only wraps when repeat is on; otherwise it stops, which
   * is what "repeat: off" means. `repeat: one` is handled by whatever is
   * playing rather than here — it never advances.
   */
  step(dir: 1 | -1, by?: string): PlayerState {
    const { queue, index, shuffle, repeat } = this.#state
    if (!queue.length) return this.state

    if (shuffle && dir === 1) {
      const next = Math.floor(Math.random() * queue.length)
      return this.#set({ index: next, trackId: queue[next], position: 0, playing: true }, by)
    }

    const next = index + dir
    if (next >= queue.length) {
      if (repeat !== 'all') return this.#set({ playing: false, position: 0 }, by)
      return this.#set({ index: 0, trackId: queue[0], position: 0, playing: true }, by)
    }
    if (next < 0) {
      // Going back from the first track restarts it rather than wrapping to the
      // end, which is what every player does and what people expect.
      return this.#set({ position: 0 }, by)
    }
    return this.#set({ index: next, trackId: queue[next], position: 0, playing: true }, by)
  }

  /** Jumps to a track already in the queue. */
  goTo(trackId: string, by?: string): PlayerState {
    const index = this.#state.queue.indexOf(trackId)
    if (index < 0) return this.state
    return this.#set({ index, trackId, position: 0, playing: true }, by)
  }

  setTarget(target: PlayerTarget, by?: string): PlayerState {
    // Moving the music to another room should not restart it, so the position
    // is kept and it is the renderer's job to pick it up.
    return this.#set({ target }, by)
  }

  set(patch: Pick<Partial<PlayerState>, 'repeat' | 'shuffle'>, by?: string): PlayerState {
    // Absent keys are dropped rather than spread: `PATCH /player { shuffle }`
    // arrives here as `{ repeat: undefined, shuffle: true }`, and spreading
    // that erases the repeat mode. Turning shuffle on must not silently turn
    // repeat off — they are two controls that happen to share a route.
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    return this.#set(given, by)
  }

  /**
   * A renderer reporting where it really is.
   *
   * Deliberately not a full state change: a renderer is allowed to say where it
   * got to, not to reorder the queue. It also does not bump `by` — a position
   * tick is not somebody doing something.
   */
  report(position: number, playing?: boolean): PlayerState {
    this.#state = {
      ...this.#state,
      position: Math.max(0, position),
      ...(playing === undefined ? {} : { playing }),
      revision: this.#state.revision + 1,
    }
    this.#events.emit('player', this.#state)
    return this.state
  }

  clear(by?: string): PlayerState {
    return this.#set({ ...EMPTY, revision: this.#state.revision }, by)
  }

  /** The state with the current track's metadata, which is what a UI wants. */
  withTrack(): PlayerState & { track: unknown } {
    const track = this.#state.trackId
      ? this.#db.prepare(
          `SELECT id, name, artist, albumArtist, album, duration, format
           FROM tracks WHERE id = ? AND deletedAt IS NULL`).get(this.#state.trackId)
      : null
    return { ...this.state, track: track ?? null }
  }
}
