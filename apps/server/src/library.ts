import type { DB } from './db.ts'
import { clampLimit, cursorWhere, decodeCursor, encodeCursor, orderBy, parseSort } from './paging.ts'

export type TrackQuery = {
  sort?: string
  cursor?: string
  limit?: unknown
  kind?: string
  q?: string
  genre?: string
  artist?: string
  album?: string
  /** Codec name as stored: `mp3`, `aac`, `alac`, `flac`, `opus`, `vorbis`, `wav`, `aiff`. */
  format?: string
  /** A tag the listener wrote. One at a time; two of them is a smart playlist. */
  tag?: string
  /** A field left empty: `album`, `artist`, `genre`, `year`, `track`, `artwork`, or `any`. */
  missing?: string
  /** Everything under a folder, as a prefix of the stored path. */
  folder?: string
  sourceId?: string
  /**
   * The sources this request may see at all, or absent for every one.
   *
   * Not a filter the client chooses: it comes from the account, and it is
   * applied in SQL beside the others for the reason every filter here is —
   * narrowing a page after fetching it would answer "3 tracks" for a library
   * of four hundred, and would leak the count of what was hidden.
   */
  sourceIds?: string[]
  /**
   * Rating filters. Typed loosely on purpose: the route hands the raw query
   * object through, so these arrive as strings from HTTP and as numbers from
   * the SDK, and both have to mean the same thing.
   */
  rating?: number | string
  ratingMin?: number | string
  /** Whether the file that would play is lossless. Asked of the rendition. */
  lossless?: boolean | string
  /** Present on this device (comma-separated ids). */
  onDevice?: string
  /** Missing from this device — the question that matters when syncing. */
  notOnDevice?: string
  /** `all`: on *every* listed device. `any` (default): on at least one. */
  match?: string
}

const COLUMNS = `t.id, t.sourceId, t.path, t.kind, t.name, t.artist, t.albumArtist, t.album,
  t.genre, t.composer, t.year, t.trackNumber, t.trackCount, t.discNumber, t.duration,
  t.bitRate, t.sampleRate, t.format, t.size, t.rating, t.loved, t.enabled, t.comments,
  t.grouping, t.bpm, t.compilation, t.playCount, t.skipCount, t.dateAdded, t.lastPlayed,
  t.artworkHash, t.rev`

const ids = (csv: string) => csv.split(',').map((s) => s.trim()).filter(Boolean)

/**
 * Every playlist and device that holds one track.
 *
 * The playlist half cannot be answered by a client, and that is the reason this
 * route exists rather than convenience: a smart playlist's membership is a
 * query, not a stored list, so "is this track in it" is the rules engine's
 * question. Anything computed client-side would be wrong for exactly the
 * playlists people care most about.
 */
export type Memberships = {
  playlists: { id: string; name: string; smart: string | null; position: number | null }[]
  devices: { id: string; name: string; wanted: boolean; present: boolean }[]
}

export function membershipsOf(db: DB, trackId: string, smart: (rules: any) => { where: string; params: unknown[]; limit: number }): Memberships | null {
  if (!db.prepare(`SELECT id FROM tracks WHERE id = ? AND deletedAt IS NULL`).get(trackId)) return null

  const playlists: Memberships['playlists'] = []

  for (const p of db.prepare(`SELECT * FROM playlists WHERE deletedAt IS NULL ORDER BY createdAt`)
    .all() as any[]) {
    if (!p.smart) {
      const row = db.prepare(
        `SELECT position FROM playlist_tracks WHERE playlistId = ? AND trackId = ?`)
        .get(p.id, trackId) as any
      // Position is worth having: "track 4 of Jazz for the evening" says where
      // you put it, which is most of why anyone opens this.
      if (row) playlists.push({ id: p.id, name: p.name, smart: null, position: row.position })
      continue
    }

    // A smart playlist is asked, not read. The rules run with the track pinned,
    // which is the same query the playlist itself uses -- so the answer cannot
    // drift from what the playlist would actually show.
    const q = smart(p.rules ? JSON.parse(p.rules) : {})
    const hit = db.prepare(
      `SELECT id FROM (SELECT id FROM tracks WHERE ${q.where} LIMIT ${q.limit}) WHERE id = ?`)
      .get(...([...q.params, trackId] as never[]))
    if (hit) playlists.push({ id: p.id, name: p.name, smart: p.smart, position: null })
  }

  // `present` and `wanted` are different facts and the second is the reason to
  // look: a track hand-picked for the iPod that has not synced yet is exactly
  // the case someone opens this menu to check.
  const devices = (db.prepare(
    `SELECT d.id, d.name,
            EXISTS (SELECT 1 FROM device_wanted w WHERE w.deviceId = d.id AND w.trackId = ?) AS wanted,
            EXISTS (SELECT 1 FROM device_tracks t WHERE t.deviceId = d.id AND t.trackId = ?) AS present
     FROM devices d ORDER BY d.name`).all(trackId, trackId) as any[])
    .map((d) => ({ id: d.id, name: d.name, wanted: Boolean(d.wanted), present: Boolean(d.present) }))
    .filter((d) => d.wanted || d.present)

  return { playlists, devices }
}

