import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../src/app.ts'

const FIXTURES = resolve(import.meta.dirname, '../../../.fixtures')

/**
 * The revision delta, which is the second of the five network rules.
 *
 * The rule is not "a revision exists". It is that **anything a client can see
 * in a page must be reachable through the delta** — because a client that syncs
 * this way never fetches the page again. If a change is invisible here, it is
 * invisible for ever, and the client does not even know to ask: it receives a
 * higher revision with an empty list and concludes it is up to date.
 *
 * That is exactly what device presence did.
 */

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'jukebox-delta-lib-'))
  await mkdir(join(root, 'A'), { recursive: true })
  await copyFile(join(FIXTURES, 'Daft Punk/Discovery/01.mp3'), join(root, 'A/01.mp3'))
  await copyFile(join(FIXTURES, 'Daft Punk/Discovery/02.mp3'), join(root, 'A/02.mp3'))

  const dir = await mkdtemp(join(tmpdir(), 'jukebox-delta-'))
  const app = createApp(join(dir, 'db.sqlite'))
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.app.fetch(new Request(`http://x/api/v1${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  const settle = async () => {
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      if (!app.jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  await call('POST', '/sources', { id: 's', name: 'S', root })
  await call('POST', '/sources/s/scan')
  await settle()

  // Statements executed, counted by wrapping prepare(). The only way to ask
  // "is this one round trip" without guessing from a stopwatch.
  let statements = 0
  const realPrepare = app.db.prepare.bind(app.db)
  ;(app.db as any).prepare = (sql: string) => {
    const stmt = realPrepare(sql)
    for (const m of ['all', 'get', 'run'] as const) {
      const fn = (stmt as any)[m].bind(stmt)
      ;(stmt as any)[m] = (...args: unknown[]) => { statements++; return fn(...args) }
    }
    return stmt
  }

  return {
    call,
    statements: () => statements,
    cleanup: async () => {
      app.jobs.stop()
      await rm(dir, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('a track arriving on a device reaches the delta', async () => {
  const h = await harness()
  try {
    const t = (await h.call('GET', '/tracks?limit=5')).body.items[0]
    await h.call('POST', '/devices', { id: 'ipod', name: 'iPod', kind: 'ipod-classic' })
    const { revision } = (await h.call('GET', '/tracks/delta?since=0')).body

    await h.call('PUT', '/devices/ipod/tracks', {
      items: [{ deviceLocalId: 'F00', name: t.name, artist: t.artist, duration: t.duration, size: t.size }],
    })

    // The page changed, so the delta must say so. `devices` travels with the
    // track, which makes this a change to the track as far as a client is
    // concerned.
    const page = (await h.call('GET', '/tracks?limit=5')).body.items.find((x: any) => x.id === t.id)
    assert.deepEqual(page.devices, ['ipod'])

    const delta = (await h.call('GET', `/tracks/delta?since=${revision}`)).body
    const seen = delta.changed.find((x: any) => x.id === t.id)
    assert.ok(seen, 'the track that moved is in the delta')
    assert.deepEqual(seen.devices, ['ipod'], 'and carries its new presence')
  } finally { await h.cleanup() }
})

test('a track leaving a device reaches it too', async () => {
  const h = await harness()
  try {
    const t = (await h.call('GET', '/tracks?limit=5')).body.items[0]
    await h.call('POST', '/devices', { id: 'ipod', name: 'iPod', kind: 'ipod-classic' })
    await h.call('PUT', '/devices/ipod/tracks', {
      items: [{ deviceLocalId: 'F00', name: t.name, artist: t.artist, duration: t.duration, size: t.size }],
    })

    const { revision } = (await h.call('GET', '/tracks/delta?since=0')).body
    // Deleted from the iPod: the device now reports an empty library.
    await h.call('PUT', '/devices/ipod/tracks', { items: [] })

    const delta = (await h.call('GET', `/tracks/delta?since=${revision}`)).body
    const seen = delta.changed.find((x: any) => x.id === t.id)
    assert.ok(seen, 'leaving is a change too')
    assert.deepEqual(seen.devices, [])
  } finally { await h.cleanup() }
})

test('a resync that changed nothing pushes nothing', async () => {
  const h = await harness()
  try {
    const t = (await h.call('GET', '/tracks?limit=5')).body.items[0]
    await h.call('POST', '/devices', { id: 'ipod', name: 'iPod', kind: 'ipod-classic' })
    const items = [{ deviceLocalId: 'F00', name: t.name, artist: t.artist, duration: t.duration, size: t.size }]
    await h.call('PUT', '/devices/ipod/tracks', { items })

    const { revision } = (await h.call('GET', '/tracks/delta?since=0')).body

    // A satellite re-reporting the same contents on every heartbeat must not
    // push a delta of the whole device to every client, for ever.
    await h.call('PUT', '/devices/ipod/tracks', { items })
    await h.call('PUT', '/devices/ipod/tracks', { items })

    const delta = (await h.call('GET', `/tracks/delta?since=${revision}`)).body
    assert.deepEqual(delta.changed, [])
    assert.equal(delta.revision, revision, 'and the revision did not move either')
  } finally { await h.cleanup() }
})

test('the ordinary edits are all reachable through the delta', async () => {
  const h = await harness()
  try {
    const t = (await h.call('GET', '/tracks?limit=5')).body.items[0]

    for (const [label, mutate] of [
      ['a rating', () => h.call('PATCH', '/tracks', { ids: [t.id], patch: { rating: 4 } })],
      ['a tag', () => h.call('POST', '/tracks/tags', { ids: [t.id], add: ['workout'] })],
      ['a play', () => h.call('POST', `/tracks/${t.id}/play`, { played: 200 })],
    ] as const) {
      const { revision } = (await h.call('GET', '/tracks/delta?since=0')).body
      await mutate()
      const delta = (await h.call('GET', `/tracks/delta?since=${revision}`)).body
      assert.ok(delta.changed.some((x: any) => x.id === t.id), `${label} is invisible to a syncing client`)
    }
  } finally { await h.cleanup() }
})

test('a client that follows the delta ends up with what the page says', async () => {
  const h = await harness()
  try {
    // The property the whole rule exists for, checked end to end: replay every
    // delta from zero and the result must equal the page. Anything that changes
    // a page without stamping a track breaks this, whatever the mechanism.
    await h.call('POST', '/devices', { id: 'ipod', name: 'iPod', kind: 'ipod-classic' })
    const first = (await h.call('GET', '/tracks?limit=50')).body.items
    await h.call('PATCH', '/tracks', { ids: [first[0].id], patch: { rating: 5 } })
    await h.call('PUT', '/devices/ipod/tracks', {
      items: [{ deviceLocalId: 'F00', name: first[1].name, artist: first[1].artist, duration: first[1].duration, size: first[1].size }],
    })

    const held = new Map<string, any>()
    const delta = (await h.call('GET', '/tracks/delta?since=0')).body
    for (const t of delta.changed) held.set(t.id, t)
    for (const id of delta.deleted) held.delete(id)

    const page = (await h.call('GET', '/tracks?limit=50')).body.items
    assert.equal(held.size, page.length)
    for (const t of page) {
      const mine = held.get(t.id)
      assert.ok(mine, `${t.name} never arrived`)
      assert.equal(mine.rating, t.rating, t.name)
      assert.deepEqual(mine.devices, t.devices, `${t.name}: presence disagrees`)
    }
  } finally { await h.cleanup() }
})

test('a page costs the same number of queries however large it is', async () => {
  const h = await harness()
  try {
    // The fourth rule: one round trip per page. Presence, renditions and tags
    // travel with the rows, so a 300-row page must not become 301 queries --
    // the shape of every slow listing endpoint ever written.
    const counts: number[] = []
    for (const limit of [1, 2, 50]) {
      const before = h.statements()
      await h.call('GET', `/tracks?limit=${limit}`)
      counts.push(h.statements() - before)
    }
    assert.equal(new Set(counts).size, 1,
      `query count grew with the page: ${counts.join(', ')}`)
  } finally { await h.cleanup() }
})
