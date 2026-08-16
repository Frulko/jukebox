import { connect as tcpConnect, type Socket } from 'node:net'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { spawn, type ChildProcess } from 'node:child_process'

/**
 * The transports the host hands a plugin.
 *
 * Not because a plugin could not call `fetch` or `net.connect` itself — it can,
 * it runs in this process — but because of what happens when it is turned off.
 * A plugin that opened its own socket keeps it open for ever: `deactivate` has
 * no way to reach it, and a disabled plugin quietly holding a connection to a
 * broker is the leak nobody finds. Everything opened through here is tracked
 * against the plugin that opened it and closed when it stops.
 *
 * Timers are in here for the same reason, and they are the most common leak of
 * the lot: a plugin that polls every thirty seconds keeps polling after being
 * disabled, right up until the process restarts.
 *
 * Child processes are here for the third time the same reason: a plugin that
 * spawns its own analyser or daemon leaves it running after being disabled, and
 * an orphaned process is worse than an orphaned socket — it holds a port, eats
 * CPU, and survives everything short of a reboot.
 *
 * No MQTT yet. It is a binary protocol and would be the first runtime
 * dependency added for a feature nothing uses; a plugin needing it today can
 * carry its own client. The host takes it over when several plugins want the
 * same broker, because sharing one connection is the only thing a plugin cannot
 * arrange for itself.
 */

export type Transports = {
  /** `fetch`, with the plugin's requests abortable as a group. */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
  ws: (url: string, protocols?: string | string[]) => WebSocket
  tcp: (opts: { host: string; port: number }) => Socket
  udp: (opts?: { type?: 'udp4' | 'udp6' }) => UdpSocket
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearInterval: (t: ReturnType<typeof setInterval>) => void
  clearTimeout: (t: ReturnType<typeof setTimeout>) => void
  /**
   * A child process the host owns.
   *
   * For plugins whose integration *is* a program: an analyser, a daemon, a
   * bridge that already exists in another language. The plugin gets the process
   * and the host gets the responsibility — it is killed when the plugin stops,
   * and it cannot be the reason the server refuses to exit.
   */
  spawn: (command: string, args?: string[], opts?: SidecarOptions) => Sidecar
}

export type SidecarOptions = {
  cwd?: string
  env?: Record<string, string>
  /**
   * Start it again if it dies, with a growing delay.
   *
   * Off by default, because a program that exits immediately and is restarted
   * for ever is a fork bomb with good intentions. On, the backoff is what keeps
   * a broken sidecar from becoming a busy loop.
   */
  restart?: boolean
  /** Called for every line the process writes, on either stream. */
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void
  /** Called when it exits, whether or not it will be restarted. */
  onExit?: (code: number | null, signal: string | null) => void
}

export type Sidecar = {
  /** The current process, which changes across a restart. */
  readonly process: ChildProcess | null
  readonly running: boolean
  /** How many times it has been started, restarts included. */
  readonly starts: number
  write: (data: string) => void
  /** Stops it, and stops restarting it. */
  stop: () => void
}

/**
 * Everything one plugin has open.
 *
 * `closeAll` is deliberately total and forgiving: it is called while turning a
 * plugin off, often because that plugin is already misbehaving, so one socket
 * that throws on close must not prevent the next one from being closed.
 */
export class Resources {
  #sockets = new Set<{ destroy?: () => void; close?: () => void }>()
  #children = new Set<ChildProcess>()
  #timers = new Set<ReturnType<typeof setInterval>>()
  #abort = new AbortController()
  #closed = false

