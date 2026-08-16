import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../src/db.ts'
import { findDuplicates, mergeTracks, normalize } from '../src/duplicates.ts'
import { addTracks, createPlaylist } from '../src/playlists.ts'

test('normalisation removes what differs between copies and keeps what does not', () => {
  assert.equal(normalize('Café Déjà vu'), 'cafe deja vu')
  assert.equal(normalize("Don't Stop"), 'dont stop')
  assert.equal(normalize('Rock & Roll'), 'rock roll')
  assert.equal(normalize('Song (feat. Someone)'), 'song')
  // A remaster is a different recording. Merging it away loses the one the
  // user chose, so the suffix stays part of the identity.
  assert.notEqual(normalize('Song (Remastered 2011)'), normalize('Song'))
})

function fixture() {
  const db = open(':memory:')
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s','local','S','/m',1)`)
  return db
}

let n = 0
const track = (db: any, over: Record<string, unknown> = {}) => {
  const id = `t${++n}`
  const row = {
    name: 'One More Time', artist: 'Daft Punk', albumArtist: 'Daft Punk', album: 'Discovery',
    duration: 320, format: 'mp3', size: 5_000_000, bitRate: 320, rating: 0, playCount: 0,
    loved: 0, fingerprint: null, dateAdded: 1000, path: `/m/${id}.mp3`, ...over,
  } as any
  db.prepare(`INSERT INTO tracks (id, sourceId, path, kind, name, artist, albumArtist, album,
      duration, format, size, bitRate, rating, playCount, loved, fingerprint, dateAdded, rev)
    VALUES (?, 's', ?, 'music', ?,?,?,?,?,?,?,?,?,?,?,?,?,1)`)
    .run(id, row.path, row.name, row.artist, row.albumArtist, row.album, row.duration,
      row.format, row.size, row.bitRate, row.rating, row.playCount, row.loved,
      row.fingerprint, row.dateAdded)
  db.prepare(`INSERT INTO renditions (id, trackId, sourceId, path, format, size, preferred, createdAt)
              VALUES (?,?, 's', ?, ?, ?, 1, 1)`)
    .run(`r-${id}`, id, row.path, row.format, row.size)
  return id
}

test('the same song ripped and downloaded is one group', () => {
  const db = fixture()
  const a = track(db, { format: 'flac', size: 30_000_000, path: '/m/a.flac' })
  const b = track(db, { format: 'mp3', duration: 322, path: '/m/b.mp3' })

  const groups = findDuplicates(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].reason, 'metadata')
  assert.deepEqual(groups[0].tracks.map((t) => t.id).sort(), [a, b].sort())
})

test('two songs with one title are not duplicates', () => {
  const db = fixture()
  // Every band has an "Intro", and a live take runs minutes longer than the
  // studio one. This is the pair that must never be merged.
  track(db, { name: 'Intro', duration: 45 })
  track(db, { name: 'Intro', duration: 200 })
  assert.equal(findDuplicates(db).length, 0)
})

test('different artists sharing a title are not duplicates', () => {
  const db = fixture()
  track(db, { name: 'Hurt', albumArtist: 'Nine Inch Nails' })
  track(db, { name: 'Hurt', albumArtist: 'Johnny Cash' })
  assert.equal(findDuplicates(db).length, 0)
})

test('an acoustic fingerprint matches whatever the tags say', () => {
  const db = fixture()
  // Same audio, tagged completely differently by two sources. Only the
  // fingerprint can see through that -- and a weak one cannot, because it is
  // derived from the tags in the first place.
  const a = track(db, { fingerprint: 'cp:abc', name: 'One More Time' })
  const b = track(db, { fingerprint: 'cp:abc', name: 'one more time (radio edit)', albumArtist: 'daftpunk' })
  const groups = findDuplicates(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].reason, 'fingerprint')
  assert.deepEqual(groups[0].tracks.map((t) => t.id).sort(), [a, b].sort())
})

