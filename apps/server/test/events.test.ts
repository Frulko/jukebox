import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'

/**
 * The event stream is what makes "shared" mean anything. A second controller
 * that has to poll to notice a pause is not sharing a queue, it is guessing at
 * one — and polling is the single thing this API set out not to make anyone do.
 */
async function listen(app: any, ms = 700): Promise<{ event: string; data: any }[]> {
  const ctrl = new AbortController()
  const res = await app.fetch(new Request('http://x/api/v1/events', { signal: ctrl.signal }))
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const events: { event: string; data: any }[] = []

  const read = (async () => {
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (const block of buffer.split('\n\n')) {
        const name = /^event: (.+)$/m.exec(block)?.[1]
        const data = /^data: (.+)$/m.exec(block)?.[1]
        if (name && data && !events.some((e) => e.event === name && JSON.stringify(e.data) === data)) {
          events.push({ event: name, data: JSON.parse(data) })
        }
      }
    }
  })().catch(() => {})

  return { events, stop: async () => { ctrl.abort(); await read; return events } } as never
}

test('a client is told the current state on connect, not only what happens next', async () => {
  const { app, jobs, db } = createApp(':memory:')
  try {
    db.exec(`INSERT INTO sources (id,kind,name,root,rev) VALUES ('s','local','S','/m',1)`)
    db.exec(`INSERT INTO tracks (id,sourceId,path,name,dateAdded,rev) VALUES ('t1','s','/a.mp3','Dreams',1,1)`)
    await app.fetch(new Request('http://x/api/v1/player/queue', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackIds: ['t1'] }),
    }))

    const stream = (await listen(app)) as any
    await new Promise((r) => setTimeout(r, 150))
    const events = await stream.stop()

    const hello = events.find((e: any) => e.event === 'hello')
    assert.ok(hello, 'a stream that says nothing until something happens is useless mid-song')
    // Reconnecting during a paused song would otherwise show nothing, for ever.
    assert.equal(hello.data.player.trackId, 't1')
    assert.ok(typeof hello.data.revision === 'number')
  } finally { jobs.stop() }
})

test('a change made by one controller reaches another', async () => {
  const { app, jobs, db } = createApp(':memory:')
  try {
    db.exec(`INSERT INTO sources (id,kind,name,root,rev) VALUES ('s','local','S','/m',1)`)
    db.exec(`INSERT INTO tracks (id,sourceId,path,name,dateAdded,rev) VALUES ('t1','s','/a.mp3','Dreams',1,1)`)

    const stream = (await listen(app)) as any
    await new Promise((r) => setTimeout(r, 100))

    // One controller acts...
    await app.fetch(new Request('http://x/api/v1/player/queue', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-jukebox-client': 'phone' },
      body: JSON.stringify({ trackIds: ['t1'] }),
    }))
    await new Promise((r) => setTimeout(r, 150))
    const events = await stream.stop()

    const update = events.find((e: any) => e.event === 'player' && e.data.trackId === 't1')
    assert.ok(update, 'without this the queue is not shared, it is polled')
    assert.equal(update.data.by, 'phone', 'and the other client can say who did it')
  } finally { jobs.stop() }
})

test('a recorded play is announced, which is what a scrobbler hangs off', async () => {
  const { app, jobs, db } = createApp(':memory:')
  try {
    db.exec(`INSERT INTO sources (id,kind,name,root,rev) VALUES ('s','local','S','/m',1)`)
    db.exec(`INSERT INTO tracks (id,sourceId,path,name,artist,duration,dateAdded,rev)
             VALUES ('t1','s','/a.mp3','Dreams','A',300,1,1)`)

    const stream = (await listen(app)) as any
    await new Promise((r) => setTimeout(r, 100))
    await app.fetch(new Request('http://x/api/v1/tracks/t1/play', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ played: 200 }),
    }))
    await new Promise((r) => setTimeout(r, 150))
    const events = await stream.stop()

    const played = events.find((e: any) => e.event === 'play')
    assert.ok(played)
    assert.equal(played.data.trackId, 't1')
    assert.equal(played.data.track.name, 'Dreams')
  } finally { jobs.stop() }
})