  get open(): { sockets: number; timers: number; children: number } {
    return { sockets: this.#sockets.size, timers: this.#timers.size, children: this.#children.size }
  }

  get closed(): boolean {
    return this.#closed
  }

  transports(): Transports {
    const track = <T extends { destroy?: () => void; close?: () => void }>(s: T): T => {
      if (this.#closed) {
        // Opening something after the plugin stopped means a callback outlived
        // it. Close it immediately rather than leaving an untracked socket.
        queueMicrotask(() => (s.destroy?.() ?? s.close?.()))
        return s
      }
      this.#sockets.add(s)
      return s
    }

    const forget = (s: any) => this.#sockets.delete(s)

    return {
      fetch: (input, init = {}) => {
        // The plugin's own signal still wins; the group abort is added on top,
        // so turning the plugin off cancels requests already in flight.
        const signal = init.signal
          ? AbortSignal.any([init.signal, this.#abort.signal])
          : this.#abort.signal
        return fetch(input, { ...init, signal })
      },

      ws: (url, protocols) => {
        const socket = new WebSocket(url, protocols as never)
        const wrapper = { close: () => socket.close() }
        track(wrapper)
        socket.addEventListener('close', () => forget(wrapper))
        return socket
      },

      tcp: ({ host, port }) => {
        const socket = tcpConnect({ host, port })
        track(socket)
        socket.on('close', () => forget(socket))
        return socket
      },

      udp: ({ type = 'udp4' } = {}) => {
        const socket = createSocket(type)
        track(socket)
        socket.on('close', () => forget(socket))
        return socket
      },

      // Unref'd, both of them. A plugin polling every minute must never be the
      // reason the process refuses to exit: without this, a single scrobbler
      // keeps the event loop alive and SIGTERM hangs until someone kills it.
      // They still fire normally for as long as the server is up, which is the
      // whole of what a plugin needs.
      setInterval: (fn, ms) => {
        const t = setInterval(fn, ms)
        t.unref?.()
        if (this.#closed) clearInterval(t)
        else this.#timers.add(t)
        return t
      },
      setTimeout: (fn, ms) => {
        const t = setTimeout(() => {
          this.#timers.delete(t)
          fn()
        }, ms)
        t.unref?.()
        if (this.#closed) clearTimeout(t)
        else this.#timers.add(t)
        return t
      },
      clearInterval: (t) => {
        clearInterval(t)
        this.#timers.delete(t)
      },
      clearTimeout: (t) => {
        clearTimeout(t)
        this.#timers.delete(t)
      },

      spawn: (command, args = [], opts = {}) => this.#spawn(command, args, opts),
    }
  }

  /**
   * Starts a program and keeps hold of it.
   *
   * Three things here are not optional, and each is a bug this project has
   * already met somewhere else:
   *
   * - **The output is drained.** A process whose stdout pipe fills up blocks
   *   mid-write and appears to hang. ffmpeg taught this one.
   * - **The child is unref'd**, so a running sidecar cannot be the reason
   *   SIGTERM does nothing. Plugin timers taught this one.
   * - **The restart backs off.** Restarting something that exits immediately,
   *   immediately, is a busy loop that looks like a hung server.
   */
  #spawn(command: string, args: string[], opts: SidecarOptions): Sidecar {
    let child: ChildProcess | null = null
    let starts = 0
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | null = null

    const line = (stream: 'stdout' | 'stderr') => {
      let buffer = ''
      return (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        // The last piece is whatever came before the next newline arrives.
        buffer = lines.pop() ?? ''
        for (const l of lines) if (l.trim()) opts.onOutput?.(l, stream)
      }
    }

    const start = () => {
      if (stopped || this.#closed) return
      starts++

      // No shell: a plugin passing a filename with a space in it should get a
      // filename with a space in it, not two arguments and an injection.
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Drained whether or not anyone is listening. `resume()` alone would
      // discard the output; the line reader is only attached when asked for.
      if (opts.onOutput) {
        child.stdout?.on('data', line('stdout'))
        child.stderr?.on('data', line('stderr'))
      } else {
        child.stdout?.resume()
        child.stderr?.resume()
      }

      child.unref()
      child.on('error', (err) => {
        // A command that does not exist arrives here rather than as an exit.
        opts.onOutput?.(`failed to start: ${err.message}`, 'stderr')
      })

      child.on('exit', (code, signal) => {
        const died = child
        child = null
        this.#children.delete(died!)
        opts.onExit?.(code, signal)

        if (!opts.restart || stopped || this.#closed) return
        // Growing delay, capped: a program failing to start should be retried
        // slowly enough that the log is readable and the CPU is idle.
        const delay = Math.min(30_000, 500 * 2 ** Math.min(starts, 6))
        retry = setTimeout(start, delay)
        retry.unref?.()
      })

      this.#children.add(child)
    }

    start()

    return {
      get process() { return child },
      get running() { return Boolean(child && child.exitCode === null) },
      get starts() { return starts },
      write: (data) => { child?.stdin?.write(data) },
      stop: () => {
        stopped = true
        if (retry) clearTimeout(retry)
        retry = null
        if (child) {
          this.#children.delete(child)
          child.kill('SIGTERM')
          child = null
        }
      },
    }
  }

  closeAll(): void {
    this.#closed = true
    for (const t of this.#timers) {
      clearInterval(t)
      clearTimeout(t)
    }
    this.#timers.clear()

    for (const s of this.#sockets) {
      try {
        s.destroy?.() ?? s.close?.()
      } catch { /* already gone, or refusing to close: the next one still gets its turn */ }
    }
    this.#sockets.clear()

    // SIGTERM rather than SIGKILL: a sidecar deserves the chance to flush and
    // close cleanly, and anything still alive goes when the server does.
    for (const child of this.#children) {
      try {
        child.kill('SIGTERM')
      } catch { /* already dead */ }
    }
    this.#children.clear()

    try {
      this.#abort.abort(new Error('the plugin was stopped'))
    } catch { /* nothing was in flight */ }
  }
}
