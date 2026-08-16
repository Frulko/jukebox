/**
 * Talking to rclone.
 *
 * rclone runs as a sidecar (`rclone rcd --rc-serve`), not as a library and not
 * as a per-operation subprocess. One long-lived process holds the connections,
 * the auth tokens and the directory cache for SMB, S3, Drive, Dropbox, WebDAV,
 * FTP and the rest — sixty backends this server does not have to implement, in
 * userspace, with no kernel mount and no root.
 *
 * That last part is what makes it work on a NAS or in a container, where
 * mounting requires privileges the process does not have and should not want.
 *
 * Two halves of the same daemon are used:
 *
 * - the **RC API** (`/operations/...`) to list and stat, and
 * - **`--rc-serve`**, which exposes every remote over HTTP at `/[fs]/path`,
 *   with `Range` support. Streaming a track off Google Drive is then a proxied
 *   range request, and nothing is ever copied to local disk.
 */

export type RcloneConfig = {
  /** Where the daemon listens, e.g. `http://127.0.0.1:5572`. */
  url: string
  /** The rclone remote, e.g. `gdrive:Music` or an absolute path for a local one. */
  fs: string
  user?: string
  pass?: string
}

export type RcloneEntry = {
  path: string
  name: string
  size: number
  mimeType: string
  modTime: number
  isDir: boolean
}

export class RcloneError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'RcloneError'
    this.status = status
  }
}

const TIMEOUT = 30_000

/** One RC call. Everything rclone exposes is POST with a JSON body. */
export async function rc<T>(cfg: RcloneConfig, method: string, params: unknown = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.user) {
    headers.authorization = `Basic ${Buffer.from(`${cfg.user}:${cfg.pass ?? ''}`).toString('base64')}`
  }

  let res: Response
  try {
    res = await fetch(`${cfg.url.replace(/\/$/, '')}/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch (err) {
    // The daemon not running is the single most likely failure, and it must not
    // look like a broken remote.
    throw new RcloneError(503, `cannot reach rclone at ${cfg.url}: ${err instanceof Error ? err.message : err}`)
  }

  const body = await res.json().catch(() => null) as any
  if (!res.ok) {
    throw new RcloneError(res.status, body?.error ?? `rclone answered ${res.status}`)
  }
  return body as T
}

/** Version and uptime, which is also the cheapest way to ask "are you there?". */
export const version = (cfg: RcloneConfig) =>
  rc<{ version: string; os: string; arch: string }>(cfg, 'core/version')

/** Free and total bytes. Not every backend implements it. */
export async function about(cfg: RcloneConfig): Promise<{ total: number; used: number; free: number } | null> {
  try {
    const r = await rc<any>(cfg, 'operations/about', { fs: cfg.fs })
    return { total: r.total ?? 0, used: r.used ?? 0, free: r.free ?? 0 }
  } catch {
    // S3 has no concept of free space. That is not an error worth surfacing.
    return null
  }
}

/** One directory. `dir` is relative to the configured remote. */
export async function list(cfg: RcloneConfig, dir = ''): Promise<RcloneEntry[]> {
  const r = await rc<{ list: any[] }>(cfg, 'operations/list', {
    fs: cfg.fs,
    remote: dir,
    opt: { recurse: false },
  })
  return (r.list ?? []).map((e) => ({
    path: e.Path,
    name: e.Name,
    size: e.Size ?? 0,
    mimeType: e.MimeType ?? '',
    modTime: Date.parse(e.ModTime) || 0,
    isDir: Boolean(e.IsDir),
  }))
}

/**
 * Every file under the remote, one directory at a time.
 *
 * Deliberately not `recurse: true`. rclone would answer a 100,000-file remote
 * as a single JSON array, which has to be buffered whole before it can be
 * parsed — on armhf, where the V8 heap caps around a gigabyte, that is the
 * scan running out of memory instead of finishing. Walking directory by
 * directory keeps every response small, at the cost of more round trips to a
 * daemon that is usually on localhost.
 */
export async function* walk(cfg: RcloneConfig, dir = ''): AsyncGenerator<RcloneEntry> {
  let entries: RcloneEntry[]
  try {
    entries = await list(cfg, dir)
  } catch (err) {
    // An unreadable directory skips, exactly as the local scanner does. One
    // permission-denied folder must not abandon the rest of the library.
    if (err instanceof RcloneError && err.status !== 503) return
    throw err
  }

  for (const e of entries) {
    if (e.isDir) yield* walk(cfg, e.path)
    else yield e
  }
}

/**
 * Where `--rc-serve` exposes one file.
 *
 * The brackets are literal and must not be encoded — that is the daemon's own
 * syntax for "this is the remote". The path after them is encoded per segment,
 * because a track called `Symphony #5` would otherwise truncate at the hash.
 */
export function fileUrl(cfg: RcloneConfig, path: string): string {
  const base = cfg.url.replace(/\/$/, '')
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${base}/[${cfg.fs}]/${encoded}`
}

/**
 * Opens a file, optionally a byte range of it.
 *
 * The response is handed back whole rather than buffered: streaming a 40 MB
 * FLAC out of Drive must cost the server no memory, so the body flows straight
 * through to the client.
 */
export async function open(cfg: RcloneConfig, path: string, range?: { start: number; end?: number }): Promise<Response> {
  const headers: Record<string, string> = {}
  // An absent `end` stays absent: `bytes=100-` means "to the end of the file",
  // whereas inventing a huge number is a range some servers reject outright.
  if (range) headers.range = `bytes=${range.start}-${range.end ?? ''}`
  if (cfg.user) {
    headers.authorization = `Basic ${Buffer.from(`${cfg.user}:${cfg.pass ?? ''}`).toString('base64')}`
  }

  const res = await fetch(fileUrl(cfg, path), { headers })
  if (!res.ok && res.status !== 206) {
    await res.body?.cancel().catch(() => {})
    throw new RcloneError(res.status, `rclone could not serve ${path}`)
  }
  return res
}

/** Reads the config stored on a source row. */
export function configOf(source: { root: string; config: string }): RcloneConfig {
  const c = JSON.parse(source.config || '{}')
  return {
    url: c.url ?? process.env.RCLONE_RC_URL ?? 'http://127.0.0.1:5572',
    // The source's `root` is the remote itself, so one column means the same
    // thing for a local folder and a remote one.
    fs: c.fs ?? source.root,
    user: c.user,
    pass: c.pass,
  }
}