export type Rendition = {
  id: string
  format: string
  bitRate: number
  sampleRate: number
  channels: number
  size: number
  lossless: 0 | 1
  preferred: 0 | 1
  path: string
  sourceId: string
}

/**
 * Which file to serve for a track.
 *
 * Order of preference: an explicitly named rendition, then one whose format the
 * caller said it accepts, then the preferred one. That middle case is what a
 * renderer profile is: a speaker that only plays mp3 should be handed the mp3
 * this library already holds rather than the FLAC it cannot decode.
 *
 * Returns `null` only when the track has no renditions at all, which callers
 * must handle by falling back to the track's own flat columns -- those are the
 * preferred rendition's copy and always present.
 */
export function pickRendition(
  db: DB,
  trackId: string,
  opts: { rendition?: string; format?: string; accept?: string } = {},
): (Rendition & { root: string; kind: string; config: string; externalId: string | null }) | null {
  // `externalId` comes from the track rather than the rendition: it is the
  // upstream server's id for the song, and it is what a Jellyfin or Plex stream
  // URL is keyed on. Without it here the stream falls back to the file path,
  // which those servers do not answer to -- a 404 that only shows up against a
  // real server.
  const rows = db.prepare(
    `SELECT r.id, r.format, r.bitRate, r.sampleRate, r.channels, r.size, r.lossless,
            r.preferred, r.path, r.sourceId, s.root, s.kind, s.config, t.externalId
     FROM renditions r
     JOIN sources s ON s.id = r.sourceId
     JOIN tracks t ON t.id = r.trackId
     WHERE r.trackId = ? ORDER BY r.preferred DESC`).all(trackId) as any[]
  if (!rows.length) return null

  if (opts.rendition) return rows.find((r) => r.id === opts.rendition) ?? null
  if (opts.format) {
    const want = opts.format.toLowerCase()
    return rows.find((r) => String(r.format).toLowerCase() === want) ?? null
  }
  if (opts.accept) {
    const accepted = opts.accept.split(',').map((f) => f.trim().toLowerCase()).filter(Boolean)
    // Lossless first among the acceptable ones: if a device takes both ALAC and
    // AAC, it should get the better file, not whichever was scanned first.
    const playable = rows.filter((r) => accepted.includes(String(r.format).toLowerCase()))
    if (playable.length) {
      return playable.find((r) => r.lossless) ?? playable[0]
    }
    // Nothing it accepts. The preferred one is returned rather than nothing:
    // transcoding on the fly is the streaming endpoint's business, and it needs
    // a source file to work from.
  }
  return rows[0]
}

/**
 * The renditions of a page of tracks, in one query.
 *
 * One query for the page rather than one per track: a 300-row page would
 * otherwise be 301 round trips to SQLite, which is the shape of every slow
 * listing endpoint ever written.
 */
export function renditionsFor(db: DB, trackIds: string[]): Map<string, Rendition[]> {
  const out = new Map<string, Rendition[]>()
  if (!trackIds.length) return out
  const rows = db.prepare(
    `SELECT id, trackId, format, bitRate, sampleRate, channels, size, lossless, preferred, path, sourceId
     FROM renditions WHERE trackId IN (${trackIds.map(() => '?').join(',')})
     ORDER BY preferred DESC, format`).all(...(trackIds as never[])) as any[]
  for (const r of rows) {
    const { trackId, ...rest } = r
    out.set(trackId, [...(out.get(trackId) ?? []), rest as Rendition])
  }
  return out
}

