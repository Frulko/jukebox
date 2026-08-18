import { opendir, readdir, stat } from 'node:fs/promises'
import { join, relative, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { parseFile, parseBuffer } from 'music-metadata'
import type { DB } from './db.ts'
import { nextRev } from './db.ts'
import { describe } from './mounts.ts'
import type { JobContext } from './jobs.ts'
import { shortFormat } from './tags.ts'
import { configOf, list as rcList, open as rcOpen, walk as rcWalk } from './rclone.ts'
import { configOf as jfConfig, items as jfItems, libraries as jfLibraries } from './jellyfin.ts'
import { configOf as plexConfig, items as plexItems, musicSections } from './plex.ts'
import { insideRoot } from './organize.ts'

export const AUDIO = new Set(['.mp3', '.m4a', '.aac', '.flac', '.alac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.wma', '.m4b'])

/**
 * Streamed walk, never an array.
 *
 * On armhf the V8 heap caps out around a gigabyte: a 100,000-file library does
 * not fit in memory. An async generator keeps exactly one entry alive at a
 * time, whatever the size of the source.
 */
async function* walk(root: string, rel = ''): AsyncGenerator<string> {
  let dir
  try {
    dir = await opendir(join(root, rel))
  } catch {
    return // unreadable directory: skip it rather than collapse the whole scan
  }
  for await (const entry of dir) {
    if (entry.name.startsWith('.')) continue
    const child = rel ? join(rel, entry.name) : entry.name
    if (entry.isDirectory()) yield* walk(root, child)
    else if (AUDIO.has(extname(entry.name).toLowerCase())) yield child
  }
}

// NUL separates the two halves because it is the one byte a path cannot
// contain: without it, source `a` + path `b/c` and source `a/b` + path `c`
// would hash to the same track. Written as an escape, not as a raw byte -- a
// literal NUL in the file makes git treat the whole source as binary.
type Entry = {
  path: string
  size: number
  mtime: number
  mimeType?: string
  /**
   * Metadata the source already knew.
   *
   * Jellyfin has an artist, an album and a duration its own scanner worked out,
   * so indexing it downloads nothing. Every other source leaves this undefined
   * and the tags are read from the bytes.
   */
  meta?: Record<string, unknown>
  /** The source's own id for this item, when it has one. */
  externalId?: string
}

/**
 * Every file under a source, whatever kind it is.
 *
 * The local walk uses `opendir`; an rclone source walks the daemon's directory
 * listings. Both stream one entry at a time -- a 100,000-file library must
 * never exist as an array, on either side.
 */
async function* entries(source: any): AsyncGenerator<Entry> {
  if (source.kind === 'rclone') {
    const cfg = configOf(source)
    for await (const e of rcWalk(cfg)) {
      if (!AUDIO.has(extname(e.name).toLowerCase())) continue
      yield { path: e.path, size: e.size, mtime: e.modTime, mimeType: e.mimeType }
    }
    return
  }

  if (source.kind === 'jellyfin' || source.kind === 'emby') {
    const cfg = jfConfig(source)
    for await (const item of jfItems(cfg)) {
      yield {
        path: item.path,
        size: item.size,
        // Jellyfin does not expose a file mtime, so the scan cannot skip on it.
        // Zero means "always re-read", which costs nothing here because
        // re-reading is one field copy rather than a download.
        mtime: 0,
        externalId: item.itemId,
        meta: {
          title: item.name, artist: item.artist, albumartist: item.albumArtist,
          album: item.album, genre: [item.genre], year: item.year,
          track: { no: item.trackNumber }, disk: { no: item.discNumber },
          duration: item.duration, bitrate: item.bitRate * 1000,
          container: item.format, codec: item.format,
        },
      }
    }
    return
  }

  if (source.kind === 'plex') {
    const cfg = plexConfig(source)
    for await (const item of plexItems(cfg)) {
      yield {
        path: item.path,
        size: item.size,
        mtime: 0,
        externalId: item.itemId,
        meta: {
          title: item.name, artist: item.artist, albumartist: item.albumArtist,
          album: item.album, genre: [item.genre], year: item.year,
          track: { no: item.trackNumber }, disk: { no: item.discNumber },
          duration: item.duration, bitrate: item.bitRate * 1000,
          container: item.format, codec: item.format,
        },
      }
    }
    return
  }

  for await (const rel of walk(source.root)) {
    const st = await stat(join(source.root, rel)).catch(() => null)
    if (!st) continue
    yield { path: rel, size: st.size, mtime: Math.floor(st.mtimeMs) }
  }
}

export type BrowseEntry = { name: string; path: string; dir: boolean; size?: number }

/**
 * One level of a source, for a person choosing a folder rather than a scanner
 * eating them all.
 *
 * Folder-backed kinds list directories and the audio files that prove a folder
 * holds music. The API-backed kinds have no folders to walk — their top level
 * lists the server's libraries, which is what `config.section` / `parentId`
 * ask the user to copy out of an URL today. `rel` uses the same relative-path
 * contract as everything else; an absolute or escaping path is a refusal, not
 * a join.
 */
export async function browse(source: any, rel = ''): Promise<BrowseEntry[]> {
  if (rel !== '' && !insideRoot(source.root || '/', rel)) {
    throw new BrowseError('bad_path', 'path must stay inside the source')
  }

  if (source.kind === 'rclone') {
    const all = await rcList(configOf(source), rel)
    return all
      .filter((e) => e.isDir || AUDIO.has(extname(e.name).toLowerCase()))
      .map((e) => ({ name: e.name, path: e.path, dir: e.isDir, ...(e.isDir ? {} : { size: e.size }) }))
      .sort(dirsFirst)
  }

  if (source.kind === 'jellyfin' || source.kind === 'emby') {
    if (rel !== '') return []
    const libs = await jfLibraries(jfConfig(source))
    return libs.map((l) => ({ name: l.kind ? `${l.name} (${l.kind})` : l.name, path: l.id, dir: true }))
  }

  if (source.kind === 'plex') {
    if (rel !== '') return []
    const sections = await musicSections(plexConfig(source))
    return sections.map((s) => ({ name: s.title, path: s.key, dir: true }))
  }

  const base = join(source.root, rel)
  let found
  try {
    found = await readdir(base, { withFileTypes: true })
  } catch (err) {
    throw new BrowseError('unreachable', err instanceof Error ? err.message : 'unreadable directory')
  }
  return found
    .filter((e) => !e.name.startsWith('.'))
    .filter((e) => e.isDirectory() || AUDIO.has(extname(e.name).toLowerCase()))
    .map((e) => ({
      name: e.name,
      path: rel ? `${rel}/${e.name}` : e.name,
      dir: e.isDirectory(),
    }))
    .sort(dirsFirst)
}

/** What went wrong browsing, split so the route can answer 400 vs 502. */
export class BrowseError extends Error {
  code: 'bad_path' | 'unreachable'
  constructor(code: 'bad_path' | 'unreachable', message: string) {
    super(message)
    this.code = code
  }
}

const dirsFirst = (a: BrowseEntry, b: BrowseEntry) =>
  Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)

