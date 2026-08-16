/**
 * Cursor pagination.
 *
 * `LIMIT 200 OFFSET 90000` makes SQLite re-read 90,000 rows just to throw 90,000
 * away. A cursor encodes the last sort key read and becomes `WHERE (key) > (…)`:
 * constant cost no matter how deep you are.
 *
 * This is the only pagination the API exposes. There is no `offset`, not even as
 * an option — exposing one guarantees a client eventually uses it.
 */

export type SortDir = 'asc' | 'desc'
export type SortKey = { column: string; dir: SortDir }

/** An exposed sort needs a covering index, and must end on a unique column. */
export const SORTS: Record<string, SortKey[]> = {
  artist: [
    { column: 'artist', dir: 'asc' },
    { column: 'album', dir: 'asc' },
    { column: 'discNumber', dir: 'asc' },
    { column: 'trackNumber', dir: 'asc' },
    { column: 'id', dir: 'asc' },
  ],
  album: [
    { column: 'album', dir: 'asc' },
    { column: 'discNumber', dir: 'asc' },
    { column: 'trackNumber', dir: 'asc' },
    { column: 'id', dir: 'asc' },
  ],
  name: [
    { column: 'name', dir: 'asc' },
    { column: 'id', dir: 'asc' },
  ],
  added: [
    { column: 'dateAdded', dir: 'desc' },
    { column: 'id', dir: 'asc' },
  ],
}

export function parseSort(input: string | undefined): SortKey[] {
  if (!input) return SORTS.artist
  const base = SORTS[input.replace(/^-/, '')]
  if (!base) return SORTS.artist
  if (!input.startsWith('-')) return base
  // Reversing a sort must reverse its tie-breakers too. Otherwise two tracks
  // with the same name swap places between pages and one of them is skipped.
  return base.map((k) => ({ ...k, dir: k.dir === 'asc' ? 'desc' : 'asc' }))
}

export const encodeCursor = (values: unknown[]): string =>
  Buffer.from(JSON.stringify(values), 'utf8').toString('base64url')

export function decodeCursor(cursor: string | undefined, arity: number): unknown[] | null {
  if (!cursor) return null
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    return Array.isArray(v) && v.length === arity ? v : null
  } catch {
    return null
  }
}

/**
 * Lexicographic comparison in portable SQL.
 *
 * SQLite accepts `(a, b) > (?, ?)`, but only when every column sorts the same
 * way. As soon as a sort mixes asc and desc — `dateAdded DESC, id ASC` — the
 * cascading form has to be spelled out, or the second page silently skips rows.
 */
export function cursorWhere(keys: SortKey[], values: unknown[]): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  for (let i = 0; i < keys.length; i++) {
    const parts: string[] = []
    for (let j = 0; j < i; j++) {
      parts.push(`${keys[j].column} = ?`)
      params.push(values[j])
    }
    parts.push(`${keys[i].column} ${keys[i].dir === 'asc' ? '>' : '<'} ?`)
    params.push(values[i])
    clauses.push(`(${parts.join(' AND ')})`)
  }
  return { sql: `(${clauses.join(' OR ')})`, params }
}

export const orderBy = (keys: SortKey[]): string =>
  keys.map((k) => `${k.column} ${k.dir === 'asc' ? 'ASC' : 'DESC'}`).join(', ')

export const clampLimit = (raw: unknown, fallback = 200, max = 500): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback
}
