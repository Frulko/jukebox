import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { HOST_API_VERSION, readManifest, satisfies } from '../src/plugins.ts'

test('a caret range accepts what it should and refuses what it should not', () => {
  assert.ok(satisfies('1.0.0', '^1.0.0'))
  assert.ok(satisfies('1.4.2', '^1.0.0'))
  assert.ok(!satisfies('2.0.0', '^1.0.0'), 'a major bump is why the field exists')
  assert.ok(!satisfies('1.0.0', '^1.2.0'), 'a plugin needing a newer host is refused')
  assert.ok(satisfies('1.2.3', '1.2.3'))
  assert.ok(!satisfies('1.2.4', '1.2.3'), 'an exact range is exact')
  assert.ok(satisfies('9.9.9', '*'))

  // Below 1.0.0 the minor is the breaking position. This is the rule people get
  // wrong when they hand-roll it, and it means a plugin written against 0.3
  // refuses to load on 0.4 rather than half-working.
  assert.ok(satisfies('0.3.9', '^0.3.0'))
  assert.ok(!satisfies('0.4.0', '^0.3.0'))
  assert.ok(!satisfies('nonsense', '^1.0.0'))
})

test('a manifest is checked before anything is imported', () => {
  const ok = { id: 'lastfm', name: 'Last.fm', version: '1.0.0', hostApi: `^${HOST_API_VERSION}`, main: 'index.js' }
  assert.ok('manifest' in readManifest(ok))

  assert.match((readManifest({ ...ok, id: undefined }) as any).error, /missing id/)
  assert.match((readManifest({ ...ok, id: 'Last FM!' }) as any).error, /lowercase/)
  // `main` becomes a path join; a plugin must not be able to point it anywhere.
  assert.match((readManifest({ ...ok, main: '../../etc/passwd' }) as any).error, /inside the plugin folder/)
  assert.match((readManifest({ ...ok, hostApi: '^99.0.0' }) as any).error, /needs host API/)
})

/* ---- against plugins on disk ---- */

async function harness(plugins: Record<string, { manifest?: unknown; code?: string }> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-pl-'))
  const pluginRoot = join(dir, 'plugins')
  await mkdir(pluginRoot, { recursive: true })

  for (const [id, p] of Object.entries(plugins)) {
    await mkdir(join(pluginRoot, id), { recursive: true })
    if (p.manifest !== undefined) {
      await writeFile(join(pluginRoot, id, 'plugin.json'), JSON.stringify(p.manifest))
    }
    if (p.code !== undefined) await writeFile(join(pluginRoot, id, 'index.mjs'), p.code)
  }

  process.env.JUKEBOX_PLUGINS = pluginRoot
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
  return {
    call, host: app.plugins, db: app.db,
    cleanup: () => { app.jobs.stop(); delete process.env.JUKEBOX_PLUGINS; return rm(dir, { recursive: true, force: true }) },
  }
}

const manifest = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, version: '1.0.0', hostApi: `^${HOST_API_VERSION}`, main: 'index.mjs', ...over,
})

test('a plugin is discovered, activated, and can be turned off again', async () => {
  const h = await harness({
    greeter: {
      manifest: manifest('greeter', { description: 'says hello', permissions: ['network'] }),
      code: `
        export function activate(host) { globalThis.__greeted = host.pluginId }
        export function deactivate() { globalThis.__greeted = null }
      `,
    },
  })
  try {
    await h.host.discover()
    await h.host.activateAll()

    const p = (await h.call('GET', '/plugins/greeter')).body
    assert.equal(p.state, 'active')
    assert.equal(p.description, 'says hello')
    assert.deepEqual(p.permissions, ['network'])
    assert.equal((globalThis as any).__greeted, 'greeter', 'activate really ran')

    const off = (await h.call('PATCH', '/plugins/greeter', { enabled: false })).body
    assert.equal(off.enabled, 0)
    assert.equal(off.state, 'disabled')
    assert.equal((globalThis as any).__greeted, null, 'deactivate really ran')
  } finally {
    delete (globalThis as any).__greeted
    await h.cleanup()
  }
})

test('a plugin that throws is recorded, and the others still run', async () => {
  const h = await harness({
    broken: { manifest: manifest('broken'), code: `throw new Error('I am broken')` },
    'throws-on-activate': {
      manifest: manifest('throws-on-activate'),
      code: `export function activate() { throw new Error('no thanks') }`,
    },
    fine: { manifest: manifest('fine'), code: `export function activate() { globalThis.__fine = true }` },
  })
  try {
    await h.host.discover()
    await h.host.activateAll()

    const byId = Object.fromEntries((await h.call('GET', '/plugins')).body.items.map((p: any) => [p.id, p]))
    assert.equal(byId.broken.state, 'failed')
    assert.match(byId.broken.error, /I am broken/)
    assert.equal(byId['throws-on-activate'].state, 'failed')
    assert.match(byId['throws-on-activate'].error, /no thanks/)
    // The point: one bad plugin is not an outage.
    assert.equal(byId.fine.state, 'active')
    assert.equal((globalThis as any).__fine, true)
  } finally {
    delete (globalThis as any).__fine
    await h.cleanup()
  }
})

test('a folder that is not a plugin is listed with the reason, not silently dropped', async () => {
  const h = await harness({
    'no-manifest': { code: `export function activate() {}` },
    'bad-json': { manifest: undefined },
    'wrong-host': { manifest: manifest('wrong-host', { hostApi: '^99.0.0' }), code: 'export function activate() {}' },
  })
  try {
    await writeFile(join(h.host.root, 'bad-json', 'plugin.json'), '{ not json')
    const items = (await h.call('POST', '/plugins/scan')).body.items
    const byId = Object.fromEntries(items.map((p: any) => [p.id, p]))

    // Vanishing would leave the user guessing why their install did nothing.
    assert.match(byId['no-manifest'].error, /plugin.json/)
    assert.match(byId['bad-json'].error, /plugin.json/)
    assert.match(byId['wrong-host'].error, /needs host API/)
  } finally { await h.cleanup() }
})

