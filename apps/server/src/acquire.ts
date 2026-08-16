import { mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import { createHash } from 'node:crypto'
import type { DB } from './db.ts'
import { nextRev } from './db.ts'
import type { JobContext } from './jobs.ts'
import { readTags } from './tags.ts'

/**
 * Pulls tracks off a device and into a source.
 *
 * The satellite serves the bytes; the server writes them and indexes the
 * result. Each file lands under a temporary name and is renamed into place, so
 * an interrupted import leaves no half-written file that a later scan would
 * happily index as a real track.
 */
export function makeAcquireHandler(db: DB) {
  return async function acquire(ctx: JobContext): Promise<void> {
    const { deviceId, deviceLocalIds, targetSourceId, targetPath } = ctx.payload
    const source = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(targetSourceId) as any
    if (!source) throw new Error(`unknown target source: ${targetSourceId}`)
    if (!source.writable) throw new Error('target source is read-only')

    const row = db.prepare(
      `SELECT deviceLocalId, name, artist, album, format, sourceUrl
       FROM device_tracks WHERE deviceId = ? AND deviceLocalId = ?`)

    const start = ctx.cursor ? deviceLocalIds.indexOf(ctx.cursor) + 1 : 0
    let done = start
    let bytes = 0

    for (let i = start; i < deviceLocalIds.length; i++) {
      if (ctx.aborted()) return
      const t = row.get(deviceId, deviceLocalIds[i]) as any
      done++
      if (!t) {
        ctx.item(i, deviceLocalIds[i], 'skipped', { error: 'no longer on the device' })
        continue
      }
      if (!t.sourceUrl) {
        // Nothing to fetch. Saying which track and why beats a silent skip.
        ctx.item(i, t.deviceLocalId, 'failed', { error: 'no fetch URL from the satellite' })
        continue
      }

      try {
        const res = await fetch(t.sourceUrl)
        if (!res.ok) throw new Error(`${res.status} fetching ${t.deviceLocalId}`)
        const buf = Buffer.from(await res.arrayBuffer())

        const safe = (s: string) => (s || 'Unknown').replace(/[/\\:*?"<>|]/g, '_').trim()
        const ext = t.format ? `.${t.format}` : extname(t.name) || '.mp3'
        const rel = join(targetPath, safe(t.artist), safe(t.album), `${safe(t.name)}${ext}`)
        const abs = join(source.root, rel)
        await mkdir(dirname(abs), { recursive: true })

        // Temp then rename: an interrupted import must not leave a truncated file
        // that the next scan indexes as a real track.
        const tmp = `${abs}.part-${createHash('sha1').update(t.deviceLocalId).digest('hex').slice(0, 8)}`
        await writeFile(tmp, buf)
        await rename(tmp, abs)
        bytes += buf.byteLength

        let meta: any = {}
        try {
          meta = await readTags(abs)
        } catch { /* unreadable: it still enters the library so the user can fix it */ }

        const id = createHash('sha1').update(`${source.id} ${rel}`).digest('base64url').slice(0, 16)
        db.prepare(`
          INSERT INTO tracks (id, sourceId, path, name, artist, albumArtist, album, duration,
            bitRate, format, size, mtime, dateAdded, rev)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT (sourceId, path) DO UPDATE SET deletedAt = NULL, rev = excluded.rev`)
          .run(id, source.id, rel, meta.tags?.name ?? t.name, meta.tags?.artist ?? t.artist,
            meta.tags?.albumArtist ?? t.artist, meta.tags?.album ?? t.album,
            meta.audio?.duration ?? 0, meta.audio?.bitRate ?? 0,
            (meta.audio?.format || t.format || '').toLowerCase(), buf.byteLength, Date.now(),
            Date.now(), nextRev(db))

        // The imported file is this track's rendition. Every path that creates a
        // track has to create one, or the track has no playable file and the
        // sync plan would call it unconvertible.
        db.prepare(`
          INSERT INTO renditions (id, trackId, sourceId, path, format, bitRate, size, mtime, preferred, createdAt)
          VALUES (?,?,?,?,?,?,?,?,1,?)
          ON CONFLICT (sourceId, path) DO UPDATE SET
            format = excluded.format, size = excluded.size, mtime = excluded.mtime`)
          .run(`r-${id}`, id, source.id, rel,
            (meta.audio?.format || t.format || '').toLowerCase(),
            meta.audio?.bitRate ?? 0, buf.byteLength, Date.now(), Date.now())

        // Link the device row to the track we just created: the same music is now
        // in both places, and the presence column should say so immediately.
        db.prepare(`UPDATE device_tracks SET trackId = ? WHERE deviceId = ? AND deviceLocalId = ?`)
          .run(id, deviceId, t.deviceLocalId)

        ctx.item(i, t.deviceLocalId, 'done', { bytes: buf.byteLength })
      } catch (err) {
        // One unreachable file must not abandon the other 299. An import runs
        // over a network and a device that can be unplugged mid-transfer;
        // throwing here meant a single hiccup lost the whole batch.
        ctx.item(i, t.deviceLocalId, 'failed', { error: err instanceof Error ? err.message : String(err) })
      }

      ctx.checkpoint(t.deviceLocalId, { done, total: deviceLocalIds.length, bytes })
    }

    db.exec(`INSERT INTO tracks_fts (tracks_fts) VALUES ('rebuild')`)
    ctx.checkpoint(null, { done, total: deviceLocalIds.length, bytes })
  }
}
