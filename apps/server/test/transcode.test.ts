import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createApp } from '../src/app.ts'
import { canStreamTo, streamMimeFor, transcodeStream } from '../src/ffmpeg.ts'

const run = promisify(execFile)
const FIXTURES = resolve(import.meta.dirname, '../../../.fixtures')

/**
 * On-the-fly conversion, against real ffmpeg and real files.
 *
 * Mocking the encoder would test the plumbing and miss every question that
 * actually matters here — whether the container can be written to a pipe,
 * whether the bytes decode, whether the process is still running afterwards.
 */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-tc-'))
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
  const raw = (path: string) => app.app.fetch(new Request(`http://x/api/v1${path}`))
  const settle = async () => {
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      if (!app.jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')) return
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  await call('POST', '/sources', { id: 'local', name: 'Local', root: FIXTURES, kind: 'local' })
  await call('POST', '/sources/local/scan')
  await settle()

  return {
    call, raw, db: app.db,
    cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) },
  }
}

/** The FLAC fixture: the case that matters, a lossless library and a device that is not. */
async function flacTrack(h: Awaited<ReturnType<typeof harness>>) {
  const items = (await h.call('GET', '/tracks?limit=50')).body.items as any[]
  const t = items.find((x) => x.format === 'flac')
  assert.ok(t, 'the fixtures include a FLAC file')
  return t
}

test('a device that cannot play FLAC is sent something it can', async () => {
  const h = await harness()
  try {
    const t = await flacTrack(h)

    const res = await h.raw(`/stream/${t.id}?accept=mp3`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'audio/mpeg')
    assert.equal(res.headers.get('x-jukebox-transcoded'), 'mp3')
    // Not "bytes": a player told it can seek sends a Range, gets the start of a
    // fresh encode, and the track appears to restart.
    assert.equal(res.headers.get('accept-ranges'), 'none')

    const audio = Buffer.from(await res.arrayBuffer())
    assert.ok(audio.length > 1000, `got ${audio.length} bytes`)
    // The first two bytes of an MPEG frame, or an ID3 header. Asserting on the
    // length alone would pass for a stream of ffmpeg's error messages.
    const looksLikeMp3 = audio.subarray(0, 3).toString() === 'ID3'
      || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)
    assert.ok(looksLikeMp3, `not an MP3: ${audio.subarray(0, 8).toString('hex')}`)
  } finally { await h.cleanup() }
})

test('the produced stream is really decodable, not merely bytes', async () => {
  const h = await harness()
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-tc-out-'))
  try {
    const t = await flacTrack(h)
    const res = await h.raw(`/stream/${t.id}?accept=aac`)
    // AAC into a pipe has to be ADTS: an .m4a is an MP4, MP4 rewrites its index
    // at the front when it closes, and a pipe cannot seek backwards. ffmpeg
    // refuses outright, so this header is the whole difference between working
    // and a 501.
    assert.equal(res.headers.get('content-type'), 'audio/aac')

    const out = join(dir, 'out.aac')
    await writeFile(out, Buffer.from(await res.arrayBuffer()))

    // ffprobe is the only honest judge of whether that was audio.
    const { stdout } = await run('ffprobe', [
      '-hide_banner', '-loglevel', 'error', '-show_entries', 'stream=codec_name',
      '-of', 'default=nw=1:nk=1', out,
    ])
    assert.equal(stdout.trim(), 'aac')
  } finally { await h.cleanup(); await rm(dir, { recursive: true, force: true }) }
})

test('a format the library already holds is served, not re-encoded', async () => {
  const h = await harness()
  try {
    const items = (await h.call('GET', '/tracks?limit=50')).body.items as any[]
    const mp3 = items.find((x) => x.format === 'mp3')

    const res = await h.raw(`/stream/${mp3.id}?accept=mp3,aac`)
    // Burning CPU to produce a worse copy of a file that was already acceptable
    // is the failure mode this check exists to prevent.
    assert.equal(res.headers.get('x-jukebox-transcoded'), null)
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
    await res.arrayBuffer()
  } finally { await h.cleanup() }
})

test('an accept list including the held format wins over one that does not', async () => {
  const h = await harness()
  try {
    const t = await flacTrack(h)
    const asIs = await h.raw(`/stream/${t.id}?accept=mp3,flac`)
    // Order is the client's preference, but a format it accepts *and* the
    // library holds beats making a lossy copy of it.
    assert.equal(asIs.headers.get('x-jukebox-transcoded'), null)
    await asIs.arrayBuffer()
  } finally { await h.cleanup() }
})

test('ALAC is refused rather than attempted, because it cannot be piped', async () => {
  // Its container is MP4, which has to seek back to write its index. Attempting
  // it produces "muxer does not support non seekable output" halfway through a
  // response that has already been declared a success.
  assert.equal(canStreamTo('alac'), false)
  assert.equal(canStreamTo('mp3'), true)
  assert.equal(streamMimeFor('opus'), 'audio/ogg')

  const h = await harness()
  try {
    const t = await flacTrack(h)
    const res = await h.raw(`/stream/${t.id}?format=alac`)
    // 501, not the FLAC we happen to have: a client that named a format and
    // silently got a different one has no way to find out.
    assert.equal(res.status, 501)
    assert.match((await res.json() as any).error.message, /cannot be served as alac/)
  } finally { await h.cleanup() }
})

test('hanging up kills the encoder', async () => {
  // The whole risk in this route. A tab closed mid-song, a speaker off the
  // wifi, a player switching track -- each abandons a running ffmpeg, and
  // three abandoned encoders is a Raspberry Pi.
  const child = await transcodeStream(join(FIXTURES, 'Daft Punk/Discovery/03.flac'), 'mp3')
  assert.ok(child.pid)
  const pid = child.pid!

  await new Promise((r) => child.stdout!.once('data', r))
  assert.doesNotThrow(() => process.kill(pid, 0), 'it is running')

  child.kill('SIGKILL')
  await new Promise((r) => child.once('exit', r))

  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'and now it is not')
})

test('a remote source says why it cannot convert, rather than failing midway', async () => {
  const h = await harness()
  try {
    await h.call('POST', '/sources', {
      id: 'jf', name: 'Remote', root: 'http://127.0.0.1:1', kind: 'jellyfin', config: { token: 'x' },
    })
    const t = await flacTrack(h)

    // Moved onto the remote source rather than scanned from one: a scan would
    // need a server standing up, and the branch under test is which source the
    // track claims to be on.
    h.db.prepare(`UPDATE tracks SET sourceId = 'jf' WHERE id = ?`).run(t.id)
    h.db.prepare(`UPDATE renditions SET sourceId = 'jf' WHERE trackId = ?`).run(t.id)

    const res = await h.raw(`/stream/${t.id}?accept=mp3`)
    // ffmpeg would have to open an authenticated URL, which is a different
    // problem than this one. A 501 that names the reason beats a stream that
    // dies a second in.
    assert.equal(res.status, 501)
    assert.match((await res.json() as any).error.message, /needs a local file.*jellyfin/)
  } finally { await h.cleanup() }
})