test('a plugin keeps its settings and its enabled choice across a rescan', async () => {
  const h = await harness({
    keeper: { manifest: manifest('keeper'), code: `export function activate() {}` },
  })
  try {
    await h.host.discover()
    await h.call('PATCH', '/plugins/keeper', { config: { apiKey: 'secret' } })
    await h.call('PATCH', '/plugins/keeper', { enabled: false })

    // A rescan re-reads the manifest; it must not reset what the user chose.
    await h.host.discover()
    const p = (await h.call('GET', '/plugins/keeper')).body
    assert.equal(p.enabled, 0, 'a disabled plugin does not switch itself back on')
    assert.deepEqual(p.config, { apiKey: 'secret' })
  } finally { await h.cleanup() }
})

test('a plugin gets its config and can register a namespaced job', async () => {
  const h = await harness({
    worker: {
      manifest: manifest('worker'),
      code: `
        export function activate(host) {
          globalThis.__seen = { id: host.pluginId, api: host.apiVersion, config: host.config }
          host.registerJob('refresh', async () => {})
        }
      `,
    },
  })
  try {
    await h.host.discover()
    h.db.prepare(`UPDATE plugins SET config = '{"token":"abc"}' WHERE id = 'worker'`).run()
    await h.host.activate('worker')

    const seen = (globalThis as any).__seen
    assert.equal(seen.id, 'worker')
    assert.equal(seen.api, HOST_API_VERSION)
    assert.deepEqual(seen.config, { token: 'abc' })
  } finally {
    delete (globalThis as any).__seen
    await h.cleanup()
  }
})

/* ---- what happens to a plugin's sockets and timers when it stops ---- */

test('turning a plugin off closes what it opened', async () => {
  const { createServer } = await import('node:net')
  const echo = createServer((s) => s.on('data', (d) => s.write(d)))
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
  const port = (echo.address() as any).port

  const h = await harness({
    chatty: {
      manifest: manifest('chatty'),
      code: `
        export function activate(host) {
          globalThis.__ticks = 0
          host.net.setInterval(() => { globalThis.__ticks++ }, 5)
          globalThis.__sock = host.net.tcp({ host: '127.0.0.1', port: ${port} })
        }
      `,
    },
  })
  try {
    await h.host.discover()
    await h.host.activate('chatty')
    await new Promise((r) => setTimeout(r, 60))

    const held = h.host.resourcesOf('chatty')!
    assert.equal(held.timers, 1)
    assert.equal(held.sockets, 1)
    const ticked = (globalThis as any).__ticks
    assert.ok(ticked > 0, 'the timer really was running')

    await h.host.setEnabled('chatty', false)
    await new Promise((r) => setTimeout(r, 60))

    // The leak this exists to prevent: a disabled plugin still polling, and
    // still holding a connection, until the process restarts.
    assert.equal((globalThis as any).__ticks, ticked, 'the timer stopped with the plugin')
    assert.equal((globalThis as any).__sock.destroyed, true, 'the socket was closed')
    assert.equal(h.host.resourcesOf('chatty'), null)
  } finally {
    delete (globalThis as any).__ticks
    delete (globalThis as any).__sock
    echo.close()
    await h.cleanup()
  }
})

test('a plugin that opens something and then throws still lets go of it', async () => {
  const h = await harness({
    leaky: {
      manifest: manifest('leaky'),
      code: `
        export function activate(host) {
          globalThis.__leaked = host.net.setInterval(() => { globalThis.__leaks = (globalThis.__leaks ?? 0) + 1 }, 5)
          throw new Error('half way through')
        }
      `,
    },
  })
  try {
    await h.host.discover()
    const p = await h.host.activate('leaky')
    assert.equal(p!.state, 'failed')

    const before = (globalThis as any).__leaks ?? 0
    await new Promise((r) => setTimeout(r, 60))
    // Without the cleanup on the failure path, a plugin that throws on every
    // restart leaves another timer running each time.
    assert.equal((globalThis as any).__leaks ?? 0, before)
  } finally {
    delete (globalThis as any).__leaks
    delete (globalThis as any).__leaked
    await h.cleanup()
  }
})

test('requests in flight are cancelled when the plugin stops', async () => {
  const { createServer } = await import('node:http')
  // A server that accepts and never answers, which is what a hung request is.
  const slow = createServer(() => {})
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r))
  const port = (slow.address() as any).port

  const h = await harness({
    waiter: {
      manifest: manifest('waiter'),
      code: `
        export function activate(host) {
          globalThis.__result = 'pending'
          host.net.fetch('http://127.0.0.1:${port}/')
            .then(() => { globalThis.__result = 'answered' })
            .catch((e) => { globalThis.__result = 'aborted: ' + e.name })
        }
      `,
    },
  })
  try {
    await h.host.discover()
    await h.host.activate('waiter')
    await new Promise((r) => setTimeout(r, 40))
    assert.equal((globalThis as any).__result, 'pending')

    await h.host.setEnabled('waiter', false)
    await new Promise((r) => setTimeout(r, 60))
    assert.match((globalThis as any).__result, /aborted/, 'the request did not outlive the plugin')
  } finally {
    delete (globalThis as any).__result
    slow.close()
    await h.cleanup()
  }
})
