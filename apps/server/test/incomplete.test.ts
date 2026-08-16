import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../src/db.ts'
import { countTracks, listTracks } from '../src/library.ts'

/** One track per gap, plus one that has everything. */
function fixture() {
  const db = open(':memory:')
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s','local','S','/',1)`)
  const ins = db.prepare(
    `INSERT INTO tracks (id, sourceId, path, name, artist, albumArtist, album, genre, year,
       trackNumber, artworkHash, dateAdded, rev)
     VALUES (?, 's', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`)
  //        id      name        artist   albumArtist  album     genre   year  track  artwork
  const rows: [string, string, string, string, string, string, number, number, string | null][] = [
    ['whole', 'Whole',      'A', 'A', 'Alb', 'Rock', 1999, 3, 'hash'],
    ['noalb', 'No album',   'A', 'A', '',    'Rock', 1999, 3, 'hash'],
    ['noart', 'No artist',  '',  '',  'Alb', 'Rock', 1999, 3, 'hash'],
    ['noaa',  'Only album artist', 'A', '', 'Alb',  'Rock', 1999, 3, 'hash'],
    ['nogen', 'No genre',   'A', 'A', 'Alb', '',     1999, 3, 'hash'],
    ['noyr',  'No year',    'A', 'A', 'Alb', 'Rock', 0,    3, 'hash'],
    ['notr',  'No number',  'A', 'A', 'Alb', 'Rock', 1999, 0, 'hash'],
    ['nocov', 'No artwork', 'A', 'A', 'Alb', 'Rock', 1999, 3, null],
  ]
  for (const [id, name, artist, albumArtist, album, genre, year, track, art] of rows)
    ins.run(id, `/p/${id}`, name, artist, albumArtist, album, genre, year, track, art)
  return db
}

const ids = (db: ReturnType<typeof open>, missing: string) =>
  listTracks(db, { missing }).items.map((t: any) => t.id).sort()

test('each field finds exactly what is empty', () => {
  const db = fixture()
  assert.deepEqual(ids(db, 'album'), ['noalb'])
  assert.deepEqual(ids(db, 'genre'), ['nogen'])
  assert.deepEqual(ids(db, 'year'), ['noyr'])
  assert.deepEqual(ids(db, 'track'), ['notr'])
  // No `artwork`: nothing writes `artworkHash`, so a filter on it would match
  // every track ever scanned. Absent beats plausibly wrong.
  assert.deepEqual(ids(db, 'artwork'), [])
})

test('an empty album artist alone is not a missing artist', () => {
  const db = fixture()
  // `noaa` has an artist and no album artist. Only `noart` has neither.
  assert.deepEqual(ids(db, 'artist'), ['noart'])
})

test('but an empty album artist is its own gap, because artist browse uses it', () => {
  const db = fixture()
  // The `?artist=` filter and the artists facet both read `albumArtist`, so
  // this track is unreachable by browsing artists while looking complete.
  assert.deepEqual(ids(db, 'albumartist'), ['noaa'])
})

test('`any` is the union, and counts what the page cannot', () => {
  const db = fixture()
  assert.deepEqual(ids(db, 'any'), ['noaa', 'noalb', 'noart', 'nogen', 'notr', 'noyr'].sort())
  // The number the sidebar shows comes from SQL over the whole library, which
  // is the entire reason this is a query parameter and not a client-side filter.
  assert.equal(countTracks(db, { missing: 'any' }), 6)
  assert.equal(countTracks(db, {}), 8)
})

test('a field nobody defined matches nothing, rather than everything', () => {
  const db = fixture()
  // The alternative — an unknown value falling through to no filter — returns
  // the whole library for a typo, under a heading that says "incomplete".
  assert.deepEqual(ids(db, 'nonsense'), [])
})

test('it composes with the other filters instead of replacing them', () => {
  const db = fixture()
  db.exec(`UPDATE tracks SET genre = 'Jazz' WHERE id = 'noalb'`)
  assert.deepEqual(listTracks(db, { missing: 'any', genre: 'Jazz' }).items.map((t: any) => t.id), ['noalb'])
})
