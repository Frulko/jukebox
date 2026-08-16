import type { DB } from './db.ts'
import type { JobKind } from './jobs.ts'
import type { JobQueue } from './jobs.ts'

/**
 * Scheduled work: the overnight sync, the podcast refresh, the nightly rescan.
 *
 * Two decisions shape everything here.
 *
 * **The clock is asked, never predicted.** A tick fires once a minute and asks
 * each schedule "do you match *this* minute?". The alternative — computing the
 * next fire time and sleeping until it — has to reason about DST, and gets it
 * wrong twice a year: a 02:30 job either runs twice in October or not at all in
 * March. Matching the wall clock is immune to that, because the wall clock is
 * what the user meant.
 *
 * **No cron dependency.** The five-field subset below is the whole of what a
 * schedule needs, and it fits in one screen with tests. The one part that is
 * genuinely subtle — day-of-month against day-of-week — is implemented to the
 * standard's OR rule rather than the obvious AND.
 */

const RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7],  // day of week, with 7 as a second Sunday
]

const NAMES: Record<string, number>[] = [
  {}, {}, {},
  { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
]

/** The values one field accepts, or `null` if the expression is malformed. */
function field(spec: string, index: number): Set<number> | null {
  const [lo, hi] = RANGES[index]
  const out = new Set<number>()

  for (const part of spec.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) return null

    let from: number
    let to: number
    if (rangePart === '*') {
      from = lo
      to = hi
    } else {
      const bounds = rangePart.split('-')
      if (bounds.length > 2) return null
      const parse = (s: string) => {
        const named = NAMES[index][s.toLowerCase()]
        return named === undefined ? Number(s) : named
      }
      from = parse(bounds[0])
      to = bounds.length === 2 ? parse(bounds[1]) : from
      // `5/15` means "from 5 to the end of the field, every 15" -- not "5 only".
      if (bounds.length === 1 && stepPart !== undefined) to = hi
      if (!Number.isInteger(from) || !Number.isInteger(to)) return null
      if (from < lo || to > hi || from > to) return null
    }

    for (let v = from; v <= to; v += step) out.add(v)
  }

  // Sunday is both 0 and 7; normalising here means the matcher never has to care.
  if (index === 4 && out.has(7)) out.add(0)
  return out.size ? out : null
}

export type Cron = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domRestricted: boolean; dowRestricted: boolean }

/** Parses a five-field expression. Returns `null` if it is not one. */
export function parseCron(expr: string): Cron | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const sets = parts.map((p, i) => field(p, i))
  if (sets.some((s) => s === null)) return null
  const [minute, hour, dom, month, dow] = sets as Set<number>[]
  return {
    minute, hour, dom, month, dow,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  }
}

/**
 * Does this expression fire at this local minute?
 *
 * Local, not UTC: "every night at 3" means 3 in the morning where the user is.
 */
export function matches(c: Cron, at: Date): boolean {
  if (!c.minute.has(at.getMinutes())) return false
  if (!c.hour.has(at.getHours())) return false
  if (!c.month.has(at.getMonth() + 1)) return false

  const domHit = c.dom.has(at.getDate())
  const dowHit = c.dow.has(at.getDay())

  // The standard's rule, and the one everyone gets wrong: when *both* day
  // fields are restricted they are OR'd, not AND'd. `0 0 13 * fri` is the 13th
  // *or* any Friday — that is what makes "Friday the 13th" impossible to write
  // and "1st or Monday" easy.
  if (c.domRestricted && c.dowRestricted) return domHit || dowHit
  if (c.domRestricted) return domHit
  if (c.dowRestricted) return dowHit
  return true
}

export type Schedule = {
  id: string
  name: string
  cron: string
  kind: JobKind
  payload: unknown
  enabled: 0 | 1
  lastRunAt: number | null
  lastJobId: string | null
}

const hydrate = (r: any): Schedule => ({
  id: r.id, name: r.name, cron: r.cron, kind: r.kind,
  payload: JSON.parse(r.payload || '{}'),
  enabled: r.enabled, lastRunAt: r.lastRunAt, lastJobId: r.lastJobId,
})

export function listSchedules(db: DB): Schedule[] {
  return (db.prepare(`SELECT * FROM schedules ORDER BY name`).all() as any[]).map(hydrate)
}

export function getSchedule(db: DB, id: string): Schedule | null {
  const r = db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as any
  return r ? hydrate(r) : null
}

/**
 * Fires every schedule due at `now`, and returns what it started.
 *
 * A schedule that already ran this minute is skipped: the ticker can fire more
 * than once inside the same minute (a slow tick, a clock nudged by NTP), and a
 * nightly sync must not start twice because of it.
 *
 * Missed minutes are not caught up. A machine asleep from 02:00 to 09:00 wakes
 * to seven hours of "due" jobs under any catch-up scheme, and running them all
 * at once is worse than skipping them — the next occurrence is minutes or hours
 * away, and that is the one the user wants.
 */
export function runDue(db: DB, jobs: JobQueue, now: Date): string[] {
  const started: string[] = []
  const minute = Math.floor(now.getTime() / 60000)

  for (const s of listSchedules(db)) {
    if (!s.enabled) continue
    const cron = parseCron(s.cron)
    if (!cron) continue
    if (!matches(cron, now)) continue
    if (s.lastRunAt !== null && Math.floor(s.lastRunAt / 60000) === minute) continue

    // The idempotency key carries the minute, so a schedule cannot stack two
    // jobs for the same occurrence even if the queue is behind.
    const job = jobs.create(s.kind, s.payload, { idempotencyKey: `sched-${s.id}-${minute}` })
    db.prepare(`UPDATE schedules SET lastRunAt = ?, lastJobId = ? WHERE id = ?`)
      .run(now.getTime(), job.id, s.id)
    started.push(job.id)
  }
  return started
}

/**
 * The ticker.
 *
 * It wakes every 30 seconds rather than every 60 so a minute is never missed to
 * drift; `runDue` refuses to fire the same schedule twice in one minute, which
 * is what makes the extra wake-up harmless.
 */
export class Scheduler {
  #db: DB
  #jobs: JobQueue
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(db: DB, jobs: JobQueue) {
    this.#db = db
    this.#jobs = jobs
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => {
      try {
        runDue(this.#db, this.#jobs, new Date())
      } catch (err) {
        // A broken schedule must not take the ticker down with it, or every
        // other schedule stops too.
        console.error('[cron] tick failed:', err instanceof Error ? err.message : err)
      }
    }, 30_000)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }
}
