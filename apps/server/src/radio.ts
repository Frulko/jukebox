import { randomUUID } from 'node:crypto'
import type { DB } from './db.ts'
import { nextRev } from './db.ts'

/**
 * Internet radio.
 *
 * A station is a URL and whatever we can learn about it. The learning is the
 * interesting part: people paste a stream URL and expect a name, a genre and a
 * logo to appear, the way every radio app they have used does it.
 *
 * Three sources, cheapest first:
 *
 * 1. **The stream's own ICY headers.** Free, authoritative, no third party. An
 *    Icecast server answers `icy-name`, `icy-genre`, `icy-br` and `icy-url` to
 *    an ordinary GET.
 * 2. **The station's homepage favicon**, found from the `icy-url` or a homepage
 *    the user gave.
 * 3. **Radio-Browser**, the community directory, when the first two find
 *    nothing. Best-effort: a directory being down must not stop anyone adding
 *    a station.
 */

/** Nothing here may hang a request. A radio server that accepts and never answers is common. */
const TIMEOUT = 6000

export type Radio = {
  id: string
  name: string
  streamUrl: string
  homepageUrl: string | null
  imageUrl: string | null
  genre: string
  country: string
  bitrate: number
  codec: string
  favorite: 0 | 1
}

const hydrate = (r: any): Radio => ({
  id: r.id, name: r.name, streamUrl: r.streamUrl, homepageUrl: r.homepageUrl,
  imageUrl: r.imageUrl, genre: r.genre, country: r.country,
  bitrate: r.bitrate, codec: r.codec, favorite: r.favorite,
})

export function listRadios(db: DB): Radio[] {
  return (db.prepare(`SELECT * FROM radios WHERE deletedAt IS NULL ORDER BY favorite DESC, name`)
    .all() as any[]).map(hydrate)
}

export function getRadio(db: DB, id: string): Radio | null {
  const r = db.prepare(`SELECT * FROM radios WHERE id = ? AND deletedAt IS NULL`).get(id) as any
  return r ? hydrate(r) : null
}

