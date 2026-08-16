import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DB } from './db.ts'
import type { JobQueue } from './jobs.ts'
import { Resources, type Transports } from './transports.ts'
import type { Events, PlayEvent } from './plays.ts'

/**
 * The plugin host.
 *
 * Plugins are ordinary Node modules, run in this process. That is a deliberate
 * choice with a cost, and the cost is worth naming: **a plugin can do anything
 * the server can do.** The permissions in a manifest are shown to whoever
 * installs it; they are not enforced by anything. Home Assistant and Volumio
 * both landed here after trying harder, because the plugins people actually
 * want are wrappers around HTTP, MQTT and hardware, and every real sandbox
 * either blocks those or is a full process boundary with its own IPC to
 * maintain.
 *
 * What the host does guarantee is that a plugin cannot take the *server* down:
 * loading, activating and deactivating are each isolated, and a plugin that
 * throws is recorded as failed while everything else carries on.
 *
 * `hostApi` is the compatibility contract. A plugin declares the host version
 * it was written against and is refused rather than half-working when the host
 * has moved on — a plugin calling a method that no longer exists fails at the
 * worst possible moment otherwise.
 */

/** Bumped on a breaking change to what `PluginHost` hands a plugin. */
export const HOST_API_VERSION = '1.0.0'

export type Manifest = {
  id: string
  name: string
  version: string
  /** Semver range against `HOST_API_VERSION`, e.g. `^1.0.0`. */
  hostApi: string
  /** Entry point, relative to the plugin folder. */
  main: string
  description?: string
  author?: string
  /** Declared, shown before install, and not enforced. See the note above. */
  permissions?: string[]
  /** Where a plugin says it wants to appear in the UI. */
  contributes?: Record<string, unknown>
}

export type PluginState = 'installed' | 'active' | 'failed' | 'disabled'

export type Plugin = {
  id: string
  name: string
  version: string
  description: string
  author: string
  permissions: string[]
  contributes: Record<string, unknown>
  enabled: 0 | 1
  state: PluginState
  error: string | null
  config: Record<string, unknown>
}

/**
 * Caret and exact ranges only.
 *
 * The whole of what a `hostApi` field needs, and a fraction of what a semver
 * library carries. `^1.2.3` accepts 1.x at or above 1.2.3; below 1.0.0 the
 * minor is the breaking position, which is the rule people get wrong when they
 * hand-roll this.
 */
export function satisfies(version: string, range: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const v = parse(version)
  if (!v) return false

  const spec = range.trim()
  if (spec === '*') return true

  const caret = spec.startsWith('^')
  const r = parse(caret ? spec.slice(1) : spec)
  if (!r) return false

  if (!caret) return v[0] === r[0] && v[1] === r[1] && v[2] === r[2]

  const atLeast = v[0] > r[0]
    || (v[0] === r[0] && (v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2])))
  if (!atLeast) return false
  // 0.x is special: every minor is a breaking change, which is exactly what
  // makes an early plugin against 0.3 refuse to load on 0.4.
  return r[0] === 0 ? v[0] === 0 && v[1] === r[1] : v[0] === r[0]
}

/** Reads and checks a manifest. Returns the reason when it is not usable. */
export function readManifest(raw: unknown): { manifest: Manifest } | { error: string } {
  const m = raw as Manifest
  for (const field of ['id', 'name', 'version', 'hostApi', 'main'] as const) {
    if (typeof m?.[field] !== 'string' || !m[field]) return { error: `manifest is missing ${field}` }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(m.id)) {
    // The id becomes a table key and a URL segment; keeping it boring means it
    // never has to be escaped anywhere.
    return { error: `id must be lowercase letters, digits and dashes: ${m.id}` }
  }
  if (m.main.includes('..')) return { error: 'main must stay inside the plugin folder' }
  if (!satisfies(HOST_API_VERSION, m.hostApi)) {
    return { error: `needs host API ${m.hostApi}, this host is ${HOST_API_VERSION}` }
  }
  return { manifest: m }
}

