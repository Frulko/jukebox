import { randomUUID } from 'node:crypto'
import { cpus } from 'node:os'
import type { DB } from './db.ts'

/**
 * The job queue — the server's central mechanism.
 *
 * Scanning, transcoding, fingerprinting, podcasts, device sync, analysis, stream
 * relaying: everything long-running has the same shape, so it gets one
 * implementation. The satellite protocol is this same contract seen remotely.
 */

export type JobKind =
  | 'scan' | 'transcode' | 'fingerprint' | 'podcast' | 'writeback'
  | 'sync' | 'acquire' | 'analyze' | 'relay' | 'move' | 'backup'

export type JobState = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

/** States a job will never leave on its own. */
const TERMINAL = new Set<JobState>(['done', 'failed', 'cancelled'])

export type Job = {
  id: string
  kind: JobKind
  state: JobState
  priority: number
  parentId: string | null
  payload: unknown
  cursor: string | null
  done: number
  total: number
  bytes: number
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

/** What a handler receives. `checkpoint` is what makes a job resumable. */
export type JobContext = {
  job: Job
  payload: any
  /** Resume point from the previous run, `null` on the first pass. */
  cursor: string | null
  /** Records progress. Call it often: it is the only resume point. */
  checkpoint(cursor: string | null, progress?: { done?: number; total?: number; bytes?: number }): void
  /**
   * Records the outcome of one item within the job.
   *
   * A sync of 300 tracks that reports "failed: ENOSPC" is nearly useless — the
   * question is always *which* ones, and whether the other 290 landed. This is
   * how a job answers that. Idempotent on `idx`, so a resumed job overwrites
   * its own earlier attempt at the same item rather than doubling it.
   */
  item(idx: number, ref: string, state: JobItemState, extra?: { bytes?: number; error?: string }): void
  /** `true` when the job must stop — cancelled or paused. */
  aborted(): boolean
}

export type JobItemState = 'pending' | 'done' | 'failed' | 'skipped'

export type JobItem = {
  idx: number
  ref: string
  state: JobItemState
  bytes: number
  error: string | null
}

export type JobHandler = (ctx: JobContext) => Promise<void>

/**
 * Per-kind concurrency caps. On a Pi this is the difference between "slow" and
 * "unusable": running eight transcodes on one core does not speed them up, it
 * makes all eight time out.
 */
const coreCount = cpus().length || 2

const CONCURRENCY: Record<JobKind, number> = {
  scan: 1,          // one scan per source is enough; two just fight over the disk
  transcode: Math.max(1, Math.min(4, coreCount - 1)),
  fingerprint: Math.max(1, Math.min(2, coreCount - 1)),
  podcast: 2,
  writeback: 1,     // rewriting two files in the same folder in parallel helps nothing
  sync: 1,
  acquire: 2,
  analyze: 1,
  relay: 4,         // bounded by the network, not the CPU
  move: 1,          // moving files around does not parallelise safely
  backup: 1,
}

type Listener = (job: Job) => void

export class JobQueue {
  #db: DB
  #handlers = new Map<JobKind, JobHandler>()
  #running = new Map<string, { abort: boolean }>()
  #listeners = new Set<Listener>()
  #pumping = false
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(db: DB) {
    this.#db = db
    // A job still marked `running` comes from a hard stop: there is no process
    // behind it. Requeue it — its `cursor` resumes it where it left off.
    db.exec(`UPDATE jobs SET state = 'queued', startedAt = NULL WHERE state = 'running'`)
  }

  register(kind: JobKind, handler: JobHandler): void {
    this.#handlers.set(kind, handler)
  }

  onChange(fn: Listener): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  #emit(job: Job): void {
    for (const fn of this.#listeners) fn(job)
  }

  /**
   * Creates a job. `idempotencyKey` becomes the id: reposting the same key
   * returns the existing job instead of creating a second one. Without it, a
   * client timeout while the server already accepted the request triggers a
   * duplicate sync.
   */
  create(kind: JobKind, payload: unknown, opts: { idempotencyKey?: string; priority?: number; parentId?: string; total?: number } = {}): Job {
    const id = opts.idempotencyKey ?? randomUUID()
    const existing = this.get(id)
    // Idempotency guards against an **in-flight** duplicate: a client timeout
    // while the server is already working. It must not make the operation
    // unique forever — otherwise a source could never be rescanned. A finished
    // job makes way for a new run.
    if (existing) {
      if (!TERMINAL.has(existing.state)) return existing
      this.#db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id)
    }

    this.#db
      .prepare(
        `INSERT INTO jobs (id, kind, state, priority, parentId, payload, total, createdAt)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(id, kind, opts.priority ?? 0, opts.parentId ?? null, JSON.stringify(payload ?? {}), opts.total ?? 0, Date.now())

    const job = this.get(id)!
    this.#emit(job)
    this.pump()
    return job
  }

  get(id: string): Job | null {
    const row = this.#db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as any
    return row ? hydrate(row) : null
  }

  list(filter: { state?: JobState; kind?: JobKind; limit?: number } = {}): Job[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.state) { where.push('state = ?'); params.push(filter.state) }
    if (filter.kind) { where.push('kind = ?'); params.push(filter.kind) }
    const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY createdAt DESC LIMIT ?`
    params.push(filter.limit ?? 50)
    return (this.#db.prepare(sql).all(...(params as never[])) as any[]).map(hydrate)
  }

  /**
   * The items of one job, paginated.
   *
   * Paginated because it is unbounded: a full iPod sync is tens of thousands of
   * rows, and "show me what failed" must not mean shipping all of them. Ordered
   * by `idx` — the order the job did the work in, which is the order a reader
   * wants to scan for the point things went wrong.
   */
  items(jobId: string, opts: { cursor?: string; limit?: unknown; state?: JobItemState } = {}):
    { items: JobItem[]; next: string | null; counts: Record<JobItemState, number> } {
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000)
    const where = ['jobId = ?']
    const params: unknown[] = [jobId]
    if (opts.state) { where.push('state = ?'); params.push(opts.state) }
    // The cursor is the last `idx` seen. An integer, so no encoding to get wrong.
    if (opts.cursor) { where.push('idx > ?'); params.push(Number(opts.cursor)) }

    const rows = this.#db
      .prepare(`SELECT idx, ref, state, bytes, error FROM job_items
                WHERE ${where.join(' AND ')} ORDER BY idx ASC LIMIT ?`)
      .all(...([...params, limit] as never[])) as any[]

    // The totals come from SQL over the whole job, never from the page: "3 of
    // 40000 failed" is the number worth reading, and counting a page would
    // answer "3 of 200".
    const counts = { pending: 0, done: 0, failed: 0, skipped: 0 } as Record<JobItemState, number>
    for (const r of this.#db.prepare(`SELECT state, COUNT(*) AS n FROM job_items WHERE jobId = ? GROUP BY state`)
      .all(jobId) as any[]) {
      counts[r.state as JobItemState] = r.n as number
    }

    return {
      items: rows,
      next: rows.length === limit ? String(rows[rows.length - 1].idx) : null,
      counts,
    }
  }

  pause(id: string): Job | null {
    this.#running.get(id) && (this.#running.get(id)!.abort = true)
    this.#db.prepare(`UPDATE jobs SET state = 'paused' WHERE id = ? AND state IN ('queued','running')`).run(id)
    const job = this.get(id)
    if (job) this.#emit(job)
    return job
  }

  resume(id: string): Job | null {
    this.#db.prepare(`UPDATE jobs SET state = 'queued' WHERE id = ? AND state = 'paused'`).run(id)
    const job = this.get(id)
    if (job) this.#emit(job)
    this.pump()
    return job
  }

  cancel(id: string): Job | null {
    this.#running.get(id) && (this.#running.get(id)!.abort = true)
    this.#db
      .prepare(`UPDATE jobs SET state = 'cancelled', finishedAt = ? WHERE id = ? AND state IN ('queued','running','paused')`)
      .run(Date.now(), id)
    const job = this.get(id)
    if (job) this.#emit(job)
    return job
  }

  /** Starts the loop. The heartbeat picks up jobs requeued by a restart. */
  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => this.pump(), 1000)
    this.#timer.unref?.()
    this.pump()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    for (const h of this.#running.values()) h.abort = true
  }

  pump(): void {
    if (this.#pumping) return
    this.#pumping = true
    queueMicrotask(() => {
      this.#pumping = false
      this.#dispatch()
    })
  }

  #dispatch(): void {
    const counts = new Map<JobKind, number>()
    for (const id of this.#running.keys()) {
      const job = this.get(id)
      if (job) counts.set(job.kind, (counts.get(job.kind) ?? 0) + 1)
    }

    const queued = this.#db
      .prepare(`SELECT * FROM jobs WHERE state = 'queued' ORDER BY priority DESC, createdAt ASC LIMIT 50`)
      .all() as any[]

    for (const row of queued) {
      const job = hydrate(row)
      const handler = this.#handlers.get(job.kind)
      if (!handler) continue
      const inFlight = counts.get(job.kind) ?? 0
      if (inFlight >= (CONCURRENCY[job.kind] ?? 1)) continue
      counts.set(job.kind, inFlight + 1)
      void this.#run(job, handler)
    }
  }

  async #run(job: Job, handler: JobHandler): Promise<void> {
    const handle = { abort: false }
    this.#running.set(job.id, handle)
    this.#db.prepare(`UPDATE jobs SET state = 'running', startedAt = ?, error = NULL WHERE id = ?`).run(Date.now(), job.id)
    this.#emit(this.get(job.id)!)

    const ctx: JobContext = {
      job,
      payload: JSON.parse(String(job.payload ?? '{}')),
      cursor: job.cursor,
      checkpoint: (cursor, progress) => {
        this.#db
          .prepare(
            `UPDATE jobs SET cursor = ?,
               done  = COALESCE(?, done),
               total = COALESCE(?, total),
               bytes = COALESCE(?, bytes)
             WHERE id = ?`,
          )
          .run(cursor, progress?.done ?? null, progress?.total ?? null, progress?.bytes ?? null, job.id)
        const fresh = this.get(job.id)
        if (fresh) this.#emit(fresh)
      },
      item: (idx, ref, state, extra) => {
        this.#db
          .prepare(
            `INSERT INTO job_items (jobId, idx, ref, state, bytes, error) VALUES (?,?,?,?,?,?)
             ON CONFLICT (jobId, idx) DO UPDATE SET
               ref = excluded.ref, state = excluded.state,
               bytes = excluded.bytes, error = excluded.error`,
          )
          .run(job.id, idx, ref, state, extra?.bytes ?? 0, extra?.error ?? null)
      },
      aborted: () => {
        if (handle.abort) return true
        const row = this.#db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(job.id) as { state: JobState } | undefined
        return !row || row.state === 'cancelled' || row.state === 'paused'
      },
    }

    try {
      await handler(ctx)
      // A job paused or cancelled mid-flight must not be marked done.
      const state = (this.#db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(job.id) as any)?.state
      if (state === 'running') {
        this.#db.prepare(`UPDATE jobs SET state = 'done', finishedAt = ?, cursor = NULL WHERE id = ?`).run(Date.now(), job.id)
      }
    } catch (err) {
      this.#db
        .prepare(`UPDATE jobs SET state = 'failed', finishedAt = ?, error = ? WHERE id = ?`)
        .run(Date.now(), err instanceof Error ? err.message : String(err), job.id)
    } finally {
      this.#running.delete(job.id)
      const fresh = this.get(job.id)
      if (fresh) this.#emit(fresh)
      this.pump()
    }
  }
}

function hydrate(row: any): Job {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    priority: row.priority,
    parentId: row.parentId ?? null,
    payload: row.payload,
    cursor: row.cursor ?? null,
    done: row.done,
    total: row.total,
    bytes: row.bytes,
    error: row.error ?? null,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
  }
}

/** Public view: aggregates only. Per-item detail is paginated separately. */
export const publicJob = (j: Job) => ({
  id: j.id,
  kind: j.kind,
  state: j.state,
  progress: { done: j.done, total: j.total, bytes: j.bytes },
  error: j.error,
  createdAt: j.createdAt,
  startedAt: j.startedAt,
  finishedAt: j.finishedAt,
})