/**
 * A query-string value as a number, or null for "not asked".
 *
 * Everything arrives as a string here — the route hands the raw query object
 * straight through — so `rating=0` has to survive, and `rating=` has to not
 * become 0. Those are opposite answers to the same screen.
 */
function number(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * The same for booleans, where the string form is the trap: `lossless=false` is
 * a non-empty string, so anything testing it for truthiness filters for exactly
 * the opposite of what was asked.
 */
function bool(v: unknown): boolean | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'boolean') return v
  const s = String(v).toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return null
}

/**
 * Builds the filter clause. Device presence is computed here, in SQL — never by
 * filtering a page that was already fetched, or a 200-row page can return 3 and
 * the UI looks empty while 40,000 tracks are still waiting behind it.
 */
function filters(qs: TrackQuery): { sql: string[]; params: unknown[] } {
  const sql = ['t.deletedAt IS NULL']
  const params: unknown[] = []

  for (const [col, val] of [
    ['t.kind', qs.kind], ['t.genre', qs.genre], ['t.albumArtist', qs.artist],
    ['t.album', qs.album], ['t.sourceId', qs.sourceId],
  ] as const) {
    if (val) { sql.push(`${col} = ?`); params.push(val) }
  }

  // Lowercased rather than matched case-sensitively: the column is written
  // lowercase by the scanner, but a client typing `FLAC` should not silently
  // get nothing back.
  if (qs.format) { sql.push(`lower(t.format) = lower(?)`); params.push(qs.format) }

  /**
   * Fields left empty, which is what "consolidate the library" is about.
   *
   * The scanner writes `''` and `0` rather than NULL, so this is an equality
   * test and not `IS NULL`.
   *
   * There is no `artwork`, and its absence is the interesting part: the column
   * exists and *nothing writes it*. Covers are read on demand rather than
   * during a scan — opening a hundred thousand files for their artwork would
   * make a first scan interminable — so `artworkHash IS NULL` is true of every
   * track ever scanned. A filter on it would return the whole library while
   * looking like it worked, which is worse than not offering it.
   */
  const EMPTY: Record<string, string> = {
    album: `t.album = ''`,
    artist: `(t.artist = '' AND t.albumArtist = '')`,
    // Its own case rather than part of `artist`, because of what it breaks: the
    // `?artist=` filter and the artists facet both read `albumArtist`, so a
    // track with an artist and an empty album artist looks complete in a
    // listing and cannot be reached by browsing artists at all. The scanner
    // falls back to the artist, so this only happens to a file carrying an
    // explicitly empty tag — rare, and invisible without asking for it.
    albumartist: `(t.artist <> '' AND t.albumArtist = '')`,
    genre: `t.genre = ''`,
    year: `t.year = 0`,
    track: `t.trackNumber = 0`,
  }
  if (qs.missing) {
    const clause = qs.missing === 'any'
      ? `(${Object.values(EMPTY).join(' OR ')})`
      : EMPTY[qs.missing]
    // An unknown field name filters for nothing rather than everything: a typo
    // in a query parameter must not quietly return the whole library.
    sql.push(clause ?? '0')
  }

  if (qs.folder) {
    // A prefix, with the separator forced on: without it `/music/Live` would
    // also take `/music/Live Sessions`, which is a different folder.
    const prefix = qs.folder.endsWith('/') ? qs.folder : `${qs.folder}/`
    // `\` escapes the LIKE wildcards, or a folder containing `_` — which is
    // most of them — matches any character in that position.
    sql.push(`t.path LIKE ? ESCAPE '\\'`)
    params.push(`${prefix.replace(/([%_\\])/g, '\\$1')}%`)
  }

  // Tags are a table, so this is an EXISTS rather than a join: a join would
  // multiply the row by its tags and turn a page of 300 into a page of 300
  // repeated as many times as anyone was thorough.
  if (qs.tag) {
    sql.push(`EXISTS (SELECT 1 FROM track_tags tt WHERE tt.trackId = t.id AND tt.tag = ?)`)
    params.push(qs.tag)
  }

  if (qs.sourceIds) {
    // An empty list is "no sources", not "no filter". Reading it as the latter
    // would show a narrowed account the entire library the moment its last
    // source was taken away.
    if (!qs.sourceIds.length) sql.push(`0`)
    else {
      sql.push(`t.sourceId IN (${qs.sourceIds.map(() => '?').join(',')})`)
      params.push(...qs.sourceIds)
    }
  }

  // Rating. Both forms exist because they answer different questions: `rating=0`
  // is "what have I never rated", which is the query people run when tidying a
  // library, and `ratingMin=4` is "the good stuff". Folding them into one
  // parameter loses the first.
  const rating = number(qs.rating)
  const ratingMin = number(qs.ratingMin)
  if (rating !== null) { sql.push(`t.rating = ?`); params.push(rating) }
  if (ratingMin !== null) { sql.push(`t.rating >= ?`); params.push(ratingMin) }

  const lossless = bool(qs.lossless)
  if (lossless !== null) {
    // Asked of the rendition, not derived from the codec name. "Is this a lossy
    // copy" is a property of the file, and a client enumerating
    // flac|alac|wav|aiff is a rule that rots the day another codec is
    // supported. The preferred rendition is the one that would actually play.
    sql.push(`COALESCE((SELECT r.lossless FROM renditions r
                        WHERE r.trackId = t.id ORDER BY r.preferred DESC LIMIT 1), 0) = ?`)
    params.push(lossless ? 1 : 0)
  }

  if (qs.q?.trim()) {
    // FTS5 over an external content table: fetch the rowids, join on them.
    // OR the file path, which FTS does not index: the case this serves is a
    // file whose tags say one thing and whose name on disk says another — a
    // re-rip, a download — and what the person types is what they saw in the
    // path. A LIKE scan only runs when a search is typed, and every word must
    // appear in the path for it to count, mirroring the FTS AND.
    const words = qs.q.trim().split(/\s+/)
    sql.push(`(t.rowid IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?)
               OR (${words.map(() => `t.path LIKE ? ESCAPE '\\'`).join(' AND ')}))`)
    params.push(words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' '))
    params.push(...words.map((w) => `%${w.replace(/([%_\\])/g, '\\$1')}%`))
  }

  if (qs.onDevice) {
    const list = ids(qs.onDevice)
    if (qs.match === 'all') {
      // On *every* listed device: count the distinct matches.
      sql.push(`(SELECT COUNT(DISTINCT deviceId) FROM device_tracks
                 WHERE trackId = t.id AND deviceId IN (${list.map(() => '?').join(',')})) = ?`)
      params.push(...list, list.length)
    } else {
      sql.push(`EXISTS (SELECT 1 FROM device_tracks
                        WHERE trackId = t.id AND deviceId IN (${list.map(() => '?').join(',')}))`)
      params.push(...list)
    }
  }

  if (qs.notOnDevice) {
    const list = ids(qs.notOnDevice)
    sql.push(`NOT EXISTS (SELECT 1 FROM device_tracks
                          WHERE trackId = t.id AND deviceId IN (${list.map(() => '?').join(',')}))`)
    params.push(...list)
  }

  return { sql, params }
}