/** What a plugin is handed on activation. The surface `hostApi` is versioning. */
export type Host = {
  apiVersion: string
  pluginId: string
  /** Prefixed with the plugin id, so a noisy plugin is identifiable. */
  log: (...args: unknown[]) => void
  /** The plugin's own settings, as stored by the server. */
  config: Record<string, unknown>
  /** Persists settings back. */
  setConfig: (next: Record<string, unknown>) => void
  /** Registers a job kind, namespaced to the plugin so two cannot collide. */
  registerJob: (name: string, handler: (ctx: any) => Promise<void>) => void
  /**
   * Sockets, requests and timers that the host closes when the plugin stops.
   *
   * A plugin can reach `fetch` and `net.connect` directly — it runs in this
   * process. Using these instead is what makes turning it off actually turn it
   * off.
   */
  net: Transports
  /**
   * Server events. Currently `play`, which is what a scrobbler needs.
   *
   * The returned function unsubscribes, and the host calls it for you when the
   * plugin stops — a listener that outlives its plugin fires into code that is
   * no longer there.
   */
  on: (event: 'play', handler: (e: PlayEvent) => void) => () => void
}

type Loaded = {
  manifest: Manifest
  module: { activate?: (host: Host) => unknown; deactivate?: () => unknown }
  resources: Resources
  /** Unsubscribers for every listener the plugin registered. */
  off: (() => void)[]
}

const hydrate = (r: any): Plugin => ({
  id: r.id, name: r.name, version: r.version,
  description: r.description, author: r.author,
  permissions: JSON.parse(r.permissions || '[]'),
  contributes: JSON.parse(r.contributes || '{}'),
  enabled: r.enabled, state: r.state, error: r.error,
  config: JSON.parse(r.config || '{}'),
})

export function listPlugins(db: DB): Plugin[] {
  return (db.prepare(`SELECT * FROM plugins ORDER BY name`).all() as any[]).map(hydrate)
}

export function getPlugin(db: DB, id: string): Plugin | null {
  const r = db.prepare(`SELECT * FROM plugins WHERE id = ?`).get(id) as any
  return r ? hydrate(r) : null
}

export class PluginHost {
  #db: DB
  #jobs: JobQueue
  #root: string
  #loaded = new Map<string, Loaded>()

  #events: Events

  constructor(db: DB, jobs: JobQueue, root: string, events: Events) {
    this.#db = db
    this.#jobs = jobs
    this.#root = resolve(root)
    this.#events = events
  }

  get root(): string {
    return this.#root
  }

