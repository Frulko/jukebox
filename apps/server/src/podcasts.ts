import { randomUUID, createHash } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import type { DB } from './db.ts'
import { nextRev } from './db.ts'
import type { JobContext } from './jobs.ts'
import { parseFeed } from './feed.ts'
import { readTags } from './tags.ts'

/**
 * Podcasts: subscribe to a feed, keep the episode list current, optionally keep
 * the newest N downloaded.
 *
 * The refresh is a job like any other, so it gets the queue's cancellation,
 * resumption and per-item reporting for free, and a schedule can point at it
 * without any of this knowing what a schedule is.
 */

export type Podcast = {
  id: string
  feedUrl: string
  title: string
  description: string
  author: string
  imageUrl: string | null
  siteUrl: string | null
  cron: string | null
  keepLast: number
  autoDownload: 0 | 1
  targetSourceId: string | null
  targetPath: string
  lastFetchAt: number | null
  lastError: string | null
  episodeCount: number
  downloadedCount: number
}

const hydrate = (r: any): Podcast => ({
  id: r.id, feedUrl: r.feedUrl, title: r.title, description: r.description,
  author: r.author, imageUrl: r.imageUrl, siteUrl: r.siteUrl,
  cron: r.cron, keepLast: r.keepLast, autoDownload: r.autoDownload,
  targetSourceId: r.targetSourceId, targetPath: r.targetPath,
  lastFetchAt: r.lastFetchAt, lastError: r.lastError,
  episodeCount: r.episodeCount ?? 0, downloadedCount: r.downloadedCount ?? 0,
})

const WITH_COUNTS = `
  SELECT p.*,
         (SELECT COUNT(*) FROM episodes e WHERE e.podcastId = p.id) AS episodeCount,
         (SELECT COUNT(*) FROM episodes e WHERE e.podcastId = p.id AND e.trackId IS NOT NULL) AS downloadedCount
  FROM podcasts p WHERE p.deletedAt IS NULL`

export function listPodcasts(db: DB): Podcast[] {
  return (db.prepare(`${WITH_COUNTS} ORDER BY p.title`).all() as any[]).map(hydrate)
}

export function getPodcast(db: DB, id: string): Podcast | null {
  const r = db.prepare(`${WITH_COUNTS} AND p.id = ?`).get(id) as any
  return r ? hydrate(r) : null
}

