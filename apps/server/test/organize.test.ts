import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { insideRoot, renderPattern, sanitize } from '../src/organize.ts'

const FIXTURES = process.env.JUKEBOX_FIXTURES ?? ''
const skip = FIXTURES ? false : 'JUKEBOX_FIXTURES is not set'

/* ---- the parts that decide whether a disk survives ---- */

test('a tag cannot walk a rename out of the music folder', () => {
  // The whole reason this is sanitised per segment. An album tag of `../../..`
  // is not hypothetical: it is what a badly written ripper produces.
  // What matters is the property, not a pretty string: no separator and no
  // dot-run survives, so no rendered segment can ever climb a directory.
  for (const nasty of ['../../etc', '..', 'a/b', 'a\\b', '....', './..']) {
    const out = sanitize(nasty)
    assert.ok(!out.includes('/') && !out.includes('\\'), `${nasty} kept a separator`)
    assert.ok(!out.includes('..'), `${nasty} kept a dot-run`)
  }
  assert.equal(sanitize('../../etc'), 'etc')
  assert.equal(sanitize('a/b'), 'a-b')
  assert.equal(sanitize('..'), '')

  const rendered = renderPattern('{album}/{name}', { album: '../../..', name: 'x', path: 'a.mp3' })
  assert.ok('path' in rendered)
  assert.ok(!rendered.path.includes('..'))
})

test('the characters a filesystem refuses are replaced, not passed on', () => {
  assert.equal(sanitize('AC/DC'), 'AC-DC')
  assert.equal(sanitize('What? *Now*'), 'What_ _Now_')
  assert.equal(sanitize('Trailing.  '), 'Trailing')
  // Windows strips trailing dots and spaces silently, then cannot find the file
  // it just wrote.
  assert.equal(sanitize('name. '), 'name')
  assert.ok(sanitize('x'.repeat(400)).length <= 120)
})

test('the root check catches what sanitising might not', () => {
  assert.ok(insideRoot('/music', 'Artist/Album/1.mp3'))
  assert.ok(!insideRoot('/music', '../elsewhere/1.mp3'))
  assert.ok(!insideRoot('/music', '/etc/passwd'))
  assert.ok(!insideRoot('/music', ''))
})

test('a pattern fills from the track, padding what it is asked to', () => {
  const t = { albumArtist: 'Daft Punk', album: 'Discovery', trackNumber: 4, name: 'Crescendolls', path: 'x/y.mp3' }
  const r = renderPattern('{albumArtist}/{album}/{trackNumber:02} {name}', t)
  assert.deepEqual(r, { path: 'Daft Punk/Discovery/04 Crescendolls.mp3' })
  // The extension comes from the file, never from the pattern.
  assert.match((renderPattern('{name}', { name: 'a', path: 'x/y.FLAC' }) as any).path, /\.flac$/)
})

test('an empty field stops the move rather than inventing a folder', () => {
  // `Unknown Artist/Unknown Album/` is how a library gets shuffled into a heap
  // that nobody can untangle afterwards.
  const r = renderPattern('{albumArtist}/{name}', { albumArtist: '', name: 'a', path: 'x.mp3' })
  assert.ok('error' in r && /albumArtist is empty/.test(r.error))
  assert.ok('error' in renderPattern('{year}/{name}', { year: 0, name: 'a', path: 'x.mp3' }))
  assert.ok('error' in renderPattern('{nonsense}', { path: 'x.mp3' }))
})

