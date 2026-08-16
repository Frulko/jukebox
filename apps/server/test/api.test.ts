import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import { readTags } from '../src/tags.ts'

const FIXTURES = process.env.JUKEBOX_FIXTURES ?? ''
const skip = FIXTURES ? false : 'JUKEBOX_FIXTURES is not set'

/** The app is exercised as Request → Response: no port, nothing to wait on. */
async function harness(writable = true) {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-api-'))
  const musicDir = join(dir, 'music')
  await cp(FIXTURES, musicDir, { recursive: true })
  const { app, jobs } = createApp(join(dir, 'db.sqlite'))

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(new Request(`http://x/api/v1${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
  }

  await call('POST', '/sources', { id: 'loc', name: 'Music', root: musicDir, writable })
  await call('POST', '/sources/loc/scan')
  await settle(jobs)
  const raw = (method: string, path: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://x/api/v1${path}`, { method, headers }))

  return { call, raw, jobs, musicDir, cleanup: () => { jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

/** Waits for the queue to drain — more reliable than a fixed delay. */
async function settle(jobs: any, ms = 4000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const busy = jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')
    if (!busy) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('the queue never drains')
}

test('scan then read: the library fills up and paginates', { skip }, async () => {
  const h = await harness()
  try {
    const { body } = await h.call('GET', '/tracks?limit=100')
    assert.equal(body.items.length, 4, '4 files indexed')
    const daft = body.items.filter((t: any) => t.artist === 'Daft Punk')
    assert.equal(daft.length, 3)
    assert.ok(daft.every((t: any) => t.duration > 0), 'durations read from the signal')
    assert.ok(daft.every((t: any) => Array.isArray(t.devices)), 'device presence ships with the page')
  } finally { await h.cleanup() }
})

test('ETag: the second call returns no bytes', { skip }, async () => {
  const h = await harness()
  try {
    const first = await h.call('GET', '/tracks')
    const etag = first.headers.get('etag')!
    assert.ok(etag)

    const again = await h.raw('GET', '/tracks', { 'if-none-match': etag })
    assert.equal(again.status, 304)
    assert.equal((await again.text()).length, 0, 'no body bytes')

    // A write changes the revision, so the ETag, so the client reloads.
    const ids = first.body.items.slice(0, 1).map((t: any) => t.id)
    await h.call('PATCH', '/tracks', { ids, patch: { rating: 5 }, writeToFiles: false })
    const afterWrite = await h.raw('GET', '/tracks', { 'if-none-match': etag })
    assert.equal(afterWrite.status, 200, 'after a write, the old ETag no longer holds')
  } finally { await h.cleanup() }
})

test('bulk edit: the database answers immediately, the disk follows in a job', { skip }, async () => {
  const h = await harness(true)
  try {
    const before = await h.call('GET', '/tracks?limit=100')
    const ids = before.body.items.filter((t: any) => t.artist === 'Daft Punk').map((t: any) => t.id)
    assert.equal(ids.length, 3)

    const res = await h.call('PATCH', '/tracks', { ids, patch: { genre: 'French House', year: 2001 } })
    assert.equal(res.status, 200)
    assert.equal(res.body.updated, 3)
    assert.ok(res.body.job, 'a write-through job is created')

    // The database is up to date immediately, without waiting for the disk.
    const after = await h.call('GET', '/tracks?limit=100')
    const edited = after.body.items.filter((t: any) => ids.includes(t.id))
    assert.ok(edited.every((t: any) => t.genre === 'French House'), 'database up to date right away')

    await settle(h.jobs)
    assert.equal(h.jobs.get(res.body.job.id)!.state, 'done')

    // And the file on disk really carries the new tag.
    const tags = await readTags(join(h.musicDir, 'Daft Punk/Discovery/01.mp3'))
    assert.equal(tags.tags.genre, 'French House', 'the tag is written into the file')
    assert.equal(tags.tags.year, 2001)
  } finally { await h.cleanup() }
})

test('a read-only source keeps its files untouched', { skip }, async () => {
  const h = await harness(false)
  try {
    const page = await h.call('GET', '/tracks?limit=100')
    const one = page.body.items.find((t: any) => t.path.endsWith('01.mp3'))
    const before = await readTags(join(h.musicDir, one.path))

    const res = await h.call('PATCH', '/tracks', { ids: [one.id], patch: { genre: 'Must not be written' } })
    await settle(h.jobs)
    assert.equal(h.jobs.get(res.body.job.id)!.state, 'done', 'the job completes without failing')

    const after = await readTags(join(h.musicDir, one.path))
    assert.equal(after.tags.genre, before.tags.genre, 'the file is not touched')
    const reread = await h.call('GET', '/tracks?limit=100')
    assert.equal(reread.body.items.find((t: any) => t.id === one.id).genre, 'Must not be written',
      'the database keeps the value: that is the user\'s choice, not an error')
  } finally { await h.cleanup() }
})

test('a rescan does not re-read what has not changed', { skip }, async () => {
  const h = await harness()
  try {
    const r1 = await h.call('GET', '/tracks?limit=100')
    const rev1 = r1.body.revision

    const relance = await h.call('POST', '/sources/loc/scan')
    assert.notEqual(relance.body.state, 'done', 'a finished scan does not block the next one')
    await settle(h.jobs)

    const r2 = await h.call('GET', '/tracks?limit=100')
    assert.equal(r2.body.items.length, 4, 'no duplicates')
    assert.equal(r2.body.revision, rev1, 'nothing changed on disk: no writes, revision unchanged')
  } finally { await h.cleanup() }
})

test('an unknown route answers in the documented error format', { skip }, async () => {
  const h = await harness()
  try {
    const res = await h.call('GET', '/nonsense')
    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'not_found')
  } finally { await h.cleanup() }
})

test('GET /tracks/:id returns the right track, even past the first page', { skip }, async () => {
  const h = await harness()
  try {
    const { body } = await h.call('GET', '/tracks?limit=100')
    // Every track must be findable by its id. An early version searched inside
    // a bounded page and fell back to the first row: a 200 with the wrong
    // track, which is worse than an error.
    for (const t of body.items) {
      const one = await h.call('GET', `/tracks/${t.id}`)
      assert.equal(one.status, 200)
      assert.equal(one.body.id, t.id)
      assert.equal(one.body.name, t.name)
    }
    const absent = await h.call('GET', '/tracks/does-not-exist')
    assert.equal(absent.status, 404)
    assert.equal(absent.body.error.code, 'not_found')
  } finally { await h.cleanup() }
})

test('the artwork URL has a route behind it', { skip }, async () => {
  const h = await harness()
  try {
    const { body } = await h.call('GET', '/tracks?limit=1')
    const t = body.items[0]
    assert.ok(t.artwork, 'every track carries an artwork URL')

    const res = await h.raw('GET', t.artwork.replace('/api/v1', ''))
    // The ffmpeg fixtures embed no artwork: we want an explicit 404, not a
    // missing route answering "not found".
    assert.equal(res.status, 404)
    const err = await res.json() as any
    assert.equal(err.error.code, 'no_artwork', 'the route exists and knows how to say there is no image')
  } finally { await h.cleanup() }
})

test('a satellite registers a device and reports its real contents', { skip }, async () => {
  const h = await harness()
  try {
    const dev = await h.call('POST', '/devices', {
      id: 'ipod-1', name: "Mowmow's iPod", kind: 'ipod-classic',
      capacity: 160e9, acceptedFormats: ['mp3', 'aac', 'alac'], battery: 68,
    })
    assert.equal(dev.status, 201)
    assert.equal(dev.body.connected, 1)

    // Registering twice must not create a second iPod: a satellite restarts.
    await h.call('POST', '/devices', { id: 'ipod-1', name: 'Renamed', kind: 'ipod-classic' })
    assert.equal((await h.call('GET', '/devices')).body.items.length, 1)

    const library = (await h.call('GET', '/tracks?limit=100')).body.items
    const onDevice = library.filter((t: any) => t.artist === 'Daft Punk').slice(0, 2)

    const report = await h.call('PUT', '/devices/ipod-1/tracks', {
      items: [
        // Matched by artist + title + duration, never by path: no two systems
        // agree on where a file lives.
        ...onDevice.map((t: any, i: number) => ({
          deviceLocalId: `F0${i}`, name: t.name, artist: t.artist, duration: t.duration,
        })),
        // Present on the device, absent from the library: this is what makes
        // recovering an old iPod possible.
        { deviceLocalId: 'F99', name: 'Lost Track', artist: 'Unknown', duration: 200 },
      ],
    })
    assert.equal(report.body.received, 3)
    assert.equal(report.body.matched, 2)
    assert.equal(report.body.orphans, 1)
  } finally { await h.cleanup() }
})

test('presence travels with the page, and the filters run in SQL', { skip }, async () => {
  const h = await harness()
  try {
    await h.call('POST', '/devices', { id: 'ipod-1', name: 'iPod', kind: 'ipod-classic' })
    const library = (await h.call('GET', '/tracks?limit=100')).body.items
    const two = library.filter((t: any) => t.artist === 'Daft Punk').slice(0, 2)
    await h.call('PUT', '/devices/ipod-1/tracks', {
      items: two.map((t: any, i: number) => ({
        deviceLocalId: `F0${i}`, name: t.name, artist: t.artist, duration: t.duration,
      })),
    })

    const page = (await h.call('GET', '/tracks?limit=100')).body.items
    const held = page.filter((t: any) => t.devices.includes('ipod-1'))
    assert.equal(held.length, 2, 'presence ships with the track, no extra request')

    const missing = (await h.call('GET', '/tracks?notOnDevice=ipod-1')).body.items
    assert.equal(missing.length, library.length - 2)
    assert.ok(!missing.some((t: any) => t.devices.includes('ipod-1')))

    const present = (await h.call('GET', '/tracks?onDevice=ipod-1')).body.items
    assert.equal(present.length, 2)
  } finally { await h.cleanup() }
})

test('streaming answers ranges, which is what makes seeking cheap', { skip }, async () => {
  const h = await harness()
  try {
    const t = (await h.call('GET', '/tracks?limit=1')).body.items[0]

    const whole = await h.raw('GET', `/stream/${t.id}`)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('accept-ranges'), 'bytes', 'without this the player never even tries a range')
    assert.match(whole.headers.get('content-type') ?? '', /^audio\//)
    const body = new Uint8Array(await whole.arrayBuffer())
    assert.equal(body.length, Number(whole.headers.get('content-length')))

    const part = await h.raw('GET', `/stream/${t.id}`, { range: 'bytes=10-19' })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-length'), '10', 'inclusive at both ends')
    assert.equal(part.headers.get('content-range'), `bytes 10-19/${body.length}`)
    // The bytes must be the ones asked for, not the first ten of the file.
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [...body.slice(10, 20)])

    const tail = await h.raw('GET', `/stream/${t.id}`, { range: 'bytes=-16' })
    assert.equal(tail.status, 206)
    assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [...body.slice(-16)],
      'a suffix range is the end of the file, not the start')

    const past = await h.raw('GET', `/stream/${t.id}`, { range: `bytes=${body.length + 10}-` })
    assert.equal(past.status, 416)
    assert.equal(past.headers.get('content-range'), `bytes */${body.length}`,
      '416 carries the real size so the client can correct itself')

    assert.equal((await h.raw('GET', '/stream/no-such-track')).status, 404)
  } finally { await h.cleanup() }
})

