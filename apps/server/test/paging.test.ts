import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../src/db.ts'
import { SORTS, clampLimit, cursorWhere, decodeCursor, encodeCursor, orderBy, parseSort } from '../src/paging.ts'

/** Pages through the whole table by cursor and returns the ids in the order seen. */
function pageThrough(db: ReturnType<typeof open>, sort: string, limit: number): string[] {
  const keys = parseSort(sort)
  const seen: string[] = []
  let cursor: string | undefined

  for (let guard = 0; guard < 1000; guard++) {
    const values = decodeCursor(cursor, keys.length)
    let sql = `SELECT ${keys.map((k) => k.column).join(', ')} FROM tracks`
    const params: unknown[] = []
    if (values) {
      const w = cursorWhere(keys, values)
      sql += ` WHERE ${w.sql}`
      params.push(...w.params)
    }
    sql += ` ORDER BY ${orderBy(keys)} LIMIT ${limit}`

    const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]
    if (rows.length === 0) return seen
    for (const r of rows) seen.push(String(r.id))
    const last = rows[rows.length - 1]
    cursor = encodeCursor(keys.map((k) => last[k.column]))
  }
  throw new Error('endless pagination')
}

function seed(n: number) {
  const db = open(':memory:')
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s', 'local', 's', '/', 1)`)
  const ins = db.prepare(
    `INSERT INTO tracks (id, sourceId, path, name, artist, album, discNumber, trackNumber, dateAdded, rev)
     VALUES (?, 's', ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
  // Plenty of deliberate ties: lexicographic comparison breaks on equal keys,
  // not on values that are all distinct.
  for (let i = 0; i < n; i++) {
    ins.run(
      `t${String(i).padStart(4, '0')}`,
      `/p/${i}`,
      `Title ${i % 7}`,
      `Artist ${i % 5}`,
      `Album ${i % 3}`,
      1,
      i % 4,
      1700000000000 + (i % 6) * 1000,
    )
  }
  return db
}

test('the cursor visits every row exactly once, for every sort', () => {
  const N = 250
  const db = seed(N)
  const all = (db.prepare('SELECT id FROM tracks').all() as { id: string }[]).map((r) => r.id).sort()

  for (const sort of [...Object.keys(SORTS), ...Object.keys(SORTS).map((s) => '-' + s)]) {
    for (const limit of [1, 7, 60, N, N + 10]) {
      const seen = pageThrough(db, sort, limit)
      assert.deepEqual(
        [...seen].sort(),
        all,
        `sort ${sort} · limit ${limit} — ${seen.length} rows seen out of ${N}`,
      )
      assert.equal(new Set(seen).size, seen.length, `sort ${sort} · limit ${limit} — duplicates`)
    }
  }
})

test('reversing the sort reverses the tie-breakers too', () => {
  // Without this, two tracks with the same name swap order between pages and one gets skipped.
  const asc = parseSort('name')
  const desc = parseSort('-name')
  assert.equal(asc.length, desc.length)
  for (let i = 0; i < asc.length; i++) assert.notEqual(asc[i].dir, desc[i].dir)
})

test('pagination is ordered, not just complete', () => {
  const db = seed(120)
  const seen = pageThrough(db, 'name', 13)
  const expected = (
    db.prepare(`SELECT id FROM tracks ORDER BY ${orderBy(parseSort('name'))}`).all() as { id: string }[]
  ).map((r) => r.id)
  assert.deepEqual(seen, expected)
})

test('a corrupt cursor is ignored, not fatal', () => {
  assert.equal(decodeCursor('pas-du-base64!!', 2), null)
  assert.equal(decodeCursor(encodeCursor([1]), 2), null, 'wrong arity')
  assert.deepEqual(decodeCursor(encodeCursor(['a', 'b']), 2), ['a', 'b'])
})

test('the limit is clamped', () => {
  assert.equal(clampLimit(undefined), 200)
  assert.equal(clampLimit('50'), 50)
  assert.equal(clampLimit('999999'), 500, 'a client does not get to decide on its own to receive everything')
  assert.equal(clampLimit('-3'), 200)
})
