/**
 * A brake on password guessing.
 *
 * Two problems, not one, and the second is the reason this exists at all on a
 * server whose passwords are already scrypt-hashed:
 *
 * 1. **Guessing.** scrypt is memory-hard, so an attacker pays for every
 *    attempt — but they pay in *our* CPU, not theirs, and they can try all
 *    night.
 * 2. **Exhaustion.** That is the sharper edge. Each attempt makes this server
 *    do the memory-hard work, so hammering the login route is a denial of
 *    service against a box that may be a Raspberry Pi. A password that is
 *    never guessed is no comfort if the music stops.
 *
 * Keyed on **username and address together**. Username alone would let anyone
 * lock a household out of their own server by failing logins on purpose, which
 * turns a protection into the attack. Address alone would punish everyone
 * behind one NAT for one person's typing.
 *
 * Nothing is ever locked permanently: the window passes and the key is
 * forgotten. This slows an attacker to a crawl rather than deciding who is one.
 */

export type ThrottleOptions = {
  /** Failures tolerated in a window before the brake comes on. */
  limit?: number
  /** How long failures are remembered. */
  windowMs?: number
  /** How long a throttled key is refused. */
  blockMs?: number
  /** Injected by the tests; real callers use the clock. */
  now?: () => number
}

type Entry = { failures: number; first: number; until: number }

export class Throttle {
  #entries = new Map<string, Entry>()
  #limit: number
  #window: number
  #block: number
  #now: () => number

  constructor(opts: ThrottleOptions = {}) {
    // Ten is deliberately generous. This is a household server: somebody
    // mistyping their password five times in a row is a Tuesday, and a limit
    // that punishes that is a limit people disable.
    this.#limit = opts.limit ?? 10
    this.#window = opts.windowMs ?? 15 * 60_000
    this.#block = opts.blockMs ?? 60_000
    this.#now = opts.now ?? Date.now
  }

  /** Seconds to wait, or 0 when the caller may proceed. */
  retryAfter(key: string): number {
    const entry = this.#entries.get(key)
    if (!entry) return 0
    const now = this.#now()

    if (entry.until > now) return Math.ceil((entry.until - now) / 1000)

    // The window has passed with the brake off: forget it entirely rather than
    // letting a failure from an hour ago count towards tonight.
    if (now - entry.first > this.#window) {
      this.#entries.delete(key)
      return 0
    }
    return 0
  }

  /** Records a failed attempt, and returns whether that one tripped the brake. */
  fail(key: string): boolean {
    const now = this.#now()
    const entry = this.#entries.get(key)

    if (!entry || now - entry.first > this.#window) {
      this.#entries.set(key, { failures: 1, first: now, until: 0 })
      return false
    }

    entry.failures++
    if (entry.failures >= this.#limit) {
      entry.until = now + this.#block
      // The count restarts with the block, so a blocked key that keeps trying
      // serves the same minute again rather than an ever-growing sentence.
      entry.failures = 0
      entry.first = now
      return true
    }
    return false
  }

  /** A success clears the record: the person proved they are not guessing. */
  succeed(key: string): void {
    this.#entries.delete(key)
  }

  /**
   * Drops keys nobody has touched in a window.
   *
   * Without it this map is a slow leak keyed on attacker-chosen strings, which
   * is a memory exhaustion of its own — the shape of bug this file exists to
   * prevent, reintroduced by the fix.
   */
  prune(): number {
    const now = this.#now()
    let dropped = 0
    for (const [key, entry] of this.#entries) {
      if (entry.until <= now && now - entry.first > this.#window) {
        this.#entries.delete(key)
        dropped++
      }
    }
    return dropped
  }

  get size(): number {
    return this.#entries.size
  }
}

/**
 * Who is asking, as far as we can tell.
 *
 * Behind a reverse proxy — which is how this is meant to be deployed — the
 * socket address is the proxy for everybody, so `X-Forwarded-For` is read when
 * present. That header is caller-controlled and therefore spoofable: an
 * attacker can vary it to dodge the brake. It is used anyway, because the
 * alternative is throttling every user behind the proxy as one, and the
 * username half of the key still applies.
 */
export function callerKey(username: string, headers: { get(name: string): string | null }): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const address = forwarded || headers.get('x-real-ip') || 'local'
  return `${username.toLowerCase()}@${address}`
}