test('the scanned format is a codec name a device can be compared against', { skip }, async () => {
  const h = await harness()
  try {
    const formats = (await h.call('GET', '/tracks?limit=100')).body.items.map((t: any) => t.format)
    // `mpeg` or `m4a/isom/iso2` here means every mp3 in the library would be
    // queued for transcoding against an iPod that plays mp3 natively.
    assert.ok(formats.includes('mp3'), `expected mp3, got ${JSON.stringify(formats)}`)
    assert.ok(!formats.some((f: string) => f.includes('/') || f === 'mpeg'), 'no container names leak through')
  } finally { await h.cleanup() }
})

test('a full rescan re-reads files an incremental scan would skip', { skip }, async () => {
  const h = await harness()
  try {
    // Nothing on disk moved, so an ordinary scan skips everything...
    const before = (await h.call('GET', '/tracks?limit=100')).body.items[0]
    await h.call('POST', '/sources/loc/scan?full=true')
    await settle(h.jobs)
    const after = (await h.call('GET', '/tracks?limit=100')).body.items[0]
    // ...whereas a full scan bumps the revision because it wrote every row again.
    assert.ok(after.rev > before.rev, 'a full rescan actually re-reads')
  } finally { await h.cleanup() }
})

test('hand-picking tracks for a device shows up in its plan', { skip }, async () => {
  const h = await harness()
  try {
    await h.call('POST', '/devices', {
      id: 'ipod-1', name: 'iPod', kind: 'ipod-classic', capacity: 10_000_000_000,
    })
    // syncMode defaults to 'playlists' with none selected: the plan is empty
    // until something is picked by hand.
    assert.equal((await h.call('POST', '/devices/ipod-1/sync', { dryRun: true })).body.add.length, 0)

    const ids = (await h.call('GET', '/tracks?limit=3')).body.items.map((t: any) => t.id)
    const first = await h.call('POST', '/devices/ipod-1/wanted', { trackIds: [...ids, 'no-such-track'] })
    assert.equal(first.body.added, ids.length)
    assert.equal(first.body.unknown, 1, 'a stale id is dropped, not a 400 for the whole drop')

    // Dropping the same selection twice must not claim to have added it twice.
    const again = await h.call('POST', '/devices/ipod-1/wanted', { trackIds: ids })
    assert.equal(again.body.added, 0)
    assert.equal(again.body.alreadyWanted, ids.length)

    const plan = (await h.call('POST', '/devices/ipod-1/sync', { dryRun: true })).body
    assert.deepEqual(plan.add.map((a: any) => a.trackId).sort(), [...ids].sort())

    const undone = await h.call('DELETE', '/devices/ipod-1/wanted', { trackIds: [ids[0]] })
    assert.equal(undone.body.removed, 1)
    assert.equal((await h.call('POST', '/devices/ipod-1/sync', { dryRun: true })).body.add.length, ids.length - 1)

    assert.equal((await h.call('POST', '/devices/nope/wanted', { trackIds: ids })).status, 404)
  } finally { await h.cleanup() }
})

