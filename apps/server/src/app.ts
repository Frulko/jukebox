import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { compress } from 'hono/compress'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { open, revision, nextRev, type DB } from './db.ts'
import { JobQueue, publicJob, type JobItemState, type JobKind } from './jobs.ts'
import { makeScanHandler } from './scan.ts'
import { makeWritebackHandler } from './writeback.ts'
import { makeAcquireHandler } from './acquire.ts'
import { makeSyncHandler, planSync } from './sync.ts'
import { getSchedule, listSchedules, parseCron, Scheduler } from './cron.ts'
import { createPodcast, getPodcast, listEpisodes, listPodcasts, makePodcastHandler } from './podcasts.ts'
import { createRadio, deleteRadio, discover, getRadio, listRadios, updateRadio } from './radio.ts'
import {
  countTracks, deviceStats, facets, getTrack, listDeviceTracks, listTracks, playlistTracks, smartTracks, tracksDelta,
} from './library.ts'
import { WRITABLE } from './tags.ts'
import { mimeFor, parseRange } from './stream.ts'
import { configOf, open as rcOpen, RcloneError } from './rclone.ts'
import { exportBackup, importBackup } from './backup.ts'
import { makeOrganizeHandler, makeUndoHandler, planOrganize } from './organize.ts'
import { getPlugin, HOST_API_VERSION, listPlugins, PluginHost } from './plugins.ts'
import {
  addTracks, createPlaylist, deletePlaylist, getPlaylist, listPlaylists,
  removeTracks, renamePlaylist, reorder, seedPresets, smartQuery,
} from './playlists.ts'

/** Node stream to the web stream Hono returns. Never buffers the file. */
const toWeb = (s: import('node:fs').ReadStream) => Readable.toWeb(s) as unknown as ReadableStream

/**
 * Serves a track that lives on a remote, by proxying the range to rclone.
 *
 * The daemon already speaks `Range` over `--rc-serve`, so the request is passed
 * through rather than reimplemented, and its answer -- 200 or 206, with the
 * content-range it chose -- is what goes back to the player. Reimplementing the
 * arithmetic on this side would mean two places that can disagree about the
 * same file.
 */
async function streamRemote(c: any, t: any): Promise<Response> {
  const cfg = configOf(t)
  const range = c.req.header('range')

  let upstream: Response
  try {
    upstream = await rcOpen(cfg, t.path, range ? parseUpstreamRange(range) : undefined)
  } catch (err) {
    const status = err instanceof RcloneError ? err.status : 502
    return c.json({ error: { code: status === 503 ? 'rclone_down' : 'gone',
      message: err instanceof Error ? err.message : 'the remote could not serve this track' } },
      status === 503 ? 503 : 410)
  }

  const headers: Record<string, string> = {
    'Content-Type': mimeFor(t.format),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  }
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h)
    if (v) headers[h === 'content-length' ? 'Content-Length' : 'Content-Range'] = v
  }
  return c.body(upstream.body, upstream.status === 206 ? 206 : 200, headers)
}

/**
 * `bytes=a-b` for the upstream request.
 *
 * A suffix range (`bytes=-500`) is handed to rclone untouched by returning
 * nothing here and letting the header pass: resolving it needs the file size,
 * which only the remote knows.
 */
function parseUpstreamRange(header: string): { start: number; end?: number } | undefined {
  const m = /^bytes=(\d+)-(\d*)/.exec(header.trim())
  if (!m) return undefined
  return { start: Number(m[1]), end: m[2] === '' ? undefined : Number(m[2]) }
}

