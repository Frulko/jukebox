import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from '../src/app.ts'
import { createClient, type EventSourceLike } from '../../../packages/client-sdk/src/index.ts'

const FIXTURES = resolve(import.meta.dirname, '../../../.fixtures')

/**
 * `client.sync()` — the five network rules used rather than described.
 *
 * Against a real port, because the thing under test is an event stream: an
 * in-process `app.fetch` transport cannot hold one open, and a mocked stream
 * would test the mock. The SDK's own `eventSource` hook is what makes a Node
 * test possible at all, and it is the same hook a server-side consumer needs.
 */

/** The little of EventSource this needs, over `fetch`. */
function nodeEventSource(url: string): EventSourceLike {
  const listeners = new Map<string, ((e: { data: string }) => void)[]>()
  const controller = new AbortController()

  void (async () => {
    try {
      const res = await fetch(url, { signal: controller.signal })
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const name = /^event: (.+)$/m.exec(frame)?.[1]
          const data = /^data: (.+)$/m.exec(frame)?.[1]
          if (name) for (const fn of listeners.get(name) ?? []) fn({ data: data ?? 'null' })
        }
      }
    } catch { /* closed by the test */ }
  })()

  return {
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    close: () => controller.abort(),
  }
}

async function harness(files = 3) {
  const root = await mkdtemp(join(tmpdir(), 'jukebox-sync-lib-'))
  for (let i = 0; i < files; i++) {
    await mkdir(join(root, `A${i}`), { recursive: true })
    await copyFile(join(FIXTURES, 'Daft Punk/Discovery/01.mp3'), join(root, `A${i}/01.mp3`))
  }

  const dir = await mkdtemp(join(tmpdir(), 'jukebox-sync-'))
  const app = createApp(join(dir, 'db.sqlite'))
  const server = serve({ fetch: app.app.fetch, port: 0 })
  const port = (server.address() as any).port
  const baseUrl = `http://127.0.0.1:${port}/api/v1`

  const api = createClient({ baseUrl, eventSource: nodeEventSource })
  const settle = async () => {
    const until = Date.now() + 30_000
    while (Date.now() < until) {
      if (!app.jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  await api.sources.create({ id: 's', name: 'S', root } as any)
  await api.sources.scan('s')
  await settle()

  return {
    api, settle, root,
    cleanup: async () => {
      app.closeOutputs()
      app.jobs.stop()
      await new Promise<void>((r) => server.close(() => r()))
      await rm(dir, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    },
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits for a condition instead of sleeping long enough and hoping. */
async function until(fn: () => boolean, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await wait(25)
  }
  return false
}

test('a fresh client catches up, then is told rather than asking', async () => {
  const h = await harness(3)
  let state: any = null
  const sync = h.api.sync({ onChange: (s) => { state = s } })
  try {
    assert.ok(await until(() => state?.tracks.size === 3), `caught up: ${state?.tracks.size}`)

    // An edit made elsewhere arrives without this client polling anything.
    const [first] = [...state.tracks.values()] as any[]
    await h.api.tracks.patch([first.id], { rating: 5 })

    assert.ok(await until(() => state.tracks.get(first.id)?.rating === 5), 'the rating never arrived')
    assert.ok(sync.revision() > 0)
  } finally { sync.close(); await h.cleanup() }
})

test('a deletion is applied, not merely skipped', async () => {
  const h = await harness(3)
  let state: any = null
  const sync = h.api.sync({ onChange: (s) => { state = s } })
  try {
    assert.ok(await until(() => state?.tracks.size === 3))
    const gone = ([...state.tracks.values()] as any[])
      .find((t) => t.path.includes('A0'))
    assert.ok(gone, 'a track to remove')

    // A file really disappears and the source is rescanned, which is the only
    // way a track leaves this library.
    await rm(join(h.root, 'A0'), { recursive: true, force: true })
    await h.api.sources.scan('s')
    await h.settle()

    // A client that merges `changed` and ignores `deleted` goes on showing
    // music that is not there any more.
    assert.ok(await until(() => !state.tracks.has(gone.id)),
      'the removed track is still in the synced copy')
    assert.equal(state.tracks.size, 2)
  } finally { sync.close(); await h.cleanup() }
})

test('catching up loops past the page cap', async () => {
  const h = await harness(5)
  let state: any = null
  // A cap smaller than the library, which is the situation a client resuming
  // after a large import is always in. Stopping after one response leaves it
  // quietly behind for ever.
  const sync = h.api.sync({ onChange: (s) => { state = s }, pageSize: 2 })
  try {
    assert.ok(await until(() => state?.tracks.size === 5),
      `only ${state?.tracks.size} of 5 arrived — the catch-up did not loop`)
  } finally { sync.close(); await h.cleanup() }
})

test('closing stops it listening', async () => {
  const h = await harness(2)
  let changes = 0
  const sync = h.api.sync({ onChange: () => { changes++ } })
  try {
    assert.ok(await until(() => changes > 0))
    sync.close()
    const after = changes

    const page = await h.api.tracks.list({ limit: 5 })
    await h.api.tracks.patch([page.items[0].id], { rating: 2 })
    await wait(600)
    assert.equal(changes, after, 'it kept syncing after being closed')
  } finally { await h.cleanup() }
})

test('the SDK says what is missing rather than throwing a global name', async () => {
  const bare = createClient({ baseUrl: 'http://127.0.0.1:1/api/v1' })
  // In a runtime without EventSource -- Node, in most versions -- the old code
  // failed with "EventSource is not defined", which reads as a bug in the SDK
  // rather than a missing global.
  assert.throws(() => bare.events({ library: () => {} }), /pass one to createClient/)
})