test('ejecting disconnects the device without forgetting anything', { skip }, async () => {
  const h = await harness()
  try {
    await h.call('POST', '/devices', { id: 'ipod-1', name: 'iPod', kind: 'ipod-classic' })
    const ids = (await h.call('GET', '/tracks?limit=2')).body.items.map((t: any) => t.id)
    await h.call('POST', '/devices/ipod-1/wanted', { trackIds: ids })
    await h.call('PUT', '/devices/ipod-1/tracks', {
      items: [{ deviceLocalId: 'F1', name: 'Something', artist: 'Someone', duration: 100 }],
    })

    assert.equal((await h.call('POST', '/devices/ipod-1/eject')).body.ejected, true)
    const dev = (await h.call('GET', '/devices')).body.items[0]
    assert.equal(dev.connected, 0)
    // Plugging the same iPod back in must show what it showed before, not an
    // empty device waiting for a first scan.
    assert.equal((await h.call('GET', '/devices/ipod-1/tracks')).body.items.length, 1)
    assert.equal((await h.call('POST', '/devices/ipod-1/sync', { dryRun: true })).body.add.length, ids.length)

    assert.equal((await h.call('POST', '/devices/nope/eject')).status, 404)
  } finally { await h.cleanup() }
})

test('importing from a device refuses a read-only target before creating a job', { skip }, async () => {
  const h = await harness(false) // source declared read-only
  try {
    await h.call('POST', '/devices', { id: 'ipod-1', name: 'iPod', kind: 'ipod-classic' })
    await h.call('PUT', '/devices/ipod-1/tracks', {
      items: [{ deviceLocalId: 'F99', name: 'Lost Track', artist: 'Unknown', duration: 200,
                sourceUrl: 'http://satellite.local/f99' }],
    })

    const res = await h.call('POST', '/devices/ipod-1/import', {
      deviceLocalIds: ['F99'], targetSourceId: 'loc',
    })
    // Refusing now beats failing after a transfer has started.
    assert.equal(res.status, 409)
    assert.equal(res.body.error.code, 'read_only')
    assert.equal(h.jobs.list({ kind: 'acquire' }).length, 0, 'no job is created')
  } finally { await h.cleanup() }
})

