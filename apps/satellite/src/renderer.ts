import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'

/**
 * A satellite that plays.
 *
 * The same machine that docks an iPod usually has a headphone socket or a DAC
 * hat, and a Pi in the hallway is a perfectly good speaker. This makes it one:
 * it registers with the server as an output, watches the shared queue, and
 * plays whatever the queue says it should.
 *
 * **It pulls.** The server never pushes audio here — it publishes an intent and
 * this decides how to honour it, which is the same rule the device side already
 * follows. That is what lets a satellite live on hardware the server could not
 * run on, behind a NAT, on a flaky wifi link, and simply catch up when it
 * reconnects rather than needing the server to have retried.
 *
 * Playback is a subprocess. Decoding audio in Node would mean a native module,
 * which this project does not ship, and every machine that can play music
 * already has something that plays music.
 */

/** Players worth trying, best first. Whichever exists is the one used. */
const PLAYERS = [
  // Purpose-built for exactly this: no window, no video, reads a URL, exits
  // when the stream ends.
  { bin: 'mpv', args: (url: string) => ['--no-video', '--really-quiet', '--no-terminal', url] },
  // Ships with ffmpeg, which is already a dependency for conversion.
  { bin: 'ffplay', args: (url: string) => ['-nodisp', '-autoexit', '-loglevel', 'error', url] },
  // The last resort on a bare Debian: no seeking, but it makes sound.
  { bin: 'cvlc', args: (url: string) => ['--play-and-exit', '--intf', 'dummy', url] },
]

export function findPlayer(): { bin: string; args: (url: string) => string[] } | null {
  for (const p of PLAYERS) {
    try {
      execFileSync(p.bin, ['--version'], { stdio: 'ignore', timeout: 3000 })
      return p
    } catch {
      // Not installed, or it does not take --version. Either way, not this one.
    }
  }
  return null
}

export type RendererOptions = {
  server: string
  id: string
  name: string
  url: string
  /** What this machine can decode, so the server sends a rendition it plays. */
  formats?: string[]
  /** Overridden by the tests; nothing else has a reason to. */
  player?: { bin: string; args: (url: string) => string[] }
  fetch?: typeof globalThis.fetch
}

type Snapshot = { trackId: string | null; playing: boolean; targetId: string | null; position: number }

/**
 * Follows the shared queue and makes the right noise.
 *
 * The state machine is deliberately small, because the interesting failures are
 * all about *when* to restart the subprocess rather than how. It restarts when
 * the track changes, and only then — a position report or somebody else's pause
 * must not interrupt a song that is playing correctly.
 */
export class SatelliteRenderer {
  #opts: RendererOptions
  #fetch: typeof globalThis.fetch
  #child: ChildProcess | null = null
  #playingTrack: string | null = null
  #startedAt = 0
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(opts: RendererOptions) {
    this.#opts = opts
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  get playing(): string | null {
    return this.#playingTrack
  }

  /** Announces itself. Also the heartbeat: calling again keeps it from going stale. */
  async register(): Promise<boolean> {
    try {
      const res = await this.#fetch(`${this.#opts.server}/outputs/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: this.#opts.id, name: this.#opts.name, kind: 'satellite',
          url: this.#opts.url, formats: this.#opts.formats ?? [],
        }),
      })
      return res.ok
    } catch {
      // The server being down is the normal case on a Pi that boots first.
      return false
    }
  }

  async poll(): Promise<Snapshot | null> {
    let state: any
    try {
      const res = await this.#fetch(`${this.#opts.server}/player`)
      if (!res.ok) return null
      state = await res.json()
    } catch {
      return null
    }

    const targetId = state.target?.kind === 'output' ? state.target.id : null
    const mine = targetId === this.#opts.id
    const snapshot: Snapshot = {
      trackId: state.trackId ?? null,
      playing: Boolean(state.playing),
      targetId,
      position: Number(state.position) || 0,
    }

    if (!mine || !snapshot.playing || !snapshot.trackId) {
      // Somebody moved the music elsewhere, or paused it. Silence is immediate;
      // waiting for the track to end would be surreal.
      this.stop()
      return snapshot
    }

    // Already playing the right thing. Restarting here is the bug that makes a
    // song stutter every time anyone touches anything.
    if (this.#playingTrack === snapshot.trackId) return snapshot

    this.#start(snapshot.trackId)
    return snapshot
  }

  #start(trackId: string): void {
    this.stop()
    const player = this.#opts.player ?? findPlayer()
    if (!player) {
      console.error('satellite · no player found — install mpv, ffmpeg or vlc')
      return
    }

    // `accept` tells the server what this machine decodes, so it hands over a
    // rendition that already plays rather than one needing conversion.
    const accept = (this.#opts.formats ?? []).join(',')
    const url = `${this.#opts.server}/stream/${trackId}${accept ? `?accept=${accept}` : ''}`

    const child = spawn(player.bin, player.args(url), { stdio: 'ignore' })
    this.#child = child
    this.#playingTrack = trackId
    this.#startedAt = Date.now()

    child.on('exit', () => {
      // Both checks compare against *this* child, not whatever is current.
      //
      // A track change kills the old process and spawns the new one in the same
      // tick; the old one's `exit` arrives afterwards. Clearing unconditionally
      // there orphans the process that just started -- `stop()` then finds
      // nothing to kill, the player keeps running for ever, and the next track
      // plays over the top of it.
      if (this.#child === child) this.#child = null
      if (this.#playingTrack === trackId) this.#playingTrack = null
    })
  }

  stop(): void {
    if (this.#child) {
      this.#child.kill('SIGTERM')
      this.#child = null
    }
    this.#playingTrack = null
  }

  /** Where this machine actually is, which only it knows. */
  async report(): Promise<void> {
    if (!this.#playingTrack) return
    try {
      await this.#fetch(`${this.#opts.server}/player/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jukebox-client': this.#opts.name },
        body: JSON.stringify({ position: Math.floor((Date.now() - this.#startedAt) / 1000), playing: true }),
      })
    } catch {
      // A missed report is a stale scrubber for a second, not a problem.
    }
  }

  /**
   * Polls the queue and reports back, on one timer.
   *
   * A second a piece: fast enough that pressing pause on a phone feels
   * immediate, slow enough that a Pi on wifi is not doing anything else.
   */
  start(intervalMs = 1000): void {
    if (this.#timer) return
    void this.register()
    this.#timer = setInterval(() => {
      void this.poll().then(() => this.report())
    }, intervalMs)
    this.#timer.unref?.()
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.stop()
  }
}