/**
 * A full page in one round trip: metadata **and** device presence. One call per
 * track to learn whether it is on the iPod would be 200 requests per screen.
 */
function withPresence(db: DB, rows: any[]): any[] {
  if (rows.length === 0) return rows
  const placeholders = rows.map(() => '?').join(',')
  const links = db
    .prepare(`SELECT trackId, deviceId FROM device_tracks WHERE trackId IN (${placeholders})`)
    .all(...(rows.map((r) => r.id) as never[])) as { trackId: string; deviceId: string }[]

  const byTrack = new Map<string, string[]>()
  for (const l of links) {
    const cur = byTrack.get(l.trackId)
    cur ? cur.push(l.deviceId) : byTrack.set(l.trackId, [l.deviceId])
  }
  // Renditions ride along on the same page, for the same reason: a listing that
  // shows a format column, or a sync that has to pick a playable file, must not
  // turn one page into three hundred queries.
  const byRendition = renditionsFor(db, rows.map((r) => r.id))

  // Same one-query-per-page rule: a tag column, or a window that shows the tags
  // of a track, must not cost a request each.
  const byTag = new Map<string, string[]>()
  for (const t of db
    .prepare(`SELECT trackId, tag FROM track_tags WHERE trackId IN (${placeholders}) ORDER BY tag`)
    .all(...(rows.map((r) => r.id) as never[])) as { trackId: string; tag: string }[]) {
    const cur = byTag.get(t.trackId)
    cur ? cur.push(t.tag) : byTag.set(t.trackId, [t.tag])
  }

  for (const r of rows) {
    r.devices = byTrack.get(r.id) ?? []
    r.tags = byTag.get(r.id) ?? []
    r.renditions = byRendition.get(r.id) ?? []
    r.loved = !!r.loved
    r.enabled = !!r.enabled
    r.compilation = !!r.compilation
    r.artwork = `/api/v1/artwork/${r.id}`
    delete r.artworkHash
  }
  return rows
}