test('importing from a device queues a job when the target accepts writes', { skip }, async () => {
  const h = await harness(true)
  try {
    await h.call('POST', '/devices', { id: 'ipod-1', name: 'iPod', kind: 'ipod-classic' })
    await h.call('PUT', '/devices/ipod-1/tracks', {
      items: [{ deviceLocalId: 'F99', name: 'Lost Track', artist: 'Unknown', duration: 200,
                sourceUrl: 'http://satellite.local/f99' }],
    })

    const orphans = await h.call('GET', '/devices/ipod-1/tracks?orphansOnly=true')
    assert.equal(orphans.body.items.length, 1)
    assert.equal(orphans.body.items[0].libraryTrackId, null)
    assert.equal(orphans.body.items[0].sourceUrl, 'http://satellite.local/f99',
      'without a fetch URL there is nothing to import')

    const res = await h.call('POST', '/devices/ipod-1/import', {
      deviceLocalIds: ['F99'], targetSourceId: 'loc', targetPath: 'Recovered',
    })
    assert.equal(res.status, 202)
    assert.equal(res.body.kind, 'acquire')

    const res2 = await h.call('POST', '/devices/ipod-1/import', {
      deviceLocalIds: ['F99'], targetSourceId: 'loc',
    })
    assert.notEqual(res2.body.id, undefined)
  } finally { await h.cleanup() }
})
