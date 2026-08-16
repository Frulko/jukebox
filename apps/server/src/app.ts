import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { compress } from 'hono/compress'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { open, revision, nextRev, onRevision, type DB } from './db.ts'
import { JobQueue, publicJob, type JobItemState, type JobKind } from './jobs.ts'
import { makeScanHandler } from './scan.ts'
import { makeWritebackHandler } from './writeback.ts'
import { makeAcquireHandler } from './acquire.ts'
import { makeSyncHandler, planSync } from './sync.ts'
import { getSchedule, listSchedules, parseCron, Scheduler } from './cron.ts'
import { createPodcast, getPodcast, listEpisodes, listPodcasts, makePodcastHandler } from './podcasts.ts'
import { createRadio, deleteRadio, discover, getRadio, listRadios, updateRadio } from './radio.ts'
import {
  countTracks, deviceStats, facets, getTrack, listDeviceTracks, listTracks, membershipsOf,
  pickRendition, playlistTracks, smartTracks, tagTracks, tracksDelta,
} from './library.ts'
import { WRITABLE } from './tags.ts'
import { mimeFor, parseRange } from './stream.ts'
import { configOf, open as rcOpen, RcloneError, version as rcVersion } from './rclone.ts'
import { configOf as jfConfigOf, info as jfInfo, open as jfOpen } from './jellyfin.ts'
import { configOf as plexConfigOf, info as plexInfo, open as plexOpen } from './plex.ts'
import * as airplay from './airplay.ts'
import * as cast from './chromecast.ts'
import { canStreamTo, streamMimeFor, transcodeStream } from './ffmpeg.ts'
import { mountFor, readMounts } from './mounts.ts'

/**
 * A renderer, whichever protocol found it.
 *
 * Kept as a tagged union rather than flattened into a common shape: the two
 * protocols need genuinely different things to be told to play — a control URL
 * and a SOAP envelope on one side, an address and a session on the other — and
 * a lowest common denominator would only push the difference somewhere less
 * obvious.
 */
type Output =
  | { kind: 'upnp'; id: string; name: string; upnp: Renderer }
  | { kind: 'airplay'; id: string; name: string; airplay: airplay.AirPlayDevice }
  | { kind: 'cast'; id: string; name: string; cast: cast.CastDevice }
import { exportBackup, importBackup } from './backup.ts'
import { makeOrganizeHandler, makeUndoHandler, planOrganize } from './organize.ts'
import { getPlugin, HOST_API_VERSION, listPlugins, PluginHost } from './plugins.ts'
import { Events, recordPlay } from './plays.ts'
import { compatible, fetchIndex, install, uninstall } from './store.ts'
import { FORMATS, tools } from './ffmpeg.ts'
import { makeConvertHandler } from './convert.ts'
import { findDuplicates, mergeTracks } from './duplicates.ts'
import {
  authenticate, createToken, createUser, isOpen, listTokens, listUsers,
  can, getUser, revokeToken, setPassword, setSourcesFor, sourcesFor, userForToken,
  type Capability, type User,
} from './auth.ts'
import { subsonicRouter } from './subsonic.ts'
import { buildOpenApi } from './openapi.ts'
import { Player, type PlayerState } from './player.ts'
import {
  advertisedBase, discover as discoverRenderers, pause as pauseRenderer, playUrl,
  setVolume as setRendererVolume, stop as stopRenderer, type Renderer,
} from './upnp.ts'
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
    'Content-Type': mimeFor(t.format, t.path),
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
/**
 * Serves a track that lives on another media server.
 *
 * Jellyfin, Emby and Plex all reduce to the same thing here: ask them for the
 * bytes, pass the range through, hand back what they send. Only the opener
 * differs, so only the opener is a parameter — the error handling, the range
 * translation and the header copying are one implementation because they are
 * one problem.
 *
 * `externalId` is their id for the item, which is what the stream URL is keyed
 * on; `path` is the fallback for a source indexed before that column existed.
 */
async function streamUpstream(
  c: any,
  t: any,
  open: (t: any, id: string, range?: { start: number; end?: number }) => Promise<Response>,
): Promise<Response> {
  const range = c.req.header('range')
  let upstream: Response
  try {
    upstream = await open(t, t.externalId ?? t.path, range ? parseUpstreamRange(range) : undefined)
  } catch (err) {
    return c.json(
      { error: { code: 'gone', message: err instanceof Error ? err.message : 'unreachable' } }, 502)
  }

  const headers: Record<string, string> = {
    // Their content type, not ours: they know what they are actually sending.
    'Content-Type': upstream.headers.get('content-type') ?? mimeFor(t.format, t.path),
    'Accept-Ranges': 'bytes',
  }
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h)
    if (v) headers[h === 'content-length' ? 'Content-Length' : 'Content-Range'] = v
  }
  return c.body(upstream.body, upstream.status === 206 ? 206 : 200, headers)
}

/**
 * Which format to make, when the library holds nothing the client can play.
 *
 * Returns null in the overwhelmingly common case: the file on disk is already
 * fine, and transcoding it would burn CPU to produce something worse.
 */
function transcodeTarget(have: string, q: { format?: string; accept?: string }): string | null {
  const format = String(have).toLowerCase()

  // An explicit format the library does not hold. Asking for the one it does
  // hold is not a conversion request.
  if (q.format) {
    const want = q.format.toLowerCase()
    return want !== format && canStreamTo(want) ? want : null
  }

  if (!q.accept) return null
  const accepted = q.accept.split(',').map((f) => f.trim().toLowerCase()).filter(Boolean)
  if (!accepted.length || accepted.includes(format)) return null

  // The first thing it accepts that can actually be produced into a pipe. The
  // client's order is its preference, and it knows its own hardware better than
  // a table here would.
  return accepted.find((f) => canStreamTo(f)) ?? null
}

/**
 * Converts while sending.
 *
 * No `Content-Length` and no `Range`: neither is knowable before the encode
 * finishes, and inventing one produces a player whose scrubber lies. Seeking a
 * transcoded stream means asking for it again from a different offset, which is
 * what `?seek=` is for.
 *
 * The encoder is killed when the client goes away. That is the whole risk in
 * this route — a tab closed mid-song, a speaker dropping off the wifi, a player
 * switching track all abandon a running ffmpeg, and on a Raspberry Pi three of
 * those is the machine.
 */