export function createApp(dbFile: string) {
  const db: DB = open(dbFile)
  const jobs = new JobQueue(db)
  jobs.register('scan', makeScanHandler(db))
  jobs.register('writeback', makeWritebackHandler(db))
  jobs.register('acquire', makeAcquireHandler(db))
  jobs.register('sync', makeSyncHandler(db))
  jobs.register('podcast', makePodcastHandler(db))
  // One kind, two directions: the payload says which. A separate kind would
  // need its own concurrency cap for work that must never run beside itself.
  const organize = makeOrganizeHandler(db)
  const undo = makeUndoHandler(db)
  jobs.register('move', (ctx) => (ctx.payload.undo ? undo(ctx) : organize(ctx)))
  jobs.start()
  const scheduler = new Scheduler(db, jobs)
  scheduler.start()
  // Constructed, not started. Discovery touches the database and imports
  // arbitrary code, so who runs it and when is the caller's decision: `serve.ts`
  // awaits it at boot, and a test drives it explicitly. Started here as a
  // floating promise it could still be reading the database after the process
  // that owns it has closed it.
  const plugins = new PluginHost(db, jobs, process.env.JUKEBOX_PLUGINS ?? './plugins')
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

  /**
   * Tracks whose file the scanner could not find any more.
   *
   * They are soft deleted, never removed: the row carries the ratings and play
   * counts, and it is what playlists point at. An unmounted share must not cost
   * anyone their library, so plugging it back in and rescanning restores them.
   */
  api.get('/tracks/missing', (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 1000)
    return c.json({
      items: db.prepare(
        `SELECT t.id, t.sourceId, t.path, t.name, t.artist, t.album, t.duration,
                t.rating, t.playCount, t.deletedAt, s.name AS sourceName
         FROM tracks t JOIN sources s ON s.id = t.sourceId
         WHERE t.deletedAt IS NOT NULL ORDER BY t.deletedAt DESC, t.id LIMIT ?`).all(limit),
    })
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

  /**
   * Library totals, computed in SQL.
   *
   * The front end cannot work these out from a page: with cursor pagination it
   * only ever holds a few hundred rows, and counting those answers a different
   * question. Every number here is over the whole library.
   */
  api.get('/stats', (c) => withETag(c, {
    ...(db.prepare(
      `SELECT COUNT(*) AS tracks,
              COUNT(DISTINCT album) AS albums,
              COUNT(DISTINCT albumArtist) AS artists,
              COALESCE(SUM(size), 0) AS bytes,
              COALESCE(SUM(duration), 0) AS seconds
       FROM tracks WHERE deletedAt IS NULL AND kind = 'music'`).get() as any),
    missing: (db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE deletedAt IS NOT NULL`).get() as any).n,
    playlists: (db.prepare(`SELECT COUNT(*) AS n FROM playlists WHERE deletedAt IS NULL`).get() as any).n,
    podcasts: (db.prepare(`SELECT COUNT(*) AS n FROM podcasts WHERE deletedAt IS NULL`).get() as any).n,
    radios: (db.prepare(`SELECT COUNT(*) AS n FROM radios WHERE deletedAt IS NULL`).get() as any).n,
    sources: (db.prepare(`SELECT COUNT(*) AS n FROM sources`).get() as any).n,
    devices: (db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE connected = 1`).get() as any).n,
    jobs: db.prepare(`SELECT state, COUNT(*) AS n FROM jobs GROUP BY state`).all()
      .reduce((acc: any, r: any) => ({ ...acc, [r.state]: r.n }), {}),
  }))

  /* ---------------- plugins ---------------- */

  api.get('/plugins', (c) => withETag(c, {
    items: listPlugins(db),
    // The host version a plugin has to declare compatibility with. Published so
    // an author can check before installing rather than after failing.
    hostApi: HOST_API_VERSION,
  }))

  /** Re-reads the plugin folder. What fails to load is listed with the reason. */
  api.post('/plugins/scan', async (c) => c.json({ items: await plugins.discover() }))

  api.get('/plugins/:id', (c) => {
    const p = getPlugin(db, c.req.param('id'))
    return p ? c.json(p) : fail(c, 404, 'not_found', 'unknown plugin')
  })

  api.patch('/plugins/:id', async (c) => {
    const id = c.req.param('id')
    if (!getPlugin(db, id)) return fail(c, 404, 'not_found', 'unknown plugin')
    const b = await c.req.json().catch(() => ({}))

    if (b.config !== undefined) {
      db.prepare(`UPDATE plugins SET config = ? WHERE id = ?`).run(JSON.stringify(b.config), id)
    }
    if (b.enabled !== undefined) return c.json(await plugins.setEnabled(id, Boolean(b.enabled)))
    return c.json(getPlugin(db, id))
  })

  /* ---------------- file organisation ---------------- */

  /**
   * What a reorganisation would do. This is the default and the only thing that
   * happens without `apply: true` — the one operation here that rewrites
   * someone's disk does not get to be a single click.
   */
  api.post('/organize', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.sourceId || !b?.pattern) return fail(c, 400, 'bad_body', 'expected { sourceId, pattern }')

    let plan
    try {
      plan = planOrganize(db, { sourceId: b.sourceId, pattern: b.pattern })
    } catch (err) {
      return fail(c, 400, 'bad_rule', err instanceof Error ? err.message : 'cannot plan')
    }

    if (!b.apply) return c.json(plan)
    // Refused rather than resolved: picking a winner between two tracks that
    // want the same name would silently delete one of them.
    if (plan.conflicts.length) {
      return c.json({ error: { code: 'conflicts',
        message: `${plan.conflicts.length} destinations are wanted by more than one track`,
        details: plan.conflicts } }, 409)
    }

    const job = jobs.create('move', { sourceId: b.sourceId, pattern: b.pattern })
    return c.json({ ...publicJob(job), plan }, 202)
  })

  /** Puts a reorganisation back, newest move first. */
  api.post('/organize/:jobId/undo', (c) => {
    const jobId = c.req.param('jobId')
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM moves WHERE jobId = ? AND undoneAt IS NULL`)
      .get(jobId) as any).n
    if (!n) return fail(c, 404, 'not_found', 'no moves left to undo for that job')
    const job = jobs.create('move', { undo: true, jobId }, { idempotencyKey: `undo-${jobId}` })
    return c.json(publicJob(job), 202)
  })

  /** The move log, newest first. */
  api.get('/organize/log', (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 1000)
    return c.json({
      items: db.prepare(
        `SELECT id, jobId, trackId, sourceId, fromPath, toPath, movedAt, undoneAt
         FROM moves ORDER BY id DESC LIMIT ?`).all(limit),
    })
  })

  /* ---------------- backup ---------------- */

  /**
   * Everything a rescan cannot rebuild. Credentials are left out unless asked
   * for: a backup file is the thing most likely to be emailed to someone.
   */
  api.get('/backup', (c) => {
    const body = exportBackup(db, { secrets: c.req.query('secrets') === 'true' })
    c.header('content-disposition',
      `attachment; filename="jukebox-backup-${new Date(body.createdAt).toISOString().slice(0, 10)}.json"`)
    return c.json(body)
  })

  api.post('/restore', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b) return fail(c, 400, 'bad_body', 'expected a backup document')
    try {
      return c.json(importBackup(db, b))
    } catch (err) {
      return fail(c, 400, 'bad_backup', err instanceof Error ? err.message : 'unreadable backup')
    }
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
    // `full` re-reads every file instead of trusting mtime and size. It is what
    // to run when the server changes how it derives a field: the files have not
    // moved, so an ordinary scan would skip all of them.
    const full = c.req.query('full') === 'true'
    // One key per source: re-triggering a running scan joins it instead of duplicating it.
    // A full scan gets its own key, or it would join the incremental one it was
    // meant to replace.
    const job = jobs.create('scan', { sourceId: id, full },
      { idempotencyKey: c.req.header('idempotency-key') ?? `scan-${id}${full ? '-full' : ''}` })
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

  /**
   * What a job did, item by item.
   *
   * "Failed: ENOSPC" over 300 tracks does not say which ones, or whether the
   * other 290 landed. `counts` answers that from SQL over the whole job, so it
   * stays "3 of 40000 failed" rather than "3 of the 200 on this page".
   */
  api.get('/jobs/:id/items', (c) => {
    const id = c.req.param('id')
    if (!jobs.get(id)) return fail(c, 404, 'not_found', 'unknown job')
    const state = c.req.query('state')
    return c.json(jobs.items(id, {
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit'),
      state: state as JobItemState | undefined,
    }))
  })

  api.delete('/jobs/:id', (c) => {
    const job = jobs.cancel(c.req.param('id'))
    return job ? c.json(publicJob(job)) : fail(c, 404, 'not_found', 'unknown job')
  })

  /* ---------------- radios ---------------- */

  api.get('/radios', (c) => withETag(c, { items: listRadios(db) }))

  /**
   * Adding a station is one call: paste a URL, get a name, a genre and a logo.
   * The discovery is best-effort and never blocks the creation — a station
   * whose stream is asleep is still a station worth keeping.
   */
  api.post('/radios', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.streamUrl) return fail(c, 400, 'bad_body', 'expected { streamUrl }')
    try {
      const u = new URL(b.streamUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme')
    } catch {
      return fail(c, 400, 'bad_stream_url', 'expected an http or https URL')
    }

    const found = b.discover === false ? { ...b, error: null } : await discover(b.streamUrl, b, { directory: b.directory !== false })
    const radio = createRadio(db, { ...found, streamUrl: b.streamUrl, favorite: b.favorite })
    // The probe error travels with the response but is not stored: it describes
    // this moment, not the station.
    return c.json({ ...radio, probeError: found.error ?? null }, 201)
  })

  api.get('/radios/:id', (c) => {
    const r = getRadio(db, c.req.param('id'))
    return r ? c.json(r) : fail(c, 404, 'not_found', 'unknown radio')
  })

  api.patch('/radios/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    const r = updateRadio(db, c.req.param('id'), b)
    return r ? c.json(r) : fail(c, 404, 'not_found', 'unknown radio')
  })

  api.delete('/radios/:id', (c) =>
    deleteRadio(db, c.req.param('id'))
      ? c.body(null, 204)
      : fail(c, 404, 'not_found', 'unknown radio'))

  /** Re-runs discovery on an existing station, without overwriting what was set by hand. */
  api.post('/radios/:id/discover', async (c) => {
    const r = getRadio(db, c.req.param('id'))
    if (!r) return fail(c, 404, 'not_found', 'unknown radio')
    const found = await discover(r.streamUrl, {
      // Only blanks are filled: re-running this must not undo a rename.
      name: r.name, homepageUrl: r.homepageUrl ?? undefined,
      imageUrl: r.imageUrl ?? undefined, genre: r.genre, country: r.country,
    }, { directory: c.req.query('directory') !== 'false' })
    const updated = updateRadio(db, r.id, found)
    return c.json({ ...updated, probeError: found.error ?? null })
  })

  /* ---------------- podcasts ---------------- */

  api.get('/podcasts', (c) => withETag(c, { items: listPodcasts(db) }))

  api.post('/podcasts', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.feedUrl) return fail(c, 400, 'bad_body', 'expected { feedUrl }')
    try {
      // Rejected here rather than on the first refresh: a typo in a feed URL
      // should be an error at the moment it is typed.
      const u = new URL(b.feedUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme')
    } catch {
      return fail(c, 400, 'bad_feed_url', 'expected an http or https URL')
    }
    if (b.cron && !parseCron(b.cron)) {
      return fail(c, 400, 'bad_cron', `not a five-field cron expression: ${b.cron}`)
    }
    if (db.prepare(`SELECT id FROM podcasts WHERE feedUrl = ? AND deletedAt IS NULL`).get(b.feedUrl)) {
      return fail(c, 409, 'already_subscribed', 'already subscribed to this feed')
    }

    const p = createPodcast(db, b)
    // Fetched immediately: a subscription that shows nothing until the next
    // scheduled refresh looks broken.
    const job = jobs.create('podcast', { podcastId: p.id }, { idempotencyKey: `podcast-${p.id}` })
    return c.json({ ...p, job: publicJob(job) }, 201)
  })

  api.get('/podcasts/:id', (c) => {
    const p = getPodcast(db, c.req.param('id'))
    return p ? c.json(p) : fail(c, 404, 'not_found', 'unknown podcast')
  })

  api.patch('/podcasts/:id', async (c) => {
    const id = c.req.param('id')
    if (!getPodcast(db, id)) return fail(c, 404, 'not_found', 'unknown podcast')
    const b = await c.req.json().catch(() => ({}))
    if (b.cron !== undefined && b.cron !== null && !parseCron(b.cron)) {
      return fail(c, 400, 'bad_cron', `not a five-field cron expression: ${b.cron}`)
    }
    const ALLOWED = ['title', 'cron', 'keepLast', 'autoDownload', 'targetSourceId', 'targetPath'] as const
    const cols = ALLOWED.filter((k) => b[k] !== undefined)
    if (!cols.length) return fail(c, 400, 'no_field', 'no editable field')
    const values = cols.map((k) => (k === 'autoDownload' ? (b[k] ? 1 : 0) : b[k]))
    db.prepare(`UPDATE podcasts SET ${cols.map((k) => `${k} = ?`).join(', ')}, rev = ? WHERE id = ?`)
      .run(...([...values, nextRev(db), id] as never[]))
    return c.json(getPodcast(db, id))
  })

  api.delete('/podcasts/:id', (c) => {
    const r = db.prepare(`UPDATE podcasts SET deletedAt = ?, rev = ? WHERE id = ? AND deletedAt IS NULL`)
      .run(Date.now(), nextRev(db), c.req.param('id'))
    return r.changes ? c.body(null, 204) : fail(c, 404, 'not_found', 'unknown podcast')
  })

  api.get('/podcasts/:id/episodes', (c) => {
    const id = c.req.param('id')
    if (!getPodcast(db, id)) return fail(c, 404, 'not_found', 'unknown podcast')
    return c.json(listEpisodes(db, id, { cursor: c.req.query('cursor'), limit: c.req.query('limit') }))
  })

  api.post('/podcasts/:id/refresh', (c) => {
    const id = c.req.param('id')
    if (!getPodcast(db, id)) return fail(c, 404, 'not_found', 'unknown podcast')
    const job = jobs.create('podcast', { podcastId: id }, { idempotencyKey: `podcast-${id}` })
    return c.json(publicJob(job), 202)
  })

  /* ---------------- schedules ---------------- */

  api.get('/schedules', (c) => withETag(c, { items: listSchedules(db) }))

  api.post('/schedules', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.name || !b?.cron || !b?.kind) return fail(c, 400, 'bad_body', 'expected { name, cron, kind }')
    // Rejected here rather than stored: an expression that never parses is a
    // schedule that silently never runs, and the user finds out weeks later.
    if (!parseCron(b.cron)) return fail(c, 400, 'bad_cron', `not a five-field cron expression: ${b.cron}`)
    if (!jobs.knows(b.kind)) return fail(c, 400, 'bad_kind', `no handler registered for ${b.kind}`)

    const id = `sc-${randomUUID().slice(0, 8)}`
    db.prepare(`INSERT INTO schedules (id, name, cron, kind, payload, enabled, createdAt)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, b.name, b.cron, b.kind, JSON.stringify(b.payload ?? {}), b.enabled === false ? 0 : 1, Date.now())
    return c.json(getSchedule(db, id), 201)
  })

  api.patch('/schedules/:id', async (c) => {
    const id = c.req.param('id')
    if (!getSchedule(db, id)) return fail(c, 404, 'not_found', 'unknown schedule')
    const b = await c.req.json().catch(() => ({}))
    if (b.cron !== undefined && !parseCron(b.cron)) {
      return fail(c, 400, 'bad_cron', `not a five-field cron expression: ${b.cron}`)
    }
    const ALLOWED = ['name', 'cron', 'enabled', 'payload'] as const
    const cols = ALLOWED.filter((k) => b[k] !== undefined)
    if (!cols.length) return fail(c, 400, 'no_field', 'no editable field')
    const values = cols.map((k) =>
      k === 'payload' ? JSON.stringify(b[k]) : k === 'enabled' ? (b[k] ? 1 : 0) : b[k])
    db.prepare(`UPDATE schedules SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...([...values, id] as never[]))
    return c.json(getSchedule(db, id))
  })

  api.delete('/schedules/:id', (c) => {
    const r = db.prepare(`DELETE FROM schedules WHERE id = ?`).run(c.req.param('id'))
    return r.changes ? c.body(null, 204) : fail(c, 404, 'not_found', 'unknown schedule')
  })

  /** Runs it now, without waiting for its next occurrence and without moving it. */
  api.post('/schedules/:id/run', (c) => {
    const s = getSchedule(db, c.req.param('id'))
    if (!s) return fail(c, 404, 'not_found', 'unknown schedule')
    const job = jobs.create(s.kind, s.payload)
    db.prepare(`UPDATE schedules SET lastJobId = ? WHERE id = ?`).run(job.id, s.id)
    return c.json(publicJob(job), 202)
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
   * Hand-picked tracks for a device — dropping a selection on the iPod in the
   * sidebar, or sending it there from the context menu.
   *
   * Nothing is transferred here. The picks join whatever the sync rules already
   * want, and the next sync moves the bytes; that keeps one code path deciding
   * what a device holds instead of two that can disagree.
   */
  api.post('/devices/:id/wanted', async (c) => {
    const id = c.req.param('id')
    if (!db.prepare(`SELECT id FROM devices WHERE id = ?`).get(id)) {
      return fail(c, 404, 'not_found', 'unknown device')
    }
    const b = await c.req.json().catch(() => null)
    if (!Array.isArray(b?.trackIds) || !b.trackIds.length) {
      return fail(c, 400, 'bad_body', 'expected { trackIds: [] }')
    }
    // Unknown ids are dropped rather than rejected: a selection can outlive a
    // track that was deleted in another window, and failing the whole drop
    // because of one stale row helps nobody.
    const known = db.prepare(
      `SELECT id FROM tracks WHERE deletedAt IS NULL AND id IN (${b.trackIds.map(() => '?').join(',')})`)
      .all(...(b.trackIds as never[])) as any[]
    const ins = db.prepare(
      `INSERT INTO device_wanted (deviceId, trackId, addedAt) VALUES (?, ?, ?)
       ON CONFLICT (deviceId, trackId) DO NOTHING`)
    let added = 0
    for (const t of known) added += ins.run(id, t.id, Date.now()).changes as number
    nextRev(db)
    return c.json({ added, alreadyWanted: known.length - added, unknown: b.trackIds.length - known.length })
  })

  api.delete('/devices/:id/wanted', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!Array.isArray(b?.trackIds) || !b.trackIds.length) {
      return fail(c, 400, 'bad_body', 'expected { trackIds: [] }')
    }
    const r = db.prepare(
      `DELETE FROM device_wanted WHERE deviceId = ? AND trackId IN (${b.trackIds.map(() => '?').join(',')})`)
      .run(...([c.req.param('id'), ...b.trackIds] as never[]))
    nextRev(db)
    return c.json({ removed: r.changes as number })
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

  /**
   * Eject — the device stops being connected, nothing about it is forgotten.
   *
   * Its contents, its sync rules and its hand-picked tracks all stay: plugging
   * the same iPod back in must show what it showed before, not an empty device
   * waiting for a first scan.
   */
  api.post('/devices/:id/eject', (c) => {
    const r = db.prepare(`UPDATE devices SET connected = 0, rev = ? WHERE id = ?`)
      .run(nextRev(db), c.req.param('id'))
    if (!r.changes) return fail(c, 404, 'not_found', 'unknown device')
    return c.json({ ejected: true })
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

  /* ---------------- audio ---------------- */

  /**
   * The bytes of a track.
   *
   * `Range` is the entire point: seeking in a 40 MB file must cost kilobytes,
   * not a fresh download. The size and mtime come from the row rather than a
   * `stat` per request, and are checked against the file only when it is opened.
   *
   * No token yet — nothing on this server is authenticated, so a stream token
   * would guard nothing. It goes in with the rest of auth, and the URL shape
   * already has room for it.
   */
  api.get('/stream/:id', async (c) => {
    const t = db.prepare(
      `SELECT t.path, t.format, t.size, t.mtime, s.root, s.kind, s.config FROM tracks t
       JOIN sources s ON s.id = t.sourceId
       WHERE t.id = ? AND t.deletedAt IS NULL`).get(c.req.param('id')) as any
    if (!t) return fail(c, 404, 'not_found', 'unknown track')

    // A remote source is proxied rather than read: the range goes to rclone and
    // the body flows straight back out. Nothing is copied to local disk, which
    // is the whole reason the source is userspace in the first place.
    if (t.kind === 'rclone') return streamRemote(c, t)

    const abs = join(t.root, t.path)
    let size: number
    try {
      // The row can be stale -- a file re-encoded since the last scan has a
      // different length, and serving ranges against the old one hands the
      // player garbage. The file on disk is the authority.
      size = (await stat(abs)).size
    } catch {
      return fail(c, 410, 'gone', 'the file behind this track is no longer readable')
    }

    const type = mimeFor(t.format)
    const etag = `"s-${t.mtime}-${size}"`
    const base = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': 'private, max-age=3600',
    }

    const range = parseRange(c.req.header('range'), size)
    if (range === 'unsatisfiable') {
      // 416 has to carry the real size, or the client cannot correct itself.
      return c.body(null, 416, { ...base, 'Content-Range': `bytes */${size}` })
    }

    // A HEAD must answer exactly what the matching GET would, minus the body --
    // a player that probes with HEAD and is told 200/full-length stops asking
    // for ranges at all.
    if (c.req.method === 'HEAD') {
      return range
        ? c.body(null, 206, {
            ...base,
            'Content-Length': String(range.end - range.start + 1),
            'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
          })
        : c.body(null, 200, { ...base, 'Content-Length': String(size) })
    }

    if (!range) {
      return c.body(toWeb(createReadStream(abs)), 200, { ...base, 'Content-Length': String(size) })
    }

    const length = range.end - range.start + 1
    return c.body(toWeb(createReadStream(abs, { start: range.start, end: range.end })), 206, {
      ...base,
      'Content-Length': String(length),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    })
  })

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

  return { app, db, jobs, scheduler, plugins }
}
