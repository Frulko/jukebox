import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { compress } from 'hono/compress'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { open, revision, nextRev, type DB } from './db.ts'
import { JobQueue, publicJob, type JobKind } from './jobs.ts'
import { makeScanHandler } from './scan.ts'
import { makeWritebackHandler } from './writeback.ts'
import { makeAcquireHandler } from './acquire.ts'
import { makeSyncHandler, planSync } from './sync.ts'
import {
  countTracks, deviceStats, facets, getTrack, listDeviceTracks, listTracks, playlistTracks, smartTracks, tracksDelta,
} from './library.ts'
import { WRITABLE } from './tags.ts'
import {
  addTracks, createPlaylist, deletePlaylist, getPlaylist, listPlaylists,
  removeTracks, renamePlaylist, reorder, seedPresets, smartQuery,
} from './playlists.ts'

export function createApp(dbFile: string) {
  const db: DB = open(dbFile)
  const jobs = new JobQueue(db)
  jobs.register('scan', makeScanHandler(db))
  jobs.register('writeback', makeWritebackHandler(db))
  jobs.register('acquire', makeAcquireHandler(db))
  jobs.register('sync', makeSyncHandler(db))
  jobs.start()
  seedPresets(db)

  const app = new Hono()
  app.use('*', cors())
  app.use('*', compress())

  const api = new Hono()

  const fail = (c: any, status: number, code: string, message: string) =>
    c.json({ error: { code, message } }, status)

  /**
   * A collection's ETag is the current revision. Free to compute, and it removes
   * nearly all refresh traffic: a client coming back to an unchanged library
   * gets a 304 and zero bytes of body.
   */
  const withETag = (c: any, body: unknown) => {
    const etag = `"rev-${revision(db)}"`
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag })
    c.header('ETag', etag)
    return c.json(body)
  }

  api.get('/health', (c) => c.json({ ok: true, revision: revision(db) }))

  /* ---------------- library ---------------- */

  api.get('/tracks', (c) => {
    const q = c.req.query()
    const page = listTracks(db, q)
    return withETag(c, { ...page, revision: revision(db) })
  })

  api.get('/facets', (c) => withETag(c, facets(db, c.req.query())))

  api.get('/tracks/count', (c) => withETag(c, { count: countTracks(db, c.req.query()) }))

  api.get('/tracks/delta', (c) => {
    const since = Number(c.req.query('since') ?? 0)
    if (!Number.isFinite(since) || since < 0) return fail(c, 400, 'bad_since', '`since` must be a positive integer')
    return c.json({ revision: revision(db), ...tracksDelta(db, since, Number(c.req.query('limit') ?? 500)) })
  })

  api.get('/tracks/:id', (c) => {
    const track = getTrack(db, c.req.param('id'))
    return track ? c.json(track) : fail(c, 404, 'not_found', 'unknown track')
  })

  /** Bulk edit — this is what the "Multiple Item Information" modal calls. */
  api.patch('/tracks', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body?.ids?.length || !body?.patch) return fail(c, 400, 'bad_body', 'expected { ids: [], patch: {} }')

    const ALLOWED = new Set(['name', 'artist', 'albumArtist', 'album', 'genre', 'composer', 'year',
      'trackNumber', 'discNumber', 'bpm', 'comments', 'grouping', 'rating', 'loved', 'enabled', 'compilation', 'kind'])
    const cols = Object.keys(body.patch).filter((k) => ALLOWED.has(k))
    if (!cols.length) return fail(c, 400, 'no_field', 'no editable field')

    const rev = nextRev(db)
    const set = cols.map((k) => `${k} = ?`).join(', ')
    const values = cols.map((k) => (typeof body.patch[k] === 'boolean' ? (body.patch[k] ? 1 : 0) : body.patch[k]))
    const stmt = db.prepare(`UPDATE tracks SET ${set}, rev = ? WHERE id = ?`)
    for (const id of body.ids) stmt.run(...([...values, rev, id] as never[]))
    db.exec(`INSERT INTO tracks_fts (tracks_fts) VALUES ('rebuild')`)

    // The database answers at once; propagating to files is a job. Rewriting
    // 500 files over a network share takes minutes — the UI must not wait, and
    // the operation has to stay cancellable.
    const writable = cols.some((k) => (WRITABLE as string[]).includes(k))
    const job = writable && body.writeToFiles !== false
      ? jobs.create('writeback', { ids: body.ids, patch: body.patch })
      : null

    return c.json({ updated: body.ids.length, revision: rev, job: job ? publicJob(job) : null })
  })

  /* ---------------- playlists ---------------- */

  api.get('/playlists', (c) => withETag(c, { items: listPlaylists(db) }))

  api.post('/playlists', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.name) return fail(c, 400, 'bad_body', 'expected { name }')
    return c.json(createPlaylist(db, b), 201)
  })

  api.get('/playlists/:id', (c) => {
    const pl = getPlaylist(db, c.req.param('id'))
    return pl ? c.json(pl) : fail(c, 404, 'not_found', 'unknown playlist')
  })

  api.patch('/playlists/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    if (!b.name) return fail(c, 400, 'bad_body', 'expected { name }')
    const pl = renamePlaylist(db, c.req.param('id'), b.name)
    return pl ? c.json(pl) : fail(c, 404, 'not_found', 'unknown playlist')
  })

  api.delete('/playlists/:id', (c) =>
    deletePlaylist(db, c.req.param('id'))
      ? c.body(null, 204)
      : fail(c, 404, 'not_found', 'unknown playlist'))

  api.get('/playlists/:id/tracks', (c) => {
    const pl = getPlaylist(db, c.req.param('id'))
    if (!pl) return fail(c, 404, 'not_found', 'unknown playlist')
    // A smart playlist has no stored contents: it is a query.
    return c.json(pl.smart
      ? smartTracks(db, smartQuery(pl.rules ?? {}))
      : playlistTracks(db, pl.id, { cursor: c.req.query('cursor'), limit: c.req.query('limit') }))
  })

  api.post('/playlists/:id/tracks', async (c) => {
    const b = await c.req.json().catch(() => null)
    const pl = getPlaylist(db, c.req.param('id'))
    if (!pl) return fail(c, 404, 'not_found', 'unknown playlist')
    if (pl.smart) return fail(c, 409, 'smart_playlist', 'a smart playlist is changed through its rules')
    if (!b?.ids?.length) return fail(c, 400, 'bad_body', 'expected { ids: [] }')
    return c.json({ added: addTracks(db, pl.id, b.ids, b.position) })
  })

  api.delete('/playlists/:id/tracks', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.ids?.length) return fail(c, 400, 'bad_body', 'expected { ids: [] }')
    return c.json({ removed: removeTracks(db, c.req.param('id'), b.ids) })
  })

  api.put('/playlists/:id/order', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.ids?.length || typeof b.toIndex !== 'number') {
      return fail(c, 400, 'bad_body', 'expected { ids: [], toIndex }')
    }
    const pl = getPlaylist(db, c.req.param('id'))
    if (!pl) return fail(c, 404, 'not_found', 'unknown playlist')
    if (pl.smart) return fail(c, 409, 'smart_playlist', 'a smart playlist has no manual order')
    reorder(db, pl.id, b.ids, b.toIndex)
    return c.body(null, 204)
  })

  /* ---------------- sources ---------------- */

  api.get('/sources', (c) => withETag(c, { items: db.prepare(`SELECT * FROM sources`).all() }))

  api.post('/sources', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.name || !b?.root) return fail(c, 400, 'bad_body', 'expected { name, root }')
    const id = b.id ?? randomUUID().slice(0, 8)
    db.prepare(`INSERT INTO sources (id, kind, name, root, writable, rev) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, b.kind ?? 'local', b.name, b.root, b.writable ? 1 : 0, nextRev(db))
    return c.json(db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id), 201)
  })

  api.post('/sources/:id/scan', (c) => {
    const id = c.req.param('id')
    if (!db.prepare(`SELECT id FROM sources WHERE id = ?`).get(id)) return fail(c, 404, 'not_found', 'unknown source')
    // One key per source: re-triggering a running scan joins it instead of duplicating it.
    const job = jobs.create('scan', { sourceId: id }, { idempotencyKey: c.req.header('idempotency-key') ?? `scan-${id}` })
    return c.json(publicJob(job), 202)
  })

  /* ---------------- jobs ---------------- */

  api.get('/jobs', (c) =>
    c.json({
      items: jobs
        .list({ state: c.req.query('state') as any, kind: c.req.query('kind') as JobKind, limit: Number(c.req.query('limit') ?? 50) })
        .map(publicJob),
    }))

  api.get('/jobs/:id', (c) => {
    const job = jobs.get(c.req.param('id'))
    return job ? c.json(publicJob(job)) : fail(c, 404, 'not_found', 'unknown job')
  })

  api.patch('/jobs/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const job = b.action === 'pause' ? jobs.pause(c.req.param('id'))
      : b.action === 'resume' ? jobs.resume(c.req.param('id'))
      : null
    return job ? c.json(publicJob(job)) : fail(c, 400, 'bad_action', 'action ∈ pause | resume')
  })

  api.delete('/jobs/:id', (c) => {
    const job = jobs.cancel(c.req.param('id'))
    return job ? c.json(publicJob(job)) : fail(c, 404, 'not_found', 'unknown job')
  })

  /* ---------------- devices ---------------- */

  const hydrateDevice = (d: any) => ({
    ...d,
    used: JSON.parse(d.used || '{}'),
    acceptedFormats: JSON.parse(d.acceptedFormats || '[]'),
    syncPlaylistIds: JSON.parse(d.syncPlaylistIds || '[]'),
    charging: !!d.charging,
  })

  api.get('/devices', (c) =>
    withETag(c, { items: (db.prepare(`SELECT * FROM devices`).all() as any[]).map(hydrateDevice) }))

  /**
   * Device registration — what a satellite calls when it sees hardware appear.
   * Idempotent on the device id: a satellite restarting must not create a
   * duplicate iPod.
   */
  api.post('/devices', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.id || !b?.name || !b?.kind) return fail(c, 400, 'bad_body', 'expected { id, name, kind }')
    db.prepare(`
      INSERT INTO devices (id, satelliteId, name, kind, model, serial, firmware, capacity, used,
        battery, acceptedFormats, charging, connected, rev)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT (id) DO UPDATE SET
        satelliteId=excluded.satelliteId, name=excluded.name, model=excluded.model,
        serial=excluded.serial, firmware=excluded.firmware, capacity=excluded.capacity,
        used=excluded.used, battery=excluded.battery, acceptedFormats=excluded.acceptedFormats,
        charging=excluded.charging, connected=1, rev=excluded.rev`)
      .run(b.id, b.satelliteId ?? null, b.name, b.kind, b.model ?? '', b.serial ?? '', b.firmware ?? '',
        b.capacity ?? 0, JSON.stringify(b.used ?? {}), b.battery ?? null,
        JSON.stringify(b.acceptedFormats ?? []), b.charging ? 1 : 0, nextRev(db))
    const d = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(b.id) as any
    return c.json(hydrateDevice(d), 201)
  })

  /**
   * The satellite reports what is actually on the device. Matching against the
   * library happens here, by fingerprint when we have one and by artist+title
   * otherwise — never by file path, which no two systems agree on.
   */
  api.put('/devices/:id/tracks', async (c) => {
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => null)
    if (!Array.isArray(b?.items)) return fail(c, 400, 'bad_body', 'expected { items: [] }')

    db.prepare(`DELETE FROM device_tracks WHERE deviceId = ?`).run(id)
    const ins = db.prepare(`
      INSERT INTO device_tracks (deviceId, deviceLocalId, trackId, name, artist, album,
        duration, size, format, fingerprint, sourceUrl, syncedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    const byFp = db.prepare(`SELECT id FROM tracks WHERE fingerprint = ? AND deletedAt IS NULL LIMIT 1`)
    const byMeta = db.prepare(
      `SELECT id FROM tracks WHERE lower(artist) = lower(?) AND lower(name) = lower(?)
         AND abs(duration - ?) <= 3 AND deletedAt IS NULL LIMIT 1`)

    let matched = 0
    for (const it of b.items) {
      const hit = (it.fingerprint ? byFp.get(it.fingerprint) : null)
        ?? byMeta.get(it.artist ?? '', it.name ?? '', it.duration ?? 0)
      const trackId = (hit as any)?.id ?? null
      if (trackId) matched++
      ins.run(id, it.deviceLocalId, trackId, it.name ?? '', it.artist ?? '', it.album ?? '',
        it.duration ?? 0, it.size ?? 0, it.format ?? '', it.fingerprint ?? null,
        it.sourceUrl ?? null, Date.now())
    }
    nextRev(db)
    return c.json({ received: b.items.length, matched, orphans: b.items.length - matched })
  })

  api.patch('/devices/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const ALLOWED = ['name', 'autoSync', 'syncMode', 'syncPlaylistIds'] as const
    const cols = ALLOWED.filter((k) => b[k] !== undefined)
    if (!cols.length) return fail(c, 400, 'no_field', 'no editable field')
    const values = cols.map((k) =>
      k === 'syncPlaylistIds' ? JSON.stringify(b[k]) : typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k])
    db.prepare(`UPDATE devices SET ${cols.map((k) => `${k} = ?`).join(', ')}, rev = ? WHERE id = ?`)
      .run(...([...values, nextRev(db), c.req.param('id')] as never[]))
    const d = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(c.req.param('id')) as any
    return d ? c.json(hydrateDevice(d)) : fail(c, 404, 'not_found', 'unknown device')
  })

  /**
   * Sync and backup create a job. The real work will belong to the satellite;
   * this lays down the contract so the UI is honest right now and will not have
   * to change when the satellite lands.
   */
  /**
   * `dryRun` returns the plan and writes nothing. Seeing "340 to add, 12 to
   * remove, 2.1 GB short" before a three-hour transfer is worth more than any
   * progress bar during it.
   */
  api.post('/devices/:id/sync', async (c) => {
    const id = c.req.param('id')
    if (!db.prepare(`SELECT id FROM devices WHERE id = ?`).get(id)) {
      return fail(c, 404, 'not_found', 'unknown device')
    }
    const body = await c.req.json().catch(() => ({}))
    if (body?.dryRun) return c.json(planSync(db, id))

    const job = jobs.create('sync', { deviceId: id },
      { idempotencyKey: c.req.header('idempotency-key') ?? `sync-${id}` })
    return c.json(publicJob(job), 202)
  })

  api.post('/devices/:id/backup', async (c) => {
    const id = c.req.param('id')
    if (!db.prepare(`SELECT id FROM devices WHERE id = ?`).get(id)) {
      return fail(c, 404, 'not_found', 'unknown device')
    }
    const job = jobs.create('backup', { deviceId: id },
      { idempotencyKey: c.req.header('idempotency-key') ?? `backup-${id}` })
    return c.json(publicJob(job), 202)
  })

  /** What is actually on the device, independently of the library. */
  api.get('/devices/:id/tracks', (c) =>
    c.json(listDeviceTracks(db, c.req.param('id'), {
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit'),
      orphansOnly: c.req.query('orphansOnly') === 'true',
    })))

  /**
   * Import tracks that live on the device but not in the library.
   *
   * This is the point of showing a device independently: an old iPod is often
   * the last copy of music whose library is long gone. The satellite serves the
   * bytes; without a `sourceUrl` there is nothing to fetch, and the job says so
   * rather than failing with no reason.
   */
  api.post('/devices/:id/import', async (c) => {
    const id = c.req.param('id')
    const b = await c.req.json().catch(() => null)
    if (!b?.deviceLocalIds?.length) return fail(c, 400, 'bad_body', 'expected { deviceLocalIds: [] }')
    if (!b.targetSourceId) return fail(c, 400, 'bad_body', 'expected a targetSourceId')

    const target = db.prepare(`SELECT id, writable FROM sources WHERE id = ?`).get(b.targetSourceId) as any
    if (!target) return fail(c, 404, 'not_found', 'unknown target source')
    // Importing writes files. A read-only source refuses before a job is even
    // created, so the user is told now rather than after a failed transfer.
    if (!target.writable) return fail(c, 409, 'read_only', 'target source is read-only')

    const job = jobs.create('acquire', {
      deviceId: id, deviceLocalIds: b.deviceLocalIds,
      targetSourceId: b.targetSourceId, targetPath: b.targetPath ?? 'Imported',
    }, { idempotencyKey: c.req.header('idempotency-key') })
    return c.json(publicJob(job), 202)
  })

  api.get('/devices/:id/stats', (c) => withETag(c, deviceStats(db, c.req.param('id'))))

  /* ---------------- cover art ---------------- */

  /**
   * Extracted on demand, never during a scan: reading covers out of 100,000
   * files would make the first scan interminable for a benefit only visible on
   * screen. The ETag comes from the source file's mtime and size, so a retagged
   * file invalidates its own cover.
   */
  api.get('/artwork/:id', async (c) => {
    const t = db.prepare(
      `SELECT t.path, t.mtime, t.size, s.root FROM tracks t
       JOIN sources s ON s.id = t.sourceId WHERE t.id = ?`).get(c.req.param('id')) as any
    if (!t) return fail(c, 404, 'not_found', 'unknown track')

    const etag = `"art-${t.mtime}-${t.size}"`
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag })

    const { readTags } = await import('./tags.ts')
    let picture = null
    try {
      picture = (await readTags(join(t.root, t.path))).picture
    } catch { /* unreadable file: no cover, no error */ }
    if (!picture) return fail(c, 404, 'no_artwork', 'no embedded cover art')

    return c.body(picture.data as unknown as ArrayBuffer, 200, {
      'Content-Type': picture.format ?? 'image/jpeg',
      ETag: etag,
      'Cache-Control': 'private, max-age=86400',
    })
  })

  /* ---------------- events ---------------- */

  /** One stream: the client never polls in a loop. */
  api.get('/events', (c) =>
    c.newResponse(
      new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder()
          const send = (event: string, data: unknown) =>
            ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          send('hello', { revision: revision(db) })
          const off = jobs.onChange((j) => send('job.progress', publicJob(j)))
          const beat = setInterval(() => ctrl.enqueue(enc.encode(': ping\n\n')), 25000)
          c.req.raw.signal.addEventListener('abort', () => { off(); clearInterval(beat); ctrl.close() })
        },
      }),
      200,
      { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    ))

  app.route('/api/v1', api)
  app.notFound((c) => fail(c, 404, 'not_found', 'unknown route'))

  return { app, db, jobs }
}