export function createPodcast(db: DB, input: { feedUrl: string; cron?: string | null; keepLast?: number; autoDownload?: boolean; targetSourceId?: string | null; targetPath?: string }): Podcast {
  const id = `pc-${randomUUID().slice(0, 8)}`
  db.prepare(`INSERT INTO podcasts (id, feedUrl, cron, keepLast, autoDownload,
                targetSourceId, targetPath, createdAt, rev)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, input.feedUrl, input.cron ?? null, input.keepLast ?? 0,
      input.autoDownload ? 1 : 0, input.targetSourceId ?? null,
      input.targetPath ?? 'Podcasts', Date.now(), nextRev(db))
  return getPodcast(db, id)!
}

export function listEpisodes(db: DB, podcastId: string, opts: { cursor?: string; limit?: unknown } = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500)
  const where = ['podcastId = ?']
  const params: unknown[] = [podcastId]
  // Newest first, which is the only order anyone reads a podcast in. The cursor
  // carries both keys because pubDate is not unique -- a feed that publishes
  // three episodes at once would otherwise skip two of them at a page boundary.
  if (opts.cursor) {
    const [date, id] = String(opts.cursor).split('|')
    where.push('(pubDate < ? OR (pubDate = ? AND id > ?))')
    params.push(Number(date), Number(date), id)
  }
  const rows = db.prepare(
    `SELECT * FROM episodes WHERE ${where.join(' AND ')}
     ORDER BY pubDate DESC, id ASC LIMIT ?`).all(...([...params, limit] as never[])) as any[]

  const last = rows[rows.length - 1]
  return {
    items: rows,
    next: rows.length === limit ? `${last.pubDate}|${last.id}` : null,
  }
}

/**
 * Fetches the feed and reconciles the episode list.
 *
 * Conditional: the stored ETag and Last-Modified go back out, so a feed polled
 * hourly that has not published anything costs a 304 and no body. That is the
 * same discipline the API applies to its own clients, pointed outward.
 */
export function makePodcastHandler(db: DB) {
  return async function podcast(ctx: JobContext): Promise<void> {
    const p = db.prepare(`SELECT * FROM podcasts WHERE id = ? AND deletedAt IS NULL`)
      .get(ctx.payload.podcastId) as any
    if (!p) throw new Error(`unknown podcast: ${ctx.payload.podcastId}`)

    // One episode, on demand — the row's right-click "Download". The feed is
    // not refetched: the episode is already known, and a click on one row
    // should not turn into a refresh of the whole show.
    if (ctx.payload.episodeId) {
      const e = db.prepare(`SELECT * FROM episodes WHERE id = ? AND podcastId = ?`)
        .get(ctx.payload.episodeId, p.id) as any
      if (!e) throw new Error(`unknown episode: ${ctx.payload.episodeId}`)
      await download(db, ctx, p, [e])
      return
    }

    const headers: Record<string, string> = { accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' }
    if (p.etag) headers['if-none-match'] = p.etag
    if (p.lastModified) headers['if-modified-since'] = p.lastModified

    let res: Response
    try {
      res = await fetch(p.feedUrl, { headers })
    } catch (err) {
      // The error is stored rather than thrown away: a feed that has been dead
      // for a month should say so in the UI, not just stop updating silently.
      fail(db, p.id, err instanceof Error ? err.message : String(err))
      throw err
    }

    if (res.status === 304) {
      db.prepare(`UPDATE podcasts SET lastFetchAt = ?, lastError = NULL WHERE id = ?`).run(Date.now(), p.id)
      ctx.checkpoint(null, { done: 0, total: 0 })
      return
    }
    if (!res.ok) {
      fail(db, p.id, `feed responded ${res.status}`)
      throw new Error(`feed responded ${res.status}`)
    }

    const feed = parseFeed(await res.text())
    if (!feed) {
      fail(db, p.id, 'the response was not an RSS feed')
      throw new Error('the response was not an RSS feed')
    }

    db.prepare(`UPDATE podcasts SET title = ?, description = ?, author = ?, imageUrl = ?,
                  siteUrl = ?, etag = ?, lastModified = ?, lastFetchAt = ?, lastError = NULL, rev = ?
                WHERE id = ?`)
      .run(feed.title || p.title, feed.description, feed.author, feed.imageUrl, feed.siteUrl,
        res.headers.get('etag'), res.headers.get('last-modified'), Date.now(), nextRev(db), p.id)

    // Upsert on (podcastId, guid). Metadata is refreshed -- titles and show
    // notes get corrected after publication -- but `trackId`, `played` and
    // `position` are never touched, or a refresh would forget what you listened
    // to.
    const ins = db.prepare(`
      INSERT INTO episodes (id, podcastId, guid, title, description, pubDate, duration,
        episodeNumber, season, enclosureUrl, enclosureLength, enclosureType, imageUrl, rev)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (podcastId, guid) DO UPDATE SET
        title = excluded.title, description = excluded.description,
        pubDate = excluded.pubDate, duration = excluded.duration,
        episodeNumber = excluded.episodeNumber, season = excluded.season,
        enclosureUrl = excluded.enclosureUrl, enclosureLength = excluded.enclosureLength,
        enclosureType = excluded.enclosureType, imageUrl = excluded.imageUrl,
        rev = excluded.rev`)

    const rev = nextRev(db)
    let i = 0
    for (const e of feed.episodes) {
      if (ctx.aborted()) return
      const id = `ep-${createHash('sha1').update(`${p.id}\0${e.guid}`).digest('base64url').slice(0, 14)}`
      ins.run(id, p.id, e.guid, e.title, e.description, e.pubDate, e.duration,
        e.episodeNumber, e.season, e.enclosureUrl, e.enclosureLength, e.enclosureType,
        e.imageUrl, rev)
      ctx.item(i, e.guid, 'done')
      i++
      if (i % 50 === 0) ctx.checkpoint(e.guid, { done: i, total: feed.episodes.length })
    }

    ctx.checkpoint(null, { done: i, total: feed.episodes.length })

    if (p.autoDownload && p.targetSourceId) {
      await download(db, ctx, p)
    }
    if (p.keepLast > 0) {
      await prune(db, p)
    }
  }
}

const fail = (db: DB, id: string, message: string) =>
  db.prepare(`UPDATE podcasts SET lastFetchAt = ?, lastError = ? WHERE id = ?`)
    .run(Date.now(), message, id)

/** Fetches the newest undownloaded episodes, bounded by `keepLast` — or just
 *  `only`, when a single episode was asked for by hand. */
async function download(db: DB, ctx: JobContext, p: any, only?: any[]): Promise<void> {
  // The podcast's own target when it has one; otherwise the first local
  // writable source, so a feed subscribed without a destination can still
  // answer a hand-picked "Download".
  const source = (db.prepare(`SELECT * FROM sources WHERE id = ?`).get(p.targetSourceId)
    ?? db.prepare(`SELECT * FROM sources WHERE kind = 'local' AND writable = 1 ORDER BY id`).get()) as any
  if (!source?.writable) return

  const limit = p.keepLast > 0 ? p.keepLast : 5
  const pending = only ?? db.prepare(
    `SELECT * FROM episodes WHERE podcastId = ? AND trackId IS NULL AND enclosureUrl IS NOT NULL
     ORDER BY pubDate DESC, id ASC LIMIT ?`).all(p.id, limit) as any[]

  const safe = (s: string) => (s || 'Unknown').replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 120)

  for (const e of pending) {
    if (ctx.aborted()) return
    try {
      const res = await fetch(e.enclosureUrl)
      if (!res.ok) throw new Error(`${res.status} fetching the episode`)
      const buf = Buffer.from(await res.arrayBuffer())

      const ext = extname(new URL(e.enclosureUrl).pathname) || '.mp3'
      const rel = join(p.targetPath, safe(p.title), `${safe(e.title)}${ext}`)
      const abs = join(source.root, rel)
      await mkdir(dirname(abs), { recursive: true })
      // Temp then rename, as everywhere else: an interrupted download must not
      // leave a truncated file the next scan indexes as a real episode.
      const tmp = `${abs}.part`
      await writeFile(tmp, buf)
      await rename(tmp, abs)

      let meta: any = {}
      try { meta = await readTags(abs) } catch { /* still enters the library */ }

      const trackId = createHash('sha1').update(`${source.id}\0${rel}`).digest('base64url').slice(0, 16)
      db.prepare(`
        INSERT INTO tracks (id, sourceId, path, kind, name, artist, albumArtist, album,
          duration, format, size, mtime, dateAdded, rev)
        VALUES (?,?,?,'podcast',?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (sourceId, path) DO UPDATE SET deletedAt = NULL, rev = excluded.rev`)
        .run(trackId, source.id, rel, e.title, p.author || p.title, p.author || p.title,
          p.title, meta.audio?.duration ?? e.duration, meta.audio?.format ?? '',
          buf.byteLength, Date.now(), Date.now(), nextRev(db))

      // Same rule as everywhere else: a track without a rendition has no file.
      db.prepare(`
        INSERT INTO renditions (id, trackId, sourceId, path, format, size, mtime, preferred, createdAt)
        VALUES (?,?,?,?,?,?,?,1,?)
        ON CONFLICT (sourceId, path) DO UPDATE SET
          format = excluded.format, size = excluded.size, mtime = excluded.mtime`)
        .run(`r-${trackId}`, trackId, source.id, rel,
          meta.audio?.format ?? '', buf.byteLength, Date.now(), Date.now())

      db.prepare(`UPDATE episodes SET trackId = ?, rev = ? WHERE id = ?`)
        .run(trackId, nextRev(db), e.id)
    } catch (err) {
      // One bad episode does not abandon the rest of the feed.
      ctx.item(1000 + pending.indexOf(e), e.guid, 'failed',
        { error: err instanceof Error ? err.message : String(err) })
    }
  }
  db.exec(`INSERT INTO tracks_fts (tracks_fts) VALUES ('rebuild')`)
}

/**
 * Keeps only the newest `keepLast` downloaded episodes.
 *
 * An episode that has been listened to is deleted first; beyond that the oldest
 * go. The row survives with `trackId` cleared, so the episode stays visible and
 * re-downloadable — deleting the row would make it reappear as brand new on the
 * next refresh.
 */
async function prune(db: DB, p: any): Promise<void> {
  const downloaded = db.prepare(
    `SELECT e.id, e.trackId, t.path, s.root FROM episodes e
     JOIN tracks t ON t.id = e.trackId
     JOIN sources s ON s.id = t.sourceId
     WHERE e.podcastId = ? ORDER BY e.pubDate DESC, e.id ASC`).all(p.id) as any[]

  for (const old of downloaded.slice(p.keepLast)) {
    try {
      await unlink(join(old.root, old.path))
    } catch { /* already gone: the row still needs clearing */ }
    db.prepare(`UPDATE tracks SET deletedAt = ?, rev = ? WHERE id = ?`)
      .run(Date.now(), nextRev(db), old.trackId)
    db.prepare(`UPDATE episodes SET trackId = NULL, rev = ? WHERE id = ?`)
      .run(nextRev(db), old.id)
  }
}
