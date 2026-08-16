import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { about, fileUrl, list, open, RcloneError, version, walk, type RcloneConfig } from '../src/rclone.ts'

/**
 * Driven against a real `rclone rcd`, not a fake.
 *
 * A hand-written stub would encode what I believe rclone's API looks like, and
 * the whole risk of this module is that belief being wrong — the bracket syntax
 * of `--rc-serve`, whether Range actually works through it, what a missing path
 * answers. A stub would agree with every one of my mistakes.
 */

let rcd: ChildProcess | null = null
let root = ''
let cfg: RcloneConfig
const PORT = 15573

const haveRclone = (() => {
  try {
    execFileSync('rclone', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const skip = haveRclone ? false : 'rclone is not installed'

before(async () => {
  if (!haveRclone) return
  root = await mkdtemp(join(tmpdir(), 'jukebox-rc-'))
  await mkdir(join(root, 'Artist', 'Album'), { recursive: true })
  await writeFile(join(root, 'Artist', 'Album', 'track.mp3'), Buffer.alloc(4096, 7))
  await writeFile(join(root, 'Artist', 'Album', 'Symphony #5.mp3'), Buffer.alloc(2048, 9))
  await writeFile(join(root, 'top.mp3'), Buffer.alloc(1024, 3))

  rcd = spawn('rclone', [
    'rcd', '--rc-no-auth', '--rc-serve', '--rc-addr', `127.0.0.1:${PORT}`,
  ], { stdio: 'ignore' })

  cfg = { url: `http://127.0.0.1:${PORT}`, fs: root }
  // Wait for the daemon rather than sleeping a fixed amount.
  for (let i = 0; i < 60; i++) {
    try {
      await version(cfg)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error('rclone rcd did not come up')
})

after(async () => {
  rcd?.kill()
  if (root) await rm(root, { recursive: true, force: true })
})

test('the daemon answers who it is', { skip }, async () => {
  const v = await version(cfg)
  assert.match(v.version, /^v\d/)
})

test('a directory lists its children, files and folders alike', { skip }, async () => {
  const top = await list(cfg, '')
  const byName = Object.fromEntries(top.map((e) => [e.name, e]))
  assert.equal(byName.Artist.isDir, true)
  assert.equal(byName['top.mp3'].isDir, false)
  assert.equal(byName['top.mp3'].size, 1024)
  assert.ok(byName['top.mp3'].modTime > 0, 'a usable mtime, not a string')
})

test('walking yields every file and no directory', { skip }, async () => {
  const found: string[] = []
  for await (const e of walk(cfg)) found.push(e.path)
  assert.deepEqual(found.sort(), [
    'Artist/Album/Symphony #5.mp3',
    'Artist/Album/track.mp3',
    'top.mp3',
  ])
})

test('a file is served whole, and by range', { skip }, async () => {
  const whole = await open(cfg, 'Artist/Album/track.mp3')
  assert.equal(whole.status, 200)
  assert.equal(Number(whole.headers.get('content-length')), 4096)
  await whole.body?.cancel()

  // This is the claim the streaming endpoint rests on: a range request against
  // a remote costs the range, not the file.
  const part = await open(cfg, 'Artist/Album/track.mp3', { start: 10, end: 109 })
  assert.equal(part.status, 206)
  const bytes = new Uint8Array(await part.arrayBuffer())
  assert.equal(bytes.length, 100)
  assert.ok(bytes.every((b) => b === 7))
})

test('a name with a hash survives the URL', { skip }, async () => {
  // Unencoded, everything after the `#` is a fragment and the request asks for
  // "Symphony " instead.
  const res = await open(cfg, 'Artist/Album/Symphony #5.mp3')
  assert.equal(Number(res.headers.get('content-length')), 2048)
  await res.body?.cancel()
})

test('the bracket syntax is left alone while the path is encoded', { skip }, () => {
  const url = fileUrl({ url: 'http://h:1', fs: 'gdrive:Music' }, 'A B/c#d.mp3')
  assert.equal(url, 'http://h:1/[gdrive:Music]/A%20B/c%23d.mp3')
})

test('a missing file is an error carrying its status', { skip }, async () => {
  await assert.rejects(() => open(cfg, 'nope/missing.mp3'), (err: any) => {
    assert.ok(err instanceof RcloneError)
    assert.equal(err.status, 404)
    return true
  })
})

test('free space is reported, or honestly absent', { skip }, async () => {
  const a = await about(cfg)
  // A local remote knows; S3 does not, and null is the right answer there.
  assert.ok(a === null || a.total > 0)
})

test('a daemon that is not running says so, and does not look like a broken remote', async () => {
  const dead = { url: 'http://127.0.0.1:1', fs: 'whatever:' }
  await assert.rejects(() => version(dead), (err: any) => {
    assert.equal(err.status, 503)
    assert.match(err.message, /cannot reach rclone/)
    return true
  })
})

/* ---- the scanner, against a real remote ---- */

test('an rclone source is scanned like any other', { skip }, async () => {
  const { createApp } = await import('../src/app.ts')
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-rcscan-'))
  const { app, jobs, db } = createApp(join(dir, 'db.sqlite'))
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(new Request(`http://x/api/v1${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  try {
    // `root` is the remote; here a local path, which is what rclone calls a
    // local remote. Swapping in `gdrive:Music` changes nothing on this side.
    db.prepare(`INSERT INTO sources (id, kind, name, root, config, writable, rev)
                VALUES ('rc', 'rclone', 'Remote', ?, ?, 0, 1)`)
      .run(root, JSON.stringify({ url: `http://127.0.0.1:${PORT}` }))

    await call('POST', '/sources/rc/scan')
    const until = Date.now() + 8000
    while (Date.now() < until) {
      const busy = jobs.list({}).filter((j: any) => j.state === 'queued' || j.state === 'running')
      if (!busy.length) break
      await new Promise((r) => setTimeout(r, 25))
    }

    const items = (await call('GET', '/tracks?limit=50')).body.items
    const paths = items.map((t: any) => t.path).sort()
    assert.deepEqual(paths, ['Artist/Album/Symphony #5.mp3', 'Artist/Album/track.mp3', 'top.mp3'],
      'every file on the remote reached the library')
    // The size comes from the listing, not from a local stat that cannot exist.
    assert.equal(items.find((t: any) => t.path === 'top.mp3').size, 1024)

    // And it plays: the range goes to rclone and the bytes come back, without
    // anything ever landing on local disk.
    const track = items.find((t: any) => t.path === 'Artist/Album/track.mp3')
    const raw = (method: string, path: string, headers: Record<string, string> = {}) =>
      app.fetch(new Request(`http://x/api/v1${path}`, { method, headers }))

    const whole = await raw('GET', `/stream/${track.id}`)
    assert.equal(whole.status, 200)
    assert.equal(Number(whole.headers.get('content-length')), 4096)
    await whole.body?.cancel()

    const part = await raw('GET', `/stream/${track.id}`, { range: 'bytes=10-109' })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), 'bytes 10-109/4096')
    const bytes = new Uint8Array(await part.arrayBuffer())
    assert.equal(bytes.length, 100)
    assert.ok(bytes.every((b) => b === 7), 'the right bytes, not the first hundred')

    // An open-ended range must stay open-ended rather than become a huge number.
    const tail = await raw('GET', `/stream/${track.id}`, { range: 'bytes=4000-' })
    assert.equal(tail.status, 206)
    assert.equal(Number(tail.headers.get('content-length')), 96)
    await tail.body?.cancel()
  } finally {
    jobs.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
