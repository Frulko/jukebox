import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The device half of the satellite — the contract a real iPod implementation
 * has to keep.
 *
 * It had no tests at all, and it turned out the two rules stated at the top of
 * `serve.ts` were only stated: nothing was ever written to disk, and the
 * `Range` header the comment promised was never sent. The bytes were fetched,
 * counted and discarded. This file is what makes those rules true rather than
 * aspirational, because the whole purpose of a reference implementation is to
 * prove the contract that hardware will be held to.
 *
 * Driven as a subprocess over HTTP rather than by importing it, because that is
 * how it runs: it starts a server on import and exports nothing. Testing the
 * real process also means the test cannot drift from the deployment.
 */

const SATELLITE = resolve(import.meta.dirname, '../src/serve.ts')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(fn: () => boolean | Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await wait(25)
  }
  return false
}

/** A source of bytes that records what was asked of it. */
async function origin(content: Buffer) {
  const seen: { url: string; range?: string }[] = []
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', range: req.headers.range })

    const range = /^bytes=(\d+)-/.exec(req.headers.range ?? '')
    if (range) {
      const start = Number(range[1])
      res.writeHead(206, {
        'content-type': 'audio/mpeg',
        'content-range': `bytes ${start}-${content.length - 1}/${content.length}`,
      })
      return res.end(content.subarray(start))
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(content.length) })
    res.end(content)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as any).port}/track.mp3`,
    close: () => { server.closeAllConnections(); server.close() },
  }
}

/** Each satellite gets its own port: they run one after another, and a socket
 *  in TIME_WAIT from the previous one would make the next look dead. */
let nextPort = 9310

async function satellite() {
  const root = await mkdtemp(join(tmpdir(), 'jukebox-device-'))
  const port = nextPort++

  const child: ChildProcess = spawn(process.execPath,
    ['--experimental-strip-types', '--no-warnings', SATELLITE], {
      env: {
        ...process.env,
        // SATELLITE_PORT, not PORT. Getting this wrong points every request at
        // a port nothing is listening on, and the failure looks like the
        // satellite never starting.
        SATELLITE_PORT: String(port),
        SATELLITE_ROOT: root,
        SATELLITE_DEVICE_ID: 'ipod-test',
        // Unreachable on purpose: the satellite must serve its device whether or
        // not a server is up, and it says so in its own comments.
        JUKEBOX_SERVER: 'http://127.0.0.1:1/api/v1',
        SATELLITE_RENDERER: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  child.stdout?.resume()
  child.stderr?.resume()

  const base = `http://127.0.0.1:${port}`
  const up = await until(async () => {
    try {
      const res = await fetch(`${base}/satellite`)
      return res.ok
    } catch { return false }
  })
  assert.ok(up, 'the satellite came up')

  return {
    root, base,
    post: async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.json() as any
    },
    get: async (path: string) => (await fetch(`${base}${path}`)).json() as any,
    files: () => readdir(root),
    close: async () => {
      child.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('a transferred track actually lands on the device', async () => {
  const content = Buffer.alloc(64_000, 7)
  const source = await origin(content)
  const sat = await satellite()
  try {
    const job = await sat.post('/devices/ipod-test/jobs', {
      id: 'j1', add: [{ url: source.url, name: '01.mp3' }], remove: [],
    })
    // Not `queued`: `runJob` is started before the response is serialised and
    // sets `transferring` on its first line, so the caller never observes the
    // initial state. Asserting it would be testing the scheduler's timing.
    assert.ok(['queued', 'transferring'].includes(job.state), job.state)

    assert.ok(await until(async () => (await sat.get(`/devices/ipod-test/jobs/j1`)).state === 'done'),
      'the job finished')

    // The bytes were being fetched, counted and discarded. Nothing reached the
    // device, and the job reported success.
    const landed = await readFile(join(sat.root, '01.mp3'))
    assert.equal(landed.length, content.length)
    assert.ok(landed.equals(content), 'and they are the right bytes')

    const finished = await sat.get('/devices/ipod-test/jobs/j1')
    assert.equal(finished.done, 1)
    assert.equal(finished.bytes, content.length)
  } finally { await sat.close(); source.close() }
})

test('an interrupted transfer resumes instead of starting over', async () => {
  const content = Buffer.alloc(64_000, 9)
  const source = await origin(content)
  const sat = await satellite()
  try {
    // What an interrupted three-hour sync leaves behind: a partial file.
    const already = 20_000
    await writeFile(join(sat.root, '01.mp3.part'), content.subarray(0, already))

    await sat.post('/devices/ipod-test/jobs', {
      id: 'j2', add: [{ url: source.url, name: '01.mp3' }], remove: [],
    })
    assert.ok(await until(async () => (await sat.get('/devices/ipod-test/jobs/j2')).state === 'done'))

    // The header the comment had been promising since the file was written.
    assert.equal(source.seen.at(-1)?.range, `bytes=${already}-`)

    const landed = await readFile(join(sat.root, '01.mp3'))
    assert.equal(landed.length, content.length, 'not doubled, not truncated')
    assert.ok(landed.equals(content))

    // And only what it fetched counts, not the part it already had.
    const job = await sat.get('/devices/ipod-test/jobs/j2')
    assert.equal(job.bytes, content.length - already)
  } finally { await sat.close(); source.close() }
})

test('a partial file is never visible as device contents', async () => {
  const content = Buffer.alloc(8_000, 3)
  const source = await origin(content)
  const sat = await satellite()
  try {
    await writeFile(join(sat.root, 'half.mp3.part'), content.subarray(0, 1_000))

    const tracks = await sat.get('/devices/ipod-test/tracks')
    // An interrupted sync must not leave the device appearing to hold truncated
    // music. `.part` is not an audio extension, so the walk skips it by
    // construction rather than by a rule someone has to remember.
    assert.equal(tracks.items?.some?.((t: any) => t.path.includes('.part')) ?? false, false)
  } finally { await sat.close(); source.close() }
})

test('the commit happens once, after every file has landed', async () => {
  const content = Buffer.alloc(4_000, 1)
  const source = await origin(content)
  const sat = await satellite()
  try {
    await sat.post('/devices/ipod-test/jobs', {
      id: 'j3',
      add: [
        { url: source.url, name: 'a.mp3' },
        { url: source.url, name: 'b.mp3' },
        { url: source.url, name: 'c.mp3' },
      ],
      remove: [],
    })
    assert.ok(await until(async () => (await sat.get('/devices/ipod-test/jobs/j3')).state === 'done'))

    const files = (await sat.files()).filter((f) => f.endsWith('.mp3')).sort()
    assert.deepEqual(files, ['a.mp3', 'b.mp3', 'c.mp3'])
    // No leftovers: every transfer was renamed out of its partial name.
    assert.deepEqual((await sat.files()).filter((f) => f.endsWith('.part')), [])

    // And the device reports all three, which is the commit having happened.
    const tracks = await sat.get('/devices/ipod-test/tracks')
    assert.equal(tracks.items.length, 3)
  } finally { await sat.close(); source.close() }
})

test('cancelling stops the transfer mid-flight', async () => {
  const content = Buffer.alloc(2_000, 5)
  const source = await origin(content)
  const sat = await satellite()
  try {
    const many = Array.from({ length: 40 }, (_, i) => ({ url: source.url, name: `t${i}.mp3` }))
    await sat.post('/devices/ipod-test/jobs', { id: 'j4', add: many, remove: [] })

    await fetch(`${sat.base}/devices/ipod-test/jobs/j4`, { method: 'DELETE' })
    await wait(300)

    const job = await sat.get('/devices/ipod-test/jobs/j4')
    assert.equal(job.state, 'cancelled')
    // The loop re-reads its own state each iteration rather than checking once
    // at the end, so a cancel lands mid-sync rather than after it.
    assert.ok(job.done < many.length, `stopped at ${job.done} of ${many.length}`)
  } finally { await sat.close(); source.close() }
})

test('a job id is idempotent, so a server retry does not sync twice', async () => {
  const content = Buffer.alloc(4_000, 2)
  const source = await origin(content)
  const sat = await satellite()
  try {
    const body = { id: 'same', add: [{ url: source.url, name: 'one.mp3' }], remove: [] }
    await sat.post('/devices/ipod-test/jobs', body)
    await sat.post('/devices/ipod-test/jobs', body)
    assert.ok(await until(async () => (await sat.get('/devices/ipod-test/jobs/same')).state === 'done'))

    // A server that retried after a timeout must not double the transfer.
    const job = await sat.get('/devices/ipod-test/jobs/same')
    assert.equal(job.done, 1)
    assert.equal(job.bytes, content.length)
  } finally { await sat.close(); source.close() }
})

test('a source that refuses fails the job with the reason', async () => {
  const sat = await satellite()
  try {
    await sat.post('/devices/ipod-test/jobs', {
      id: 'j5', add: [{ url: 'http://127.0.0.1:1/gone.mp3', name: 'gone.mp3' }], remove: [],
    })
    assert.ok(await until(async () => (await sat.get('/devices/ipod-test/jobs/j5')).state === 'failed'))

    const job = await sat.get('/devices/ipod-test/jobs/j5')
    assert.ok(job.error, 'it says why')
    // And nothing half-written is left claiming to be music.
    assert.deepEqual((await sat.files()).filter((f) => f.endsWith('.mp3')), [])
  } finally { await sat.close() }
})
