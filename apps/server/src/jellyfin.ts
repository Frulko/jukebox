/**
 * Jellyfin and Emby as a source.
 *
 * They are the same API for this purpose — Jellyfin is a fork of Emby and the
 * media endpoints never diverged — so one client covers both.
 *
 * What makes this different from every other source is that **the metadata is
 * already there**. rclone hands over bytes and the scanner reads tags out of
 * them; Jellyfin hands over an artist, an album, a track number and a duration
 * that its own scanner worked out. So indexing a Jellyfin library downloads
 * nothing at all, where a remote folder of the same size pulls half a megabyte
 * per track just to read its header.
 *
 * The consequence is worth stating: this trusts Jellyfin's metadata rather than
 * the files'. If somebody has fixed their tags inside Jellyfin, those fixes are
 * what arrives here, which is almost certainly what they want.
 */

export type JellyfinConfig = {
  /** Base URL, e.g. `http://jellyfin.local:8096`. */
  url: string
  /** An API key from the dashboard. Not a username and password. */
  token: string
  /** Restrict to one library. Everything audio, when absent. */
  parentId?: string
}

export type JellyfinItem = {
  id: string
  name: string
  artist: string
  albumArtist: string
  album: string
  genre: string
  year: number
  trackNumber: number
  discNumber: number
  /** Seconds. Jellyfin counts in ticks of 100 nanoseconds. */
  duration: number
  size: number
  format: string
  bitRate: number
  path: string
  /** Their id, which is also what the stream and image URLs are keyed on. */
  itemId: string
}

const TIMEOUT = 30_000

export function configOf(source: { root: string; config: string }): JellyfinConfig {
  const c = JSON.parse(source.config || '{}')
  // `root` doubles as the URL, exactly as it holds the remote for rclone: one
  // column meaning "where this source lives" for every kind of source.
  return { url: (c.url ?? source.root).replace(/\/$/, ''), token: c.token ?? '', parentId: c.parentId }
}

async function call<T>(cfg: JellyfinConfig, path: string): Promise<T> {
  const res = await fetch(`${cfg.url}${path}`, {
    headers: {
      // Both header forms exist in the wild; this one works on every version of
      // both servers.
      'x-emby-token': cfg.token,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) {
    throw new Error(res.status === 401
      ? 'Jellyfin refused the API key'
      : `Jellyfin answered ${res.status}`)
  }
  return res.json() as Promise<T>
}

/** Name and version, and the cheapest way to ask "is this really a Jellyfin?". */
export const info = (cfg: JellyfinConfig) =>
  call<{ ServerName: string; Version: string; Id: string }>(cfg, '/System/Info')

/**
 * The server's libraries, so `parentId` can be picked from a list instead of
 * copied out of an URL. All of them, not just the music-typed ones: plenty of
 * real libraries carry no CollectionType at all, and choosing is the caller's.
 */
export const libraries = (cfg: JellyfinConfig) =>
  call<{ Items?: Array<{ Id: string; Name: string; CollectionType?: string }> }>(
    cfg, '/Library/MediaFolders')
    .then((r) => (r.Items ?? []).map((i) => ({ id: i.Id, name: i.Name, kind: i.CollectionType ?? '' })))

/** Ticks of 100ns to seconds, which is the unit everything else here uses. */
const seconds = (ticks: unknown) => Math.round((Number(ticks) || 0) / 10_000_000)

function toItem(raw: any): JellyfinItem | null {
  if (!raw?.Id || !raw?.Name) return null
  const media = raw.MediaSources?.[0]
  const audio = media?.MediaStreams?.find((s: any) => s.Type === 'Audio')

  return {
    id: raw.Id,
    itemId: raw.Id,
    name: raw.Name,
    artist: raw.Artists?.[0] ?? raw.AlbumArtist ?? '',
    albumArtist: raw.AlbumArtist ?? raw.Artists?.[0] ?? '',
    album: raw.Album ?? '',
    genre: raw.Genres?.[0] ?? '',
    year: Number(raw.ProductionYear) || 0,
    trackNumber: Number(raw.IndexNumber) || 0,
    discNumber: Number(raw.ParentIndexNumber) || 1,
    duration: seconds(raw.RunTimeTicks),
    size: Number(media?.Size) || 0,
    // Their codec name is already the short form this project uses, which is a
    // happy accident worth relying on rather than re-deriving.
    format: String(audio?.Codec ?? media?.Container ?? '').toLowerCase(),
    bitRate: Math.round((Number(audio?.BitRate) || 0) / 1000),
    // Their path, kept because it is what a human recognises and what makes the
    // track identifiable if the library is ever pointed at the files directly.
    path: raw.Path ?? `${raw.AlbumArtist ?? 'Unknown'}/${raw.Album ?? 'Unknown'}/${raw.Name}`,
  }
}

/**
 * Every audio item, a page at a time.
 *
 * Paged rather than asked for in one go for the same reason the local scanner
 * streams its walk: a 100,000-track Jellyfin answering in a single response is
 * tens of megabytes of JSON that has to be buffered whole before it can be
 * parsed, which on armhf is the scan running out of memory rather than
 * finishing.
 */
export async function* items(cfg: JellyfinConfig, pageSize = 500): AsyncGenerator<JellyfinItem> {
  let start = 0

  while (true) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio',
      Recursive: 'true',
      // Without MediaSources there is no size, no codec and no bitrate, and the
      // whole point of this source is not having to open the file to learn them.
      Fields: 'Path,Genres,MediaSources,ProductionYear',
      SortBy: 'SortName',
      StartIndex: String(start),
      Limit: String(pageSize),
    })
    if (cfg.parentId) q.set('ParentId', cfg.parentId)

    const page = await call<{ Items: any[]; TotalRecordCount: number }>(cfg, `/Items?${q}`)
    const batch = page.Items ?? []
    if (!batch.length) return

    for (const raw of batch) {
      const item = toItem(raw)
      if (item) yield item
    }

    start += batch.length
    if (start >= (page.TotalRecordCount ?? 0)) return
  }
}

/**
 * Where the bytes are.
 *
 * `Static=true` matters: without it Jellyfin decides for itself whether to
 * transcode, and a server told to send a file may instead spend CPU converting
 * one that was already playable.
 */
export const streamUrl = (cfg: JellyfinConfig, itemId: string) =>
  `${cfg.url}/Audio/${itemId}/stream?Static=true&api_key=${encodeURIComponent(cfg.token)}`

export const artworkUrl = (cfg: JellyfinConfig, itemId: string) =>
  `${cfg.url}/Items/${itemId}/Images/Primary?api_key=${encodeURIComponent(cfg.token)}`

/** Opens a file, optionally a byte range. Range passes straight through. */
export async function open(cfg: JellyfinConfig, itemId: string, range?: { start: number; end?: number }): Promise<Response> {
  const headers: Record<string, string> = {
    // The token goes in the header *and* the query. The query form is what
    // makes the URL usable by a player on its own; the header is what survives
    // a reverse proxy that strips query strings, which is a common enough
    // Jellyfin deployment to be worth not depending on.
    'x-emby-token': cfg.token,
  }
  if (range) headers.range = `bytes=${range.start}-${range.end ?? ''}`

  const res = await fetch(streamUrl(cfg, itemId), { headers })
  if (!res.ok && res.status !== 206) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`Jellyfin could not serve ${itemId}: ${res.status}`)
  }
  return res
}
