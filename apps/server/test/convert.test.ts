import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { encoderFor, FORMATS, tools } from '../src/ffmpeg.ts'

const FIXTURES = process.env.JUKEBOX_FIXTURES ?? ''
const haveFfmpeg = (await tools()).ffmpeg !== null
const skip = !FIXTURES ? 'JUKEBOX_FIXTURES is not set' : !haveFfmpeg ? 'ffmpeg is not installed' : false

const exists = (p: string) => stat(p).then(() => true, () => false)

test('every offered format has an encoder and an extension', () => {
  for (const f of FORMATS) {
    const enc = encoderFor(f)
    assert.ok(enc, `${f} has no encoder`)
    assert.ok(enc.ext, `${f} has no extension`)
    // A bitrate on a lossless codec is a fatal argument error, not a no-op, so
    // the two have to be told apart before ffmpeg is invoked.
    if (enc.lossless) assert.equal(enc.defaultQuality, undefined)
    else assert.ok(enc.defaultQuality)
  }
  assert.equal(encoderFor('nonsense'), null)
  // ALAC and AAC share the m4a container: the extension is not the format.
  assert.equal(encoderFor('alac')!.ext, 'm4a')
  assert.equal(encoderFor('aac')!.ext, 'm4a')
})

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-conv-'))
  const musicDir = join(dir, 'music')
  await cp(FIXTURES, musicDir, { recursive: true })
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
  const settle = async (ms = 90_000) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const busy = app.jobs.list({}).filter((j: any) => j.state === 'queued' || j.state === 'running')
      if (!busy.length) return
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  await call('POST', '/sources', { id: 'loc', name: 'Music', root: musicDir, writable: true })
  await call('POST', '/sources/loc/scan')
  await settle()
  const raw = (method: string, path: string, headers: Record<string, string> = {}) =>
    app.app.fetch(new Request(`http://x/api/v1${path}`, { method, headers }))

  return {
    call, raw, settle, db: app.db, musicDir,
    cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) },
  }
}

test('the server says whether it can convert at all', { skip: FIXTURES ? false : 'no fixtures' }, async () => {
  const h = await harness()
  try {
    const caps = (await h.call('GET', '/transcode/capabilities')).body
    assert.equal(caps.available, haveFfmpeg)
    if (haveFfmpeg) {
      assert.ok(caps.formats.includes('aac'))
      assert.match(caps.ffmpeg, /ffmpeg version/)
      assert.equal(caps.reason, null)
    } else {
      // The honest answer when the binary is missing: a reason the UI can show,
      // rather than a queue of failures.
      assert.deepEqual(caps.formats, [])
      assert.match(caps.reason, /not installed/)
    }
    assert.equal((await h.call('POST', '/transcode', { ids: ['x'], format: 'wma' })).status, 400)
  } finally { await h.cleanup() }
})

test('keeping a copy makes one track with two files', { skip }, async () => {
  const h = await harness()
  try {
    const flac = (await h.call('GET', '/tracks?limit=100')).body.items.find((t: any) => t.format === 'flac')
    assert.ok(flac, 'the fixtures include a flac')

    assert.equal((await h.call('POST', '/transcode', {
      ids: [flac.id], format: 'aac', quality: '128k', replace: false,
    })).status, 202)
    await h.settle()

    const after = (await h.call('GET', `/tracks/${flac.id}`)).body
    // One row, two files. This is the whole point: two rows would give "is this
    // on the iPod" two answers for one song.
    assert.equal(after.renditions.length, 2)
    assert.deepEqual(after.renditions.map((r: any) => r.format).sort(), ['aac', 'flac'])
    assert.equal(after.format, 'flac', 'the original is still the preferred one')
    assert.equal(after.path, flac.path)

    const aac = after.renditions.find((r: any) => r.format === 'aac')
    assert.match(aac.path, /\.m4a$/, 'aac lives in an m4a container')
    assert.ok(await exists(join(h.musicDir, aac.path)), 'and the file is really there')
    assert.ok(await exists(join(h.musicDir, flac.path)), 'the original was kept')
    assert.ok(aac.size > 0)

    // The listing still shows one track.
    const listed = (await h.call('GET', '/tracks?limit=100')).body.items.filter((t: any) => t.id === flac.id)
    assert.equal(listed.length, 1)
  } finally { await h.cleanup() }
})