export function listTracks(db: DB, qs: TrackQuery) {
  const keys = parseSort(qs.sort)
  const limit = clampLimit(qs.limit)
  const f = filters(qs)
  const params = [...f.params]

  const cursorValues = decodeCursor(qs.cursor, keys.length)
  if (cursorValues) {
    const w = cursorWhere(keys.map((k) => ({ ...k, column: 't.' + k.column })), cursorValues)
    f.sql.push(w.sql)
    params.push(...w.params)
  }

  const where = f.sql.join(' AND ')
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM tracks t WHERE ${where}
              ORDER BY ${orderBy(keys.map((k) => ({ ...k, column: 't.' + k.column })))}
              LIMIT ?`)
    .all(...([...params, limit] as never[])) as any[]

  const next =
    rows.length === limit
      ? encodeCursor(keys.map((k) => rows[rows.length - 1][k.column]))
      : null

  return { items: withPresence(db, rows), next }
}

export function getTrack(db: DB, id: string) {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM tracks t WHERE t.id = ? AND t.deletedAt IS NULL`)
    .all(id) as any[]
  return withPresence(db, rows)[0] ?? null
}

/**
 * Distinct values for the column browser.
 *
 * It needs *every* value, not one page's worth — otherwise it only lists the
 * genres of the 300 loaded tracks. And it cascades: picking a genre narrows the
 * artists on offer, like iTunes. Each pane is therefore computed with the
 * filters of the panes to its left, never its own.
 */
