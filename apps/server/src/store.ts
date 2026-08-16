import { createHash } from 'node:crypto'
import { mkdir, rm, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readManifest, satisfies, HOST_API_VERSION } from './plugins.ts'
import { stripComponents, untar } from './untar.ts'

/**
 * The plugin store.
 *
 * An index is a JSON document at a URL listing plugins and where to download
 * them. There is no default index and no built-in one: installing from a store
 * is running someone else's code as the server, so the URL is a trust decision
 * and it has to be made deliberately, by configuring it, rather than inherited
 * from whatever this file happened to ship with.
 *
 * What is checked before anything is written to disk:
 *
 * - the entry's `sha256`, when the index gives one — an index served over HTTPS
 *   still cannot vouch for a tarball hosted somewhere else;
 * - the archive, by the extractor, which refuses links and paths that climb;
 * - the manifest inside it, including that its id matches the one the index
 *   advertised. An index entry called `lastfm` that unpacks a plugin calling
 *   itself `admin-backdoor` is the interesting attack, and it is cheap to stop.
 *
 * Only then does anything land, and it lands by unpacking beside the target and
 * renaming into place, so a failure halfway leaves the previous version intact
 * rather than a half-written plugin the host will try to load.
 */

export type StoreEntry = {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  hostApi: string
  /** Where the tarball lives. */
  tarball: string
  /** Hex sha256 of the tarball. Optional in the format, checked when present. */
  sha256?: string
  permissions?: string[]
}

export type StoreIndex = {
  version: number
  plugins: StoreEntry[]
}

const TIMEOUT = 30_000
const MAX_TARBALL = 32 * 1024 * 1024

/** Fetches and validates an index. */
export async function fetchIndex(url: string): Promise<StoreEntry[]> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`the store answered ${res.status}`)

  const body = (await res.json()) as StoreIndex
  if (!Array.isArray(body?.plugins)) throw new Error('that URL is not a plugin index')

  return body.plugins.filter((p) =>
    typeof p?.id === 'string' && typeof p?.tarball === 'string' && typeof p?.hostApi === 'string')
}

/** Entries this host could actually run, with the reason for the ones it could not. */
export function compatible(entries: StoreEntry[]): (StoreEntry & { installable: boolean; reason?: string })[] {
  return entries.map((e) => satisfies(HOST_API_VERSION, e.hostApi)
    ? { ...e, installable: true }
    : { ...e, installable: false, reason: `needs host API ${e.hostApi}, this host is ${HOST_API_VERSION}` })
}

/**
 * Downloads, verifies and unpacks one entry.
 *
 * `root` is the plugins folder; the plugin lands in `root/<id>`.
 */
export async function install(entry: StoreEntry, root: string): Promise<{ id: string; version: string; files: number }> {
  if (!satisfies(HOST_API_VERSION, entry.hostApi)) {
    throw new Error(`${entry.id} needs host API ${entry.hostApi}, this host is ${HOST_API_VERSION}`)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
    // The id becomes a directory name. Anything else is a path, not an id.
    throw new Error(`refusing an id that is not a plain name: ${entry.id}`)
  }

  const url = new URL(entry.tarball)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`refusing to download over ${url.protocol}`)
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) throw new Error(`downloading ${entry.id} answered ${res.status}`)

  const declared = Number(res.headers.get('content-length'))
  if (declared && declared > MAX_TARBALL) throw new Error(`${entry.id} is larger than ${MAX_TARBALL} bytes`)
  const tarball = Buffer.from(await res.arrayBuffer())
  if (tarball.byteLength > MAX_TARBALL) throw new Error(`${entry.id} is larger than ${MAX_TARBALL} bytes`)

  if (entry.sha256) {
    // The index and the tarball are usually not the same host, so HTTPS to the
    // index says nothing about the bytes.
    const got = createHash('sha256').update(tarball).digest('hex')
    if (got !== entry.sha256.toLowerCase()) {
      throw new Error(`${entry.id} does not match its published checksum`)
    }
  }

  const files = stripComponents(untar(tarball, { maxBytes: MAX_TARBALL }))
    // AppleDouble sidecars. `tar` on macOS writes a `._name` next to every file
    // to carry extended attributes, so any plugin packaged on a Mac ships them.
    // They are metadata, never plugin content, and `._plugin.json` sitting
    // beside the real manifest is asking for the wrong one to be read one day.
    .filter((f) => !f.name.split('/').some((seg) => seg.startsWith('._')))
  const manifestEntry = files.find((f) => f.name === 'plugin.json')
  if (!manifestEntry) throw new Error(`${entry.id} contains no plugin.json`)

  const read = readManifest(JSON.parse(manifestEntry.data.toString('utf8')))
  if ('error' in read) throw new Error(`${entry.id}: ${read.error}`)
  if (read.manifest.id !== entry.id) {
    throw new Error(`the index calls this ${entry.id} but it calls itself ${read.manifest.id}`)
  }

  // Unpacked beside the target, then renamed in. A failure halfway leaves the
  // previous version whole instead of a half-written plugin the host will try
  // to load on its next scan.
  const target = join(root, entry.id)
  const staging = `${target}.installing`
  await rm(staging, { recursive: true, force: true })

  let written = 0
  for (const f of files) {
    const dest = join(staging, f.name)
    if (f.type === 'dir') {
      await mkdir(dest, { recursive: true })
      continue
    }
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, f.data)
    written++
  }

  await rm(target, { recursive: true, force: true })
  await rename(staging, target)
  return { id: entry.id, version: read.manifest.version, files: written }
}

/** Removes an installed plugin's folder. */
export async function uninstall(id: string, root: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`not a plugin id: ${id}`)
  await rm(join(root, id), { recursive: true, force: true })
}