  /** The ids currently running, for the boot line and the admin page. */
  active(): string[] {
    return [...this.#loaded.keys()]
  }

  /** What one plugin currently holds open. Used by the tests and worth exposing. */
  resourcesOf(id: string): { sockets: number; timers: number } | null {
    return this.#loaded.get(id)?.resources.open ?? null
  }

  /**
   * Reads every plugin folder and records what it found.
   *
   * Discovery is separate from activation on purpose: a plugin that fails to
   * load still appears in the list, with the reason, instead of vanishing and
   * leaving the user to guess why their store install did nothing.
   */
  async discover(): Promise<Plugin[]> {
    let dirs: string[] = []
    try {
      dirs = (await readdir(this.#root, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
    } catch {
      return listPlugins(this.#db) // no plugin folder yet is not an error
    }

    for (const dir of dirs) {
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(join(this.#root, dir, 'plugin.json'), 'utf8'))
      } catch (err) {
        this.#record(dir, null, 'failed', `no readable plugin.json: ${err instanceof Error ? err.message : err}`)
        continue
      }

      const read = readManifest(raw)
      if ('error' in read) {
        this.#record(dir, null, 'failed', read.error)
        continue
      }
      const existing = getPlugin(this.#db, read.manifest.id)
      this.#record(read.manifest.id, read.manifest,
        existing?.enabled === 0 ? 'disabled' : 'installed', null)
    }
    return listPlugins(this.#db)
  }

  #record(id: string, manifest: Manifest | null, state: PluginState, error: string | null): void {
    this.#db.prepare(`
      INSERT INTO plugins (id, name, version, description, author, permissions, contributes,
        enabled, state, error, config, installedAt)
      VALUES (?,?,?,?,?,?,?,COALESCE((SELECT enabled FROM plugins WHERE id = ?), 1),?,?,
              COALESCE((SELECT config FROM plugins WHERE id = ?), '{}'), ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, version = excluded.version, description = excluded.description,
        author = excluded.author, permissions = excluded.permissions,
        contributes = excluded.contributes, state = excluded.state, error = excluded.error`)
      .run(id, manifest?.name ?? id, manifest?.version ?? '0.0.0',
        manifest?.description ?? '', manifest?.author ?? '',
        JSON.stringify(manifest?.permissions ?? []),
        JSON.stringify(manifest?.contributes ?? {}),
        id, state, error, id, Date.now())
  }

  /**
   * Activates one plugin.
   *
   * Everything is caught. A plugin whose top level throws, whose `activate`
   * throws, or which is not a module at all, becomes `failed` with the reason
   * on its row — it does not take the server with it.
   */
  async activate(id: string): Promise<Plugin | null> {
    const row = getPlugin(this.#db, id)
    if (!row) return null
    if (!row.enabled) return row

    try {
      const raw = JSON.parse(await readFile(join(this.#root, id, 'plugin.json'), 'utf8'))
      const read = readManifest(raw)
      if ('error' in read) throw new Error(read.error)

      const entry = join(this.#root, id, read.manifest.main)
      if (!entry.startsWith(join(this.#root, id))) throw new Error('main escapes the plugin folder')

      // Cache-busted so reinstalling a plugin loads the new code rather than the
      // copy Node already has. Node's module cache has no eviction.
      const module = await import(`${pathToFileURL(entry).href}?v=${row.version}-${Date.now()}`)
      const resources = new Resources()
      const off: (() => void)[] = []
      // Registered before activation, not after: a plugin whose `activate`
      // throws halfway may already have opened a socket, and that socket still
      // has to be closable.
      this.#loaded.set(id, { manifest: read.manifest, module, resources, off })
      await module.activate?.(this.#hostFor(read.manifest, resources, off))
      this.#db.prepare(`UPDATE plugins SET state = 'active', error = NULL WHERE id = ?`).run(id)
    } catch (err) {
      // Whatever it opened before throwing goes too, or a plugin that fails on
      // every restart accumulates sockets each time.
      const partial = this.#loaded.get(id)
      for (const off of partial?.off ?? []) off()
      partial?.resources.closeAll()
      this.#loaded.delete(id)
      this.#db.prepare(`UPDATE plugins SET state = 'failed', error = ? WHERE id = ?`)
        .run(err instanceof Error ? err.message : String(err), id)
    }
    return getPlugin(this.#db, id)
  }

  async deactivate(id: string): Promise<void> {
    const loaded = this.#loaded.get(id)
    if (!loaded) return
    try {
      await loaded.module.deactivate?.()
    } catch (err) {
      console.error(`[plugin ${id}] deactivate failed:`, err instanceof Error ? err.message : err)
    }
    // After the plugin's own cleanup, and regardless of whether it threw: a
    // plugin that fails to tidy up is exactly the one whose sockets must go.
    for (const off of loaded.off) off()
    loaded.resources.closeAll()
    this.#loaded.delete(id)
    this.#db.prepare(`UPDATE plugins SET state = 'disabled' WHERE id = ?`).run(id)
  }

  /** Activates everything enabled. Called once at boot. */
  async activateAll(): Promise<void> {
    for (const p of listPlugins(this.#db)) {
      if (p.enabled && p.state !== 'failed') await this.activate(p.id)
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<Plugin | null> {
    if (!getPlugin(this.#db, id)) return null
    this.#db.prepare(`UPDATE plugins SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id)
    if (enabled) return this.activate(id)
    await this.deactivate(id)
    return getPlugin(this.#db, id)
  }

  #hostFor(manifest: Manifest, resources: Resources, off: (() => void)[]): Host {
    const db = this.#db
    const jobs = this.#jobs
    return {
      apiVersion: HOST_API_VERSION,
      pluginId: manifest.id,
      log: (...args) => console.log(`[plugin ${manifest.id}]`, ...args),
      config: getPlugin(db, manifest.id)?.config ?? {},
      setConfig: (next) => {
        db.prepare(`UPDATE plugins SET config = ? WHERE id = ?`).run(JSON.stringify(next), manifest.id)
      },
      net: resources.transports(),
      on: (event, handler) => {
        this.#events.on(event, handler)
        const unsubscribe = () => this.#events.off(event, handler)
        off.push(unsubscribe)
        return unsubscribe
      },
      registerJob: (name, handler) => {
        // Namespaced: two plugins registering "sync" must not fight over it, and
        // a plugin must never shadow one of the server's own kinds.
        jobs.register(`plugin:${manifest.id}:${name}` as never, handler)
      },
    }
  }
}
