import { randomUUID } from 'node:crypto'
import type { DB } from './db.ts'
import { nextRev } from './db.ts'

/**
 * Manual and smart playlists.
 *
 * Smart ones are evaluated **in SQL**, not JavaScript: a "top 25 most played"
 * rule over 100,000 tracks must not load 100,000 rows to keep 25. Same
 * discipline as everywhere else.
 */

export type Rule = {
  field: 'rating' | 'playCount' | 'year' | 'genre' | 'artist' | 'albumArtist' | 'album'
       | 'dateAdded' | 'lastPlayed' | 'kind' | 'duration' | 'bpm' | 'tag'
  op: 'is' | 'isNot' | 'contains' | 'gte' | 'lte' | 'inLastDays' | 'isSet' | 'isNotSet'
  value?: string | number
}

export type SmartRules = {
  all?: Rule[]
  any?: Rule[]
  sort?: string
  limit?: number
}

const FIELDS = new Set<Rule['field']>([
  'rating', 'playCount', 'year', 'genre', 'artist', 'albumArtist', 'album',
  'dateAdded', 'lastPlayed', 'kind', 'duration', 'bpm', 'tag',
])

/**
 * A rule about tags, which is the one field that is not a column.
 *
 * Tags live one row per pair, so every operator here is an `EXISTS` rather than
 * a comparison — and `isNot` is `NOT EXISTS` rather than `<> ?`, which is the
 * distinction that matters: a track with the tags `live` and `acoustic` is not
 * "tagged something other than live", it simply is not tagged live. Written as
 * a negated comparison it would match itself through its other tag.
 *
 * The correlation is on a bare `id` on purpose. This SQL is embedded in two
 * different queries — one over `tracks`, one over `tracks t` — and the bare
 * name resolves correctly in both, where naming either would break the other.
 */
function tagRule(r: Rule): { sql: string; params: unknown[] } | null {
  const exists = (inner: string, params: unknown[]) =>
    ({ sql: `EXISTS (SELECT 1 FROM track_tags tt WHERE tt.trackId = id AND ${inner})`, params })

  switch (r.op) {
    case 'is': return exists(`tt.tag = ?`, [String(r.value).trim().toLowerCase()])
    case 'contains': return exists(`tt.tag LIKE ?`, [`%${String(r.value).trim().toLowerCase()}%`])
    case 'isNot': {
      const e = exists(`tt.tag = ?`, [String(r.value).trim().toLowerCase()])
      return { sql: `NOT ${e.sql}`, params: e.params }
    }
    // "Tagged at all" and "never tagged", which is how anyone finds the ones
    // they have not got round to yet.
    case 'isSet': return exists(`1`, [])
    case 'isNotSet': return { sql: `NOT ${exists(`1`, []).sql}`, params: [] }
    default: return null
  }
}

/** Translates a rule into SQL. Returns `null` if it is not recognised. */
function ruleToSql(r: Rule): { sql: string; params: unknown[] } | null {
  // The field is checked against a closed list: it enters the SQL by
  // concatenation, so this is the only place an injection could happen.
  if (!FIELDS.has(r.field)) return null
  if (r.field === 'tag') return tagRule(r)
  const col = r.field === 'artist' ? 'albumArtist' : r.field

  switch (r.op) {
    case 'is': return { sql: `${col} = ?`, params: [r.value] }
    case 'isNot': return { sql: `${col} <> ?`, params: [r.value] }
    case 'contains': return { sql: `${col} LIKE ?`, params: [`%${r.value}%`] }
    case 'gte': return { sql: `${col} >= ?`, params: [Number(r.value)] }
    case 'lte': return { sql: `${col} <= ?`, params: [Number(r.value)] }
    case 'isSet': return { sql: `${col} IS NOT NULL AND ${col} <> ''`, params: [] }
    case 'isNotSet': return { sql: `(${col} IS NULL OR ${col} = '')`, params: [] }
    case 'inLastDays':
      return { sql: `${col} >= ?`, params: [Date.now() - Number(r.value) * 86400000] }
    default: return null
  }
}

