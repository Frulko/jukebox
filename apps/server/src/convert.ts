import { createHash } from 'node:crypto'
import { rename, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { DB } from './db.ts'
import { nextRev } from './db.ts'
import type { JobContext } from './jobs.ts'
import { encoderFor, transcode } from './ffmpeg.ts'
import { readTags } from './tags.ts'

/**
 * Converting tracks into another format.
 *
 * The result is a **rendition**, not a new track: the same song now exists as
 * two files, and the library says so in one row. `replace` decides whether the
 * new file becomes the preferred one and the old file is deleted, or whether it
 * simply joins the list.
 *
 * "Keep a copy" is the interesting half. An iPod that takes AAC and a browser
 * that wants the FLAC are the same song; keeping both means the sync stops
 * re-encoding on every run, which is what makes this worth having at all.
 */

export type ConvertPayload = {
  ids: string[]
  format: string
  quality?: string
  /** True: the new file takes over and the original is deleted. */
  replace?: boolean
}

export function makeConvertHandler(db: DB) {
  return async function convert(ctx: JobContext): Promise<void> {
    const { ids, format, quality, replace } = ctx.payload as ConvertPayload
    const enc = encoderFor(format)
    if (!enc) throw new Error(`cannot convert to ${format}`)

    const row = db.prepare(
      `SELECT t.id, t.name, t.path, t.sourceId, t.format, s.root, s.writable
       FROM tracks t JOIN sources s ON s.id = t.sourceId
       WHERE t.id = ? AND t.deletedAt IS NULL`)

    ctx.checkpoint(null, { done: 0, total: ids.length })
    let done = 0
    let bytes = 0

    for (const id of ids) {
      if (ctx.aborted()) return
      const t = row.get(id) as any

      try {
        if (!t) throw new Error('no longer in the library')
        if (!t.writable) throw new Error('its source is read-only')

        // Already there. Not an error, and not work worth doing twice: the
        // point of renditions is that a converted file is kept.
        const existing = db.prepare(
          `SELECT id FROM renditions WHERE trackId = ? AND lower(format) = lower(?)`).get(id, format)
        if (existing && !replace) {
          ctx.item(done, t.name, 'skipped', { error: `already has ${format}` })
          done++
          continue
        }

        const source = t.path.replace(/\.[^.]+$/, '')
        const rel = `${source}.${enc.ext}`
        const abs = join(t.root, rel)
        const input = join(t.root, t.path)

        if (rel === t.path) throw new Error(`already ${format}`)

        // Converted to a temporary name and renamed in, like every other write
        // here: an interrupted encode must not leave a truncated file that the
        // next scan indexes as a real track.
        //
        // The extension stays last. ffmpeg picks its muxer from it, so a
        // temporary called `track.mp3.converting` fails with "Invalid argument"
        // and no hint that the name is what it is complaining about.
        const tmp = abs.replace(/\.([^.]+)$/, '.converting.$1')
        await transcode(input, tmp, format, quality)
        await rename(tmp, abs)

        const st = await stat(abs)
        const meta = await readTags(abs).catch(() => null)
        bytes += st.size

        const rid = `r-${createHash('sha1').update(`${t.sourceId}\0${rel}`).digest('base64url').slice(0, 16)}`
        db.prepare(`
          INSERT INTO renditions (id, trackId, sourceId, path, format, bitRate, sampleRate,
            channels, size, mtime, lossless, preferred, createdAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT (sourceId, path) DO UPDATE SET
            size = excluded.size, mtime = excluded.mtime, bitRate = excluded.bitRate`)
          .run(rid, id, t.sourceId, rel, format,
            meta?.audio.bitRate ?? 0, meta?.audio.sampleRate ?? 0, meta?.audio.channels ?? 2,
            st.size, Math.floor(st.mtimeMs), enc.lossless ? 1 : 0,
            replace ? 1 : 0, Date.now())

        if (replace) {
          const old = db.prepare(
            `SELECT id, path FROM renditions WHERE trackId = ? AND id <> ?`).all(id, rid) as any[]
          // Only one preferred per track, so the others stand down first.
          db.prepare(`UPDATE renditions SET preferred = 0 WHERE trackId = ? AND id <> ?`).run(id, rid)

          for (const o of old) {
            await rm(join(t.root, o.path), { force: true })
            db.prepare(`DELETE FROM renditions WHERE id = ?`).run(o.id)
          }

          // The flat columns are the preferred rendition's copy, so they move
          // with it -- otherwise every listing would still show the old format
          // and the streaming endpoint would look for a file that is gone.
          db.prepare(`UPDATE tracks SET path = ?, format = ?, size = ?, bitRate = ?, mtime = ?, rev = ?
                      WHERE id = ?`)
            .run(rel, format, st.size, meta?.audio.bitRate ?? 0, Math.floor(st.mtimeMs), nextRev(db), id)
        }

        ctx.item(done, t.name, 'done', { bytes: st.size })
      } catch (err) {
        // One file that will not encode must not abandon the other 299.
        ctx.item(done, t?.name ?? id, 'failed',
          { error: err instanceof Error ? err.message : String(err) })
      }

      done++
      ctx.checkpoint(id, { done, total: ids.length, bytes })
    }

    db.exec(`INSERT INTO tracks_fts (tracks_fts) VALUES ('rebuild')`)
    ctx.checkpoint(null, { done, total: ids.length, bytes })
  }
}

/** Extension for a target format, for a UI that wants to show what it will write. */
export const extensionFor = (format: string) => encoderFor(format)?.ext ?? extname(format)