/**
 * How much of a remote file to pull just to read its tags.
 *
 * Tags live at the front of every format this indexes, so the header is all
 * that is needed. Fetching whole files would make the first scan of a Drive
 * remote download the entire library -- the one thing a userspace source is
 * supposed to avoid.
 */
const TAG_HEAD = 512 * 1024

async function readMeta(source: any, e: Entry): Promise<any> {
  // Already known. A source that carries its own metadata is the one case where
  // indexing costs no bytes at all.
  if (e.meta) return e.meta

  if (source.kind !== 'rclone') {
    const parsed = await parseFile(join(source.root, e.path), { duration: true, skipCovers: true })
    return { ...parsed.common, ...parsed.format }
  }

  const end = Math.min(TAG_HEAD, Math.max(e.size - 1, 0))
  const res = await rcOpen(configOf(source), e.path, { start: 0, end })
  const buf = Buffer.from(await res.arrayBuffer())
  // The real size goes in as file info so a VBR duration is worked out from the
  // header rather than from the slice we actually hold. `skipPostHeaders` is
  // what the parser asks for when the data is partial: without it, it hunts for
  // trailing headers that are not in the buffer and reports the file as broken.
  const parsed = await parseBuffer(
    buf,
    { size: e.size, mimeType: e.mimeType },
    { duration: true, skipCovers: true, skipPostHeaders: true },
  )
  return { ...parsed.common, ...parsed.format }
}

const idFor = (sourceId: string, path: string) =>
  createHash('sha1').update(`${sourceId}\0${path}`).digest('base64url').slice(0, 16)

