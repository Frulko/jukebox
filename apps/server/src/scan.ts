import { opendir, stat } from 'node:fs/promises'
import { join, relative, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { parseFile, parseBuffer } from 'music-metadata'
import type { DB } from './db.ts'
import { nextRev } from './db.ts'
import type { JobContext } from './jobs.ts'
import { shortFormat } from './tags.ts'
import { configOf, open as rcOpen, walk as rcWalk } from './rclone.ts'

const AUDIO = new Set(['.mp3', '.m4a', '.aac', '.flac', '.alac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.wma', '.m4b'])

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
type Entry = { path: string; size: number; mtime: number; mimeType?: string }

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

  for await (const rel of walk(source.root)) {
    const st = await stat(join(source.root, rel)).catch(() => null)
    if (!st) continue
    yield { path: rel, size: st.size, mtime: Math.floor(st.mtimeMs) }
  }
}

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

    const upsert = db.prepare(`
      INSERT INTO tracks (id, sourceId, path, kind, name, artist, albumArtist, album, genre,
        composer, year, trackNumber, trackCount, discNumber, duration, bitRate, sampleRate,
        channels, format, size, mtime, compilation, dateAdded, rev)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (sourceId, path) DO UPDATE SET
        name=excluded.name, artist=excluded.artist, albumArtist=excluded.albumArtist,
        album=excluded.album, genre=excluded.genre, composer=excluded.composer,
        year=excluded.year, trackNumber=excluded.trackNumber, trackCount=excluded.trackCount,
        discNumber=excluded.discNumber, duration=excluded.duration, bitRate=excluded.bitRate,
        sampleRate=excluded.sampleRate, format=excluded.format, size=excluded.size,
        mtime=excluded.mtime, deletedAt=NULL, rev=excluded.rev`)

    const known = db.prepare(`SELECT mtime, size FROM tracks WHERE sourceId = ? AND path = ?`)
    // `lastSeenAt` is stamped rather than `rev`: bumping the revision for a file
    // that has not changed would make every client re-download the whole
    // library after each scan, which is the one thing the revision exists to
    // prevent.
    const seen = db.prepare(
      `UPDATE tracks SET deletedAt = NULL, lastSeenAt = ? WHERE sourceId = ? AND path = ?`)
    const startedAt = Date.now()

    const full = Boolean(ctx.payload.full)
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
        extname(rel).toLowerCase() === '.m4b' ? 'audiobook' : 'music',
        name, artist, meta.albumartist ?? artist, meta.album ?? '', meta.genre?.[0] ?? '',
        meta.composer?.[0] ?? '', meta.year ?? 0, meta.track?.no ?? 0, meta.track?.of ?? 0,
        meta.disk?.no ?? 1, Math.round(meta.duration ?? 0),
        Math.round((meta.bitrate ?? 0) / 1000), meta.sampleRate ?? 0, meta.numberOfChannels ?? 2,
        shortFormat(meta.container, meta.codec) || extname(rel).slice(1).toLowerCase(),
        entry.size, entry.mtime,
        meta.compilation ? 1 : 0, Date.now(), nextRev(db),
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