const SMART_SORTS: Record<string, string> = {
  playCount: 'playCount DESC, id ASC',
  dateAdded: 'dateAdded DESC, id ASC',
  lastPlayed: 'lastPlayed DESC, id ASC',
  rating: 'rating DESC, playCount DESC, id ASC',
  random: 'id ASC', // deterministic: a playlist that reshuffles on every read is unreadable
  artist: 'albumArtist ASC, album ASC, discNumber ASC, trackNumber ASC, id ASC',
}

export function smartQuery(rules: SmartRules): { where: string; params: unknown[]; order: string; limit: number } {
  const clauses: string[] = ['deletedAt IS NULL']
  const params: unknown[] = []

  for (const r of rules.all ?? []) {
    const c = ruleToSql(r)
    if (c) { clauses.push(`(${c.sql})`); params.push(...c.params) }
  }
  const anyParts: string[] = []
  for (const r of rules.any ?? []) {
    const c = ruleToSql(r)
    if (c) { anyParts.push(`(${c.sql})`); params.push(...c.params) }
  }
  if (anyParts.length) clauses.push(`(${anyParts.join(' OR ')})`)

  return {
    where: clauses.join(' AND '),
    params,
    order: SMART_SORTS[rules.sort ?? 'artist'] ?? SMART_SORTS.artist,
    // A smart playlist with no limit is still bounded: this is a view, not an
    // export.
    limit: Math.min(rules.limit ?? 500, 2000),
  }
}

export type Playlist = {
  id: string
  name: string
  smart: string | null
  rules: SmartRules | null
  trackCount: number
  createdAt: number
  rev: number
}

const hydrate = (row: any, count: number): Playlist => ({
  id: row.id,
  name: row.name,
  smart: row.smart ?? null,
  rules: row.rules ? JSON.parse(row.rules) : null,
  trackCount: count,
  createdAt: row.createdAt,
  rev: row.rev,
})

export function listPlaylists(db: DB): Playlist[] {
  const rows = db.prepare(`SELECT * FROM playlists WHERE deletedAt IS NULL ORDER BY createdAt ASC`).all() as any[]
  const counts = db.prepare(`SELECT playlistId, COUNT(*) AS n FROM playlist_tracks GROUP BY playlistId`).all() as any[]
  const byId = new Map(counts.map((c) => [c.playlistId, c.n]))

  return rows.map((r) => {
    if (!r.smart) return hydrate(r, byId.get(r.id) ?? 0)
    // A smart playlist's count is the result of its own query.
    const q = smartQuery(r.rules ? JSON.parse(r.rules) : {})
    const n = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT id FROM tracks WHERE ${q.where} LIMIT ${q.limit})`)
      .get(...(q.params as never[])) as { n: number }
    return hydrate(r, n.n)
  })
}

export function getPlaylist(db: DB, id: string): Playlist | null {
  const row = db.prepare(`SELECT * FROM playlists WHERE id = ? AND deletedAt IS NULL`).get(id) as any
  if (!row) return null
  return listPlaylists(db).find((p) => p.id === id) ?? hydrate(row, 0)
}

export function createPlaylist(db: DB, input: { name: string; smart?: string; rules?: SmartRules; trackIds?: string[] }): Playlist {
  const id = `pl-${randomUUID().slice(0, 8)}`
  const rev = nextRev(db)
  db.prepare(`INSERT INTO playlists (id, name, smart, rules, createdAt, rev) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, input.name, input.smart ?? null, input.rules ? JSON.stringify(input.rules) : null, Date.now(), rev)
  if (input.trackIds?.length) addTracks(db, id, input.trackIds)
  return getPlaylist(db, id)!
}

export function renamePlaylist(db: DB, id: string, name: string): Playlist | null {
  db.prepare(`UPDATE playlists SET name = ?, rev = ? WHERE id = ? AND deletedAt IS NULL`).run(name, nextRev(db), id)
  return getPlaylist(db, id)
}

export function deletePlaylist(db: DB, id: string): boolean {
  const r = db.prepare(`UPDATE playlists SET deletedAt = ?, rev = ? WHERE id = ? AND deletedAt IS NULL`)
    .run(Date.now(), nextRev(db), id)
  return r.changes > 0
}

