/**
 * Plex as a source.
 *
 * Same bargain as Jellyfin — the metadata is already there, so indexing costs
 * no bytes — but a different API underneath, and the differences are all in the
 * details that bite:
 *
 * - **Durations are milliseconds**, where Jellyfin counts hundred-nanosecond
 *   ticks. Reading either with the other's divisor produces numbers that look
 *   plausible and are wrong by four orders of magnitude.
 * - **The response is XML unless you ask otherwise.** `Accept: application/json`
 *   is not optional here.
 * - **A track's file lives three levels down**, in `Media[].Part[]`, and the
 *   `key` on that Part — not on the track — is what streams the bytes.
 * - **Everything is under `MediaContainer`**, including the total, which is
 *   what makes paging possible at all.
 */

export type PlexConfig = {
  /** Base URL of the server, e.g. `http://plex.local:32400`. */
  url: string
  /** An X-Plex-Token. Not an account password. */
  token: string
  /** Library section key. All music sections when absent. */
  section?: string
}

export type PlexItem = {
  name: string
  artist: string
  albumArtist: string
  album: string
  genre: string
  year: number
  trackNumber: number
  discNumber: number
  duration: number
  size: number
  format: string
  bitRate: number
  path: string
  /** The Part key, which is what streams the bytes. Not the track's ratingKey. */
  itemId: string
}

const TIMEOUT = 30_000

export function configOf(source: { root: string; config: string }): PlexConfig {
  const c = JSON.parse(source.config || '{}')
  return {
    url: (c.url ?? source.root).replace(/\/$/, ''),
    token: c.token ?? '',
    section: c.section,
  }
}

async function call<T>(cfg: PlexConfig, path: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${cfg.url}${path}${sep}X-Plex-Token=${encodeURIComponent(cfg.token)}`, {
    headers: {
      // Plex speaks XML by default and this is the whole difference between a
      // parser and a wall of markup.
      accept: 'application/json',
      'x-plex-token': cfg.token,
    },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) {
    throw new Error(res.status === 401
      ? 'Plex refused the token'
      : `Plex answered ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const info = (cfg: PlexConfig) =>
  call<{ MediaContainer: { friendlyName: string; version: string; machineIdentifier: string } }>(cfg, '/')
    .then((r) => ({
      name: r.MediaContainer?.friendlyName ?? 'Plex',
      version: r.MediaContainer?.version ?? '',
    }))

/** The music libraries. Everything else on the server is not our business. */
export async function musicSections(cfg: PlexConfig): Promise<{ key: string; title: string }[]> {
  const r = await call<any>(cfg, '/library/sections')
  return (r.MediaContainer?.Directory ?? [])
    .filter((d: any) => d.type === 'artist')
    .map((d: any) => ({ key: String(d.key), title: d.title }))
}

function toItem(raw: any): PlexItem | null {
  const media = raw?.Media?.[0]
  const part = media?.Part?.[0]
  // No Part means no file — a track Plex knows about but cannot play, which is
  // not something worth indexing.
  if (!raw?.title || !part?.key) return null

  return {
    name: raw.title,
    // Plex's own naming: grandparent is the artist, parent is the album.
    artist: raw.originalTitle ?? raw.grandparentTitle ?? '',
    albumArtist: raw.grandparentTitle ?? '',
    album: raw.parentTitle ?? '',
    genre: raw.Genre?.[0]?.tag ?? '',
    year: Number(raw.parentYear ?? raw.year) || 0,
    trackNumber: Number(raw.index) || 0,
    discNumber: Number(raw.parentIndex) || 1,
    // Milliseconds. Jellyfin's ticks are not.
    duration: Math.round((Number(raw.duration) || 0) / 1000),
    size: Number(part.size) || 0,
    format: String(media?.audioCodec ?? part.container ?? '').toLowerCase(),
    bitRate: Number(media?.bitrate) || 0,
    path: part.file ?? `${raw.grandparentTitle ?? 'Unknown'}/${raw.parentTitle ?? 'Unknown'}/${raw.title}`,
    itemId: String(part.key),
  }
}

/**
 * Every track, a page at a time.
 *
 * `type=10` is Plex's number for a track. The range headers are how it pages —
 * not query parameters, which is the sort of thing that costs an afternoon.
 */
export async function* items(cfg: PlexConfig, pageSize = 500): AsyncGenerator<PlexItem> {
  const sections = cfg.section
    ? [{ key: cfg.section, title: '' }]
    : await musicSections(cfg)

  for (const section of sections) {
    let start = 0
    while (true) {
      const r = await call<any>(
        cfg,
        `/library/sections/${section.key}/all?type=10&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${pageSize}`)

      const batch = r.MediaContainer?.Metadata ?? []
      if (!batch.length) break

      for (const raw of batch) {
        const item = toItem(raw)
        if (item) yield item
      }

      start += batch.length
      if (start >= (r.MediaContainer?.totalSize ?? r.MediaContainer?.size ?? 0)) break
    }
  }
}

/** The Part key is already a path on the server; it only needs the token. */
export const streamUrl = (cfg: PlexConfig, partKey: string) =>
  `${cfg.url}${partKey}?X-Plex-Token=${encodeURIComponent(cfg.token)}`

export async function open(cfg: PlexConfig, partKey: string, range?: { start: number; end?: number }): Promise<Response> {
  const headers: Record<string, string> = { 'x-plex-token': cfg.token }
  if (range) headers.range = `bytes=${range.start}-${range.end ?? ''}`

  const res = await fetch(streamUrl(cfg, partKey), { headers })
  if (!res.ok && res.status !== 206) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`Plex could not serve ${partKey}: ${res.status}`)
  }
  return res
}
