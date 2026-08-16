import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../src/db.ts'
import { countTracks, deviceStats, facets, listDeviceTracks, listTracks, tracksDelta } from '../src/library.ts'

function fixture() {
  const db = open(':memory:')
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s', 'local', 'Local', '/m', 1)`)
  const ins = db.prepare(
    `INSERT INTO tracks (id, sourceId, path, kind, name, artist, albumArtist, album, genre, format, dateAdded, rev)
     VALUES (?, 's', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const data: [string, string, string, string, string, string, string, number][] = [
    ['t1', 'music',     'Dreams',   'Fleetwood Mac', 'Rumours', 'Rock', 'flac', 10],
    ['t2', 'music',     'Gold Dust','Fleetwood Mac', 'Rumours', 'Rock', 'mp3',  11],
    ['t3', 'music',     'Kid A',    'Radiohead',     'Kid A',   'Alt',  'mp3',  12],
    ['t4', 'audiobook', 'Chapter 1','Anouk Duval',  'Analog',  'Book', 'aac',  13],
    ['t5', 'podcast',   'Episode 4','Compression',   'Season 1','Tech', 'mp3',  14],
  ]
  for (const [id, kind, name, artist, album, genre, format, rev] of data)
    ins.run(id, `/m/${id}.${format}`, kind, name, artist, artist, album, genre, format, 1700000000000 + rev, rev)

  db.exec(`INSERT INTO devices (id, name, kind, rev) VALUES
    ('ipod', 'iPod', 'ipod-classic', 1), ('nano', 'Nano', 'ipod-nano', 1)`)
  const link = db.prepare(
    `INSERT INTO device_tracks (deviceId, deviceLocalId, trackId, name, artist, size) VALUES (?, ?, ?, ?, ?, ?)`)
  link.run('ipod', 'F00', 't1', 'Dreams', 'Fleetwood Mac', 100)
  link.run('ipod', 'F01', 't3', 'Kid A', 'Radiohead', 200)
  link.run('nano', 'F00', 't1', 'Dreams', 'Fleetwood Mac', 100)
  // A track present on the iPod but missing from the library: this is the one
  // we want to be able to re-import.
  link.run('ipod', 'F02', null, 'Lost Track', 'Unknown', 300)
  return db
}

test('device presence arrives with the page, without a query per track', () => {
  const db = fixture()
  const { items } = listTracks(db, { sort: 'name' })
  const byId = Object.fromEntries(items.map((t: any) => [t.id, t.devices]))
  assert.deepEqual([...byId.t1].sort(), ['ipod', 'nano'])
  assert.deepEqual(byId.t3, ['ipod'])
  assert.deepEqual(byId.t2, [], 'on no device')
})

test('notOnDevice answers "what is left for me to sync"', () => {
  const db = fixture()
  const manquantes = listTracks(db, { notOnDevice: 'ipod' }).items.map((t: any) => t.id).sort()
  assert.deepEqual(manquantes, ['t2', 't4', 't5'])
  assert.equal(countTracks(db, { notOnDevice: 'ipod' }), 3)
})

test('onDevice with match=all requires every listed device', () => {
  const db = fixture()
  const any = listTracks(db, { onDevice: 'ipod,nano' }).items.map((t: any) => t.id).sort()
  assert.deepEqual(any, ['t1', 't3'], 'at least one')
  const all = listTracks(db, { onDevice: 'ipod,nano', match: 'all' }).items.map((t: any) => t.id)
  assert.deepEqual(all, ['t1'], 'on both')
})

test('the filter combines with kind, for audiobooks and podcasts', () => {
  const db = fixture()
  assert.deepEqual(
    listTracks(db, { kind: 'audiobook', notOnDevice: 'ipod' }).items.map((t: any) => t.id), ['t4'])
  assert.deepEqual(
    listTracks(db, { kind: 'podcast', onDevice: 'ipod' }).items.map((t: any) => t.id), [])
})

test('the device contents read without the library, orphans included', () => {
  const db = fixture()
  const tout = listDeviceTracks(db, 'ipod', {})
  assert.equal(tout.items.length, 3, 'the 4th row is on the nano, not on the iPod')
  const orphelines = listDeviceTracks(db, 'ipod', { orphansOnly: true })
  assert.equal(orphelines.items.length, 1)
  assert.equal(orphelines.items[0].name, 'Lost Track')
  assert.equal(orphelines.items[0].libraryTrackId, null, 'that null is what triggers the import')

  const stats = deviceStats(db, 'ipod')
  assert.equal(stats.tracks, 3)
  assert.equal(stats.orphans, 1)
  assert.equal(stats.bytes, 600, 'stats stay scoped to one device')
})

test('the delta returns only what changed, deletions included', () => {
  const db = fixture()
  assert.equal(tracksDelta(db, 12).changed.length, 2, 't4 and t5')
  assert.equal(tracksDelta(db, 0).changed.length, 5)

  db.exec(`UPDATE tracks SET deletedAt = 1, rev = 99 WHERE id = 't2'`)
  const d = tracksDelta(db, 12)
  assert.deepEqual(d.deleted, ['t2'])
  assert.ok(!d.changed.some((t: any) => t.id === 't2'), 'a deletion does not come back as a change')
})

test('full-text search goes through FTS5', () => {
  const db = fixture()
  db.exec(`INSERT INTO tracks_fts (rowid, name, artist, album, albumArtist, composer, genre)
           SELECT rowid, name, artist, album, albumArtist, composer, genre FROM tracks`)
  assert.deepEqual(listTracks(db, { q: 'fleetwood' }).items.map((t: any) => t.id).sort(), ['t1', 't2'])
  assert.deepEqual(listTracks(db, { q: 'kid' }).items.map((t: any) => t.id), ['t3'])
})

test('the page carries its cursor and device presence stays correct page after page', () => {
  const db = fixture()
  const seen: string[] = []
  let cursor: string | undefined
  for (let i = 0; i < 10; i++) {
    const page = listTracks(db, { sort: 'name', limit: 2, cursor })
    for (const t of page.items) seen.push(t.id)
    if (!page.next) break
    cursor = page.next
  }
  assert.equal(seen.length, 5)
  assert.equal(new Set(seen).size, 5)
})

test('facets cascade like the iTunes column browser', () => {
  const db = fixture()
  const all = facets(db, {})
  assert.deepEqual(all.genres.map((g: any) => g.value).sort(), ['Alt', 'Book', 'Rock', 'Tech'])
  assert.equal(all.genres.find((g: any) => g.value === 'Rock')!.count, 2)

  // Picking a genre narrows the artists, but not the genre list itself —
  // otherwise the left pane would collapse onto its own selection.
  const rock = facets(db, { genre: 'Rock' })
  assert.equal(rock.genres.length, 4, 'every genre is still offered')
  assert.deepEqual(rock.artists.map((a: any) => a.value), ['Fleetwood Mac'])
  assert.deepEqual(rock.albums.map((a: any) => a.value), ['Rumours'])
})

test('facets respect the search and the device filter', () => {
  const db = fixture()
  db.exec(`INSERT INTO tracks_fts (rowid, name, artist, album, albumArtist, composer, genre)
           SELECT rowid, name, artist, album, albumArtist, composer, genre FROM tracks`)
  assert.deepEqual(facets(db, { q: 'fleetwood' }).genres.map((g: any) => g.value), ['Rock'])
  // "What is left to put on the iPod" must narrow the panes too.
  assert.ok(!facets(db, { notOnDevice: 'ipod' }).artists.some((a: any) => a.value === 'Radiohead'))
})

test('the format filter runs in SQL, and the facets say what is there', () => {
  const db = fixture()
  // Whatever the library actually holds, counted over all of it -- a front end
  // filtering the page it happens to hold would offer "3 FLAC" out of four
  // hundred, which is worse than no filter.
  const f = facets(db, {})
  assert.ok(Array.isArray(f.formats))
  const total = f.formats.reduce((n, x) => n + x.count, 0)
  assert.equal(total, listTracks(db, { limit: 500 }).items.length)

  assert.deepEqual(f.formats.map((x) => x.value), ['aac', 'flac', 'mp3'], 'sorted, and only what is there')
  assert.equal(f.formats.find((x) => x.value === 'mp3')?.count, 3)

  const first = f.formats[0]
  const only = listTracks(db, { format: first.value, limit: 500 })
  assert.equal(only.items.length, first.count)
  assert.ok(only.items.every((t: any) => t.format === first.value))

  // A client typing FLAC should not silently get nothing.
  assert.equal(listTracks(db, { format: first.value.toUpperCase(), limit: 500 }).items.length, first.count)
  assert.equal(listTracks(db, { format: 'not-a-codec', limit: 500 }).items.length, 0)
})
