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
  for (const r of rows) {
    r.devices = byTrack.get(r.id) ?? []
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
