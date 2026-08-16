import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-player-'))
  const app = createApp(join(dir, 'db.sqlite'))
  app.db.exec(`INSERT INTO sources (id,kind,name,root,rev) VALUES ('s','local','S','/m',1)`)
  const ins = app.db.prepare(
    `INSERT INTO tracks (id,sourceId,path,name,artist,albumArtist,album,duration,dateAdded,rev)
     VALUES (?, 's', ?, ?, 'A', 'A', 'Alb', 200, 1, 1)`)
  for (const id of ['t1', 't2', 't3']) ins.run(id, `/m/${id}.mp3`, `Track ${id}`)

  const call = async (method: string, path: string, body?: unknown, client?: string) => {
    const headers: Record<string, string> = {}
    if (body) headers['content-type'] = 'application/json'
    if (client) headers['x-jukebox-client'] = client
    const res = await app.app.fetch(new Request(`http://x/api/v1${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  return { call, cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

test('an empty player has nothing loaded and is not playing', async () => {
  const h = await harness()
  try {
    const p = (await h.call('GET', '/player')).body
    assert.deepEqual(p.queue, [])
    assert.equal(p.index, -1)
    assert.equal(p.trackId, null)
    assert.equal(p.playing, false)
    assert.equal(p.track, null)
    assert.deepEqual(p.target, { kind: 'local' })
  } finally { await h.cleanup() }
})

test('setting a queue starts it, and the metadata comes with it', async () => {
  const h = await harness()
  try {
    const p = (await h.call('PUT', '/player/queue', { trackIds: ['t1', 't2', 't3'], startAt: 1 })).body
    assert.equal(p.index, 1)
    assert.equal(p.trackId, 't2')
    assert.equal(p.playing, true)
    // A controller drawing "now playing" should not need a second request.
    assert.equal(p.track.name, 'Track t2')
    assert.equal(p.track.duration, 200)
  } finally { await h.cleanup() }
})

test('two controllers see the same queue', async () => {
  const h = await harness()
  try {
    await h.call('PUT', '/player/queue', { trackIds: ['t1', 't2'] }, 'laptop')
    // The whole point: a second client asking gets what the first one did, not
    // its own idea of what is playing.
    const fromPhone = (await h.call('GET', '/player')).body
    assert.equal(fromPhone.trackId, 't1')
    assert.equal(fromPhone.by, 'laptop', 'so a UI can say who changed it')

    await h.call('POST', '/player/pause', undefined, 'phone')
    assert.equal((await h.call('GET', '/player')).body.playing, false)
    assert.equal((await h.call('GET', '/player')).body.by, 'phone')
  } finally { await h.cleanup() }
})

test('the revision moves on every change, so a client can ignore its own echo', async () => {
  const h = await harness()
  try {
    const a = (await h.call('GET', '/player')).body.revision
    await h.call('PUT', '/player/queue', { trackIds: ['t1'] })
    const b = (await h.call('GET', '/player')).body.revision
    assert.ok(b > a)
    await h.call('POST', '/player/pause')
    assert.ok((await h.call('GET', '/player')).body.revision > b)
  } finally { await h.cleanup() }
})

test('stepping off the end stops, unless repeat says otherwise', async () => {
  const h = await harness()
  try {
    await h.call('PUT', '/player/queue', { trackIds: ['t1', 't2'], startAt: 1 })
    // "repeat: off" has to actually mean it, or a playlist loops all night.
    const stopped = (await h.call('POST', '/player/next')).body
    assert.equal(stopped.playing, false)
    assert.equal(stopped.trackId, 't2', 'and it stays where it stopped')

    await h.call('PATCH', '/player', { repeat: 'all' })
    await h.call('POST', '/player/play')
    const wrapped = (await h.call('POST', '/player/next')).body
    assert.equal(wrapped.trackId, 't1')
    assert.equal(wrapped.playing, true)
  } finally { await h.cleanup() }
})

test('going back from the first track restarts it rather than wrapping', async () => {
  const h = await harness()
  try {
    await h.call('PUT', '/player/queue', { trackIds: ['t1', 't2', 't3'] })
    await h.call('POST', '/player/seek', { position: 90 })
    const back = (await h.call('POST', '/player/previous')).body
    // What every player does, and what people expect.
    assert.equal(back.trackId, 't1')
    assert.equal(back.position, 0)
  } finally { await h.cleanup() }
})

test('play next puts tracks after the current one, not at the end', async () => {
  const h = await harness()
  try {
    await h.call('PUT', '/player/queue', { trackIds: ['t1', 't2'] })
    const p = (await h.call('POST', '/player/queue', { trackIds: ['t3'], next: true })).body
    assert.deepEqual(p.queue, ['t1', 't3', 't2'])
    assert.equal(p.trackId, 't1', 'and it does not disturb what is playing')

    const appended = (await h.call('POST', '/player/queue', { trackIds: ['t2'] })).body
    assert.deepEqual(appended.queue, ['t1', 't3', 't2', 't2'])
  } finally { await h.cleanup() }
})

test('an empty player given tracks starts, rather than sitting there', async () => {
  const h = await harness()
  try {
    const p = (await h.call('POST', '/player/queue', { trackIds: ['t1', 't2'] })).body
    assert.equal(p.trackId, 't1')
    assert.equal(p.playing, true)
  } finally { await h.cleanup() }
})

test('a renderer reports where it is without being able to reorder anything', async () => {
  const h = await harness()
  try {
    await h.call('PUT', '/player/queue', { trackIds: ['t1', 't2'] }, 'laptop')
    const reported = (await h.call('POST', '/player/report', { position: 42 }, 'speaker')).body
    assert.equal(reported.position, 42)
    assert.deepEqual(reported.queue, ['t1', 't2'], 'the queue is not a renderer\'s business')
    // A position tick is not somebody doing something, so it must not show up
    // as "changed by speaker" in a UI.
    assert.equal(reported.by, 'laptop')
  } finally { await h.cleanup() }
})

test('an unknown output is refused rather than silently ignored', async () => {
  const h = await harness()
  try {
    const res = await h.call('PATCH', '/player', { target: { kind: 'output', id: 'no-such-speaker' } })
    assert.equal(res.status, 404)
    assert.deepEqual((await h.call('GET', '/player')).body.target, { kind: 'local' })

    // Going back to local always works, because there is nothing to find.
    assert.deepEqual((await h.call('PATCH', '/player', { target: { kind: 'local' } })).body.target,
      { kind: 'local' })
  } finally { await h.cleanup() }
})

test('jumping to a track that is not queued changes nothing', async () => {
  const h = await harness()
  try {
    await h.call('PUT', '/player/queue', { trackIds: ['t1', 't2'] })
    const p = (await h.call('POST', '/player/goto', { trackId: 'not-in-the-queue' })).body
    assert.equal(p.trackId, 't1')
    assert.equal((await h.call('POST', '/player/goto', { trackId: 't2' })).body.trackId, 't2')
  } finally { await h.cleanup() }
})

test('clearing empties everything but keeps the revision moving forward', async () => {
  const h = await harness()
  try {
    await h.call('PUT', '/player/queue', { trackIds: ['t1', 't2'] })
    const before = (await h.call('GET', '/player')).body.revision
    const cleared = (await h.call('DELETE', '/player/queue')).body
    assert.deepEqual(cleared.queue, [])
    assert.equal(cleared.trackId, null)
    // A client watching revisions must not see it go backwards, or it will
    // decide the change it just received is stale.
    assert.ok(cleared.revision >= before)
  } finally { await h.cleanup() }
})