export function facets(db: DB, qs: TrackQuery) {
  const distinct = (column: 'genre' | 'albumArtist' | 'album' | 'format', scope: TrackQuery) => {
    const f = filters(scope)
    return (db
      .prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM tracks t
                WHERE ${f.sql.join(' AND ')} AND ${column} <> ''
                GROUP BY ${column} ORDER BY ${column} COLLATE NOCASE ASC`)
      .all(...(f.params as never[])) as { value: string; count: number }[])
  }

  const base = {
    kind: qs.kind, q: qs.q, sourceId: qs.sourceId, onDevice: qs.onDevice, notOnDevice: qs.notOnDevice,
    rating: qs.rating, ratingMin: qs.ratingMin, lossless: qs.lossless, sourceIds: qs.sourceIds,
  }
  return {
    genres: distinct('genre', base),
    artists: distinct('albumArtist', { ...base, genre: qs.genre }),
    albums: distinct('album', { ...base, genre: qs.genre, artist: qs.artist }),
    // Deliberately not cascaded with the other three. Format is orthogonal to
    // genre and artist -- "which formats does this library hold" is the useful
    // question, and narrowing it by the browser selection would offer a filter
    // that empties itself as soon as it is used.
    formats: distinct('format', base),
    // From the table, so the answer is "every tag in the library" rather than
    // "every tag on this page" -- the whole reason the column browser asks the
    // server. Not cascaded, for the same reason as formats.
    tags: tagFacet(db, base),
    folders: folderFacet(db, base),
  }
}

/**
 * Every folder holding a track, with how many it holds.
 *
 * `rtrim(path, replace(path, '/', ''))` is the SQLite idiom for "everything up
 * to the last slash": the second argument is the path with its slashes removed,
 * and trimming those characters from the right stops at the final separator.
 * Doing it in SQL rather than over a page is the point — a folder picker built
 * from the loaded rows would offer three folders for a library with two
 * hundred, and the count beside each would be the page's.
 */
function folderFacet(db: DB, scope: TrackQuery): { value: string; count: number }[] {
  const f = filters(scope)
  return db
    .prepare(`SELECT rtrim(t.path, replace(t.path, '/', '')) AS value, COUNT(*) AS count
              FROM tracks t WHERE ${f.sql.join(' AND ')} AND t.path LIKE '%/%'
              GROUP BY value ORDER BY value COLLATE NOCASE ASC`)
    .all(...(f.params as never[])) as { value: string; count: number }[]
}

/** Every tag in scope, with how many tracks carry it. */
function tagFacet(db: DB, scope: TrackQuery): { value: string; count: number }[] {
  const f = filters(scope)
  return db
    .prepare(`SELECT tt.tag AS value, COUNT(*) AS count
              FROM track_tags tt JOIN tracks t ON t.id = tt.trackId
              WHERE ${f.sql.join(' AND ')}
              GROUP BY tt.tag ORDER BY tt.tag COLLATE NOCASE ASC`)
    .all(...(f.params as never[])) as { value: string; count: number }[]
}

/**
 * Adds and removes tags on a set of tracks in one call.
 *
 * Add-and-remove rather than "here are the tags now", because the interface
 * offers this on a selection: replacing would mean a hundred tracks silently
 * losing every tag they did not have in common. Tags are trimmed and lowercased
 * on the way in — "Chill", "chill " and "chill" are one tag, and a library that
 * treats them as three is a library where filtering by tag finds a third of
 * what it should.
 */
export function tagTracks(
  db: DB,
  ids: string[],
  add: string[] = [],
  remove: string[] = [],
  /** Stamped on every track that changed, so `/tracks/delta` carries tags too. */
  rev?: number,
): { tagged: number; untagged: number } {
  const clean = (list: string[]) =>
    [...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))]
  const put = db.prepare(`INSERT OR IGNORE INTO track_tags (trackId, tag, addedAt) VALUES (?, ?, ?)`)
  const drop = db.prepare(`DELETE FROM track_tags WHERE trackId = ? AND tag = ?`)
  const known = db.prepare(`SELECT 1 FROM tracks WHERE id = ? AND deletedAt IS NULL`)
  const stamp = db.prepare(`UPDATE tracks SET rev = ? WHERE id = ?`)

  let tagged = 0
  let untagged = 0
  const now = Date.now()
  db.exec('BEGIN')
  try {
    for (const id of ids) {
      // A tag on a track that is not there would be a row nothing ever reads
      // and nothing ever deletes, since the cascade needs the track to exist.
      if (!known.get(id)) continue
      let changed = 0
      for (const tag of clean(add)) changed += Number(put.run(id, tag, now).changes)
      tagged += changed
      let gone = 0
      for (const tag of clean(remove)) gone += Number(drop.run(id, tag).changes)
      untagged += gone
      // Only when something actually moved: bumping the revision of a track
      // that was already tagged would make every client re-fetch it to find
      // nothing new.
      if (rev !== undefined && (changed || gone)) stamp.run(rev, id)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { tagged, untagged }
}

export function countTracks(db: DB, qs: TrackQuery): number {
  const f = filters(qs)
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM tracks t WHERE ${f.sql.join(' AND ')}`)
    .get(...(f.params as never[])) as { n: number }
  return row.n
}

/**
 * Revision delta — what keeps clients from re-downloading the library. A client
 * away for five minutes gets what changed, not 40 MB.
 */
export function tracksDelta(db: DB, since: number, limit = 500, sourceIds?: string[]) {
  // The scope belongs here as much as in the listing: a client that syncs by
  // delta would otherwise receive, one revision at a time, everything the
  // account is not allowed to see.
  const scope = sourceIds
    ? (sourceIds.length ? ` AND t.sourceId IN (${sourceIds.map(() => '?').join(',')})` : ' AND 0')
    : ''
  const scopeParams = sourceIds ?? []

  const changed = db
    .prepare(`SELECT ${COLUMNS} FROM tracks t
              WHERE t.rev > ? AND t.deletedAt IS NULL${scope}
              ORDER BY t.rev ASC LIMIT ?`)
    .all(...([since, ...scopeParams, limit] as never[])) as any[]

  const deleted = (
    db
      .prepare(`SELECT id FROM tracks t
                WHERE t.rev > ? AND t.deletedAt IS NOT NULL${scope}
                ORDER BY t.rev ASC LIMIT ?`)
      .all(...([since, ...scopeParams, limit] as never[])) as { id: string }[]
  ).map((r) => r.id)

  return { changed: withPresence(db, changed), deleted }
}

/**
 * A playlist's tracks in its manual order — the one drag and drop established.
 * Column sorting overrides it client-side.
 */
export function playlistTracks(db: DB, playlistId: string, opts: { cursor?: string; limit?: unknown }) {
  const limit = clampLimit(opts.limit)
  const after = decodeCursor(opts.cursor, 1)
  const rows = db
    .prepare(`SELECT ${COLUMNS}, pt.position FROM playlist_tracks pt
              JOIN tracks t ON t.id = pt.trackId
              WHERE pt.playlistId = ? AND t.deletedAt IS NULL ${after ? 'AND pt.position > ?' : ''}
              ORDER BY pt.position ASC LIMIT ?`)
    .all(...([playlistId, ...(after ? [after[0]] : []), limit] as never[])) as any[]

  const next = rows.length === limit ? encodeCursor([rows[rows.length - 1].position]) : null
  for (const r of rows) delete r.position
  return { items: withPresence(db, rows), next }
}

/** A smart playlist's contents: its query, evaluated in SQL. */
export function smartTracks(db: DB, q: { where: string; params: unknown[]; order: string; limit: number }) {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM tracks t WHERE ${q.where.replace(/\b(deletedAt|rating|playCount|year|genre|albumArtist|album|dateAdded|lastPlayed|kind|duration|bpm|id)\b/g, 't.$1')}
              ORDER BY ${q.order.replace(/\b(playCount|dateAdded|lastPlayed|rating|albumArtist|album|discNumber|trackNumber|id)\b/g, 't.$1')}
              LIMIT ?`)
    .all(...([...q.params, q.limit] as never[])) as any[]
  return { items: withPresence(db, rows), next: null }
}

/** What is actually on a device, independently of the library. */
export function listDeviceTracks(db: DB, deviceId: string, opts: { cursor?: string; limit?: unknown; orphansOnly?: boolean }) {
  const limit = clampLimit(opts.limit)
  const where = ['dt.deviceId = ?']
  const params: unknown[] = [deviceId]
  // Tracks with no library match are the feature: that is the music on an old
  // iPod you can recover.
  if (opts.orphansOnly) where.push('dt.trackId IS NULL')

  const after = decodeCursor(opts.cursor, 1)
  if (after) { where.push('dt.deviceLocalId > ?'); params.push(after[0]) }

  const rows = db
    .prepare(`SELECT dt.deviceLocalId, dt.trackId AS libraryTrackId, dt.name, dt.artist,
                     dt.album, dt.duration, dt.size, dt.format, dt.sourceUrl, dt.syncedAt
              FROM device_tracks dt WHERE ${where.join(' AND ')}
              ORDER BY dt.deviceLocalId ASC LIMIT ?`)
    .all(...([...params, limit] as never[])) as any[]

  return {
    items: rows,
    next: rows.length === limit ? encodeCursor([rows[rows.length - 1].deviceLocalId]) : null,
  }
}

export function deviceStats(db: DB, deviceId: string) {
  const row = db
    .prepare(`SELECT COUNT(*) AS tracks,
                     SUM(CASE WHEN trackId IS NULL THEN 1 ELSE 0 END) AS orphans,
                     COALESCE(SUM(size), 0) AS bytes,
                     COALESCE(SUM(duration), 0) AS seconds
              FROM device_tracks WHERE deviceId = ?`)
    .get(deviceId) as any
  return { tracks: row.tracks, orphans: row.orphans ?? 0, bytes: row.bytes, seconds: row.seconds }
}