/** The scan job. Resumable: its cursor is the last path processed. */
export function makeScanHandler(db: DB) {
  return async function scan(ctx: JobContext): Promise<void> {
    const source = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(ctx.payload.sourceId) as any
    if (!source) throw new Error(`unknown source: ${ctx.payload.sourceId}`)

    // A favorite with a kind is a filing rule: everything scanned under that
    // folder is that kind of track. Insert-time only — the ON CONFLICT below
    // leaves `kind` alone on purpose, so a track someone refiled by hand keeps
    // its filing. Deepest prefix first: the closest starred parent decides.
    const filed: Array<{ prefix: string; kind: string }> = (() => {
      try {
        const parsed = JSON.parse(source.favorites ?? '[]')
        return (Array.isArray(parsed) ? parsed : [])
          .filter((f: any) => f && typeof f === 'object' && typeof f.path === 'string' &&
            ['music', 'audiobook', 'podcast'].includes(f.kind))
          .map((f: any) => ({ prefix: `${f.path}/`, kind: f.kind }))
          .sort((a: any, b: any) => b.prefix.length - a.prefix.length)
      } catch { return [] }
    })()
    const kindOf = (rel: string) =>
      filed.find((m) => rel.startsWith(m.prefix))?.kind
        ?? (extname(rel).toLowerCase() === '.m4b' ? 'audiobook' : 'music')

    const upsert = db.prepare(`
      INSERT INTO tracks (id, sourceId, path, kind, name, artist, albumArtist, album, genre,
        composer, year, trackNumber, trackCount, discNumber, duration, bitRate, sampleRate,
        channels, format, size, mtime, compilation, dateAdded, rev, externalId)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (sourceId, path) DO UPDATE SET
        name=excluded.name, artist=excluded.artist, albumArtist=excluded.albumArtist,
        album=excluded.album, genre=excluded.genre, composer=excluded.composer,
        year=excluded.year, trackNumber=excluded.trackNumber, trackCount=excluded.trackCount,
        discNumber=excluded.discNumber, duration=excluded.duration, bitRate=excluded.bitRate,
        sampleRate=excluded.sampleRate, format=excluded.format, size=excluded.size,
        mtime=excluded.mtime, deletedAt=NULL, rev=excluded.rev,
        externalId=excluded.externalId`)

    const known = db.prepare(`SELECT mtime, size FROM tracks WHERE sourceId = ? AND path = ?`)
    // `lastSeenAt` is stamped rather than `rev`: bumping the revision for a file
    // that has not changed would make every client re-download the whole
    // library after each scan, which is the one thing the revision exists to
    // prevent.
    const seen = db.prepare(
      `UPDATE tracks SET deletedAt = NULL, lastSeenAt = ? WHERE sourceId = ? AND path = ?`)
    const startedAt = Date.now()

    const full = Boolean(ctx.payload.full)
    // Deleting every track of a source is a deliberate act, never a default.
    // See the guard before the sweep.
    const prune = Boolean(ctx.payload.prune)
    let done = 0
    let bytes = 0
    let skipped = 0
    const resumeAfter = ctx.cursor
    let resuming = Boolean(resumeAfter)

    for await (const entry of entries(source)) {
      if (ctx.aborted()) return
      const rel = entry.path

      // Resume: walk again without re-doing work until the last known path.
      // The walk is deterministic, so this is reliable and only costs `readdir`
      // calls, not tag reads.
      if (resuming) {
        // Still stamped while skipping ahead: without this the sweep at the end
        // would treat everything before the resume point as missing and delete
        // the first half of the library.
        seen.run(startedAt, source.id, rel)
        if (rel === resumeAfter) resuming = false
        continue
      }

      // A file whose size and mtime have not moved does not need re-reading:
      // on a rescan that is 99% of them. `full` overrides that -- the only way
      // back when the server changes how it derives a field, since the files
      // themselves have not moved and nothing else would ever re-read them.
      const prev = known.get(source.id, rel) as { mtime: number; size: number } | undefined
      if (!full && prev && prev.mtime === entry.mtime && prev.size === entry.size) {
        seen.run(startedAt, source.id, rel)
        skipped++
        done++
        if (done % 200 === 0) ctx.checkpoint(rel, { done, bytes })
        continue
      }

      let meta: any = {}
      try {
        meta = await readMeta(source, entry)
      } catch {
        // An unreadable file still enters the database: the user has to see it
        // in their library to be able to fix it.
      }

      const name = meta.title || rel.split('/').pop()!.replace(/\.[^.]+$/, '')
      const artist = meta.artist ?? ''
      upsert.run(
        idFor(source.id, rel), source.id, rel,
        kindOf(rel),
        name, artist, meta.albumartist ?? artist, meta.album ?? '', meta.genre?.[0] ?? '',
        meta.composer?.[0] ?? '', meta.year ?? 0, meta.track?.no ?? 0, meta.track?.of ?? 0,
        meta.disk?.no ?? 1, Math.round(meta.duration ?? 0),
        Math.round((meta.bitrate ?? 0) / 1000), meta.sampleRate ?? 0, meta.numberOfChannels ?? 2,
        shortFormat(meta.container, meta.codec) || extname(rel).slice(1).toLowerCase(),
        entry.size, entry.mtime,
        meta.compilation ? 1 : 0, Date.now(), nextRev(db), entry.externalId ?? null,
      )

      seen.run(startedAt, source.id, rel)
      // The file itself, as this track's rendition. One per scanned file today;
      // a second appears when something is transcoded, and the duplicates pass
      // will later merge two scanned files that are the same song.
      db.prepare(`
        INSERT INTO renditions (id, trackId, sourceId, path, format, bitRate, sampleRate,
          channels, size, mtime, lossless, preferred, createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)
        ON CONFLICT (sourceId, path) DO UPDATE SET
          format = excluded.format, bitRate = excluded.bitRate,
          sampleRate = excluded.sampleRate, channels = excluded.channels,
          size = excluded.size, mtime = excluded.mtime, lossless = excluded.lossless`)
        .run(`r-${idFor(source.id, rel)}`, idFor(source.id, rel), source.id, rel,
          shortFormat(meta.container, meta.codec) || extname(rel).slice(1).toLowerCase(),
          Math.round((meta.bitrate ?? 0) / 1000), meta.sampleRate ?? 0,
          meta.numberOfChannels ?? 2, entry.size, entry.mtime,
          meta.lossless ? 1 : 0, Date.now())

      done++
      bytes += entry.size
      if (done % 50 === 0) ctx.checkpoint(rel, { done, bytes })
    }

    ctx.checkpoint(null, { done, total: done, bytes })

    // Anything not seen during a *complete* pass is gone from the source. Soft
    // deleted, never removed: the row carries ratings and play counts, it is
    // what playlists point at, and a network share that was briefly unmounted
    // must not cost anyone their library. Plugging it back in and rescanning
    // brings every one of them back.
    //
    // Guarded on a complete pass for the same reason: a cancelled scan has seen
    // only part of the source, and sweeping there would delete the rest.
    // Counted before writing, so the revision is only bumped when something
    // actually went. Bumping it on every scan would make each client
    // re-download the whole library after every scan -- the exact cost the
    // revision exists to avoid.
    // Nothing at all was found where there used to be a library. That is a
    // share that is not mounted, a drive that is not plugged in or a path that
    // was edited -- and it is *shaped exactly* like a library somebody deleted.
    //
    // The two cannot be told apart from here, so the asymmetry decides: a
    // wrong refusal leaves stale rows until someone confirms, a wrong sweep
    // makes the whole library disappear. Refuse, and say how to mean it.
    const had = (db.prepare(
      `SELECT COUNT(*) AS n FROM tracks WHERE sourceId = ? AND deletedAt IS NULL`)
      .get(source.id) as { n: number }).n

    if (done === 0 && skipped === 0 && had > 0 && !prune) {
      const mount = await describe(source.root)
      const because = mount?.network
        ? `${source.root} is on a ${mount.type} mount that looks unmounted`
        : `${source.root} is empty`
      db.prepare(`UPDATE sources SET lastScanAt = ? WHERE id = ?`).run(Date.now(), source.id)
      throw new Error(
        `${because}, but this source has ${had} tracks. Nothing was removed. `
        + `Mount it and scan again, or scan with prune=true to delete them on purpose.`)
    }

    const gone = (db.prepare(
      `SELECT COUNT(*) AS n FROM tracks
       WHERE sourceId = ? AND deletedAt IS NULL AND (lastSeenAt IS NULL OR lastSeenAt < ?)`)
      .get(source.id, startedAt) as { n: number }).n

    if (gone > 0) {
      db.prepare(
        `UPDATE tracks SET deletedAt = ?, rev = ?
         WHERE sourceId = ? AND deletedAt IS NULL AND (lastSeenAt IS NULL OR lastSeenAt < ?)`)
        .run(Date.now(), nextRev(db), source.id, startedAt)
      console.log(`[scan] ${source.name}: ${gone} tracks no longer on disk`)
    }
    db.prepare(`UPDATE sources SET lastScanAt = ? WHERE id = ?`).run(Date.now(), source.id)

    // FTS is rebuilt after the batch: indexing row by row costs far more.
    db.exec(`INSERT INTO tracks_fts (tracks_fts) VALUES ('rebuild')`)
    console.log(`[scan] ${source.name}: ${done} files, ${skipped} unchanged${full ? ' (full rescan)' : ''}`)
  }
}
