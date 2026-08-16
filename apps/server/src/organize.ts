import { rename, mkdir, stat, rmdir } from 'node:fs/promises'
import { dirname, join, extname, relative, isAbsolute, sep } from 'node:path'
import type { DB } from './db.ts'
import { nextRev } from './db.ts'
import type { JobContext } from './jobs.ts'

/**
 * Moving files into a pattern.
 *
 * This is the only feature here that rewrites someone's disk, so the shape is
 * built around not being trusted: the plan is computed and returned first,
 * applying it is a separate explicit call, every move is logged, and the log is
 * enough to put everything back.
 *
 * Three ways this destroys a library, all of them guarded:
 *
 * - **Escaping the source.** Tags are attacker-controlled in the sense that
 *   nobody checks them: an album called `../../..` would walk a rename right out
 *   of the music folder. Every segment is sanitised, and the final path is
 *   verified to still be inside the root before anything moves.
 * - **Collisions.** Two tracks whose tags render to the same name would leave
 *   one file where there were two. Conflicts are found during planning and
 *   refused, never resolved by silently overwriting.
 * - **Half-finished runs.** Each move is recorded as it happens, so an
 *   interrupted job is undoable up to exactly where it stopped.
 */

export type OrganizeRule = {
  sourceId: string
  /** e.g. `{albumArtist}/{album}/{trackNumber:02} {name}` — the extension is kept. */
  pattern: string
}

export type PlannedMove = {
  trackId: string
  from: string
  to: string
}

export type OrganizePlan = {
  moves: PlannedMove[]
  /** Two or more tracks rendering to the same path. Nothing runs while any exist. */
  conflicts: { to: string; trackIds: string[] }[]
  /** Already where the pattern wants them. */
  unchanged: number
  /** Tracks the pattern could not render, with the field that was empty. */
  skipped: { trackId: string; reason: string }[]
}

const FIELDS = new Set([
  'artist', 'albumArtist', 'album', 'name', 'title', 'genre', 'composer',
  'year', 'trackNumber', 'discNumber', 'kind',
])

/**
 * One path segment, made safe.
 *
 * The separators and `..` go first: a tag of `../../etc` is how a rename leaves
 * the music folder. Then the characters Windows and macOS refuse, then trailing
 * dots and spaces, which Windows silently strips and then cannot find the file
 * it just wrote.
 */
