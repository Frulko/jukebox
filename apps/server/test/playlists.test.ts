import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../src/db.ts'
import {
  addTracks, createPlaylist, deletePlaylist, listPlaylists, removeTracks,
  renamePlaylist, reorder, seedPresets, smartQuery,
} from '../src/playlists.ts'
import { membershipsOf, playlistTracks, smartTracks } from '../src/library.ts'

function fixture() {
  const db = open(':memory:')
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s','local','S','/',1)`)
  const ins = db.prepare(
    `INSERT INTO tracks (id, sourceId, path, name, artist, albumArtist, album, genre, year,
       rating, playCount, lastPlayed, dateAdded, rev)
     VALUES (?, 's', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
  const rows: [string, string, string, string, string, number, number, number, number | null, number][] = [
    ['t1', 'Dreams',   'Fleetwood Mac', 'Rumours', 'Rock', 1977, 5, 40, 1700000000000, 10],
    ['t2', 'Gold Dust','Fleetwood Mac', 'Rumours', 'Rock', 1977, 3, 12, 1700000001000, 20],
    ['t3', 'Kid A',    'Radiohead',     'Kid A',   'Alt',  2000, 5,  7, null,          30],
    ['t4', 'Untrue',   'Burial',        'Untrue',  'Elec', 1995, 2, 90, 1700000002000, 40],
    ['t5', 'Blue',     'Air',           'Moon',    'Elec', 1998, 0,  0, null,          50],
  ]
  for (const [id, name, artist, album, genre, year, rating, plays, last, added] of rows)
    ins.run(id, `/p/${id}`, name, artist, artist, album, genre, year, rating, plays, last, added)
  return db
}

test('a manual playlist keeps insertion order and dedupes', () => {
  const db = fixture()
  const pl = createPlaylist(db, { name: 'Party' })
  assert.equal(addTracks(db, pl.id, ['t3', 't1', 't4']), 3)
  assert.equal(addTracks(db, pl.id, ['t1', 't5']), 1, 't1 is already in, only t5 gets added')

  const ids = playlistTracks(db, pl.id, {}).items.map((t: any) => t.id)
  assert.deepEqual(ids, ['t3', 't1', 't4', 't5'], 'manual order, not alphabetical')
  assert.equal(listPlaylists(db).find((p) => p.id === pl.id)!.trackCount, 4)
})

test('reordering a batch preserves its relative order', () => {
  const db = fixture()
  const pl = createPlaylist(db, { name: 'X', trackIds: ['t1', 't2', 't3', 't4', 't5'] })
  // This is drag-and-drop of a multiple selection: t1 and t2 move to the end
  // together, in that order.
  reorder(db, pl.id, ['t1', 't2'], 5)
  assert.deepEqual(playlistTracks(db, pl.id, {}).items.map((t: any) => t.id), ['t3', 't4', 't5', 't1', 't2'])

  reorder(db, pl.id, ['t5'], 0)
  assert.deepEqual(playlistTracks(db, pl.id, {}).items.map((t: any) => t.id), ['t5', 't3', 't4', 't1', 't2'])
})

test('positions stay gapless after a removal', () => {
  const db = fixture()
  const pl = createPlaylist(db, { name: 'X', trackIds: ['t1', 't2', 't3', 't4'] })
  assert.equal(removeTracks(db, pl.id, ['t2']), 1)
  // Without renumbering, positions drift and an insert at a given position
  // lands in the wrong place.
  const pos = (db.prepare(`SELECT position FROM playlist_tracks WHERE playlistId = ? ORDER BY position`)
    .all(pl.id) as any[]).map((r) => r.position)
  assert.deepEqual(pos, [0, 1, 2])

  addTracks(db, pl.id, ['t5'], 1)
  assert.deepEqual(playlistTracks(db, pl.id, {}).items.map((t: any) => t.id), ['t1', 't5', 't3', 't4'])
})

test('a smart playlist is a query, not a stored list of tracks', () => {
  const db = fixture()
  const pl = createPlaylist(db, {
    name: 'Top Rated', smart: 'topRated',
    rules: { all: [{ field: 'rating', op: 'gte', value: 4 }], sort: 'rating' },
  })
  const ids = smartTracks(db, smartQuery(pl.rules!)).items.map((t: any) => t.id).sort()
  assert.deepEqual(ids, ['t1', 't3'])

  // It follows the data: rating t4 pulls it in without touching the playlist.
  db.exec(`UPDATE tracks SET rating = 5 WHERE id = 't4'`)
  assert.equal(smartTracks(db, smartQuery(pl.rules!)).items.length, 3)
})

test('the rules cover ranges, membership and empty fields', () => {
  const db = fixture()
  const q = (r: any) => smartTracks(db, smartQuery(r)).items.map((t: any) => t.id).sort()

  assert.deepEqual(q({ all: [{ field: 'year', op: 'gte', value: 1990 }, { field: 'year', op: 'lte', value: 1999 }] }),
    ['t4', 't5'])
  assert.deepEqual(q({ any: [{ field: 'genre', op: 'is', value: 'Rock' }, { field: 'genre', op: 'is', value: 'Alt' }] }),
    ['t1', 't2', 't3'])
  assert.deepEqual(q({ all: [{ field: 'lastPlayed', op: 'isSet' }] }), ['t1', 't2', 't4'])
  assert.deepEqual(q({ all: [{ field: 'albumArtist', op: 'contains', value: 'Fleet' }] }), ['t1', 't2'])
})

test('a smart playlist limit is applied in SQL', () => {
  const db = fixture()
  const items = smartTracks(db, smartQuery({ sort: 'playCount', limit: 2 })).items
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((t: any) => t.id), ['t4', 't1'], 'the two most played, in order')
})

test('an unknown field in a rule is ignored, never concatenated', () => {
  const db = fixture()
  // The field goes into the SQL by concatenation: it is the one spot where an
  // injection would be possible, so it is validated against a closed list.
  const q = smartQuery({ all: [{ field: "id; DROP TABLE tracks; --" as any, op: 'is', value: 1 }] })
  assert.ok(!q.where.includes('DROP'))
  assert.equal(smartTracks(db, q).items.length, 5, 'the rule is ignored, the table is intact')
})

test('rename and delete', () => {
  const db = fixture()
  const pl = createPlaylist(db, { name: 'Before' })
  assert.equal(renamePlaylist(db, pl.id, 'After')!.name, 'After')
  assert.equal(deletePlaylist(db, pl.id), true)
  assert.equal(deletePlaylist(db, pl.id), false, 'deleting twice does not lie')
  assert.ok(!listPlaylists(db).some((p) => p.id === pl.id))
})

test('the iTunes presets are seeded only once', () => {
  const db = fixture()
  seedPresets(db)
  const n = listPlaylists(db).length
  assert.ok(n >= 5)
  seedPresets(db)
  assert.equal(listPlaylists(db).length, n, 'a restart does not duplicate the presets')
})

test('a smart playlist can ask about tags, which are not a column', () => {
  const db = open(':memory:')
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s','local','S','/m',1)`)
  const ins = db.prepare(
    `INSERT INTO tracks (id, sourceId, path, kind, name, artist, albumArtist, album, rating, dateAdded, rev)
     VALUES (?, 's', ?, 'music', ?, 'A', 'A', 'Album', ?, 1700000000000, 1)`)
  ins.run('t1', '/m/1.mp3', 'Warm Up', 5)
  ins.run('t2', '/m/2.mp3', 'Cool Down', 3)
  ins.run('t3', '/m/3.mp3', 'Untagged', 5)

  const tag = db.prepare(`INSERT INTO track_tags (trackId, tag, addedAt) VALUES (?, ?, 1700000000000)`)
  tag.run('t1', 'workout')
  tag.run('t1', 'loud')
  tag.run('t2', 'workout')

  const ids = (rules: any) => smartTracks(db, smartQuery(rules)).items.map((t: any) => t.id).sort()

  assert.deepEqual(ids({ all: [{ field: 'tag', op: 'is', value: 'workout' }] }), ['t1', 't2'])

  // The thing someone will actually type first.
  assert.deepEqual(
    ids({ all: [{ field: 'tag', op: 'is', value: 'workout' }, { field: 'rating', op: 'gte', value: 4 }] }),
    ['t1'])

  // `isNot` has to be NOT EXISTS, not `<> ?`. As a comparison, t1 would match
  // "not tagged loud" through its *other* tag, which is the opposite answer.
  assert.deepEqual(ids({ all: [{ field: 'tag', op: 'isNot', value: 'loud' }] }), ['t2', 't3'])

  assert.deepEqual(ids({ all: [{ field: 'tag', op: 'isNotSet' }] }), ['t3'])
  assert.deepEqual(ids({ all: [{ field: 'tag', op: 'isSet' }] }), ['t1', 't2'])
  assert.deepEqual(ids({ all: [{ field: 'tag', op: 'contains', value: 'work' }] }), ['t1', 't2'])

  // Case and padding are normalised the same way the tagging route does it, or
  // a rule typed "Workout" would silently match nothing.
  assert.deepEqual(ids({ all: [{ field: 'tag', op: 'is', value: '  WORKOUT ' }] }), ['t1', 't2'])

  // And `any` still ORs, with a tag rule inside it.
  assert.deepEqual(
    ids({ any: [{ field: 'tag', op: 'is', value: 'loud' }, { field: 'rating', op: 'lte', value: 3 }] }),
    ['t1', 't2'])
})

test('asking a smart playlist whether it holds a track works for tag rules too', () => {
  const db = open(':memory:')
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s','local','S','/m',1)`)
  db.prepare(
    `INSERT INTO tracks (id, sourceId, path, kind, name, artist, albumArtist, album, dateAdded, rev)
     VALUES (?, 's', ?, 'music', ?, 'A', 'A', 'Album', 1700000000000, 1)`).run('t1', '/m/1.mp3', 'Warm Up')
  db.prepare(`INSERT INTO track_tags (trackId, tag, addedAt) VALUES ('t1','workout',1)`).run()

  createPlaylist(db, { name: 'Workout', smart: 'tagged', rules: { all: [{ field: 'tag', op: 'is', value: 'workout' }] } })

  // membershipsOf embeds the same SQL in a different query -- over `tracks`
  // rather than `tracks t` -- which is why the correlation is a bare `id`.
  const m = membershipsOf(db, 't1', smartQuery)!
  assert.deepEqual(m.playlists.map((p) => p.name), ['Workout'])
})
