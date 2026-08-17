import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRev, open } from '../src/db.ts'
import { mergeTracks, substituteMissing } from '../src/duplicates.ts'
import { addTracks, createPlaylist } from '../src/playlists.ts'

function fixture() {
  const db = open(':memory:')
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s','local','S','/m',1)`)
  return db
}

let n = 0
function track(db: any, over: Record<string, unknown> = {}) {
  const id = (over.id as string) ?? `t${++n}`
  const row = {
    name: 'One More Time', artist: 'Daft Punk', albumArtist: 'Daft Punk', album: 'Discovery',
    duration: 320, rating: 0, playCount: 0, skipCount: 0, loved: 0, dateAdded: 1000,
    lastPlayed: null, deletedAt: null, path: `/m/${id}.mp3`, ...over,
  } as any
  db.prepare(`INSERT INTO tracks (id, sourceId, path, kind, name, artist, albumArtist, album,
      duration, format, size, bitRate, rating, playCount, skipCount, loved, dateAdded,
      lastPlayed, deletedAt, rev)
    VALUES (?, 's', ?, 'music', ?,?,?,?,?, 'mp3', 1, 320, ?,?,?,?,?,?,?,?)`)
    .run(id, row.path, row.name, row.artist, row.albumArtist, row.album, row.duration,
      row.rating, row.playCount, row.skipCount, row.loved, row.dateAdded,
      row.lastPlayed, row.deletedAt,
      // The real revision counter, as the scanner uses it: a fixture that
      // hard-codes 1 makes the delta assertion below pass or fail by accident.
      nextRev(db))
  db.prepare(`INSERT INTO renditions (id, trackId, sourceId, path, format, size, preferred, createdAt)
              VALUES (?,?, 's', ?, 'mp3', 1, 1, 1)`).run(`r-${id}`, id, row.path)
  return id
}

/** What the Missing page asks the database for, verbatim. */
const missing = (db: any) =>
  (db.prepare(
    `SELECT id FROM tracks WHERE deletedAt IS NOT NULL AND mergedInto IS NULL`).all() as any[])
    .map((t) => t.id)

test('a missing track hands its history to the copy that still has a file', () => {
  const db = fixture()
  const gone = track(db, {
    id: 'gone', path: '/m/old.mp3', rating: 5, playCount: 42, skipCount: 3,
    dateAdded: 500, lastPlayed: 9000, deletedAt: 123,
  })
  const found = track(db, { id: 'found', path: '/m/new/one.mp3', rating: 0, playCount: 1, dateAdded: 8000 })

  const result = substituteMissing(db, found, [gone])
  assert.deepEqual({ merged: result!.merged, renditions: result!.renditions }, { merged: 1, renditions: 0 })

  const keeper = db.prepare(`SELECT * FROM tracks WHERE id = 'found'`).get() as any
  assert.equal(keeper.playCount, 43, 'plays are added up, not picked between')
  assert.equal(keeper.skipCount, 3)
  assert.equal(keeper.rating, 5, 'the rating the listener gave survives the file')
  assert.equal(keeper.dateAdded, 500, 'the library has held this song since the older date')
  assert.equal(keeper.lastPlayed, 9000)
})

test('the file that is gone never becomes a file of the keeper', () => {
  // The whole difference from a merge. A rendition is a file; carrying the
  // missing one across would hand the keeper a path on no disk, and the player
  // would eventually try to stream it.
  const db = fixture()
  const gone = track(db, { id: 'gone', path: '/m/old.mp3', deletedAt: 123 })
  const found = track(db, { id: 'found', path: '/m/new.mp3' })

  substituteMissing(db, found, [gone])
  const paths = (db.prepare(`SELECT path FROM renditions WHERE trackId = 'found'`).all() as any[])
    .map((r) => r.path)
  assert.deepEqual(paths, ['/m/new.mp3'])
})