test('an iPod then gets the converted file instead of a re-encode', { skip }, async () => {
  const h = await harness()
  try {
    const flac = (await h.call('GET', '/tracks?limit=100')).body.items.find((t: any) => t.format === 'flac')
    await h.call('POST', '/devices', {
      id: 'ipod-1', name: 'iPod', kind: 'ipod-classic', capacity: 10_000_000_000,
      acceptedFormats: ['mp3', 'aac', 'alac'],
    })
    await h.call('POST', '/devices/ipod-1/wanted', { trackIds: [flac.id] })

    // Before converting: nothing on hand that the device plays.
    const before = (await h.call('POST', '/devices/ipod-1/sync', { dryRun: true })).body
    assert.equal(before.add[0].transcode, 'alac')

    await h.call('POST', '/transcode', { ids: [flac.id], format: 'aac', replace: false })
    await h.settle()

    // After: the work is already done, and the plan knows it.
    const after = (await h.call('POST', '/devices/ipod-1/sync', { dryRun: true })).body
    assert.equal(after.add[0].transcode, null)

    // And it counts the file it will actually send, not the preferred one.
    // Deliberately compared against the rendition rather than asserting the AAC
    // is smaller: these fixtures are two-second sine waves, which FLAC packs
    // better than any lossy codec, so "smaller" is true of music and not of
    // this test's data.
    const track = (await h.call('GET', `/tracks/${flac.id}`)).body
    const aac = track.renditions.find((r: any) => r.format === 'aac')
    assert.equal(after.add[0].size, aac.size)
    assert.notEqual(aac.size, track.size, 'the two renditions really are different files')
  } finally { await h.cleanup() }
})

test('replacing swaps the preferred file and removes the old one', { skip }, async () => {
  const h = await harness()
  try {
    const flac = (await h.call('GET', '/tracks?limit=100')).body.items.find((t: any) => t.format === 'flac')
    const originalPath = flac.path

    await h.call('POST', '/transcode', { ids: [flac.id], format: 'aac', replace: true })
    await h.settle()

    const after = (await h.call('GET', `/tracks/${flac.id}`)).body
    assert.equal(after.renditions.length, 1)
    assert.equal(after.renditions[0].format, 'aac')
    // The flat columns are the preferred rendition's copy; leaving them stale
    // would make the listing lie and the streaming endpoint look for a file
    // that is gone.
    assert.equal(after.format, 'aac')
    assert.match(after.path, /\.m4a$/)
    assert.ok(!(await exists(join(h.musicDir, originalPath))), 'the original is gone')
    assert.ok(await exists(join(h.musicDir, after.path)))

    // And it still streams, which is what keeping the flat columns in step is for.
    const res = await h.raw('GET', `/stream/${flac.id}`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^audio\//)
    await res.body?.cancel()
  } finally { await h.cleanup() }
})

test('converting to what it already is, is refused per track not per job', { skip }, async () => {
  const h = await harness()
  try {
    const items = (await h.call('GET', '/tracks?limit=100')).body.items
    const mp3 = items.find((t: any) => t.format === 'mp3')
    const flac = items.find((t: any) => t.format === 'flac')

    const job = (await h.call('POST', '/transcode', {
      ids: [mp3.id, flac.id], format: 'mp3', replace: false,
    })).body
    await h.settle()

    const page = (await h.call('GET', `/jobs/${job.id}/items`)).body
    // One refused, one done: a batch is not abandoned because one member of it
    // made no sense.
    assert.equal(page.counts.done, 1)
    assert.ok(page.counts.skipped + page.counts.failed === 1)
    assert.equal((await h.call('GET', `/jobs/${job.id}`)).body.state, 'done')
  } finally { await h.cleanup() }
})
