import { connect as tcpConnect, type Socket } from 'node:net'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'

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
  #timers = new Set<ReturnType<typeof setInterval>>()
  #abort = new AbortController()
  #closed = false

  get open(): { sockets: number; timers: number } {
    return { sockets: this.#sockets.size, timers: this.#timers.size }
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

    try {
      this.#abort.abort(new Error('the plugin was stopped'))
    } catch { /* nothing was in flight */ }
  }
}
