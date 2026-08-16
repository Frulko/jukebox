import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../src/app.ts'

const FIXTURES = resolve(import.meta.dirname, '../../../.fixtures')

/**
 * Server-sent events, which is the fifth network rule: **nobody polls**.
 *
 * The rule was two thirds kept. Jobs, the player and plays were pushed, but a
 * change to the library itself was not — so an edit made in another window, by
 * a Subsonic client, or by a satellite reporting what is on an iPod was
 * invisible until something asked. "Something asked" is polling.
 */

async function harness(files = 2) {
  const root = await mkdtemp(join(tmpdir(), 'jukebox-sse-lib-'))
  for (let i = 0; i < files; i++) {
    await mkdir(join(root, `A${i}`), { recursive: true })
    await copyFile(join(FIXTURES, 'Daft Punk/Discovery/01.mp3'), join(root, `A${i}/01.mp3`))
  }

  const dir = await mkdtemp(join(tmpdir(), 'jukebox-sse-'))
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
    const until = Date.now() + 30_000
    while (Date.now() < until) {
      if (!app.jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /** Opens the stream and collects events until told to stop. */
  const listen = async () => {
    const controller = new AbortController()
    const res = await app.app.fetch(
      new Request('http://x/api/v1/events', { signal: controller.signal }))
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const events: { event: string; data: any }[] = []

    void (async () => {
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const name = /^event: (.+)$/m.exec(frame)?.[1]
            const data = /^data: (.+)$/m.exec(frame)?.[1]
            if (name) events.push({ event: name, data: data ? JSON.parse(data) : null })
          }
        }
      } catch { /* aborted by the test */ }
    })()

    return { events, stop: () => controller.abort() }
  }

  await call('POST', '/sources', { id: 's', name: 'S', root })
  await call('POST', '/sources/s/scan')
  await settle()

  return {
    call, listen, settle,
    cleanup: async () => {
      app.closeOutputs()
      app.jobs.stop()
      await rm(dir, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    },
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('a connecting client is told where it stands', async () => {
  const h = await harness()
  try {
    const stream = await h.listen()
    await wait(120)
    const hello = stream.events.find((e) => e.event === 'hello')
    // Current state on connect, not just future changes: a client reconnecting
    // mid-song would otherwise show nothing until the next thing happened,
    // which on a paused player is never.
    assert.ok(hello, 'no hello')
    assert.ok(typeof hello!.data.revision === 'number')
    stream.stop()
  } finally { await h.cleanup() }
})

test('an edit in another window arrives without anyone polling', async () => {
  const h = await harness()
  try {
    const stream = await h.listen()
    await wait(120)
    const before = (await h.call('GET', '/tracks/delta?since=0')).body.revision

    const t = (await h.call('GET', '/tracks?limit=5')).body.items[0]
    await h.call('PATCH', '/tracks', { ids: [t.id], patch: { rating: 5 } })
    await wait(400)

    const library = stream.events.filter((e) => e.event === 'library')
    assert.ok(library.length > 0, 'the library changed and nothing was said')
    // It carries the revision and nothing else, because the client already
    // knows what to do with one: ask delta?since=. Sending the rows would
    // duplicate that endpoint and get it wrong differently.
    assert.ok(library.at(-1)!.data.revision > before)

    const delta = (await h.call('GET', `/tracks/delta?since=${before}`)).body
    assert.ok(delta.changed.some((x: any) => x.id === t.id))
    stream.stop()
  } finally { await h.cleanup() }
})

test('a satellite reporting an iPod reaches the other controllers too', async () => {
  const h = await harness()
  try {
    const t = (await h.call('GET', '/tracks?limit=5')).body.items[0]
    await h.call('POST', '/devices', { id: 'ipod', name: 'iPod', kind: 'ipod-classic' })

    const stream = await h.listen()
    await wait(120)
    const before = stream.events.filter((e) => e.event === 'library').length

    await h.call('PUT', '/devices/ipod/tracks', {
      items: [{ deviceLocalId: 'F00', name: t.name, artist: t.artist, duration: t.duration, size: t.size }],
    })
    await wait(400)

    assert.ok(stream.events.filter((e) => e.event === 'library').length > before,
      'presence changed and no controller was told')
    stream.stop()
  } finally { await h.cleanup() }
})

test('a big scan does not become one event per file', async () => {
  const h = await harness(30)
  try {
    const stream = await h.listen()
    await wait(120)

    // A scan stamps a revision per changed file. Uncoalesced, a first import of
    // 40,000 tracks would be 40,000 frames down every open connection.
    await h.call('POST', '/sources/s/scan?full=true')
    await h.settle()
    await wait(500)

    const library = stream.events.filter((e) => e.event === 'library')
    assert.ok(library.length > 0, 'the scan said nothing at all')
    assert.ok(library.length < 10, `${library.length} events for 30 files`)
    stream.stop()
  } finally { await h.cleanup() }
})

test('closing the stream unsubscribes it', async () => {
  const h = await harness()
  try {
    const stream = await h.listen()
    await wait(120)
    stream.stop()
    await wait(100)

    const after = stream.events.length
    const t = (await h.call('GET', '/tracks?limit=5')).body.items[0]
    await h.call('PATCH', '/tracks', { ids: [t.id], patch: { rating: 3 } })
    await wait(400)

    // A listener outliving its connection fires into a closed stream, which is
    // an error thrown from a timer nobody is holding.
    assert.equal(stream.events.length, after)
  } finally { await h.cleanup() }
})
