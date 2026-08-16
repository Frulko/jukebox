import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../src/db.ts'
import { JobQueue } from '../src/jobs.ts'

const settle = () => new Promise((r) => setTimeout(r, 40))

test('a job runs to completion and reports its progress', async () => {
  const db = open(':memory:')
  const q = new JobQueue(db)
  q.register('scan', async (ctx) => {
    for (let i = 1; i <= 5; i++) ctx.checkpoint(String(i), { done: i, total: 5 })
  })
  q.start()
  const job = q.create('scan', { sourceId: 's' })
  await settle()
  const done = q.get(job.id)!
  assert.equal(done.state, 'done')
  assert.equal(done.done, 5)
  assert.equal(done.cursor, null, 'the resume point is cleared once the job is done')
  q.stop()
})

test('idempotency: the same key does not create a second job', () => {
  const db = open(':memory:')
  const q = new JobQueue(db)
  q.register('sync', async () => {})
  const a = q.create('sync', { deviceId: 'd1' }, { idempotencyKey: 'sync-d1-nightly' })
  const b = q.create('sync', { deviceId: 'd1' }, { idempotencyKey: 'sync-d1-nightly' })
  assert.equal(a.id, b.id)
  assert.equal(q.list({ kind: 'sync' }).length, 1, 'a client timeout must not run the sync twice')
  q.stop()
})

test('cancelling interrupts the handler and does not mark the job done', async () => {
  const db = open(':memory:')
  const q = new JobQueue(db)
  let tours = 0
  q.register('sync', async (ctx) => {
    for (let i = 0; i < 1000; i++) {
      if (ctx.aborted()) return
      tours++
      ctx.checkpoint(String(i), { done: i })
      await new Promise((r) => setTimeout(r, 1))
    }
  })
  q.start()
  const job = q.create('sync', {})
  await new Promise((r) => setTimeout(r, 30))
  q.cancel(job.id)
  await settle()
  assert.equal(q.get(job.id)!.state, 'cancelled')
  assert.ok(tours < 1000, 'the handler stopped before the end')
  q.stop()
})

test('a resumed job restarts from its resume point, not from zero', async () => {
  const db = open(':memory:')
  const q1 = new JobQueue(db)
  q1.register('scan', async (ctx) => {
    ctx.checkpoint('file-400', { done: 400, total: 1000 })
    await new Promise((r) => setTimeout(r, 500)) // crash simulated mid-run
  })
  q1.start()
  const job = q1.create('scan', {})
  await new Promise((r) => setTimeout(r, 30))
  q1.stop()

  // Server restart: the job was `running` with no process behind it.
  const q2 = new JobQueue(db)
  const revu = q2.get(job.id)!
  assert.equal(revu.state, 'queued', 'requeued at startup')
  assert.equal(revu.cursor, 'file-400', 'the resume point survived')
  assert.equal(revu.done, 400)

  let reprisA: string | null = 'never called'
  q2.register('scan', async (ctx) => { reprisA = ctx.cursor })
  q2.start()
  await settle()
  assert.equal(reprisA, 'file-400', 'the handler resumes where it left off')
  q2.stop()
})

test('concurrency is capped per kind', async () => {
  const db = open(':memory:')
  const q = new JobQueue(db)
  let simultanes = 0
  let pic = 0
  q.register('scan', async () => {
    pic = Math.max(pic, ++simultanes)
    await new Promise((r) => setTimeout(r, 30))
    simultanes--
  })
  q.start()
  for (let i = 0; i < 5; i++) q.create('scan', { i })
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(pic, 1, 'scan is capped at 1: two scans would fight over the disk')
  q.stop()
})

test('a handler that throws marks the job failed with its reason', async () => {
  const db = open(':memory:')
  const q = new JobQueue(db)
  q.register('podcast', async () => { throw new Error('feed unreachable') })
  q.start()
  const job = q.create('podcast', {})
  await settle()
  const f = q.get(job.id)!
  assert.equal(f.state, 'failed')
  assert.match(f.error!, /feed unreachable/)
  q.stop()
})

test('idempotency dedupes in flight, not forever', async () => {
  const db = open(':memory:')
  const q = new JobQueue(db)
  q.register('scan', async () => {})
  q.start()

  const premier = q.create('scan', { sourceId: 's' }, { idempotencyKey: 'scan-s' })
  const doublon = q.create('scan', { sourceId: 's' }, { idempotencyKey: 'scan-s' })
  assert.equal(doublon.id, premier.id, 'in flight: same job')

  await new Promise((r) => setTimeout(r, 60))
  assert.equal(q.get(premier.id)!.state, 'done')

  // Without this, a source could only ever be scanned once in its lifetime.
  const relance = q.create('scan', { sourceId: 's' }, { idempotencyKey: 'scan-s' })
  assert.notEqual(relance.state, 'done', 'finished: a new run starts')
  q.stop()
})
