import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../src/db.ts'
import { planSync } from '../src/sync.ts'
import { addTracks, createPlaylist } from '../src/playlists.ts'

function fixture(opts: { capacity?: number; formats?: string[]; mode?: 'all' | 'playlists' } = {}) {
  const db = open(':memory:')
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s','local','S','/',1)`)
  const ins = db.prepare(
    `INSERT INTO tracks (id, sourceId, path, name, artist, albumArtist, album, format, size, dateAdded, rev)
     VALUES (?, 's', ?, ?, ?, ?, ?, ?, ?, 1, 1)`)
  const rows: [string, string, string, number][] = [
    ['t1', 'Dreams', 'mp3', 5_000_000],
    ['t2', 'Gold Dust', 'flac', 30_000_000],
    ['t3', 'Kid A', 'mp3', 6_000_000],
    ['t4', 'Untrue', 'opus', 4_000_000],
  ]
  for (const [id, name, format, size] of rows)
    ins.run(id, `/p/${id}`, name, 'A', 'A', 'Alb', format, size)

  db.prepare(
    `INSERT INTO devices (id, satelliteId, name, kind, capacity, acceptedFormats, syncMode, syncPlaylistIds, rev)
     VALUES ('ipod', 'sat-1', 'iPod', 'ipod-classic', ?, ?, ?, '[]', 1)`)
    .run(opts.capacity ?? 1_000_000_000,
      JSON.stringify(opts.formats ?? ['mp3', 'aac', 'alac']),
      opts.mode ?? 'all')
  return db
}

const hold = (db: any, deviceLocalId: string, trackId: string | null, size = 5_000_000, name = 'x') =>
  db.prepare(`INSERT INTO device_tracks (deviceId, deviceLocalId, trackId, name, size) VALUES ('ipod',?,?,?,?)`)
    .run(deviceLocalId, trackId, name, size)

test('the plan lists what to add and what the device already holds', () => {
  const db = fixture()
  hold(db, 'F0', 't1')
  const plan = planSync(db, 'ipod')
  assert.deepEqual(plan.add.map((a) => a.trackId).sort(), ['t2', 't3', 't4'])
  assert.equal(plan.keep, 1)
  assert.equal(plan.remove.length, 0)
})

test('the device declares its formats, the plan says what needs converting', () => {
  const db = fixture({ formats: ['mp3', 'aac', 'alac'] })
  const plan = planSync(db, 'ipod')
  const byId = Object.fromEntries(plan.add.map((a) => [a.trackId, a.transcode]))
  assert.equal(byId.t1, null, 'mp3 plays as is')
  assert.equal(byId.t2, 'alac', 'flac does not, and lossless goes to lossless')
  assert.equal(byId.t4, 'alac', 'opus does not either')
})

test('a track the device holds but the rules no longer want is removed', () => {
  const db = fixture({ mode: 'playlists' })
  const pl = createPlaylist(db, { name: 'Trip' })
  addTracks(db, pl.id, ['t1'])
  db.prepare(`UPDATE devices SET syncPlaylistIds = ? WHERE id = 'ipod'`).run(JSON.stringify([pl.id]))

  hold(db, 'F0', 't1')
  hold(db, 'F1', 't3') // in the library, not in the playlist any more
  const plan = planSync(db, 'ipod')
  assert.deepEqual(plan.remove.map((r) => r.deviceLocalId), ['F1'])
  assert.equal(plan.add.length, 0)
})

test('an orphan is never removed: it is the only copy left', () => {
  const db = fixture({ mode: 'playlists' })
  db.prepare(`UPDATE devices SET syncPlaylistIds = '[]' WHERE id = 'ipod'`).run()
  hold(db, 'F0', 't1')
  hold(db, 'F9', null, 3_000_000, 'Lost B-side')

  const plan = planSync(db, 'ipod')
  assert.deepEqual(plan.remove.map((r) => r.deviceLocalId), ['F0'],
    'the library copy goes, the orphan stays')
  assert.ok(!plan.remove.some((r) => r.deviceLocalId === 'F9'))
})

test('a plan that does not fit says how short it is, before anything moves', () => {
  // 45 MB of music, a device with 10 MB free.
  const db = fixture({ capacity: 10_000_000 })
  const plan = planSync(db, 'ipod')
  assert.ok(plan.shortBy !== null)
  assert.equal(plan.shortBy, plan.bytesAdded - plan.free)
  // Knowing this before a three-hour transfer is the whole point of dryRun.
  assert.ok(plan.shortBy > 0)
})

test('freeing space counts against what is added', () => {
  const db = fixture({ capacity: 46_000_000, mode: 'playlists' })
  const pl = createPlaylist(db, { name: 'Small' })
  addTracks(db, pl.id, ['t1'])
  db.prepare(`UPDATE devices SET syncPlaylistIds = ? WHERE id = 'ipod'`).run(JSON.stringify([pl.id]))
  hold(db, 'F1', 't2', 30_000_000) // a big track on its way out

  const plan = planSync(db, 'ipod')
  assert.equal(plan.bytesFreed, 30_000_000)
  assert.equal(plan.shortBy, null, 'the removal pays for the addition')
})