export function createRadio(db: DB, input: Partial<Radio> & { streamUrl: string }): Radio {
  const id = `rd-${randomUUID().slice(0, 8)}`
  db.prepare(`INSERT INTO radios (id, name, streamUrl, homepageUrl, imageUrl, genre, country,
                bitrate, codec, favorite, createdAt, rev)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.name ?? '', input.streamUrl, input.homepageUrl ?? null, input.imageUrl ?? null,
      input.genre ?? '', input.country ?? '', input.bitrate ?? 0, input.codec ?? '',
      input.favorite ? 1 : 0, Date.now(), nextRev(db))
  return getRadio(db, id)!
}

export function updateRadio(db: DB, id: string, patch: Partial<Radio>): Radio | null {
  const ALLOWED = ['name', 'streamUrl', 'homepageUrl', 'imageUrl', 'genre', 'country', 'favorite'] as const
  const cols = ALLOWED.filter((k) => patch[k] !== undefined)
  if (!cols.length) return getRadio(db, id)
  const values = cols.map((k) => (k === 'favorite' ? (patch[k] ? 1 : 0) : patch[k]))
  db.prepare(`UPDATE radios SET ${cols.map((k) => `${k} = ?`).join(', ')}, rev = ?
              WHERE id = ? AND deletedAt IS NULL`)
    .run(...([...values, nextRev(db), id] as never[]))
  return getRadio(db, id)
}

export function deleteRadio(db: DB, id: string): boolean {
  const r = db.prepare(`UPDATE radios SET deletedAt = ?, rev = ? WHERE id = ? AND deletedAt IS NULL`)
    .run(Date.now(), nextRev(db), id)
  return (r.changes as number) > 0
}

export type Probe = {
  name: string
  genre: string
  bitrate: number
  codec: string
  homepageUrl: string | null
  imageUrl: string | null
  /** Null when the station answered. A string is why it did not. */
  error: string | null
}

const EMPTY: Probe = { name: '', genre: '', bitrate: 0, codec: '', homepageUrl: null, imageUrl: null, error: null }

/**
 * Reads a stream's ICY headers without downloading the stream.
 *
 * The body is cancelled the moment the headers are in. A radio stream is
 * infinite: leaving it open downloads until the disk fills, and it is the one
 * mistake that turns a metadata probe into an outage.
 */
export async function probeStream(url: string): Promise<Probe> {
  let res: Response
  try {
    res = await fetch(url, {
      // `icy-metadata: 1` is what makes a Shoutcast/Icecast server answer with
      // its station headers rather than just audio.
      headers: { 'icy-metadata': '1', 'user-agent': 'jukebox/1.0' },
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: 'follow',
    })
  } catch (err) {
    // Shoutcast v1 answers `ICY 200 OK` instead of an HTTP status line, which
    // no HTTP client will parse. Saying so beats a bare "fetch failed".
    const msg = err instanceof Error ? err.message : String(err)
    return { ...EMPTY, error: /parse|invalid|protocol/i.test(msg) ? 'the server did not answer HTTP (old Shoutcast?)' : msg }
  }

  // Cancel first, read headers after: an early return between the two would
  // leave the stream running.
  await res.body?.cancel().catch(() => {})

  if (!res.ok) return { ...EMPTY, error: `the stream answered ${res.status}` }

  const h = (k: string) => res.headers.get(k) ?? ''
  const type = h('content-type').toLowerCase()
  return {
    name: h('icy-name').trim(),
    genre: h('icy-genre').trim(),
    bitrate: Number(h('icy-br')) || 0,
    codec: type.includes('mpeg') ? 'mp3' : type.includes('aac') ? 'aac'
      : type.includes('ogg') ? 'ogg' : type.split(';')[0].split('/')[1] ?? '',
    homepageUrl: h('icy-url').trim() || null,
    imageUrl: null,
    error: null,
  }
}

/**
 * The site's declared icon, or its conventional one.
 *
 * Only the `<head>` is read — a station homepage can be megabytes of scripts,
 * and the icon is declared in the first few kilobytes or not at all.
 */
export async function findFavicon(homepage: string): Promise<string | null> {
  let base: URL
  try {
    base = new URL(homepage)
  } catch {
    return null
  }

  try {
    const res = await fetch(base, {
      headers: { 'user-agent': 'jukebox/1.0' },
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (res.ok) {
      const head = (await res.text()).slice(0, 20_000)
      // Cosmetic markup scraping, so a regex is proportionate here -- a failure
      // costs a missing logo, not a wrong result.
      const link = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i.exec(head)?.[0]
      const href = link && /href=["']([^"']+)["']/i.exec(link)?.[1]
      if (href) return new URL(href, base).href
    }
  } catch { /* fall through to the conventional path */ }

  // Every server has answered this path since 1999, whether or not it says so.
  const guess = new URL('/favicon.ico', base)
  try {
    const res = await fetch(guess, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT) })
    return res.ok ? guess.href : null
  } catch {
    return null
  }
}

/**
 * Where the community directory lives. Read at call time so a test can point it
 * at a local mock, and someone behind a firewall can point it at another
 * Radio-Browser mirror.
 */
const directoryBase = () => process.env.JUKEBOX_RADIO_DIRECTORY ?? 'https://de1.api.radio-browser.info'

/**
 * The community directory, asked by stream URL.
 *
 * Best-effort by design: it is someone else's server, and a directory being
 * down must never stop a station being added.
 */
export async function lookupDirectory(streamUrl: string): Promise<Partial<Radio> | null> {
  try {
    const res = await fetch(
      `${directoryBase()}/json/stations/byurl?url=${encodeURIComponent(streamUrl)}`,
      { headers: { 'user-agent': 'jukebox/1.0' }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return null
    const list = (await res.json()) as any[]
    const hit = list?.[0]
    if (!hit) return null
    return {
      name: hit.name?.trim() || undefined,
      genre: hit.tags || undefined,
      country: hit.country || undefined,
      imageUrl: hit.favicon || undefined,
      homepageUrl: hit.homepage || undefined,
      bitrate: Number(hit.bitrate) || undefined,
      codec: hit.codec?.toLowerCase() || undefined,
    }
  } catch {
    return null
  }
}

export type RadioHit = {
  name: string
  streamUrl: string
  homepageUrl: string | null
  imageUrl: string | null
  genre: string
  country: string
  bitrate: number
  codec: string
  votes: number
}

/**
 * The directory asked by *name* — what "propose me stations" is made of.
 *
 * The by-URL lookup above is exact-match and misses every variant of a stream
 * (FIP's `midfi.mp3` is unknown while its `hifi.aac` has forty thousand votes).
 * Searching by name and ranking by votes is how every radio app fills its
 * browse page, and it hands back the canonical URL along with the logo.
 *
 * `null` means the directory did not answer — which the UI must say, because
 * "no results" and "could not ask" are different answers to the same question.
 */
export async function searchDirectory(q: string, limit = 20): Promise<RadioHit[] | null> {
  try {
    const res = await fetch(
      `${directoryBase()}/json/stations/search?name=${encodeURIComponent(q)}&order=votes&reverse=true&hidebroken=true&limit=${limit}`,
      { headers: { 'user-agent': 'jukebox/1.0' }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return null
    const list = (await res.json()) as any[]
    if (!Array.isArray(list)) return null
    return list
      .map((s): RadioHit => ({
        name: (s.name ?? '').trim(),
        // `url_resolved` is the directory having already followed the
        // playlist/redirect chain; the raw `url` may be an .m3u the element
        // cannot play.
        streamUrl: s.url_resolved || s.url || '',
        homepageUrl: s.homepage || null,
        imageUrl: s.favicon || null,
        genre: s.tags || '',
        country: s.country || '',
        bitrate: Number(s.bitrate) || 0,
        codec: (s.codec ?? '').toLowerCase(),
        votes: Number(s.votes) || 0,
      }))
      .filter((s) => s.name && /^https?:\/\//.test(s.streamUrl))
  } catch {
    return null
  }
}

/**
 * Everything we can learn about a stream, cheapest source first.
 *
 * Each source only fills what the previous one left empty, and what the user
 * typed always wins — a probe must never overwrite a name someone chose.
 */
export async function discover(
  streamUrl: string,
  given: Partial<Radio> = {},
  opts: { directory?: boolean } = {},
): Promise<Partial<Radio> & { error: string | null }> {
  const probe = await probeStream(streamUrl)

  const out: Partial<Radio> & { error: string | null } = {
    name: given.name || probe.name,
    genre: given.genre || probe.genre,
    country: given.country ?? '',
    bitrate: given.bitrate || probe.bitrate,
    codec: given.codec || probe.codec,
    homepageUrl: given.homepageUrl ?? probe.homepageUrl,
    imageUrl: given.imageUrl ?? null,
    error: probe.error,
  }

  if (!out.imageUrl && out.homepageUrl) {
    out.imageUrl = await findFavicon(out.homepageUrl)
  }

  // Only when the stream itself told us nothing worth having, and only when
  // reaching a third party is wanted -- tests turn it off, because a suite that
  // depends on someone else's server is a suite that fails for their reasons.
  if ((opts.directory ?? true) && (!out.name || !out.imageUrl)) {
    const dir = await lookupDirectory(streamUrl)
    if (dir) {
      out.name = out.name || dir.name || ''
      out.genre = out.genre || dir.genre || ''
      out.country = out.country || dir.country || ''
      out.imageUrl = out.imageUrl ?? dir.imageUrl ?? null
      out.homepageUrl = out.homepageUrl ?? dir.homepageUrl ?? null
      out.bitrate = out.bitrate || dir.bitrate || 0
      out.codec = out.codec || dir.codec || ''
    }
  }

  // Last resort: the host. Better than a station called "".
  if (!out.name) {
    try { out.name = new URL(streamUrl).hostname } catch { out.name = streamUrl }
  }
  return out
}
