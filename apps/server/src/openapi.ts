import type { Hono } from 'hono'

/**
 * The API, described.
 *
 * Generated from the router rather than written beside it. A hand-kept spec
 * drifts the first time someone adds a route in a hurry, and a spec that is
 * quietly missing half the API is worse than none — it is believed.
 *
 * So the *paths* come from `app.routes`, which cannot be wrong, and the prose
 * comes from the table below. A route with no entry still appears, marked
 * undocumented, and the test suite fails on it. That is the part that keeps
 * this honest: you can add a route without describing it, but not without
 * someone noticing.
 */

type Doc = {
  summary: string
  /** Query parameters worth knowing about. */
  query?: string[]
  body?: string
  returns?: string
  tag?: string
}

/** What each route is for. Keyed `METHOD /path` exactly as the router has it. */
const DOCS: Record<string, Doc> = {
  'GET /health': { summary: 'Liveness. The one route that never needs credentials.', tag: 'server' },
  'GET /openapi.json': { summary: 'This document.', tag: 'server' },
  'GET /stats': { summary: 'Library totals, computed in SQL over the whole library rather than a page.', tag: 'server' },

  'GET /auth/state': { summary: 'Whether this install has been claimed yet.', tag: 'auth', returns: '{ open, users }' },
  'POST /auth/setup': { summary: 'Claims a fresh install. Refused once any account exists.', tag: 'auth', body: '{ username, password }' },
  'POST /auth/login': { summary: 'Exchanges a password for a token.', tag: 'auth', body: '{ username, password }' },
  'GET /auth/me': { summary: 'The signed-in user.', tag: 'auth' },
  'GET /auth/tokens': { summary: 'Tokens belonging to the signed-in user. Secrets are never returned.', tag: 'auth' },
  'POST /auth/tokens': { summary: 'Issues a token. The secret is shown once and only its hash is kept.', tag: 'auth' },
  'DELETE /auth/tokens/:id': { summary: 'Revokes a token.', tag: 'auth' },

  'GET /tracks': { summary: 'One page of tracks, with device presence and renditions.', tag: 'library', query: ['sort', 'cursor', 'limit', 'q', 'genre', 'artist', 'album', 'format', 'kind', 'sourceId', 'onDevice', 'notOnDevice', 'match'] },
  'GET /tracks/count': { summary: 'How many tracks a query matches.', tag: 'library' },
  'GET /tracks/delta': { summary: 'What changed since a revision. The main network win.', tag: 'library', query: ['since', 'limit'] },
  'GET /tracks/missing': { summary: 'Tracks whose file the scanner can no longer find.', tag: 'library' },
  'GET /tracks/:id': { summary: 'One track.', tag: 'library' },
  'PATCH /tracks': { summary: 'Edits one or many. Tag writing to disk becomes a job.', tag: 'library', body: '{ ids, patch, writeToFiles? }' },
  'POST /tracks/:id/play': { summary: 'Records a listen. Half the length or four minutes, never under thirty seconds.', tag: 'library', body: '{ played, startedAt? }' },
  'GET /facets': { summary: 'Distinct genres, artists, albums and formats, with counts.', tag: 'library' },
  'GET /artwork/:id': { summary: 'Cover art, extracted on demand and ETagged on the file.', tag: 'library' },
  'GET /stream/:id': { summary: 'The audio, honouring Range.', tag: 'library', query: ['rendition', 'format', 'accept'] },

  'GET /playlists': { summary: 'Every playlist, manual and smart.', tag: 'playlists' },
  'POST /playlists': { summary: 'Creates one.', tag: 'playlists', body: '{ name, smart?, rules?, trackIds? }' },
  'GET /playlists/:id': { summary: 'One playlist.', tag: 'playlists' },
  'PATCH /playlists/:id': { summary: 'Renames it.', tag: 'playlists' },
  'DELETE /playlists/:id': { summary: 'Deletes it.', tag: 'playlists' },
  'GET /playlists/:id/tracks': { summary: 'Its contents. A smart playlist runs its query.', tag: 'playlists' },
  'POST /playlists/:id/tracks': { summary: 'Adds tracks, deduplicated.', tag: 'playlists' },
  'DELETE /playlists/:id/tracks': { summary: 'Removes tracks.', tag: 'playlists' },
  'PUT /playlists/:id/order': { summary: 'Moves a batch, preserving its relative order.', tag: 'playlists' },

  'GET /sources': { summary: 'Where the music lives.', tag: 'sources' },
  'POST /sources': { summary: 'Adds a source. `rclone` sources carry `config: { url, fs }`.', tag: 'sources' },
  'POST /sources/:id/scan': { summary: 'Indexes it. `?full=true` re-reads files an incremental scan would skip.', tag: 'sources', query: ['full'] },
  'GET /duplicates': { summary: 'Rows that look like one song. Proposes; never merges.', tag: 'sources' },
  'POST /duplicates/merge': { summary: 'Folds tracks into one, moving their files across as renditions.', tag: 'sources', body: '{ keeperId, ids }' },
  'POST /organize': { summary: 'What moving files into a pattern would do. Dry unless `apply`.', tag: 'sources', body: '{ sourceId, pattern, apply? }' },
  'POST /organize/:jobId/undo': { summary: 'Puts a reorganisation back, newest move first.', tag: 'sources' },
  'GET /organize/log': { summary: 'Every file a reorganisation moved.', tag: 'sources' },
  'GET /transcode/capabilities': { summary: 'Whether ffmpeg is present, and what it can write.', tag: 'sources' },
  'POST /transcode': { summary: 'Converts a selection. `replace: false` keeps both as renditions.', tag: 'sources', body: '{ ids, format, quality?, replace }' },

  'GET /devices': { summary: 'Connected devices.', tag: 'devices' },
  'POST /devices': { summary: 'Satellite registration. Idempotent on the device id.', tag: 'devices' },
  'GET /devices/:id/tracks': { summary: 'What the device actually holds, library or not.', tag: 'devices' },
  'PUT /devices/:id/tracks': { summary: 'A satellite reporting the device contents.', tag: 'devices' },
  'PATCH /devices/:id': { summary: 'Renames it or changes what it syncs.', tag: 'devices' },
  'POST /devices/:id/sync': { summary: 'Syncs. With `dryRun` returns the plan and writes nothing.', tag: 'devices' },
  'POST /devices/:id/backup': { summary: 'Backs the device up.', tag: 'devices' },
  'POST /devices/:id/eject': { summary: 'Disconnects without forgetting anything.', tag: 'devices' },
  'POST /devices/:id/import': { summary: 'Pulls tracks the device has and the library does not.', tag: 'devices' },
  'POST /devices/:id/wanted': { summary: 'Hand-picks tracks for a device. They join the sync rules.', tag: 'devices' },
  'DELETE /devices/:id/wanted': { summary: 'Un-picks them.', tag: 'devices' },
  'GET /devices/:id/stats': { summary: 'Counts and orphans on the device.', tag: 'devices' },

  'GET /player': { summary: 'The shared queue: what is playing, where, and who last changed it.', tag: 'player' },
  'PUT /player/queue': { summary: 'Replaces the queue and starts it.', tag: 'player', body: '{ trackIds, startAt? }' },
  'POST /player/queue': { summary: 'Adds to it. `next: true` puts them after the current track.', tag: 'player', body: '{ trackIds, next? }' },
  'DELETE /player/queue': { summary: 'Empties it.', tag: 'player' },
  'POST /player/play': { summary: 'Resumes.', tag: 'player' },
  'POST /player/pause': { summary: 'Pauses.', tag: 'player' },
  'POST /player/next': { summary: 'Next track. Stops at the end unless repeat is on.', tag: 'player' },
  'POST /player/previous': { summary: 'Previous track, or restarts this one.', tag: 'player' },
  'POST /player/seek': { summary: 'Moves the playhead.', tag: 'player', body: '{ position }' },
  'POST /player/goto': { summary: 'Jumps to a track already in the queue.', tag: 'player', body: '{ trackId }' },
  'PATCH /player': { summary: 'Changes the output, repeat or shuffle.', tag: 'player', body: '{ target?, repeat?, shuffle? }' },
  'POST /player/report': { summary: 'A renderer saying where it actually is. It may not reorder anything.', tag: 'player', body: '{ position, playing? }' },

  'GET /outputs': { summary: 'Renderers on the network, found by SSDP.', tag: 'outputs', query: ['refresh'] },
  'POST /outputs/:id/play': { summary: 'Points a renderer at a track and starts it.', tag: 'outputs' },
  'POST /outputs/:id/pause': { summary: 'Pauses it.', tag: 'outputs' },
  'POST /outputs/:id/stop': { summary: 'Stops it.', tag: 'outputs' },
  'POST /outputs/:id/volume': { summary: 'Sets its volume, 0 to 100.', tag: 'outputs' },

  'GET /podcasts': { summary: 'Subscriptions.', tag: 'podcasts' },
  'POST /podcasts': { summary: 'Subscribes and fetches straight away.', tag: 'podcasts', body: '{ feedUrl, cron?, keepLast?, autoDownload? }' },
  'GET /podcasts/:id': { summary: 'One subscription.', tag: 'podcasts' },
  'PATCH /podcasts/:id': { summary: 'Changes its refresh, retention or destination.', tag: 'podcasts' },
  'DELETE /podcasts/:id': { summary: 'Unsubscribes.', tag: 'podcasts' },
  'GET /podcasts/:id/episodes': { summary: 'Episodes, newest first.', tag: 'podcasts' },
  'POST /podcasts/:id/refresh': { summary: 'Refreshes now. Conditional: unchanged feeds cost no body.', tag: 'podcasts' },

  'GET /radios': { summary: 'Stations.', tag: 'radios' },
  'POST /radios': { summary: 'Adds one, discovering its name and logo unless told not to.', tag: 'radios' },
  'GET /radios/:id': { summary: 'One station.', tag: 'radios' },
  'PATCH /radios/:id': { summary: 'Edits it.', tag: 'radios' },
  'DELETE /radios/:id': { summary: 'Removes it.', tag: 'radios' },
  'POST /radios/:id/discover': { summary: 'Re-runs discovery, filling blanks only.', tag: 'radios' },

  'GET /jobs': { summary: 'Background work.', tag: 'jobs' },
  'GET /jobs/:id': { summary: 'One job.', tag: 'jobs' },
  'GET /jobs/:id/items': { summary: 'What it did item by item, with counts over the whole job.', tag: 'jobs' },
  'PATCH /jobs/:id': { summary: 'Pauses or resumes it.', tag: 'jobs' },
  'DELETE /jobs/:id': { summary: 'Cancels it.', tag: 'jobs' },
  'GET /events': { summary: 'Server-sent events. One stream; clients never poll.', tag: 'jobs' },

  'GET /schedules': { summary: 'Recurring work.', tag: 'schedules' },
  'POST /schedules': { summary: 'Adds one. The cron expression is validated now, not at fire time.', tag: 'schedules' },
  'PATCH /schedules/:id': { summary: 'Edits it.', tag: 'schedules' },
  'DELETE /schedules/:id': { summary: 'Removes it.', tag: 'schedules' },
  'POST /schedules/:id/run': { summary: 'Runs it now, without moving its next occurrence.', tag: 'schedules' },

  'GET /plugins': { summary: 'Installed plugins, and what each can be asked to do right now.', tag: 'plugins' },
  'POST /plugins/scan': { summary: 'Re-reads the plugin folder. Failures are listed with their reason.', tag: 'plugins' },
  'GET /plugins/:id': { summary: 'One plugin.', tag: 'plugins' },
  'PATCH /plugins/:id': { summary: 'Enables, disables or configures it.', tag: 'plugins' },
  'POST /plugins/:id/command': { summary: 'Runs something a plugin contributed.', tag: 'plugins', body: '{ command, trackIds? }' },
  'GET /store': { summary: 'Browses a plugin index. There is no default store, on purpose.', tag: 'plugins', query: ['index'] },
  'POST /store/install': { summary: 'Downloads, verifies and installs one.', tag: 'plugins', body: '{ index, id }' },
  'DELETE /store/:id': { summary: 'Uninstalls it.', tag: 'plugins' },

  'GET /backup': { summary: 'Everything a rescan cannot rebuild. Secrets excluded unless asked.', tag: 'backup', query: ['secrets'] },
  'POST /restore': { summary: 'Applies a backup. Adds; never replaces.', tag: 'backup' },
}