test('the keeper is the copy carrying a history', () => {
  const db = fixture()
  track(db, { path: '/m/plain.mp3' })
  const loved = track(db, { path: '/m/loved.mp3', playCount: 40, rating: 5 })
  assert.equal(findDuplicates(db)[0].keeperId, loved, 'plays and a rating cannot be recovered; a bitrate can')
})

test('merging makes one track with both files, and adds up the history', () => {
  const db = fixture()
  const keep = track(db, { format: 'flac', path: '/m/a.flac', playCount: 10, rating: 4, dateAdded: 500 })
  const other = track(db, { format: 'aac', path: '/m/b.m4a', playCount: 3, rating: 5, dateAdded: 100, lastPlayed: 9 })

  const result = mergeTracks(db, keep, [other])
  assert.equal(result!.merged, 1)
  assert.equal(result!.renditions, 1)

  const rends = db.prepare(`SELECT format FROM renditions WHERE trackId = ? ORDER BY format`).all(keep) as any[]
  assert.deepEqual(rends.map((r) => r.format), ['aac', 'flac'], 'one track, both files')

  const t = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(keep) as any
  // The song really was played thirteen times, whichever copy was playing.
  assert.equal(t.playCount, 13)
  assert.equal(t.rating, 5, 'the better rating wins')
  assert.equal(t.dateAdded, 100, 'and the earlier date, which is when it entered the library')

  const gone = db.prepare(`SELECT deletedAt FROM tracks WHERE id = ?`).get(other) as any
  assert.ok(gone.deletedAt, 'soft deleted: the row goes, the file does not')
})

test('a merge does not quietly empty a playlist', () => {
  const db = fixture()
  const keep = track(db, { path: '/m/a.flac', format: 'flac' })
  const other = track(db, { path: '/m/b.mp3' })
  const pl = createPlaylist(db, { name: 'Roadtrip' })
  addTracks(db, pl.id, [other])

  mergeTracks(db, keep, [other])

  const rows = db.prepare(`SELECT trackId FROM playlist_tracks WHERE playlistId = ?`).all(pl.id) as any[]
  // Repointed, not dropped. A merge that emptied a playlist would be worse
  // than the duplicate it fixed.
  assert.deepEqual(rows.map((r) => r.trackId), [keep])
})

test('a playlist holding both copies ends up with one entry, not a broken row', () => {
  const db = fixture()
  const keep = track(db, { path: '/m/a.flac', format: 'flac' })
  const other = track(db, { path: '/m/b.mp3' })
  const pl = createPlaylist(db, { name: 'Both' })
  addTracks(db, pl.id, [keep, other])

  mergeTracks(db, keep, [other])
  const rows = db.prepare(`SELECT trackId FROM playlist_tracks WHERE playlistId = ?`).all(pl.id) as any[]
  assert.deepEqual(rows.map((r) => r.trackId), [keep], 'the duplicate entry collapses')
})

test('what was on a device follows the keeper', () => {
  const db = fixture()
  const keep = track(db, { path: '/m/a.flac', format: 'flac' })
  const other = track(db, { path: '/m/b.mp3' })
  db.exec(`INSERT INTO devices (id, name, kind, rev) VALUES ('ipod','iPod','ipod-classic',1)`)
  db.prepare(`INSERT INTO device_tracks (deviceId, deviceLocalId, trackId, name, size)
              VALUES ('ipod','F0',?, 'x', 1)`).run(other)
  db.prepare(`INSERT INTO device_wanted (deviceId, trackId, addedAt) VALUES ('ipod',?,1)`).run(other)

  mergeTracks(db, keep, [other])
  assert.equal((db.prepare(`SELECT trackId FROM device_tracks WHERE deviceLocalId='F0'`).get() as any).trackId, keep)
  assert.equal((db.prepare(`SELECT trackId FROM device_wanted`).get() as any).trackId, keep)
})

test('merging into a track that is gone is refused', () => {
  const db = fixture()
  const a = track(db)
  assert.equal(mergeTracks(db, 'no-such-track', [a]), null)
  // And merging a track into itself changes nothing.
  assert.equal(mergeTracks(db, a, [a])!.merged, 0)
})