export function sanitize(segment: string): string {
  return segment
    .replace(/[/\\]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .slice(0, 120)
    .trim()
}

/**
 * Fills a pattern from a track.
 *
 * `{trackNumber:02}` pads to a width; that is the whole of the formatting
 * language, because a pattern nobody can read is a pattern nobody can predict.
 * Returns `null` when a referenced field is empty — moving a file into
 * `Unknown/Unknown/` is worse than leaving it where it is and saying why.
 */
export function renderPattern(pattern: string, track: any): { path: string } | { error: string } {
  let missing: string | null = null

  const body = pattern.replace(/\{(\w+)(?::(\d+))?\}/g, (_, field: string, width?: string) => {
    if (!FIELDS.has(field)) {
      missing ??= `unknown field {${field}}`
      return ''
    }
    const key = field === 'title' ? 'name' : field
    const raw = track[key]
    if (raw === null || raw === undefined || raw === '' || raw === 0) {
      missing ??= `${field} is empty`
      return ''
    }
    const value = width ? String(raw).padStart(Number(width), '0') : String(raw)
    return value
  })

  if (missing) return { error: missing }

  // Sanitised per segment, after rendering: doing it before would mangle the
  // slashes the pattern itself puts in.
  const segments = body.split('/').map(sanitize).filter(Boolean)
  if (!segments.length) return { error: 'the pattern rendered to nothing' }

  const ext = extname(track.path).toLowerCase()
  return { path: segments.join('/') + ext }
}

/**
 * True when `rel` stays inside the root once resolved.
 *
 * An absolute `rel` is rejected outright rather than joined. `join('/music',
 * '/etc/passwd')` quietly yields `/music/etc/passwd`, which *is* inside the
 * root and so would pass — safe by accident, and surprising enough that the
 * next person to read it would assume the check covers a case it does not.
 */
export function insideRoot(root: string, rel: string): boolean {
  if (!rel || isAbsolute(rel)) return false
  const back = relative(root, join(root, rel))
  return back !== '' && !back.startsWith('..') && !isAbsolute(back)
}

export function planOrganize(db: DB, rule: OrganizeRule): OrganizePlan {
  const source = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(rule.sourceId) as any
  if (!source) throw new Error(`unknown source: ${rule.sourceId}`)
  if (!source.writable) throw new Error('source is read-only')
  if (source.kind !== 'local') throw new Error(`${source.kind} sources cannot be reorganised yet`)

  const tracks = db.prepare(
    `SELECT id, path, artist, albumArtist, album, name, genre, composer, year,
            trackNumber, discNumber, kind
     FROM tracks WHERE sourceId = ? AND deletedAt IS NULL`).all(rule.sourceId) as any[]

  const moves: PlannedMove[] = []
  const skipped: OrganizePlan['skipped'] = []
  const wanted = new Map<string, string[]>()
  let unchanged = 0

  for (const t of tracks) {
    const rendered = renderPattern(rule.pattern, t)
    if ('error' in rendered) {
      skipped.push({ trackId: t.id, reason: rendered.error })
      continue
    }
    if (!insideRoot(source.root, rendered.path)) {
      skipped.push({ trackId: t.id, reason: 'the rendered path leaves the source folder' })
      continue
    }
    if (rendered.path === t.path) {
      unchanged++
      continue
    }
    moves.push({ trackId: t.id, from: t.path, to: rendered.path })
    wanted.set(rendered.path, [...(wanted.get(rendered.path) ?? []), t.id])
  }

  // A destination two tracks both want. Left alone, the second rename deletes
  // the first file.
  const conflicts = [...wanted.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([to, trackIds]) => ({ to, trackIds }))

  return { moves, conflicts, unchanged, skipped }
}

/**
 * Performs a planned reorganisation.
 *
 * The plan is recomputed here rather than taken from the caller: minutes can
 * pass between previewing and confirming, and applying a stale plan would move
 * files based on tags that have since changed.
 */
export function makeOrganizeHandler(db: DB) {
  return async function organize(ctx: JobContext): Promise<void> {
    const rule: OrganizeRule = { sourceId: ctx.payload.sourceId, pattern: ctx.payload.pattern }
    const source = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(rule.sourceId) as any
    const plan = planOrganize(db, rule)

    if (plan.conflicts.length) {
      throw new Error(`${plan.conflicts.length} destinations are wanted by more than one track`)
    }

    const log = db.prepare(
      `INSERT INTO moves (jobId, trackId, sourceId, fromPath, toPath, movedAt) VALUES (?,?,?,?,?,?)`)
    const repath = db.prepare(`UPDATE tracks SET path = ?, rev = ? WHERE id = ?`)

    ctx.checkpoint(null, { done: 0, total: plan.moves.length })
    let done = 0

    for (const m of plan.moves) {
      if (ctx.aborted()) return
      const from = join(source.root, m.from)
      const to = join(source.root, m.to)

      try {
        // Refuse rather than overwrite. The plan checked for collisions among
        // the tracks it knows about; a file the library has never indexed can
        // still be sitting there.
        const existing = await stat(to).catch(() => null)
        if (existing) {
          ctx.item(done, m.from, 'skipped', { error: `${m.to} already exists` })
          done++
          continue
        }

        await mkdir(dirname(to), { recursive: true })
        await rename(from, to)
        // Logged before the row is updated: a crash between the two leaves a
        // log entry pointing at a file that really did move, which is undoable.
        // The reverse order would lose the move entirely.
        log.run(ctx.job.id, m.trackId, rule.sourceId, m.from, m.to, Date.now())
        repath.run(m.to, nextRev(db), m.trackId)
        ctx.item(done, m.from, 'done')
      } catch (err) {
        ctx.item(done, m.from, 'failed', { error: err instanceof Error ? err.message : String(err) })
      }

      done++
      if (done % 20 === 0) ctx.checkpoint(m.from, { done, total: plan.moves.length })
    }

    await pruneEmpty(source.root, plan.moves.map((m) => m.from))
    ctx.checkpoint(null, { done, total: plan.moves.length })
  }
}

/**
 * Reverses a run, newest move first.
 *
 * Newest first because a reorganisation can move A to B and then C to A; undone
 * in the original order, restoring C would land on a file that has not moved
 * out of the way yet.
 */
export function makeUndoHandler(db: DB) {
  return async function undo(ctx: JobContext): Promise<void> {
    const rows = db.prepare(
      `SELECT m.*, s.root FROM moves m JOIN sources s ON s.id = m.sourceId
       WHERE m.jobId = ? AND m.undoneAt IS NULL ORDER BY m.id DESC`).all(ctx.payload.jobId) as any[]

    const mark = db.prepare(`UPDATE moves SET undoneAt = ? WHERE id = ?`)
    const repath = db.prepare(`UPDATE tracks SET path = ?, rev = ? WHERE id = ?`)
    ctx.checkpoint(null, { done: 0, total: rows.length })
    let done = 0

    for (const m of rows) {
      if (ctx.aborted()) return
      try {
        const back = join(m.root, m.fromPath)
        if (await stat(back).catch(() => null)) {
          ctx.item(done, m.toPath, 'skipped', { error: 'something is already back at the original path' })
        } else {
          await mkdir(dirname(back), { recursive: true })
          await rename(join(m.root, m.toPath), back)
          repath.run(m.fromPath, nextRev(db), m.trackId)
          mark.run(Date.now(), m.id)
          ctx.item(done, m.toPath, 'done')
        }
      } catch (err) {
        ctx.item(done, m.toPath, 'failed', { error: err instanceof Error ? err.message : String(err) })
      }
      done++
    }
    ctx.checkpoint(null, { done, total: rows.length })
  }
}

/**
 * Removes the folders a move emptied.
 *
 * Only the directories files actually left, and only when `rmdir` finds them
 * empty — which is why it is safe to try and ignore the failure. Walking the
 * tree looking for empty folders would eventually delete one someone made on
 * purpose.
 */
async function pruneEmpty(root: string, movedFrom: string[]): Promise<void> {
  const dirs = new Set(movedFrom.map((p) => dirname(p)).filter((d) => d && d !== '.'))
  // Deepest first, so emptying a leaf lets its parent go too.
  for (const dir of [...dirs].sort((a, b) => b.split(sep).length - a.split(sep).length)) {
    let current = dir
    while (current && current !== '.' && current !== sep) {
      try {
        await rmdir(join(root, current))
      } catch {
        break // not empty, or gone already
      }
      current = dirname(current)
    }
  }
}