async function streamTranscoded(c: any, input: string, format: string): Promise<Response> {
  let child: Awaited<ReturnType<typeof transcodeStream>>
  try {
    child = await transcodeStream(input, format, undefined, Number(c.req.query('seek')) || 0)
  } catch (err) {
    return c.json({ error: {
      code: 'not_supported',
      message: err instanceof Error ? err.message : 'cannot convert',
    } }, 501)
  }

  const stdout = child.stdout!
  const body = new ReadableStream({
    start(controller) {
      stdout.on('data', (chunk: Buffer) => controller.enqueue(chunk))
      stdout.on('end', () => {
        try { controller.close() } catch { /* already closed by a cancel */ }
      })
      stdout.on('error', (err) => {
        try { controller.error(err) } catch { /* the client is already gone */ }
      })
    },
    cancel() {
      // The client hung up. Everything else in this function exists so that
      // this line runs.
      child.kill('SIGKILL')
    },
  })

  return c.body(body, 200, {
    'Content-Type': streamMimeFor(format),
    // Explicitly *not* bytes: a player told it can seek will send a Range and
    // get the start of a fresh encode, which sounds like the track restarting.
    'Accept-Ranges': 'none',
    'Cache-Control': 'no-store',
    'X-Jukebox-Transcoded': format,
  })
}

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
  jobs.register('transcode', makeConvertHandler(db))
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
  const events = new Events()
  // Cached between searches: SSDP takes seconds, and a UI that lists outputs on
  // every render would spend its life waiting for a multicast timeout.
  let renderers: { at: number; items: Output[] } = { at: 0, items: [] }
  const player = new Player(db, events)

  /**
   * "The library changed" — the event that stops a second controller polling.
   *
   * Carries only the revision. The client already knows what to do with one:
   * ask `delta?since=`, which is the rule this composes with. Sending the rows
   * themselves would duplicate that endpoint and get it wrong differently.
   *
   * Coalesced, and that is not an optimisation. A scan stamps a revision per
   * changed file, so a first import of 40,000 tracks would otherwise be 40,000
   * events down every open connection. Waiting a beat and sending the newest
   * number loses nothing, because the number is all there is.
   */
  let revisionPending: ReturnType<typeof setTimeout> | null = null
  const stopRevisionWatch = onRevision(db, (rev) => {
    if (revisionPending) return
    revisionPending = setTimeout(() => {
      revisionPending = null
      try {
        events.emit('library', { revision: revision(db) })
      } catch {
        // The database closed during the 250ms this waited. Reading it here
        // throws from inside a timer, which is an uncaught exception rather
        // than something a caller could catch — the same shape as the job
        // queue writing after stop(), and for the same reason: a delay makes
        // "is it still open" a question the code has to ask rather than assume.
        //
        // Nothing is lost. A closed database has no connections left to notify.
      }
    }, 250)
    revisionPending.unref?.()
    void rev
  })
  const plugins = new PluginHost(db, jobs, process.env.JUKEBOX_PLUGINS ?? './plugins', events, player)
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
  /**
   * An ETag keyed on the library revision.
   *
   * Cheap, and correct *only* for collections the revision actually covers —
   * tracks, playlists, sources, devices, whatever bumps it when it changes.
   * For anything else this is a promise the server cannot keep: see
   * `withBodyETag` below, and the test named after the bug.
   */
  const withETag = (c: any, body: unknown) => {
    const etag = `"rev-${revision(db)}"`
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag })
    c.header('ETag', etag)
    return c.json(body)
  }

  /**
   * An ETag keyed on the answer itself.
   *
   * For the collections the library revision does not describe — schedules,
   * plugins, jobs, accounts. Adding a schedule changes none of the counters the
   * revision tracks, so a revision ETag told a client "nothing changed" and it
   * went on showing a list without the row it had just created. That is the
   * worst shape of caching bug: the client is not stale by a second, it is
   * stale until something unrelated happens.
   *
   * The cost is serialising the body before knowing whether it will be sent,
   * which is why it is not the default: on a 300-row page of tracks the
   * revision is free and right.
   */
  const withBodyETag = (c: any, body: unknown) => {
    const json = JSON.stringify(body)
    const etag = `"b-${createHash('sha1').update(json).digest('base64url').slice(0, 22)}"`
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag })
    return c.body(json, 200, { ETag: etag, 'Content-Type': 'application/json' })
  }

  /**
   * Authentication.
   *
   * A fresh install has no users and answers everything — nobody should be
   * locked out of their own library by a setup step they have not reached. The
   * moment the first account exists the server closes, and from then on a
   * request needs a bearer token.
   *
   * Two paths stay open once it is closed: `/health`, so a container probe does
   * not need credentials, and `/auth/*`, or logging in would require being
   * logged in.
   */
  const OPEN_PATHS = ['/health', '/openapi.json', '/auth/login', '/auth/setup', '/auth/state']

  const userOf = (c: any): User | null => (c.get('user') as User | undefined) ?? null

  api.use('*', async (c, next) => {
    if (isOpen(db) || OPEN_PATHS.includes(c.req.path.replace(/^\/api\/v1/, ''))) return next()

    const header = c.req.header('authorization') ?? ''
    // A query token as well as a header: `<audio src>` and a Subsonic client
    // cannot set headers, and refusing them would mean no playback at all.
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : c.req.query('token')
    const user = bearer ? userForToken(db, bearer) : null
    if (!user) return fail(c, 401, 'unauthorized', 'a bearer token is required')

    c.set('user' as never, user as never)
    return next()
  })

  /**
   * What a request needs to be allowed to do.
   *
   * Read as a table rather than as checks scattered through the handlers: this
   * way the answer to "who can delete a source" is one place, and a route added
   * without thinking about permissions inherits the safe default at the bottom
   * rather than none at all.
   *
   * The rule is by prefix and method, not per route, because per route is a
   * list that goes stale the first week — a new admin endpoint under /users
   * should be admin-only by virtue of where it lives.
   */
  const ADMIN_PREFIXES = [
    '/users', '/sources', '/plugins', '/store', '/settings', '/schedules',
    '/backup',
    // The destructive mirror of /backup, and it was missing: `/restore` is
    // mounted at its own path rather than under /backup, so the prefix that
    // covered the read did not cover the write. It rewrites every rating, play
    // count, playlist and tag in the library at once — for everybody, not for
    // the account that called it.
    '/restore',
  ]

  /** Routes a guest may still call, because they are playback rather than change. */
  const GUEST_WRITES = [
    /^\/tracks\/[^/]+\/play$/,   // saying you listened to something
    /^\/player(\/|$)/,            // the shared queue: pause, skip, choose an output
    /^\/outputs\/[^/]+\/(play|pause|stop|volume)$/,
  ]

  /** Reading these is administration too: the account list is not public. */
  const ADMIN_READS = ['/users']

  function required(method: string, path: string): Capability | null {
    if (method === 'GET' || method === 'HEAD') {
      return ADMIN_READS.some((p) => path === p || path.startsWith(`${p}/`)) ? 'admin' : null
    }
    if (ADMIN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return 'admin'
    if (GUEST_WRITES.some((r) => r.test(path))) return 'play'
    if (path.startsWith('/playlists')) return 'curate'
    // Everything else that changes something changes the library.
    return 'write'
  }

  api.use('*', async (c, next) => {
    // An unclaimed server has no accounts and therefore no roles; the first
    // thing anyone does with it is create one.
    if (isOpen(db)) return next()

    const path = c.req.path.replace(/^\/api\/v1/, '')
    if (OPEN_PATHS.includes(path)) return next()

    const capability = required(c.req.method, path)
    if (!capability) return next()

    const user = userOf(c)
    if (!can(user, capability)) {
      // 403 rather than 401: the credentials were fine, the account simply may
      // not do this, and saying which capability is missing is the difference
      // between a fixable message and a mystery.
      return fail(c, 403, 'forbidden', `this account cannot ${capability === 'admin' ? 'administer the server' : capability}`)
    }
    return next()
  })

  api.get('/health', (c) => c.json({ ok: true, revision: revision(db) }))

  /**
   * The API, described.
   *
   * Generated from the router itself, so it cannot claim routes that do not
   * exist or quietly omit ones that do. Open without credentials for the same
   * reason a README is: a third party deciding whether to write a client should
   * not need an account first.
   */
  // ETagged because it is a large document that cannot change while this
  // process is running: a docs site or a client generator polling it should
  // pay for it once.
  api.get('/openapi.json', (c) => withBodyETag(c, buildOpenApi(app)))

  /** Whether this install has been claimed yet. Always answerable. */
  api.get('/auth/state', (c) => c.json({ open: isOpen(db), users: listUsers(db).length }))

  /**
   * Claims a fresh install. Refused once anyone exists, or it would be a way to
   * mint an admin on a server that is already someone's.
   */
  api.post('/auth/setup', async (c) => {
    if (!isOpen(db)) return fail(c, 409, 'already_set_up', 'this server already has an account')
    const b = await c.req.json().catch(() => null)
    if (!b?.username || !b?.password) return fail(c, 400, 'bad_body', 'expected { username, password }')
    if (String(b.password).length < 8) return fail(c, 400, 'weak_password', 'at least 8 characters')

    const user = await createUser(db, { ...b, role: 'admin' }, dbFile)
    const token = createToken(db, user.id, b.tokenName ?? 'setup')
    return c.json({ user, ...token }, 201)
  })

  api.post('/auth/login', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.username || !b?.password) return fail(c, 400, 'bad_body', 'expected { username, password }')
    const user = await authenticate(db, b.username, b.password)
    // One message for both wrong username and wrong password: telling them
    // apart is telling an attacker which half to keep.
    if (!user) return fail(c, 401, 'unauthorized', 'wrong username or password')
    return c.json({ user, ...createToken(db, user.id, b.tokenName ?? 'login') })
  })

  api.get('/auth/me', (c) => {
    const user = userOf(c)
    // The capabilities as well as the role: a front end should ask what it may
    // do rather than re-derive it from a role name, or the two drift and the UI
    // offers buttons the server refuses.
    return c.json(user && {
      ...user,
      can: (['admin', 'write', 'curate', 'play'] as Capability[]).filter((k) => can(user, k)),
      sources: sourcesFor(db, user),
    })
  })

  /* ---------------- accounts ---------------- */

  /**
   * Everyone with an account. Admin only, and no secrets: `listUsers` returns
   * the hydrated shape, which has never carried a hash.
   */
  api.get('/users', (c) => withBodyETag(c, { items: listUsers(db) }))

  api.post('/users', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.username || !b?.password) return fail(c, 400, 'bad_body', 'expected { username, password, role? }')
    if (String(b.password).length < 8) return fail(c, 400, 'weak_password', 'at least 8 characters')
    if (b.role && !['admin', 'user', 'guest'].includes(b.role)) {
      return fail(c, 400, 'bad_role', 'role is admin, user or guest')
    }
    if (listUsers(db).some((u) => u.username === b.username)) {
      return fail(c, 409, 'taken', 'that username exists')
    }
    return c.json(await createUser(db, { ...b, role: b.role ?? 'user' }, dbFile), 201)
  })

  api.patch('/users/:id', async (c) => {
    const target = getUser(db, c.req.param('id'))
    if (!target) return fail(c, 404, 'not_found', 'unknown user')
    const b = await c.req.json().catch(() => ({}))

    if (b.role && !['admin', 'user', 'guest'].includes(b.role)) {
      return fail(c, 400, 'bad_role', 'role is admin, user or guest')
    }
    // Demoting the last admin locks everyone out of the server for good, and
    // there is no recovery from it short of editing the database by hand.
    if (b.role && b.role !== 'admin' && target.role === 'admin'
      && listUsers(db).filter((u) => u.role === 'admin').length === 1) {
      return fail(c, 409, 'last_admin', 'this is the only admin; promote someone else first')
    }

    if (b.role) db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(b.role, target.id)
    if (b.password) {
      if (String(b.password).length < 8) return fail(c, 400, 'weak_password', 'at least 8 characters')
      await setPassword(db, target.id, b.password, dbFile, b.subsonic)
    }
    return c.json(getUser(db, target.id))
  })

  api.delete('/users/:id', (c) => {
    const target = getUser(db, c.req.param('id'))
    if (!target) return fail(c, 404, 'not_found', 'unknown user')
    if (target.role === 'admin' && listUsers(db).filter((u) => u.role === 'admin').length === 1) {
      return fail(c, 409, 'last_admin', 'the only admin cannot be deleted')
    }
    db.prepare(`DELETE FROM users WHERE id = ?`).run(target.id)
    db.prepare(`DELETE FROM tokens WHERE userId = ?`).run(target.id)
    return c.body(null, 204)
  })

  /**
   * Which sources an account may see.
   *
   * An empty list means every source, which is what a server nobody has
   * configured returns for everyone. Narrowing is opt-in, per account, and
   * never applies to an admin.
   */
  api.get('/users/:id/sources', (c) => {
    const target = getUser(db, c.req.param('id'))
    if (!target) return fail(c, 404, 'not_found', 'unknown user')
    return c.json({ items: sourcesFor(db, target) ?? [], all: sourcesFor(db, target) === null })
  })

  api.put('/users/:id/sources', async (c) => {
    const target = getUser(db, c.req.param('id'))
    if (!target) return fail(c, 404, 'not_found', 'unknown user')
    const b = await c.req.json().catch(() => null)
    if (!Array.isArray(b?.sourceIds)) return fail(c, 400, 'bad_body', 'expected { sourceIds: [] }')

    const known = new Set((db.prepare(`SELECT id FROM sources`).all() as any[]).map((s) => s.id))
    const unknown = b.sourceIds.filter((id: string) => !known.has(id))
    if (unknown.length) return fail(c, 400, 'unknown_source', `no such source: ${unknown.join(', ')}`)

    setSourcesFor(db, target.id, b.sourceIds)
    return c.json({ items: sourcesFor(db, target) ?? [], all: sourcesFor(db, target) === null })
  })

  api.get('/auth/tokens', (c) => {
    const user = c.get('user' as never) as User | undefined
    return user ? c.json({ items: listTokens(db, user.id) }) : fail(c, 401, 'unauthorized', 'not signed in')
  })

  api.post('/auth/tokens', async (c) => {
    const user = c.get('user' as never) as User | undefined
    if (!user) return fail(c, 401, 'unauthorized', 'not signed in')
    const b = await c.req.json().catch(() => ({}))
    // Shown once. Only its hash is kept.
    return c.json(createToken(db, user.id, b.name ?? 'unnamed'), 201)
  })

  api.delete('/auth/tokens/:id', (c) =>
    revokeToken(db, c.req.param('id'))
      ? c.body(null, 204)
      : fail(c, 404, 'not_found', 'unknown token'))

  /* ---------------- library ---------------- */

  /**
   * The sources this request may see, folded into its query.
   *
   * Taken from the account and never from the query string, which is the whole
   * point: a client cannot widen its own scope by asking, because the value it
   * sends is overwritten rather than merged.
   */
  const scoped = (c: any, q: Record<string, unknown> = {}) => ({
    ...q,
    sourceIds: sourcesFor(db, userOf(c)) ?? undefined,
  })

  api.get('/tracks', (c) => {
    const page = listTracks(db, scoped(c, c.req.query()))
    return withETag(c, { ...page, revision: revision(db) })
  })

  api.get('/facets', (c) => withETag(c, facets(db, scoped(c, c.req.query()))))

  api.get('/tracks/count', (c) => withETag(c, { count: countTracks(db, scoped(c, c.req.query())) }))

  api.get('/tracks/delta', (c) => {
    const since = Number(c.req.query('since') ?? 0)
    if (!Number.isFinite(since) || since < 0) return fail(c, 400, 'bad_since', '`since` must be a positive integer')
    return c.json({
      revision: revision(db),
      ...tracksDelta(db, since, Number(c.req.query('limit') ?? 500),
        sourcesFor(db, userOf(c)) ?? undefined),
    })
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
    return withBodyETag(c, {
      items: db.prepare(
        `SELECT t.id, t.sourceId, t.path, t.name, t.artist, t.album, t.duration,
                t.rating, t.playCount, t.deletedAt, s.name AS sourceName
         FROM tracks t JOIN sources s ON s.id = t.sourceId
         WHERE t.deletedAt IS NOT NULL ORDER BY t.deletedAt DESC, t.id LIMIT ?`).all(limit),
    })
  })

  /**
   * "This was listened to."
   *
   * Playback happens in the client, so the server only knows because it is
   * told. Half the length or four minutes, whichever comes first, and never
   * under thirty seconds — Last.fm's rule, matched exactly so a play counted
   * here is a play counted everywhere else. Anything short is recorded as a
   * skip instead, which is worth knowing too.
   */
  api.post('/tracks/:id/play', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    if (typeof b?.played !== 'number' || !Number.isFinite(b.played)) {
      return fail(c, 400, 'bad_body', 'expected { played: seconds }')
    }
    const result = recordPlay(db, events, c.req.param('id'), b)
    return result ? c.json(result) : fail(c, 404, 'not_found', 'unknown track')
  })

  /**
   * Where a track lives: every playlist and device holding it.
   *
   * On the server because a client cannot answer it. A smart playlist's
   * membership is a query rather than a stored list, so "is this track in it"
   * belongs to the rules engine — and brute-forcing the manual ones would be
   * one request per playlist to answer a single right-click.
   */
  api.get('/tracks/:id/memberships', (c) => {
    const m = membershipsOf(db, c.req.param('id'), smartQuery)
    return m ? c.json(m) : fail(c, 404, 'not_found', 'unknown track')
  })

  api.get('/tracks/:id', (c) => {
    const track = getTrack(db, c.req.param('id'))
    return track ? c.json(track) : fail(c, 404, 'not_found', 'unknown track')
  })

  /**
   * Tags on a set of tracks.
   *
   * Add and remove rather than "here are the tags now": the interface offers
   * this on a selection, and a replace would mean a hundred tracks quietly
   * losing every tag they did not have in common. One call does both, so
   * swapping a tag on a selection is one request and not two states.
   */
  api.post('/tracks/tags', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!Array.isArray(b?.ids) || !b.ids.length) return fail(c, 400, 'bad_body', 'expected { ids: [], add?: [], remove?: [] }')
    const add = Array.isArray(b.add) ? b.add.map(String) : []
    const remove = Array.isArray(b.remove) ? b.remove.map(String) : []
    if (!add.length && !remove.length) return fail(c, 400, 'no_change', 'nothing to add or remove')

    const rev = nextRev(db)
    return c.json({ ...tagTracks(db, b.ids.map(String), add, remove, rev), revision: rev })
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

  /* ---------------- duplicates ---------------- */

  /**
   * Proposes. Never merges.
   *
   * Grouping is the dangerous half — two different songs sharing a title is
   * ordinary — so this returns candidates with the evidence, and each merge has
   * to name the track to keep.
   */
  // Expensive to compute and rarely different, which is exactly what an ETag
  // is for.
  api.get('/duplicates', (c) =>
    withBodyETag(c, { groups: findDuplicates(db, { limit: Number(c.req.query('limit')) || 200 }) }))

  api.post('/duplicates/merge', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.keeperId || !Array.isArray(b?.ids)) {
      return fail(c, 400, 'bad_body', 'expected { keeperId, ids: [] }')
    }
    const result = mergeTracks(db, b.keeperId, b.ids)
    return result ? c.json(result) : fail(c, 404, 'not_found', 'unknown keeper track')
  })

  /* ---------------- conversion ---------------- */

  /**
   * What this server can convert, and whether it can convert at all.
   *
   * ffmpeg is a binary on PATH rather than a dependency, so it may simply not
   * be there. Saying so here lets the UI disable conversion with a reason
   * rather than queue a job that fails once per track.
   */
  api.get('/transcode/capabilities', async (c) => {
    const t = await tools(c.req.query('refresh') === 'true')
    return c.json({
      available: Boolean(t.ffmpeg),
      formats: t.ffmpeg ? FORMATS : [],
      ffmpeg: t.ffmpeg,
      fpcalc: t.fpcalc,
      reason: t.ffmpeg ? null : 'ffmpeg is not installed on this server',
    })
  })

  /**
   * Converts a selection.
   *
   * `replace: false` keeps both files as two renditions of one track, which is
   * the case worth having: an iPod that takes AAC and a browser that wants the
   * FLAC are the same song, and keeping both stops every sync re-encoding it.
   */
  api.post('/transcode', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.ids?.length || !b?.format) return fail(c, 400, 'bad_body', 'expected { ids: [], format }')
    if (!FORMATS.includes(String(b.format).toLowerCase())) {
      return fail(c, 400, 'bad_format', `cannot convert to ${b.format}; try one of ${FORMATS.join(', ')}`)
    }
    const t = await tools()
    // Refused before a job exists: a queue full of failures is a worse answer
    // than one clear no.
    if (!t.ffmpeg) return fail(c, 503, 'no_ffmpeg', 'ffmpeg is not installed on this server')

    const job = jobs.create('transcode', {
      ids: b.ids, format: String(b.format).toLowerCase(),
      quality: b.quality, replace: Boolean(b.replace),
    })
    return c.json(publicJob(job), 202)
  })

  /* ---------------- the shared queue ---------------- */

  /**
   * One queue, several controllers.
   *
   * The server holds the intent — what is queued, which one is current, whether
   * it should be playing, where. A renderer executes it and reports back. That
   * separation is what makes "pause it from my phone while it plays on the
   * Sonos" work at all.
   */
  api.get('/player', (c) => c.json(player.withTrack()))

  api.put('/player/queue', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!Array.isArray(b?.trackIds)) return fail(c, 400, 'bad_body', 'expected { trackIds: [], startAt? }')
    const state = player.setQueue(b.trackIds, Number(b.startAt) || 0, by(c))
    void driveOutput(state)
    return c.json(player.withTrack())
  })

  api.post('/player/queue', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!Array.isArray(b?.trackIds)) return fail(c, 400, 'bad_body', 'expected { trackIds: [], next? }')
    const state = b.next ? player.playNext(b.trackIds, by(c)) : player.enqueue(b.trackIds, by(c))
    void driveOutput(state)
    return c.json(player.withTrack())
  })

  api.delete('/player/queue', (c) => c.json(player.clear(by(c))))

  // Each takes the controller's name, so "paused from iPhone" is answerable.
  // Building these without it was silently dropping the one thing that makes a
  // shared queue feel shared.
  for (const [path, act] of [
    ['play', (who: string | null) => player.play(who ?? undefined)],
    ['pause', (who: string | null) => player.pause(who ?? undefined)],
    ['next', (who: string | null) => player.step(1, who ?? undefined)],
    ['previous', (who: string | null) => player.step(-1, who ?? undefined)],
  ] as const) {
    api.post(`/player/${path}`, (c) => {
      const state = act(by(c))
      void driveOutput(state)
      return c.json(player.withTrack())
    })
  }

  api.post('/player/seek', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (typeof b?.position !== 'number') return fail(c, 400, 'bad_body', 'expected { position }')
    return c.json(player.seek(b.position, by(c)))
  })

  api.post('/player/goto', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.trackId) return fail(c, 400, 'bad_body', 'expected { trackId }')
    const state = player.goTo(b.trackId, by(c))
    void driveOutput(state)
    return c.json(player.withTrack())
  })

  api.patch('/player', async (c) => {
    const b = await c.req.json().catch(() => ({}))
    if (b.target) {
      const target = b.target.kind === 'output'
        ? renderers.items.find((r) => r.id === b.target.id)
        : null
      if (b.target.kind === 'output' && !target) {
        return fail(c, 404, 'not_found', 'unknown output; try GET /outputs?refresh=true')
      }
      const state = player.setTarget(
        target ? { kind: 'output', id: target.id, name: target.name } : { kind: 'local' }, by(c))
      // Moving rooms should pick up where it was, not start over.
      void driveOutput(state)
    }
    if (b.repeat !== undefined || b.shuffle !== undefined) {
      player.set({ repeat: b.repeat, shuffle: b.shuffle }, by(c))
    }
    return c.json(player.withTrack())
  })

  /**
   * Where the renderer says it actually is.
   *
   * Separate from the control routes because a renderer may report a position,
   * not reorder a queue — and because a position tick is not somebody doing
   * something, so it must not show up as "changed by iPhone".
   */
  api.post('/player/report', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (typeof b?.position !== 'number') return fail(c, 400, 'bad_body', 'expected { position, playing? }')
    return c.json(player.report(b.position, b.playing))
  })

  /** Names the controller, so a UI can say "paused from iPhone". */
  const by = (c: any) => c.req.header('x-jukebox-client') ?? null

  /**
   * When the target is a speaker, the server does the driving.
   *
   * Best-effort and never fatal: a renderer that has been unplugged should not
   * make pressing play return an error, it should make the next `GET /outputs`
   * stop listing it.
   */
  async function driveOutput(state: PlayerState): Promise<void> {
    if (state.target.kind !== 'output' || !state.trackId) return
    const targetId = state.target.id
    const renderer = renderers.items.find((r) => r.id === targetId)
    if (!renderer) return

    const t = getTrack(db, state.trackId)
    if (!t) return
    const base = advertisedBase(Number(process.env.PORT ?? 8787))
    try {
      if (state.playing) await startOn(renderer, t, `${base}/api/v1/stream/${t.id}`)
      else await pauseOn(renderer)
    } catch (err) {
      console.warn(`[player] ${renderer.name} refused:`, err instanceof Error ? err.message : err)
    }
  }

  /* ---------------- outputs ---------------- */

  /**
   * Both discoveries at once.
   *
   * UPnP shouts over SSDP and AirPlay answers questions over multicast DNS —
   * two protocols that share nothing but the fact that both take a second and
   * neither can be hurried. Run in parallel because they are independent, and
   * each is allowed to fail on its own: a network where one is blocked should
   * still list what the other found.
   */
  async function discoverOutputs(): Promise<Output[]> {
    const [upnp, air, casts] = await Promise.all([
      discoverRenderers().catch(() => [] as Renderer[]),
      airplay.discover().catch(() => [] as airplay.AirPlayDevice[]),
      cast.discover().catch(() => [] as cast.CastDevice[]),
    ])
    return [
      ...upnp.map((r): Output => ({ kind: 'upnp', id: r.id, name: r.name, upnp: r })),
      ...air.map((d): Output => ({ kind: 'airplay', id: d.id, name: d.name, airplay: d })),
      ...casts.map((d): Output => ({ kind: 'cast', id: d.id, name: d.name, cast: d })),
    ]
  }

  /**
   * Cast sessions, held open.
   *
   * The odd one out: UPnP and AirPlay are stateless HTTP calls, but a
   * Chromecast's media session id only exists inside a connection. Reconnecting
   * per command would mean a pause with nothing to pause, so the connection
   * lives as long as the music does.
   */
  const castSessions = new Map<string, cast.CastSession>()

  async function castSessionFor(d: cast.CastDevice): Promise<cast.CastSession> {
    const existing = castSessions.get(d.id)
    if (existing) return existing
    const session = new cast.CastSession({ host: d.address, port: d.port })
    await session.open()
    castSessions.set(d.id, session)
    return session
  }

  function closeCast(id: string): void {
    castSessions.get(id)?.close()
    castSessions.delete(id)
  }

  /**
   * The four verbs, over whichever protocol the output speaks.
   *
   * Both are told to fetch a URL rather than being sent audio, which is why one
   * dispatch works for both and why AirPlay is here at all: its other protocol,
   * RAOP, would mean encoding and packetising the stream on this side.
   */
  async function startOn(o: Output, t: any, url: string): Promise<void> {
    if (o.kind === 'upnp') {
      await playUrl(o.upnp, { name: t.name, artist: t.artist, album: t.album, duration: t.duration, url })
      return
    }
    if (o.kind === 'airplay') {
      await airplay.play(o.airplay, url)
      return
    }
    const session = await castSessionFor(o.cast)
    await session.load({
      url,
      // A Chromecast decides what it can play from the content type, so this is
      // the one place the format has to be named honestly rather than guessed.
      contentType: mimeFor(t.format, t.path),
      title: t.name, artist: t.artist, album: t.album, duration: t.duration,
    })
  }

  async function pauseOn(o: Output): Promise<void> {
    if (o.kind === 'upnp') return pauseRenderer(o.upnp).then(() => undefined)
    if (o.kind === 'airplay') return airplay.pause(o.airplay)
    const session = castSessions.get(o.cast.id)
    if (!session) throw new Error('nothing is playing on this device')
    return session.pause()
  }

  async function stopOn(o: Output): Promise<void> {
    if (o.kind === 'upnp') return stopRenderer(o.upnp).then(() => undefined)
    if (o.kind === 'airplay') return airplay.stop(o.airplay)
    const session = castSessions.get(o.cast.id)
    if (!session) return
    await session.stop().catch(() => undefined)
    // Stopped means done: holding the connection open afterwards keeps the
    // receiver app on screen for a device nobody is listening to.
    closeCast(o.cast.id)
  }

  /**
   * Renderers on the network.
   *
   * Discovery is a live SSDP search rather than a stored list: a speaker that
   * was unplugged should stop appearing, and one that was plugged in a minute
   * ago should appear without anyone pressing rescan. It costs a couple of
   * seconds, which is why the result is cached until asked to refresh.
   */
  api.get('/outputs', async (c) => {
    const now = Date.now()
    if (c.req.query('refresh') === 'true' || now - renderers.at > 30_000) {
      renderers = { at: now, items: await discoverOutputs().catch(() => []) }
    }

    // Two kinds, one list. A speaker found by shouting on the network and a
    // satellite that announced itself are the same thing to whoever is choosing
    // where the music comes out.
    const registered = (db.prepare(`SELECT * FROM outputs ORDER BY name`).all() as any[]).map((o) => ({
      id: o.id, name: o.name, kind: o.kind, manufacturer: '', model: '',
      address: o.url, formats: JSON.parse(o.formats || '[]'),
      // Stale rather than gone: a satellite that has not checked in for five
      // minutes is probably unplugged, and saying so beats removing it from a
      // list the user set up.
      stale: now - o.lastSeenAt > 5 * 60_000,
    }))

    return c.json({
      items: [
        ...renderers.items.map((o) => ({
          id: o.id,
          name: o.name,
          kind: o.kind,
          manufacturer: o.kind === 'upnp' ? o.upnp.manufacturer : o.kind === 'airplay' ? 'Apple' : 'Google',
          model: o.kind === 'upnp' ? o.upnp.model : o.kind === 'airplay' ? o.airplay.model : o.cast.model,
          address: o.kind === 'upnp' ? o.upnp.address
            : o.kind === 'airplay' ? `${o.airplay.address}:${o.airplay.port}`
              : `${o.cast.address}:${o.cast.port}`,
          formats: [],
          stale: false,
          // Whether a volume slider would do anything. AirPlay's volume lives
          // in RTSP, a protocol this does not speak, so saying so lets the UI
          // hide the control rather than offer one that silently does nothing.
          volume: o.kind === 'upnp' ? Boolean(o.upnp.volumeUrl) : o.kind === 'cast',
        })),
        ...registered,
      ],
      // What a renderer will be told to fetch. Shown because when it is wrong --
      // a container with several interfaces, a machine behind a proxy -- every
      // play silently fails, and this is the number that explains why.
      advertising: advertisedBase(Number(process.env.PORT ?? 8787)),
    })
  })

  /**
   * A satellite announcing that it can play.
   *
   * The opposite direction from SSDP: a Pi with a DAC has no discovery
   * protocol, so it says so instead. Idempotent on its id, and re-registering
   * is also the heartbeat — a satellite that stops calling goes stale rather
   * than disappearing from a list someone deliberately set up.
   */
  api.post('/outputs/register', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.id || !b?.name || !b?.url) return fail(c, 400, 'bad_body', 'expected { id, name, url, formats? }')
    db.prepare(`
      INSERT INTO outputs (id, name, kind, url, formats, lastSeenAt, registeredAt)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, url = excluded.url, formats = excluded.formats,
        lastSeenAt = excluded.lastSeenAt`)
      .run(b.id, b.name, b.kind ?? 'satellite', b.url,
        JSON.stringify(b.formats ?? []), Date.now(), Date.now())
    return c.json({ registered: b.id })
  })

  api.delete('/outputs/:id', (c) => {
    const r = db.prepare(`DELETE FROM outputs WHERE id = ?`).run(c.req.param('id'))
    return r.changes ? c.body(null, 204) : fail(c, 404, 'not_found', 'unknown output')
  })

  /** Points a renderer at a track and starts it. */
  api.post('/outputs/:id/play', async (c) => {
    const renderer = renderers.items.find((r) => r.id === c.req.param('id'))
    if (!renderer) return fail(c, 404, 'not_found', 'unknown output; try GET /outputs?refresh=true')

    const b = await c.req.json().catch(() => null)
    if (!b?.trackId) return fail(c, 400, 'bad_body', 'expected { trackId }')
    const t = getTrack(db, b.trackId)
    if (!t) return fail(c, 404, 'not_found', 'unknown track')

    const base = advertisedBase(Number(process.env.PORT ?? 8787))
    try {
      await startOn(renderer, t, `${base}/api/v1/stream/${t.id}`)
      return c.json({ playing: t.id, on: renderer.name, url: `${base}/api/v1/stream/${t.id}` })
    } catch (err) {
      return fail(c, 502, 'renderer_refused', err instanceof Error ? err.message : 'the renderer refused')
    }
  })

  for (const [path, action] of [['pause', pauseOn], ['stop', stopOn]] as const) {
    api.post(`/outputs/:id/${path}`, async (c) => {
      const renderer = renderers.items.find((r) => r.id === c.req.param('id'))
      if (!renderer) return fail(c, 404, 'not_found', 'unknown output')
      try {
        await action(renderer)
        return c.body(null, 204)
      } catch (err) {
        return fail(c, 502, 'renderer_refused', err instanceof Error ? err.message : 'the renderer refused')
      }
    })
  }

  api.post('/outputs/:id/volume', async (c) => {
    const renderer = renderers.items.find((r) => r.id === c.req.param('id'))
    if (!renderer) return fail(c, 404, 'not_found', 'unknown output')
    const b = await c.req.json().catch(() => null)
    if (typeof b?.volume !== 'number') return fail(c, 400, 'bad_body', 'expected { volume: 0-100 }')
    if (renderer.kind === 'airplay') {
      // Not a refusal and not a bug: AirPlay's volume lives in RTSP
      // SET_PARAMETER, on the protocol this deliberately does not speak.
      return fail(c, 501, 'not_supported', 'AirPlay volume is not available over its HTTP interface')
    }
    try {
      if (renderer.kind === 'cast') {
        const session = await castSessionFor(renderer.cast)
        await session.setVolume(b.volume)
        return c.body(null, 204)
      }
      await setRendererVolume(renderer.upnp, b.volume)
      return c.body(null, 204)
    } catch (err) {
      return fail(c, 502, 'renderer_refused', err instanceof Error ? err.message : 'the renderer refused')
    }
  })

  /* ---------------- plugins ---------------- */

  api.get('/plugins', (c) => withBodyETag(c, {
    // `commands` is what is registered *now*, which is not the same as what the
    // manifest contributes: a plugin that is installed but not running
    // contributes menu entries that cannot be invoked, and the UI should be
    // able to tell those apart.
    items: listPlugins(db).map((p) => ({ ...p, commands: plugins.commandsOf(p.id) })),
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

  /**
   * Browsing a store.
   *
   * The index URL is given per request rather than baked in. There is no
   * default store, because installing from one is running someone else's code
   * as this server and that has to be a deliberate choice, not a default
   * inherited from whatever this file shipped with.
   */
  api.get('/store', async (c) => {
    const url = c.req.query('index')
    if (!url) return fail(c, 400, 'no_index', 'pass ?index= with the URL of a plugin index')
    try {
      // What this host could actually run is marked, with the reason for the
      // rest -- an install that fails on hostApi should be visible before it is
      // attempted, not after.
      return c.json({ items: compatible(await fetchIndex(url)), hostApi: HOST_API_VERSION })
    } catch (err) {
      return fail(c, 502, 'store_unreachable', err instanceof Error ? err.message : 'cannot read that index')
    }
  })

  api.post('/store/install', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.index || !b?.id) return fail(c, 400, 'bad_body', 'expected { index, id }')
    try {
      const entry = (await fetchIndex(b.index)).find((p) => p.id === b.id)
      if (!entry) return fail(c, 404, 'not_found', `${b.id} is not in that index`)

      const result = await install(entry, plugins.root)
      // Discovered, then activated: the plugin appears in the list with its
      // real manifest whether or not it starts.
      await plugins.discover()
      const plugin = await plugins.activate(result.id)
      return c.json({ ...result, plugin }, 201)
    } catch (err) {
      return fail(c, 400, 'install_failed', err instanceof Error ? err.message : 'install failed')
    }
  })

  api.delete('/store/:id', async (c) => {
    const id = c.req.param('id')
    if (!getPlugin(db, id)) return fail(c, 404, 'not_found', 'unknown plugin')
    await plugins.deactivate(id)
    await uninstall(id, plugins.root)
    db.prepare(`DELETE FROM plugins WHERE id = ?`).run(id)
    return c.body(null, 204)
  })

  /**
   * Runs something a plugin contributed.
   *
   * The errors are split so a status line can say something true. A plugin
   * failing is ordinary and the user's mental model should be "that plugin is
   * broken", never "the server is broken" — so a 500 stays reserved for the
   * second case.
   */
  api.post('/plugins/:id/command', async (c) => {
    const id = c.req.param('id')
    if (!getPlugin(db, id)) return fail(c, 404, 'not_found', 'unknown plugin')

    const b = await c.req.json().catch(() => null)
    if (!b?.command) return fail(c, 400, 'bad_body', 'expected { command, trackIds? }')

    const trackIds: string[] = Array.isArray(b.trackIds) ? b.trackIds : []
    // The tracks travel with the call so a plugin never has to reach into the
    // database, which is the difference between a contract and a convention.
    const tracks = trackIds.length
      ? db.prepare(
          `SELECT id, name, artist, albumArtist, album, genre, year, duration, rating, playCount
           FROM tracks WHERE deletedAt IS NULL AND id IN (${trackIds.map(() => '?').join(',')})`)
          .all(...(trackIds as never[])) as any[]
      : []

    try {
      return c.json(await plugins.run(id, b.command, { trackIds, tracks }))
    } catch (err: any) {
      const status = { plugin_disabled: 409, unknown_command: 404, command_timeout: 504 }[err?.code as string] ?? 400
      return fail(c, status, err?.code ?? 'command_failed',
        err instanceof Error ? err.message : 'the command failed')
    }
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
    return withBodyETag(c, {
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

  /**
   * The sources, each with the filesystem it actually sits on.
   *
   * The mount is what lets a UI say "this NFS share is not mounted" instead of
   * showing a library with nothing in it. Read live rather than stored: a share
   * that came back since the last scan should stop being reported as missing
   * without anyone having to press anything.
   */
  api.get('/sources', async (c) => {
    // Narrowed accounts see the sources they may use and no others: listing the
    // name of a library somebody cannot open tells them it exists, which is
    // most of what hiding it was for.
    const allowed = sourcesFor(db, userOf(c))
    const items = (db.prepare(`SELECT * FROM sources`).all() as any[])
      .filter((s) => !allowed || allowed.includes(s.id))
    const mounts = await readMounts()

    return withETag(c, {
      items: items.map((s) => {
        if (s.kind !== 'local') return s
        const mount = mountFor(s.root, mounts)
        return {
          ...s,
          mount: mount && {
            device: mount.device, type: mount.type,
            network: mount.network, readOnly: mount.readOnly, point: mount.point,
          },
        }
      }),
    })
  })

  api.post('/sources', async (c) => {
    const b = await c.req.json().catch(() => null)
    if (!b?.name || !b?.root) return fail(c, 400, 'bad_body', 'expected { name, root }')
    const id = b.id ?? randomUUID().slice(0, 8)
    // `config` carries what a source needs beyond its root: an rclone daemon
    // URL, a Jellyfin API key. Dropping it silently meant no remote source
    // could ever be created through the API at all -- only by writing the row
    // by hand, which is how every test of one had been doing it.
    db.prepare(
      `INSERT INTO sources (id, kind, name, root, writable, config, rev) VALUES (?,?,?,?,?,?,?)`)
      .run(id, b.kind ?? 'local', b.name, b.root, b.writable ? 1 : 0,
        JSON.stringify(b.config ?? {}), nextRev(db))
    return c.json(db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id), 201)
  })

  /**
   * Does this source actually answer?
   *
   * Worth its own route because the alternative is starting a scan and reading
   * the job's error afterwards, which is a poor way to find out an API key is
   * wrong.
   */
  api.post('/sources/:id/test', async (c) => {
    const src = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(c.req.param('id')) as any
    if (!src) return fail(c, 404, 'not_found', 'unknown source')

    try {
      if (src.kind === 'jellyfin' || src.kind === 'emby') {
        const server = await jfInfo(jfConfigOf(src))
        return c.json({ ok: true, kind: src.kind, name: server.ServerName, version: server.Version })
      }
      if (src.kind === 'plex') {
        const server = await plexInfo(plexConfigOf(src))
        return c.json({ ok: true, kind: src.kind, name: server.name, version: server.version })
      }
      if (src.kind === 'rclone') {
        const v = await rcVersion(configOf(src))
        return c.json({ ok: true, kind: src.kind, name: 'rclone', version: v.version })
      }
      const { accessSync, constants } = await import('node:fs')
      accessSync(src.root, constants.R_OK)
      return c.json({ ok: true, kind: src.kind, name: src.root, version: null })
    } catch (err) {
      return c.json({ ok: false, reason: err instanceof Error ? err.message : 'unreachable' }, 200)
    }
  })

  api.post('/sources/:id/scan', (c) => {
    const id = c.req.param('id')
    if (!db.prepare(`SELECT id FROM sources WHERE id = ?`).get(id)) return fail(c, 404, 'not_found', 'unknown source')
    // `full` re-reads every file instead of trusting mtime and size. It is what
    // to run when the server changes how it derives a field: the files have not
    // moved, so an ordinary scan would skip all of them.
    const full = c.req.query('full') === 'true'
    // A scan that finds nothing where a library used to be refuses to delete
    // it, because an unmounted share and a deleted library look identical from
    // the scanner. This is how to say the second one was meant.
    const prune = c.req.query('prune') === 'true'
    // One key per source: re-triggering a running scan joins it instead of duplicating it.
    // A full scan gets its own key, or it would join the incremental one it was
    // meant to replace.
    const job = jobs.create('scan', { sourceId: id, full, prune },
      { idempotencyKey: c.req.header('idempotency-key') ?? `scan-${id}${full ? '-full' : ''}${prune ? '-prune' : ''}` })
    return c.json(publicJob(job), 202)
  })

  /* ---------------- jobs ---------------- */

  // The most polled list in the server, and the one where a revision ETag
  // would have been most wrong: job progress moves constantly and touches no
  // library counter at all.
  api.get('/jobs', (c) =>
    withBodyETag(c, {
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

  api.get('/schedules', (c) => withBodyETag(c, { items: listSchedules(db) }))

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

    // What the device held before, so that afterwards we can stamp exactly the
    // tracks whose presence changed -- see the end of this handler.
    const before = new Set((db.prepare(
      `SELECT trackId FROM device_tracks WHERE deviceId = ? AND trackId IS NOT NULL`)
      .all(id) as { trackId: string }[]).map((r) => r.trackId))

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
    const after = new Set<string>()
    for (const it of b.items) {
      const hit = (it.fingerprint ? byFp.get(it.fingerprint) : null)
        ?? byMeta.get(it.artist ?? '', it.name ?? '', it.duration ?? 0)
      const trackId = (hit as any)?.id ?? null
      if (trackId) { matched++; after.add(trackId) }
      ins.run(id, it.deviceLocalId, trackId, it.name ?? '', it.artist ?? '', it.album ?? '',
        it.duration ?? 0, it.size ?? 0, it.format ?? '', it.fingerprint ?? null,
        it.sourceUrl ?? null, Date.now())
    }

    /*
     * Stamp the tracks whose presence changed, not just the counter.
     *
     * `devices` travels with the track in every page, so a track arriving on or
     * leaving a device *is* a change to that track as far as any client is
     * concerned. Bumping only the global revision was the worst possible
     * version of this: `delta?since=` selects on the track's own `rev`, so it
     * returned nothing while reporting a higher revision — the client concluded
     * it was up to date and kept presence data that was wrong from then on.
     *
     * The symmetric difference, so a resync that changed nothing costs nothing:
     * a satellite re-reporting the same 10,000 tracks on every heartbeat must
     * not push a delta of 10,000 rows to every client.
     */
    const moved = [...new Set([...before, ...after])].filter((t) => before.has(t) !== after.has(t))
    if (moved.length) {
      const rev = nextRev(db)
      const stamp = db.prepare(`UPDATE tracks SET rev = ? WHERE id = ?`)
      for (const trackId of moved) stamp.run(rev, trackId)
    }
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
  /**
   * Serving a track, shared by the public API and the Subsonic router.
   *
   * A function rather than one route calling the other over HTTP: an internal
   * request would pass back through the auth middleware without a token, and a
   * Subsonic client that has already authenticated would be refused its own
   * music.
   */
  async function serveStream(c: any, id: string, q: { rendition?: string; format?: string; accept?: string }) {
    const flat = db.prepare(
      `SELECT t.path, t.format, t.size, t.mtime, t.externalId, s.root, s.kind, s.config FROM tracks t
       JOIN sources s ON s.id = t.sourceId
       WHERE t.id = ? AND t.deletedAt IS NULL`).get(id) as any
    if (!flat) return fail(c, 404, 'not_found', 'unknown track')

    // Which file, of possibly several. `accept` is a renderer profile: a
    // speaker that only plays mp3 gets the mp3 this library already holds
    // rather than the FLAC it cannot decode. A named rendition that does not
    // exist is a 404 rather than a silent fallback -- a client that asked for
    // one specific file should hear that it is gone.
    const wanted = q.rendition ?? q.format
    const chosen = pickRendition(db, id, q)
    // A named *rendition* that does not exist is a 404 rather than a silent
    // fallback: a client that asked for one specific file should hear it is
    // gone. A named *format* is a different request -- see below, it can be
    // made rather than found.
    if (q.rendition && !chosen) return fail(c, 404, 'not_found', `this track has no ${wanted} rendition`)

    // The flat columns are the preferred rendition's copy and always present,
    // so a track whose rendition rows are missing still plays.
    const t = chosen ?? flat

    // Nothing here plays what was asked for. Rather than handing a speaker a
    // file it cannot decode -- which is silence, and looks like a broken
    // server -- make one.
    const target = transcodeTarget(t.format, q)
    if (target) {
      if (t.kind !== 'local') {
        // A remote source would mean ffmpeg opening an authenticated URL, which
        // is a different problem than this one. Saying so beats a stream that
        // fails halfway.
        return fail(c, 501, 'not_supported',
          `on-the-fly conversion needs a local file; this track lives on a ${t.kind} source`)
      }
      return streamTranscoded(c, join(t.root, t.path), target)
    }

    // Asked for one specific format, and it is neither on disk nor something
    // ffmpeg can pipe. Serving the file we happen to have instead would be the
    // silent fallback this endpoint refuses everywhere else: a client that
    // named a format and got a different one has no way to know.
    if (q.format && String(t.format).toLowerCase() !== q.format.toLowerCase()) {
      return fail(c, 501, 'not_supported',
        `this track is ${t.format} and cannot be served as ${q.format}`)
    }

    // A remote source is proxied rather than read: the range goes upstream and
    // the body flows straight back out. Nothing is copied to local disk, which
    // is the whole reason the source is userspace in the first place.
    if (t.kind === 'rclone') return streamRemote(c, t)
    if (t.kind === 'jellyfin' || t.kind === 'emby') {
      return streamUpstream(c, t, (src, id, range) => jfOpen(jfConfigOf(src), id, range))
    }
    if (t.kind === 'plex') {
      return streamUpstream(c, t, (src, id, range) => plexOpen(plexConfigOf(src), id, range))
    }

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

    const type = mimeFor(t.format, t.path)
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
  }

  api.get('/stream/:id', (c) => serveStream(c, c.req.param('id'), {
    rendition: c.req.query('rendition'),
    format: c.req.query('format'),
    accept: c.req.query('accept'),
  }))

  /* ---------------- cover art ---------------- */

  /**
   * Extracted on demand, never during a scan: reading covers out of 100,000
   * files would make the first scan interminable for a benefit only visible on
   * screen. The ETag comes from the source file's mtime and size, so a retagged
   * file invalidates its own cover.
   */
  async function serveArtwork(c: any, id: string) {
    const t = db.prepare(
      `SELECT t.path, t.mtime, t.size, s.root FROM tracks t
       JOIN sources s ON s.id = t.sourceId WHERE t.id = ?`).get(id) as any
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
  }

  api.get('/artwork/:id', (c) => serveArtwork(c, c.req.param('id')))

  /* ---------------- events ---------------- */

  /** One stream: the client never polls in a loop. */
  api.get('/events', (c) =>
    c.newResponse(
      new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder()
          const send = (event: string, data: unknown) =>
            ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          // The current state on connect, not just future changes: a client
          // that reconnects mid-song would otherwise show nothing until the
          // next thing happened, which on a paused player is never.
          send('hello', { revision: revision(db), player: player.withTrack() })

          const off = jobs.onChange((j) => send('job.progress', publicJob(j)))

          // The shared queue is only shared if a second controller hears about
          // it. Without this the player would have to be polled, which is the
          // one thing this API set out not to make anyone do.
          const onPlayer = (state: unknown) => send('player', state)
          const onPlay = (e: unknown) => send('play', e)
          // Without this, an edit made in another window -- or by a Subsonic
          // client, or by a satellite reporting what is on an iPod -- is
          // invisible until something is polled, which is the one thing this
          // API set out not to make anyone do.
          const onLibrary = (e: unknown) => send('library', e)
          events.on('player', onPlayer)
          events.on('play', onPlay)
          events.on('library', onLibrary)

          const beat = setInterval(() => ctrl.enqueue(enc.encode(': ping\n\n')), 25000)
          c.req.raw.signal.addEventListener('abort', () => {
            off()
            events.off('player', onPlayer)
            events.off('play', onPlay)
            events.off('library', onLibrary)
            clearInterval(beat)
            ctrl.close()
          })
        },
      }),
      200,
      { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    ))

  /**
   * The Subsonic API, at the path two decades of clients expect.
   *
   * Outside `/api/v1` and outside its auth middleware on purpose: Subsonic has
   * its own credentials scheme in the query string, and its own idea that a
   * failure is still an HTTP 200.
   */
  const subsonic = subsonicRouter(db, dbFile)

  /**
   * Streaming and cover art for Subsonic clients.
   *
   * Delegated to the endpoints that already exist rather than reimplemented —
   * `Range`, rendition selection, conversion on the fly and the artwork cache
   * are all there, and a second copy would be a second set of bugs.
   */
  subsonic.app.get('/stream.view', (c) => {
    const id = c.req.query('id')
    if (!id) return c.body(null, 400)
    // `format` is honoured, and now really converts when the library holds
    // nothing that matches. `maxBitRate` is still accepted and ignored: the
    // streaming endpoint takes a format rather than a bitrate, and a client
    // asking for a smaller file would rather have the original than an error.
    return serveStream(c, id, { format: c.req.query('format') || undefined })
  })

  /**
   * Download is the original bytes, always.
   *
   * `format` is deliberately *not* passed through here, which is the whole
   * difference between the two routes now that conversion exists: `stream` may
   * hand over something made for the client, `download` may not. Anything that
   * asks to download a file and receives a re-encode of it has been given the
   * wrong file — an archiver would quietly replace a FLAC library with MP3s,
   * and an analyser would measure the encoder rather than the music.
   */
  subsonic.app.get('/download.view', (c) => {
    const id = c.req.query('id')
    if (!id) return c.body(null, 400)
    return serveStream(c, id, {})
  })

  subsonic.app.get('/getCoverArt.view', (c) => {
    const id = c.req.query('id')
    if (!id) return c.body(null, 400)
    return serveArtwork(c, id)
  })

  /** Subsonic's scrobble, mapped onto the play recording that already exists. */
  subsonic.app.get('/scrobble.view', (c) => {
    const id = c.req.query('id')
    // `submission=false` is a "now playing" ping, not a listen. Recording it
    // would count a play for every track someone skips through.
    if (!id || c.req.query('submission') === 'false') return c.json({ 'subsonic-response': { status: 'ok', version: '1.16.1' } })
    const t = getTrack(db, id)
    if (t) {
      recordPlay(db, events, id, {
        played: t.duration,
        startedAt: Number(c.req.query('time')) || undefined,
      })
    }
    return c.json({ 'subsonic-response': { status: 'ok', version: '1.16.1' } })
  })

  // Mounted last: `app.route` copies the routes that exist when it is called,
  // so anything added to a sub-app afterwards is silently never reachable.
  app.route('/api/v1', api)
  app.route('/rest', subsonic.app)
  app.notFound((c) => fail(c, 404, 'not_found', 'unknown route'))

  // A cast connection is a live socket, so it has to be given back. Without
  // this the process will not exit on its own.
  const closeOutputs = () => {
    for (const id of [...castSessions.keys()]) closeCast(id)
    if (revisionPending) clearTimeout(revisionPending)
    stopRevisionWatch()
  }

  return { app, db, jobs, scheduler, plugins, events, closeOutputs }
}
