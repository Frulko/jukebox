import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matches, minuteKey, parseCron, runDue } from '../src/cron.ts'
import { open } from '../src/db.ts'
import { JobQueue } from '../src/jobs.ts'

const at = (s: string) => new Date(s)
const fires = (expr: string, when: string) => {
  const c = parseCron(expr)
  assert.ok(c, `${expr} should parse`)
  return matches(c, at(when))
}

test('a plain expression fires on its minute and no other', () => {
  assert.ok(fires('30 3 * * *', '2026-08-16T03:30:00'))
  assert.ok(!fires('30 3 * * *', '2026-08-16T03:31:00'))
  assert.ok(!fires('30 3 * * *', '2026-08-16T04:30:00'))
})

test('steps, ranges and lists', () => {
  assert.ok(fires('*/15 * * * *', '2026-08-16T10:45:00'))
  assert.ok(!fires('*/15 * * * *', '2026-08-16T10:46:00'))
  assert.ok(fires('0 9-17 * * *', '2026-08-16T13:00:00'))
  assert.ok(!fires('0 9-17 * * *', '2026-08-16T18:00:00'))
  assert.ok(fires('0 0,12 * * *', '2026-08-16T12:00:00'))
  assert.ok(!fires('0 0,12 * * *', '2026-08-16T06:00:00'))
  // `5/15` is "from 5 onwards, every 15" — not "5 only".
  assert.ok(fires('5/15 * * * *', '2026-08-16T10:20:00'))
  assert.ok(fires('5/15 * * * *', '2026-08-16T10:35:00'))
  assert.ok(!fires('5/15 * * * *', '2026-08-16T10:10:00'))
})

test('day-of-month and day-of-week are OR-ed when both are set', () => {
  // The rule everyone gets wrong. 2026-08-16 is a Sunday; the 13th is a Thursday.
  assert.ok(fires('0 0 13 * sun', '2026-08-16T00:00:00'), 'matches because it is a Sunday')
  assert.ok(fires('0 0 13 * sun', '2026-08-13T00:00:00'), 'matches because it is the 13th')
  // AND semantics would reject both of those and only accept a Sunday the 13th.
  assert.ok(!fires('0 0 13 * sun', '2026-08-14T00:00:00'), 'neither the 13th nor a Sunday')

  // With only one of the two restricted, it simply has to match.
  assert.ok(fires('0 0 * * mon', '2026-08-17T00:00:00'))
  assert.ok(!fires('0 0 * * mon', '2026-08-18T00:00:00'))
  assert.ok(fires('0 0 1 * *', '2026-09-01T00:00:00'))
  assert.ok(!fires('0 0 1 * *', '2026-09-02T00:00:00'))
})

test('names are accepted for months and weekdays, and Sunday is both 0 and 7', () => {
  assert.ok(fires('0 0 * aug *', '2026-08-16T00:00:00'))
  assert.ok(!fires('0 0 * jan *', '2026-08-16T00:00:00'))
  assert.ok(fires('0 0 * * 7', '2026-08-16T00:00:00'), '7 is Sunday too')
  assert.ok(fires('0 0 * * 0', '2026-08-16T00:00:00'))
})

test('a malformed expression is rejected rather than silently never firing', () => {
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *',
                     '0 0 0 * *', '0 0 * 13 *', 'abc * * * *', '*/0 * * * *', '30-10 * * * *']) {
    assert.equal(parseCron(bad), null, `${JSON.stringify(bad)} should not parse`)
  }
})

/* ---- firing ---- */

function fixture() {
  const db = open(':memory:')
  const jobs = new JobQueue(db)
  // Registered but never started: the queue must not actually run anything here.
  jobs.register('scan', async () => {})
  db.prepare(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s','local','S','/',1)`).run()
  return { db, jobs }
}

const schedule = (db: any, cron: string, enabled = 1) =>
  db.prepare(`INSERT INTO schedules (id, name, cron, kind, payload, enabled, createdAt)
              VALUES ('sc1','Nightly',?, 'scan', '{"sourceId":"s"}', ?, 1)`).run(cron, enabled)

test('a due schedule starts its job exactly once for that minute', () => {
  const { db, jobs } = fixture()
  schedule(db, '30 3 * * *')
  const now = at('2026-08-16T03:30:00')

  assert.equal(runDue(db, jobs, now).length, 1)
  // The ticker wakes twice a minute; the second pass must do nothing.
  assert.equal(runDue(db, jobs, at('2026-08-16T03:30:30')).length, 0)
  assert.equal(jobs.list({ kind: 'scan' }).length, 1)
})

test('the next occurrence fires again', () => {
  const { db, jobs } = fixture()
  schedule(db, '30 3 * * *')
  runDue(db, jobs, at('2026-08-16T03:30:00'))
  assert.equal(runDue(db, jobs, at('2026-08-17T03:30:00')).length, 1)
})

test('a disabled schedule never fires', () => {
  const { db, jobs } = fixture()
  schedule(db, '30 3 * * *', 0)
  assert.equal(runDue(db, jobs, at('2026-08-16T03:30:00')).length, 0)
})

test('missed minutes are not caught up', () => {
  const { db, jobs } = fixture()
  schedule(db, '30 3 * * *')
  // The machine was asleep at 03:30 and wakes at 09:00. Running seven hours of
  // backlog at once is worse than waiting for tomorrow.
  assert.equal(runDue(db, jobs, at('2026-08-16T09:00:00')).length, 0)
})

test('a nightly job runs once on the night the clocks go back', () => {
  // 25 Oct 2026, EU autumn change: 02:30 local happens twice, an hour of real
  // time apart. Two epoch minutes, one wall-clock minute.
  const first = new Date(Date.UTC(2026, 9, 25, 0, 30))
  const second = new Date(Date.UTC(2026, 9, 25, 1, 30))
  if (first.getHours() !== 2 || second.getHours() !== 2) {
    // Only meaningful in a zone that observes the EU change; UTC CI skips it.
    return
  }

  assert.equal(minuteKey(first), minuteKey(second), 'the same occurrence, an hour apart')
  assert.notEqual(Math.floor(+first / 60000), Math.floor(+second / 60000),
    'which is exactly why an epoch-minute marker would fire twice')

  const { db, jobs } = fixture()
  schedule(db, '30 2 * * *')
  assert.equal(runDue(db, jobs, first).length, 1)
  assert.equal(runDue(db, jobs, second).length, 0, 'the repeated hour must not re-fire it')
})

test('a job at a time that never happens simply does not run', () => {
  // 29 Mar 2026, spring forward: 02:30 does not exist. Nothing to code around —
  // no instant matches it, so nothing fires.
  const { db, jobs } = fixture()
  schedule(db, '30 2 * * *')
  const skipped = new Date(Date.UTC(2026, 2, 29, 1, 30)) // 03:30 local in Paris
  if (skipped.getHours() === 3) {
    assert.equal(runDue(db, jobs, skipped).length, 0)
  }
})

test('a broken expression is skipped without stopping the others', () => {
  const { db, jobs } = fixture()
  schedule(db, 'not a cron')
  db.prepare(`INSERT INTO schedules (id, name, cron, kind, payload, enabled, createdAt)
              VALUES ('sc2','Good','30 3 * * *','scan','{"sourceId":"s"}',1,1)`).run()
  assert.equal(runDue(db, jobs, at('2026-08-16T03:30:00')).length, 1)
})
