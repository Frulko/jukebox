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
  sourceId?: string
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

  if (qs.q?.trim()) {
    // FTS5 over an external content table: fetch the rowids, join on them.
    sql.push(`t.rowid IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?)`)
    params.push(qs.q.trim().split(/\s+/).map((w) => `"${w.replace(/"/g, '')}"*`).join(' '))
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

  for (const r of rows) {
    r.devices = byTrack.get(r.id) ?? []
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

  const base = { kind: qs.kind, q: qs.q, sourceId: qs.sourceId, onDevice: qs.onDevice, notOnDevice: qs.notOnDevice }
  return {
    genres: distinct('genre', base),
    artists: distinct('albumArtist', { ...base, genre: qs.genre }),
    albums: distinct('album', { ...base, genre: qs.genre, artist: qs.artist }),
    // Deliberately not cascaded with the other three. Format is orthogonal to
    // genre and artist -- "which formats does this library hold" is the useful
    // question, and narrowing it by the browser selection would offer a filter
    // that empties itself as soon as it is used.
    formats: distinct('format', base),
  }
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
export function tracksDelta(db: DB, since: number, limit = 500) {
  const changed = db
    .prepare(`SELECT ${COLUMNS} FROM tracks t
              WHERE t.rev > ? AND t.deletedAt IS NULL
              ORDER BY t.rev ASC LIMIT ?`)
    .all(...([since, limit] as never[])) as any[]

  const deleted = (
    db
      .prepare(`SELECT id FROM tracks WHERE rev > ? AND deletedAt IS NOT NULL ORDER BY rev ASC LIMIT ?`)
      .all(...([since, limit] as never[])) as { id: string }[]
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
    .prepare(`SELECT ${COLUMNS} FROM tracks t WHERE ${q.where.replace(/\b(deletedAt|rating|playCount|year|genre|albumArtist|album|dateAdded|lastPlayed|kind|duration|bpm)\b/g, 't.$1')}
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
