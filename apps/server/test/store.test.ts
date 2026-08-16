import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { HOST_API_VERSION } from '../src/plugins.ts'

/**
 * A real store: an HTTP server handing out an index and tarballs built by the
 * system `tar`. Installing is the one operation here that runs someone else's
 * code, so the tests drive the same path a real install takes.
 */

async function packPlugin(id: string, manifestOver: Record<string, unknown> = {}, code = 'export function activate() {}'): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-pack-'))
  try {
    const inner = join(dir, id)
    await mkdir(inner, { recursive: true })
    await writeFile(join(inner, 'plugin.json'), JSON.stringify({
      id, name: id, version: '1.0.0', hostApi: `^${HOST_API_VERSION}`, main: 'index.mjs', ...manifestOver,
    }))
    await writeFile(join(inner, 'index.mjs'), code)
    const out = join(dir, 'p.tgz')
    execFileSync('tar', ['-czf', out, '-C', dir, id])
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function store(tarballs: Record<string, Buffer>, entries: (base: string) => unknown[]) {
  let server: Server
  server = createServer((req, res) => {
    const name = (req.url ?? '').replace(/^\//, '')
    if (name === 'index.json') {
      const base = `http://127.0.0.1:${(server.address() as any).port}`
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ version: 1, plugins: entries(base) }))
    }
    const tar = tarballs[name]
    if (!tar) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': 'application/gzip' })
    res.end(tar)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  return { server, url: `http://127.0.0.1:${port}/index.json`, close: () => server.close() }
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-store-'))
  const pluginRoot = join(dir, 'plugins')
  await mkdir(pluginRoot, { recursive: true })
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
    call, root: pluginRoot, host: app.plugins,
    cleanup: () => {
      app.jobs.stop()
      delete process.env.JUKEBOX_PLUGINS
      return rm(dir, { recursive: true, force: true })
    },
  }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

test('a store is browsed, and what this host cannot run says why', async () => {
  const good = await packPlugin('good')
  const s = await store({ 'good.tgz': good }, (base) => [
    { id: 'good', name: 'Good', version: '1.0.0', hostApi: `^${HOST_API_VERSION}`, tarball: `${base}/good.tgz` },
    { id: 'future', name: 'Future', version: '9.0.0', hostApi: '^99.0.0', tarball: `${base}/future.tgz` },
  ])
  const h = await harness()
  try {
    const items = (await h.call('GET', `/store?index=${encodeURIComponent(s.url)}`)).body.items
    const byId = Object.fromEntries(items.map((p: any) => [p.id, p]))
    assert.equal(byId.good.installable, true)
    assert.equal(byId.future.installable, false)
    // Better said before the install than after it fails.
    assert.match(byId.future.reason, /needs host API/)

    assert.equal((await h.call('GET', '/store')).status, 400, 'there is no default index on purpose')
  } finally { s.close(); await h.cleanup() }
})

test('installing lands the plugin and starts it', async () => {
  const tar = await packPlugin('greeter', { description: 'hi' },
    'export function activate() { globalThis.__installed = true }')
  const s = await store({ 'greeter.tgz': tar }, (base) => [
    { id: 'greeter', name: 'Greeter', version: '1.0.0', hostApi: `^${HOST_API_VERSION}`,
      tarball: `${base}/greeter.tgz`, sha256: sha(tar) },
  ])
  const h = await harness()
  try {
    const res = await h.call('POST', '/store/install', { index: s.url, id: 'greeter' })
    assert.equal(res.status, 201)
    assert.equal(res.body.plugin.state, 'active')
    assert.equal((globalThis as any).__installed, true)

    // On disk, unpacked without its wrapping directory.
    assert.deepEqual((await readdir(join(h.root, 'greeter'))).sort(), ['index.mjs', 'plugin.json'])

    assert.equal((await h.call('DELETE', '/store/greeter')).status, 204)
    assert.equal((await h.call('GET', '/plugins/greeter')).status, 404)
    assert.deepEqual(await readdir(h.root), [], 'and the folder is gone')
  } finally {
    delete (globalThis as any).__installed
    s.close(); await h.cleanup()
  }
})

test('a tarball that does not match its checksum is refused', async () => {
  const tar = await packPlugin('tampered')
  const s = await store({ 'tampered.tgz': tar }, (base) => [
    { id: 'tampered', name: 'Tampered', version: '1.0.0', hostApi: `^${HOST_API_VERSION}`,
      tarball: `${base}/tampered.tgz`, sha256: 'deadbeef'.repeat(8) },
  ])
  const h = await harness()
  try {
    const res = await h.call('POST', '/store/install', { index: s.url, id: 'tampered' })
    assert.equal(res.status, 400)
    assert.match(res.body.error.message, /checksum/)
    // Nothing may reach disk when the bytes are not the published ones.
    assert.deepEqual(await readdir(h.root), [])
  } finally { s.close(); await h.cleanup() }
})

test('a plugin that calls itself something else is refused', async () => {
  // The interesting attack: an index entry everyone trusts, unpacking a plugin
  // under a different id that overwrites something else or hides in the list.
  const tar = await packPlugin('innocent', { id: 'admin-backdoor' })
  const s = await store({ 'innocent.tgz': tar }, (base) => [
    { id: 'innocent', name: 'Innocent', version: '1.0.0', hostApi: `^${HOST_API_VERSION}`,
      tarball: `${base}/innocent.tgz` },
  ])
  const h = await harness()
  try {
    const res = await h.call('POST', '/store/install', { index: s.url, id: 'innocent' })
    assert.equal(res.status, 400)
    assert.match(res.body.error.message, /calls itself/)
    assert.deepEqual(await readdir(h.root), [])
  } finally { s.close(); await h.cleanup() }
})

test('an archive with no manifest never lands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-bare-'))
  await mkdir(join(dir, 'bare'), { recursive: true })
  await writeFile(join(dir, 'bare', 'readme.txt'), 'nothing to see')
  const out = join(dir, 'p.tgz')
  execFileSync('tar', ['-czf', out, '-C', dir, 'bare'])
  const tar = await readFile(out)
  await rm(dir, { recursive: true, force: true })

  const s = await store({ 'bare.tgz': tar }, (base) => [
    { id: 'bare', name: 'Bare', version: '1.0.0', hostApi: `^${HOST_API_VERSION}`, tarball: `${base}/bare.tgz` },
  ])
  const h = await harness()
  try {
    const res = await h.call('POST', '/store/install', { index: s.url, id: 'bare' })
    assert.equal(res.status, 400)
    assert.match(res.body.error.message, /no plugin.json/)
    assert.deepEqual(await readdir(h.root), [], 'not even a staging folder is left behind')
  } finally { s.close(); await h.cleanup() }
})

