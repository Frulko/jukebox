import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../src/db.ts'
import {
  countTracks, deviceStats, facets, listDeviceTracks, listTracks, membershipsOf, tracksDelta,
} from '../src/library.ts'
import { addTracks, createPlaylist, smartQuery } from '../src/playlists.ts'

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

test('memberships answer for smart playlists, which a client cannot', () => {
  const db = fixture()
  const manual = createPlaylist(db, { name: 'Roadtrip' })
  addTracks(db, manual.id, ['t2', 't1'])
  // A smart playlist is a query. Its membership cannot be read from a table,
  // which is the entire reason this lives on the server.
  createPlaylist(db, { name: 'Rock only', smart: 'rock', rules: { all: [{ field: 'genre', op: 'is', value: 'Rock' }] } })
  createPlaylist(db, { name: 'Jazz only', smart: 'jazz', rules: { all: [{ field: 'genre', op: 'is', value: 'Jazz' }] } })

  const m = membershipsOf(db, 't1', smartQuery)!
  const byName = Object.fromEntries(m.playlists.map((p) => [p.name, p]))

  assert.ok(byName.Roadtrip)
  // Where you put it, which is most of why anyone opens this.
  assert.equal(byName.Roadtrip.position, 1)
  assert.equal(byName.Roadtrip.smart, null)

  assert.ok(byName['Rock only'], 't1 is Rock, so the rules match it')
  assert.equal(byName['Rock only'].position, null, 'a smart playlist has matches, not positions')
  assert.ok(!byName['Jazz only'], 'and it does not appear in one whose rules it fails')

  assert.equal(membershipsOf(db, 'no-such-track', smartQuery), null)
})

test('a device says both whether it holds a track and whether it wants one', () => {
  const db = fixture()
  // Two different facts, and the second is the reason to look: a track picked
  // for the iPod that has not synced yet is the case someone checks.
  db.prepare(`INSERT INTO device_wanted (deviceId, trackId, addedAt) VALUES ('nano','t2',1)`).run()

  const held = membershipsOf(db, 't1', smartQuery)!
  const onIpod = held.devices.find((d) => d.id === 'ipod')!
  assert.equal(onIpod.present, true)
  assert.equal(onIpod.wanted, false)

  const waiting = membershipsOf(db, 't2', smartQuery)!.devices.find((d) => d.id === 'nano')!
  assert.equal(waiting.wanted, true)
  assert.equal(waiting.present, false, 'picked, not yet synced')

  // A device with no relationship to the track is not listed at all.
  assert.equal(membershipsOf(db, 't4', smartQuery)!.devices.length, 0)
})

test('rating filters in SQL, and 0 means unrated rather than no filter', () => {
  const db = fixture()
  db.exec(`UPDATE tracks SET rating = 5 WHERE id = 't1'`)
  db.exec(`UPDATE tracks SET rating = 3 WHERE id = 't2'`)

  assert.deepEqual(listTracks(db, { ratingMin: 4 }).items.map((t: any) => t.id), ['t1'])
  assert.deepEqual(listTracks(db, { rating: 3 }).items.map((t: any) => t.id), ['t2'])

  // "What have I never rated" is the query people run when tidying a library,
  // so `rating=0` has to survive the trip rather than read as "not asked".
  assert.deepEqual(listTracks(db, { rating: 0 }).items.map((t: any) => t.id).sort(), ['t3', 't4', 't5'])

  // Both forms arrive as strings over HTTP, where an empty one is a cleared
  // chip and must not become a filter for zero.
  assert.deepEqual(listTracks(db, { rating: '0' }).items.map((t: any) => t.id).sort(), ['t3', 't4', 't5'])
  assert.equal(listTracks(db, { rating: '' }).items.length, 5)
  assert.equal(listTracks(db, { ratingMin: '4' }).items.length, 1)

  // The count has to apply the same filter as the page, or a UI says "1 of 5"
  // over a list of one.
  assert.equal(countTracks(db, { ratingMin: 4 }), 1)
  assert.equal(countTracks(db, { rating: 0 }), 3)
})

test('lossless is asked of the rendition, and false means false', () => {
  const db = fixture()
  const r = db.prepare(
    `INSERT INTO renditions (id, trackId, sourceId, path, format, lossless, preferred, size, createdAt)
     VALUES (?, ?, 's', ?, ?, ?, ?, 0, 1700000000000)`)
  r.run('r1', 't1', '/m/t1.flac', 'flac', 1, 1)
  r.run('r2', 't2', '/m/t2.mp3', 'mp3', 0, 1)
  // Two files of the same song: the preferred one is what would play, so it is
  // what the filter has to answer for.
  r.run('r3', 't3', '/m/t3.mp3', 'mp3', 0, 1)
  r.run('r4', 't3', '/m/t3.flac', 'flac', 1, 0)

  assert.deepEqual(listTracks(db, { lossless: true }).items.map((t: any) => t.id), ['t1'])

  // The trap: `lossless=false` is a non-empty string, so anything testing it
  // for truthiness filters for exactly the opposite of what was asked.
  const lossy = listTracks(db, { lossless: 'false' }).items.map((t: any) => t.id).sort()
  assert.deepEqual(lossy, ['t2', 't3', 't4', 't5'])
  assert.equal(listTracks(db, { lossless: '' }).items.length, 5, 'a cleared chip is not a filter')
  assert.equal(countTracks(db, { lossless: true }), 1)
})
