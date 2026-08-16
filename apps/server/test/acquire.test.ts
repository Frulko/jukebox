import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'

const FIXTURES = process.env.JUKEBOX_FIXTURES ?? ''
const skip = FIXTURES ? false : 'JUKEBOX_FIXTURES not set'

/** Stands in for the satellite: serves one file, counts what was asked for. */
function fakeSatellite(file: string) {
  let served = 0
  const server = createServer((req, res) => {
    if (req.url === '/gone') { res.writeHead(500); res.end(); return }
    served++
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise<{ url: string; close: () => void; count: () => number }>((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), count: () => served })
    })
  })
}

const settle = async (jobs: any, ms = 6000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('the queue never drains')
}

test('importing pulls the bytes, writes the file and indexes the track', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-acq-'))
  const target = join(dir, 'library')
  await cp(FIXTURES, target, { recursive: true })
  const sat = await fakeSatellite(join(FIXTURES, 'Daft Punk/Discovery/01.mp3'))
  const { app, jobs, db } = createApp(join(dir, 'db.sqlite'))

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(new Request(`http://x/api/v1${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  try {
    await call('POST', '/sources', { id: 'loc', name: 'Music', root: target, writable: true })
    await call('POST', '/devices', { id: 'ipod-1', name: 'iPod', kind: 'ipod-classic' })
    await call('PUT', '/devices/ipod-1/tracks', {
      items: [{
        deviceLocalId: 'F90', name: 'Lost B-side', artist: 'Forgotten Band',
        album: 'Demo Tape', duration: 214, format: 'mp3', sourceUrl: `${sat.url}/F90`,
      }],
    })

    const res = await call('POST', '/devices/ipod-1/import', {
      deviceLocalIds: ['F90'], targetSourceId: 'loc', targetPath: 'Recovered',
    })
    assert.equal(res.status, 202)
    await settle(jobs)

    const job = jobs.get(res.body.id)!
    assert.equal(job.state, 'done', job.error ?? '')
    assert.equal(job.done, 1)
    assert.ok(job.bytes > 0, 'real bytes moved')
    assert.equal(sat.count(), 1, 'fetched once, from the satellite')

    // The folder layout comes from the track's own metadata, not the device path.
    const files = await readdir(join(target, 'Recovered/Forgotten Band/Demo Tape'))
    assert.equal(files.length, 1)
    assert.match(files[0], /\.mp3$/)
    assert.ok(!files[0].includes('.part-'), 'no temporary file left behind')

    // The track is now in the library *and* still on the device: presence must
    // say so without waiting for a rescan.
    const page = await call('GET', '/tracks?limit=100')
    const imported = page.body.items.find((t: any) => t.path.startsWith('Recovered'))
    assert.ok(imported, 'indexed straight away, no rescan needed')
    assert.deepEqual(imported.devices, ['ipod-1'])

    const orphans = await call('GET', '/devices/ipod-1/tracks?orphansOnly=true')
    assert.equal(orphans.body.items.length, 0, 'it is no longer an orphan')
  } finally {
    sat.close(); jobs.stop(); db.close?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a track the satellite cannot serve is reported, not silently skipped', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-acq2-'))
  const target = join(dir, 'library')
  await cp(FIXTURES, target, { recursive: true })
  const { app, jobs, db } = createApp(join(dir, 'db.sqlite'))
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(new Request(`http://x/api/v1${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  try {
    await call('POST', '/sources', { id: 'loc', name: 'Music', root: target, writable: true })
    await call('POST', '/devices', { id: 'ipod-1', name: 'iPod', kind: 'ipod-classic' })
    // No sourceUrl: the satellite knows the track exists but cannot hand it over.
    await call('PUT', '/devices/ipod-1/tracks', {
      items: [{ deviceLocalId: 'F91', name: 'Unlabelled', artist: '', duration: 180 }],
    })

    const res = await call('POST', '/devices/ipod-1/import', {
      deviceLocalIds: ['F91'], targetSourceId: 'loc',
    })
    await settle(jobs)
    assert.equal(jobs.get(res.body.id)!.state, 'done', 'one unfetchable track does not fail the batch')

    const item = db.prepare(`SELECT ref, state, error FROM job_items WHERE jobId = ?`).get(res.body.id) as any
    assert.equal(item.ref, 'F91')
    assert.equal(item.state, 'failed')
    assert.match(item.error, /no fetch URL/)
  } finally {
    jobs.stop(); db.close?.()
    await rm(dir, { recursive: true, force: true })
  }
})