test('a failed reinstall leaves the working version in place', async () => {
  const working = await packPlugin('keeper', { version: '1.0.0' },
    'export function activate() { globalThis.__v = "1.0.0" }')
  const broken = await packPlugin('keeper', { id: 'not-keeper', version: '2.0.0' })

  let serve = working
  const s = await store({ get 'keeper.tgz'() { return serve } }, (base) => [
    { id: 'keeper', name: 'Keeper', version: '1.0.0', hostApi: `^${HOST_API_VERSION}`,
      tarball: `${base}/keeper.tgz` },
  ])
  const h = await harness()
  try {
    assert.equal((await h.call('POST', '/store/install', { index: s.url, id: 'keeper' })).status, 201)
    assert.equal((globalThis as any).__v, '1.0.0')

    // The upgrade is rejected on the manifest check, after the download.
    serve = broken
    assert.equal((await h.call('POST', '/store/install', { index: s.url, id: 'keeper' })).status, 400)

    // A half-written plugin would be worse than no upgrade at all.
    const manifest = JSON.parse(await readFile(join(h.root, 'keeper', 'plugin.json'), 'utf8'))
    assert.equal(manifest.version, '1.0.0')
    assert.deepEqual(await readdir(h.root), ['keeper'], 'no staging folder survives either')
  } finally {
    delete (globalThis as any).__v
    s.close(); await h.cleanup()
  }
})

test('an index that is not one is reported, not crashed on', async () => {
  const s = await store({}, () => [])
  const h = await harness()
  try {
    const bad = `http://127.0.0.1:${(s.server.address() as any).port}/not-the-index`
    const res = await h.call('GET', `/store?index=${encodeURIComponent(bad)}`)
    assert.equal(res.status, 502)
    assert.match(res.body.error.code, /store_unreachable/)
  } finally { s.close(); await h.cleanup() }
})