/** Deduplicated insert, at the end or at a given position. */
export function addTracks(db: DB, playlistId: string, trackIds: string[], position?: number): number {
  const existing = new Set(
    (db.prepare(`SELECT trackId FROM playlist_tracks WHERE playlistId = ?`).all(playlistId) as any[])
      .map((r) => r.trackId))
  const fresh = trackIds.filter((id) => !existing.has(id))
  if (!fresh.length) return 0

  const max = (db.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM playlist_tracks WHERE playlistId = ?`)
    .get(playlistId) as any).m as number

  if (position === undefined || position > max) {
    const ins = db.prepare(`INSERT INTO playlist_tracks (playlistId, trackId, position) VALUES (?, ?, ?)`)
    fresh.forEach((id, i) => ins.run(playlistId, id, max + 1 + i))
  } else {
    db.prepare(`UPDATE playlist_tracks SET position = position + ? WHERE playlistId = ? AND position >= ?`)
      .run(fresh.length, playlistId, position)
    const ins = db.prepare(`INSERT INTO playlist_tracks (playlistId, trackId, position) VALUES (?, ?, ?)`)
    fresh.forEach((id, i) => ins.run(playlistId, id, position + i))
  }
  nextRev(db)
  return fresh.length
}

export function removeTracks(db: DB, playlistId: string, trackIds: string[]): number {
  if (!trackIds.length) return 0
  const r = db.prepare(
    `DELETE FROM playlist_tracks WHERE playlistId = ? AND trackId IN (${trackIds.map(() => '?').join(',')})`)
    .run(...([playlistId, ...trackIds] as never[]))
  compact(db, playlistId)
  nextRev(db)
  return r.changes as number
}

/**
 * Moves a batch to `toIndex`, preserving their relative order — this is dragging
 * a multi-selection inside a playlist.
 */
export function reorder(db: DB, playlistId: string, trackIds: string[], toIndex: number): void {
  const current = (db.prepare(`SELECT trackId FROM playlist_tracks WHERE playlistId = ? ORDER BY position`)
    .all(playlistId) as any[]).map((r) => r.trackId as string)

  const moving = new Set(trackIds)
  const before = current.slice(0, toIndex).filter((id) => !moving.has(id))
  const after = current.slice(toIndex).filter((id) => !moving.has(id))
  const next = [...before, ...trackIds.filter((id) => current.includes(id)), ...after]

  const upd = db.prepare(`UPDATE playlist_tracks SET position = ? WHERE playlistId = ? AND trackId = ?`)
  next.forEach((id, i) => upd.run(i, playlistId, id))
  nextRev(db)
}

/** Renumbers without gaps — otherwise positions drift as tracks are removed. */
function compact(db: DB, playlistId: string): void {
  const rows = db.prepare(`SELECT trackId FROM playlist_tracks WHERE playlistId = ? ORDER BY position`)
    .all(playlistId) as any[]
  const upd = db.prepare(`UPDATE playlist_tracks SET position = ? WHERE playlistId = ? AND trackId = ?`)
  rows.forEach((r, i) => upd.run(i, playlistId, r.trackId))
}

/** The iTunes presets, seeded on first start. */
export const PRESETS: { name: string; smart: string; rules: SmartRules }[] = [
  { name: 'My Top Rated', smart: 'topRated', rules: { all: [{ field: 'rating', op: 'gte', value: 4 }], sort: 'rating' } },
  { name: 'Recently Added', smart: 'recentlyAdded', rules: { sort: 'dateAdded', limit: 60 } },
  { name: 'Recently Played', smart: 'recentlyPlayed', rules: { all: [{ field: 'lastPlayed', op: 'isSet' }], sort: 'lastPlayed', limit: 60 } },
  { name: 'Top 25 Most Played', smart: 'top25', rules: { all: [{ field: 'playCount', op: 'gte', value: 1 }], sort: 'playCount', limit: 25 } },
  { name: '90’s Music', smart: 'nineties', rules: { all: [{ field: 'year', op: 'gte', value: 1990 }, { field: 'year', op: 'lte', value: 1999 }] } },
]

export function seedPresets(db: DB): void {
  const has = db.prepare(`SELECT COUNT(*) AS n FROM playlists`).get() as { n: number }
  if (has.n > 0) return
  for (const p of PRESETS) createPlaylist(db, p)
}
