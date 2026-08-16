import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mountFor, readMounts, type Mount } from '../src/mounts.ts'
import { createApp } from '../src/app.ts'

const FIXTURES = resolve(import.meta.dirname, '../../../.fixtures')

const MOUNTS: Mount[] = [
  { device: '/dev/disk1s1', point: '/', type: 'apfs', network: false, readOnly: false },
  { device: '/dev/disk4', point: '/Volumes/Backup', type: 'hfs', network: false, readOnly: true },
  { device: 'nas:/music', point: '/Volumes/Music', type: 'nfs', network: true, readOnly: false },
  { device: '//nas/media', point: '/Volumes/Music/deep', type: 'smbfs', network: true, readOnly: false },
]

test('a path resolves to the longest matching mount, not the first', () => {
  // `/` is a prefix of everything. Matching on the first hit reports every path
  // as being on the root filesystem, and the share underneath is never noticed.
  assert.equal(mountFor('/Volumes/Music/Air/01.flac', MOUNTS)?.type, 'nfs')
  assert.equal(mountFor('/Volumes/Music/deep/x.flac', MOUNTS)?.type, 'smbfs')
  assert.equal(mountFor('/home/me/music', MOUNTS)?.type, 'apfs')
})

test('a mountpoint is on its own mount, and a lookalike name is not', () => {
  assert.equal(mountFor('/Volumes/Music', MOUNTS)?.type, 'nfs')
  // `/Volumes/Musicians` starts with the same characters but is somewhere else
  // entirely — a prefix test without the separator gets this wrong.
  assert.equal(mountFor('/Volumes/Musicians/x', MOUNTS)?.type, 'apfs')
})

test('network filesystems are the ones that can vanish', () => {
  assert.equal(mountFor('/Volumes/Music/x', MOUNTS)?.network, true)
  // Read-only matters separately: a backup disk is present but cannot be
  // written back to, which is a different conversation from being absent.
  assert.equal(mountFor('/Volumes/Backup/x', MOUNTS)?.readOnly, true)
  assert.equal(mountFor('/Volumes/Backup/x', MOUNTS)?.network, false)
})

test('the real mount table on this machine parses', async () => {
  const mounts = await readMounts()
  assert.ok(mounts.length > 0, 'a running machine has mounts')
  // Every entry has to have the three fields the rest of this depends on, or
  // the parser silently produced rows that match nothing.
  assert.ok(mounts.every((m) => m.point.startsWith('/') && m.device && m.type))
  // And the root filesystem must be in there, since every path falls back to it.
  assert.ok(mounts.some((m) => m.point === '/'))
  assert.ok(mountFor(process.cwd(), mounts), 'this directory is on one of them')
})

/* ---- the guard ---- */

async function harness(root: string) {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-mnt-'))
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
  await call('POST', '/sources', { id: 'lib', name: 'Library', root, kind: 'local' })
  return { call, settle, cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

test('a share that is not mounted does not take the library with it', async () => {
  // The mountpoint left behind by an unmounted share: the path still resolves,
  // it is simply empty. Reproduced exactly, by emptying a directory.
  const root = await mkdtemp(join(tmpdir(), 'jukebox-share-'))
  await mkdir(join(root, 'Album'), { recursive: true })

  const { copyFile } = await import('node:fs/promises')
  await copyFile(join(FIXTURES, 'Daft Punk/Discovery/01.mp3'), join(root, 'Album/01.mp3'))
  await copyFile(join(FIXTURES, 'Daft Punk/Discovery/02.mp3'), join(root, 'Album/02.mp3'))

  const h = await harness(root)
  try {
    await h.call('POST', '/sources/lib/scan')
    await h.settle()
    assert.equal((await h.call('GET', '/tracks/count')).body.count, 2)

    // The share goes away. Everything the scanner can see is identical to a
    // library somebody deleted.
    await rm(join(root, 'Album'), { recursive: true, force: true })

    await h.call('POST', '/sources/lib/scan')
    await h.settle()

    // Still there. This is the assertion the whole file exists for.
    assert.equal((await h.call('GET', '/tracks/count')).body.count, 2)

    const job = (await h.call('GET', '/jobs')).body.items
      .filter((j: any) => j.kind === 'scan').at(0)
    assert.equal(job.state, 'failed')
    // And it says what to do about it, rather than failing mysteriously.
    assert.match(job.error, /Nothing was removed.*prune=true/s)
  } finally { await h.cleanup(); await rm(root, { recursive: true, force: true }) }
})

test('prune=true means it, for the library that really was deleted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jukebox-share-'))
  await mkdir(join(root, 'Album'), { recursive: true })
  const { copyFile } = await import('node:fs/promises')
  await copyFile(join(FIXTURES, 'Daft Punk/Discovery/01.mp3'), join(root, 'Album/01.mp3'))

  const h = await harness(root)
  try {
    await h.call('POST', '/sources/lib/scan')
    await h.settle()
    assert.equal((await h.call('GET', '/tracks/count')).body.count, 1)

    await rm(join(root, 'Album'), { recursive: true, force: true })
    await h.call('POST', '/sources/lib/scan?prune=true')
    await h.settle()

    // Soft deleted, as always: the row still carries the rating and the play
    // count, and rescanning with the files back brings it home.
    assert.equal((await h.call('GET', '/tracks/count')).body.count, 0)
  } finally { await h.cleanup(); await rm(root, { recursive: true, force: true }) }
})

test('a source that legitimately loses one file still sweeps it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jukebox-share-'))
  await mkdir(join(root, 'Album'), { recursive: true })
  const { copyFile } = await import('node:fs/promises')
  await copyFile(join(FIXTURES, 'Daft Punk/Discovery/01.mp3'), join(root, 'Album/01.mp3'))
  await copyFile(join(FIXTURES, 'Daft Punk/Discovery/02.mp3'), join(root, 'Album/02.mp3'))

  const h = await harness(root)
  try {
    await h.call('POST', '/sources/lib/scan')
    await h.settle()

    // One file gone, the rest present: an ordinary deletion, and the guard must
    // not turn into a reason never to sweep anything.
    await rm(join(root, 'Album/02.mp3'), { force: true })
    await h.call('POST', '/sources/lib/scan')
    await h.settle()

    assert.equal((await h.call('GET', '/tracks/count')).body.count, 1)
  } finally { await h.cleanup(); await rm(root, { recursive: true, force: true }) }
})

test('a source lists the filesystem it is on', async () => {
  const h = await harness(FIXTURES)
  try {
    const source = (await h.call('GET', '/sources')).body.items.find((s: any) => s.id === 'lib')
    assert.ok(source.mount, 'a local source knows what it sits on')
    assert.ok(source.mount.point.startsWith('/'))
    assert.equal(typeof source.mount.network, 'boolean')
  } finally { await h.cleanup() }
})

test('an empty source that never had anything is not an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jukebox-empty-'))
  await writeFile(join(root, 'readme.txt'), 'no music here')
  const h = await harness(root)
  try {
    await h.call('POST', '/sources/lib/scan')
    await h.settle()
    // Nothing to lose, so nothing to protect. A new source pointed somewhere
    // wrong should say "0 tracks", not fail.
    const job = (await h.call('GET', '/jobs')).body.items.find((j: any) => j.kind === 'scan')
    assert.equal(job.state, 'done')
  } finally { await h.cleanup(); await rm(root, { recursive: true, force: true }) }
})