/* ---- against real files ---- */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-org-'))
  const musicDir = join(dir, 'music')
  await cp(FIXTURES, musicDir, { recursive: true })
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
  const settle = async (ms = 6000) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const busy = jobs.list({}).filter((j: any) => j.state === 'queued' || j.state === 'running')
      if (!busy.length) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  await call('POST', '/sources', { id: 'loc', name: 'Music', root: musicDir, writable: true })
  await call('POST', '/sources/loc/scan')
  await settle()
  return { call, settle, db, jobs, musicDir, cleanup: () => { jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

const exists = (p: string) => stat(p).then(() => true, () => false)

test('planning changes nothing on disk', { skip }, async () => {
  const h = await harness()
  try {
    const before = await readdir(h.musicDir)
    const plan = (await h.call('POST', '/organize', {
      sourceId: 'loc', pattern: '{albumArtist}/{album}/{trackNumber:02} {name}',
    })).body

    assert.ok(plan.moves.length > 0)
    assert.ok(plan.moves[0].from && plan.moves[0].to)
    assert.deepEqual(await readdir(h.musicDir), before, 'a dry run is the default and it is dry')
  } finally { await h.cleanup() }
})

test('applying moves the files and the library follows', { skip }, async () => {
  const h = await harness()
  try {
    const pattern = '{albumArtist}/{album}/{trackNumber:02} {name}'
    const plan = (await h.call('POST', '/organize', { sourceId: 'loc', pattern })).body
    const first = plan.moves[0]

    const res = await h.call('POST', '/organize', { sourceId: 'loc', pattern, apply: true })
    assert.equal(res.status, 202)
    await h.settle()

    assert.ok(await exists(join(h.musicDir, first.to)), 'the file is at its new path')
    assert.ok(!(await exists(join(h.musicDir, first.from))), 'and not at the old one')

    // The library must not still point at a path that no longer exists.
    const track = (await h.call('GET', `/tracks/${first.trackId}`)).body
    assert.equal(track.path, first.to)

    // Replanning now finds nothing to do.
    const again = (await h.call('POST', '/organize', { sourceId: 'loc', pattern })).body
    assert.equal(again.moves.length, 0)
    assert.ok(again.unchanged > 0)
  } finally { await h.cleanup() }
})

test('a run can be put back exactly as it was', { skip }, async () => {
  const h = await harness()
  try {
    const pattern = '{albumArtist}/{album}/{trackNumber:02} {name}'
    const before = (await h.call('GET', '/tracks?limit=100')).body.items
      .map((t: any) => t.path).sort()

    const job = (await h.call('POST', '/organize', { sourceId: 'loc', pattern, apply: true })).body
    await h.settle()

    const log = (await h.call('GET', '/organize/log')).body.items
    assert.ok(log.length > 0, 'every move is logged, which is what makes undo possible')

    assert.equal((await h.call('POST', `/organize/${job.id}/undo`)).status, 202)
    await h.settle()

    const after = (await h.call('GET', '/tracks?limit=100')).body.items
      .map((t: any) => t.path).sort()
    assert.deepEqual(after, before, 'every file is back where it started')
    for (const p of after) assert.ok(await exists(join(h.musicDir, p)), `${p} is on disk`)

    // Nothing left to undo twice.
    assert.equal((await h.call('POST', `/organize/${job.id}/undo`)).status, 404)
  } finally { await h.cleanup() }
})

test('two tracks wanting the same name stop the run', { skip }, async () => {
  const h = await harness()
  try {
    // A pattern coarse enough that everything in an album collides.
    const pattern = '{albumArtist}/{album}'
    const plan = (await h.call('POST', '/organize', { sourceId: 'loc', pattern })).body
    assert.ok(plan.conflicts.length > 0)
    assert.ok(plan.conflicts[0].trackIds.length > 1)

    const applied = await h.call('POST', '/organize', { sourceId: 'loc', pattern, apply: true })
    // Refused, not resolved: picking a winner deletes the loser.
    assert.equal(applied.status, 409)
    assert.equal(applied.body.error.code, 'conflicts')
    assert.equal((await h.call('GET', '/organize/log')).body.items.length, 0, 'nothing moved')
  } finally { await h.cleanup() }
})

test('a read-only source is refused before anything is planned', { skip }, async () => {
  const h = await harness()
  try {
    h.db.prepare(`UPDATE sources SET writable = 0 WHERE id = 'loc'`).run()
    const res = await h.call('POST', '/organize', { sourceId: 'loc', pattern: '{name}' })
    assert.equal(res.status, 400)
    assert.match(res.body.error.message, /read-only/)
  } finally { await h.cleanup() }
})

test('tracks the pattern cannot render are reported, not guessed at', { skip }, async () => {
  const h = await harness()
  try {
    const ids = (await h.call('GET', '/tracks?limit=1')).body.items.map((t: any) => t.id)
    await h.call('PATCH', '/tracks', { ids, patch: { albumArtist: '' }, writeToFiles: false })

    const plan = (await h.call('POST', '/organize', {
      sourceId: 'loc', pattern: '{albumArtist}/{name}',
    })).body
    assert.equal(plan.skipped.length, 1)
    assert.match(plan.skipped[0].reason, /albumArtist is empty/)
    assert.ok(!plan.moves.some((m: any) => m.trackId === ids[0]))
  } finally { await h.cleanup() }
})
