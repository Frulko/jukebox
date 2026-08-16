import { join } from 'node:path'
import type { DB } from './db.ts'
import type { JobContext } from './jobs.ts'
import { WRITABLE, writeTags, type Tags } from './tags.ts'

/**
 * Propagating tag edits to disk.
 *
 * The modal's edit updates the database immediately — the UI has to answer at
 * once. Writing the files is a job: rewriting 500 files over a network share
 * takes minutes, and it has to be resumable, cancellable and visible.
 *
 * **A non-writable source is never touched.** Write capability is per source and
 * denied by default; this is the only place that decides.
 */
export function makeWritebackHandler(db: DB) {
  return async function writeback(ctx: JobContext): Promise<void> {
    const patch: Partial<Tags> = {}
    for (const key of WRITABLE) {
      if (ctx.payload.patch?.[key] !== undefined) (patch as any)[key] = ctx.payload.patch[key]
    }
    if (Object.keys(patch).length === 0) return

    const ids: string[] = ctx.payload.ids ?? []
    const row = db.prepare(
      `SELECT t.id, t.path, s.root, s.writable, s.name AS sourceName
       FROM tracks t JOIN sources s ON s.id = t.sourceId WHERE t.id = ?`)

    const start = ctx.cursor ? ids.indexOf(ctx.cursor) + 1 : 0
    let done = start
    let refused = 0

    for (let i = start; i < ids.length; i++) {
      if (ctx.aborted()) return
      const t = row.get(ids[i]) as any
      done++

      if (!t) {
        ctx.item(i, ids[i], 'skipped', { error: 'track no longer in the library' })
        continue
      }
      if (!t.writable) {
        // Not an error: the source is declared read-only and the user meant it.
        // The database keeps the value, the file does not. Recorded per item all
        // the same -- a console line saying "12 refused" cannot tell you which.
        refused++
        ctx.item(i, ids[i], 'skipped', { error: 'source is read-only' })
        continue
      }

      try {
        await writeTags(join(t.root, t.path), patch)
        ctx.item(i, ids[i], 'done')
      } catch (err) {
        // A locked or corrupt file must not fail the other 499. Record it and
        // move on.
        ctx.item(i, ids[i], 'failed', { error: err instanceof Error ? err.message : String(err) })
      }

      if (done % 20 === 0) ctx.checkpoint(ids[i], { done, total: ids.length })
    }

    ctx.checkpoint(null, { done, total: ids.length })
    if (refused > 0) console.log(`[writeback] ${refused} tracks on a read-only source — database updated, files untouched`)
  }
}