/** Hono's `:id` becomes OpenAPI's `{id}`. */
const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}')

const params = (path: string) =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map(([, name]) => ({
    name, in: 'path', required: true, schema: { type: 'string' },
  }))

export type RouteEntry = { method: string; path: string; documented: boolean }

/** Every route the server actually serves, and whether it is described. */
export function routeTable(app: Hono): RouteEntry[] {
  const seen = new Set<string>()
  const out: RouteEntry[] = []

  for (const r of app.routes) {
    // `ALL` is middleware, not an endpoint. Hono lists both.
    if (r.method === 'ALL') continue
    if (!r.path.startsWith('/api/v1')) continue

    const path = r.path.slice('/api/v1'.length) || '/'
    const key = `${r.method} ${path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ method: r.method, path, documented: key in DOCS })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
}

export function buildOpenApi(app: Hono, version = '1.0.0'): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const route of routeTable(app)) {
    const doc = DOCS[`${route.method} ${route.path}`]
    const key = toOpenApiPath(route.path)
    paths[key] ??= {}

    paths[key][route.method.toLowerCase()] = {
      // An undocumented route still appears. Hiding it would make the spec
      // wrong rather than incomplete, and the test suite fails on it anyway.
      summary: doc?.summary ?? 'Undocumented.',
      tags: [doc?.tag ?? 'other'],
      parameters: [
        ...params(route.path),
        ...(doc?.query ?? []).map((name) => ({
          name, in: 'query', required: false, schema: { type: 'string' },
        })),
      ],
      ...(doc?.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'object' }, example: doc.body } },
            },
          }
        : {}),
      responses: {
        '200': { description: doc?.returns ?? 'Success.' },
        '401': { description: 'No or invalid token, once this server has an account.' },
        '404': { description: 'No such thing.' },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'jukebox',
      version,
      description:
        'A self-hosted music library. Everything the first-party front end does, it does through '
        + 'this API and nothing else — there is no privileged route, which is the only way that '
        + 'guarantee means anything.\n\n'
        + 'Five rules shape it: cursor pagination and never OFFSET, revision-based deltas, '
        + 'collection ETags, one round trip per page with presence and renditions embedded, and '
        + 'server-sent events rather than polling.\n\n'
        + 'A Subsonic-compatible API is also served at `/rest`, which this document does not '
        + 'describe: it is somebody else\'s specification and is documented by them.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        // `<audio src>` cannot set a header, so the token is also accepted in
        // the query string. Documented because it looks like a mistake
        // otherwise.
        query: { type: 'apiKey', in: 'query', name: 'token' },
      },
    },
    security: [{ bearer: [] }, { query: [] }],
    paths,
  }
}