test('the playlists that pointed at the lost file point at the new one', () => {
  const db = fixture()
  const gone = track(db, { id: 'gone', path: '/m/old.mp3', deletedAt: 123 })
  const found = track(db, { id: 'found', path: '/m/new.mp3' })
  const pl = createPlaylist(db, { name: 'Evening' })
  addTracks(db, pl.id, [gone])

  substituteMissing(db, found, [gone])
  const inList = (db.prepare(`SELECT trackId FROM playlist_tracks WHERE playlistId = ?`).all(pl.id) as any[])
  assert.deepEqual(inList.map((r) => r.trackId), ['found'])
})

test('a substituted row leaves the Missing page; the keeper never joins it', () => {
  const db = fixture()
  const gone = track(db, { id: 'gone', path: '/m/old.mp3', deletedAt: 123 })
  const found = track(db, { id: 'found', path: '/m/new.mp3' })

  assert.deepEqual(missing(db), ['gone'])
  substituteMissing(db, found, [gone])
  assert.deepEqual(missing(db), [], 'the question was answered, so the row stops asking it')
  assert.equal((db.prepare(`SELECT mergedInto FROM tracks WHERE id = 'gone'`).get() as any).mergedInto, 'found')
})

test('substituting twice does not count the plays twice', () => {
  // A UI holding a stale list will send the same call again, and a play count
  // that grows on every retry is worse than one that refuses.
  const db = fixture()
  const gone = track(db, { id: 'gone', path: '/m/old.mp3', playCount: 10, deletedAt: 123 })
  const found = track(db, { id: 'found', path: '/m/new.mp3', playCount: 0 })

  substituteMissing(db, found, [gone])
  const second = substituteMissing(db, found, [gone])
  assert.equal(second!.merged, 0)
  assert.equal((db.prepare(`SELECT playCount FROM tracks WHERE id = 'found'`).get() as any).playCount, 10)
})

test('the keeper is stamped with a new revision, or no client ever hears about it', () => {
  const db = fixture()
  const gone = track(db, { id: 'gone', path: '/m/old.mp3', rating: 4, deletedAt: 123 })
  const found = track(db, { id: 'found', path: '/m/new.mp3' })
  const before = (db.prepare(`SELECT rev FROM tracks WHERE id = 'found'`).get() as any).rev

  substituteMissing(db, found, [gone])
  const after = (db.prepare(`SELECT rev FROM tracks WHERE id = 'found'`).get() as any).rev
  assert.ok(after > before, 'a delta the syncing clients can see')
})

test('a track that still has its file cannot be substituted away', () => {
  // Only the Missing page may call this, and only about rows that are missing.
  // Without the check it becomes a second merge that silently loses a file.
  const db = fixture()
  const alive = track(db, { id: 'alive', path: '/m/a.mp3' })
  const found = track(db, { id: 'found', path: '/m/b.mp3' })
  assert.equal(substituteMissing(db, found, [alive])!.merged, 0)
  assert.equal((db.prepare(`SELECT deletedAt FROM tracks WHERE id = 'alive'`).get() as any).deletedAt, null)
})

test('a keeper with no file of its own is refused', () => {
  const db = fixture()
  const gone = track(db, { id: 'gone', path: '/m/old.mp3', deletedAt: 123 })
  const alsoGone = track(db, { id: 'gone2', path: '/m/old2.mp3', deletedAt: 123 })
  assert.equal(substituteMissing(db, alsoGone, [gone]), null)
})

test('a duplicate folded away is not reported as a lost file', () => {
  // The bug this column was added for. `/tracks/missing` asks for soft-deleted
  // rows, and a merge soft-deletes the copy it folded — so every duplicate
  // anyone ever merged was presenting itself on the Missing page as a file to
  // go hunting for on a disk.
  const db = fixture()
  const keep = track(db, { id: 'keep', path: '/m/a.flac' })
  const dupe = track(db, { id: 'dupe', path: '/m/a.mp3' })

  mergeTracks(db, keep, [dupe])
  assert.deepEqual(missing(db), [])
  assert.equal((db.prepare(`SELECT mergedInto FROM tracks WHERE id = 'dupe'`).get() as any).mergedInto, 'keep')
})
