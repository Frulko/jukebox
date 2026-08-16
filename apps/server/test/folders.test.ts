import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../src/db.ts'
import { countTracks, facets, listTracks } from '../src/library.ts'

function fixture(paths: string[]) {
  const db = open(':memory:')
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s','local','S','/',1)`)
  const ins = db.prepare(
    `INSERT INTO tracks (id, sourceId, path, name, artist, albumArtist, album, dateAdded, rev)
     VALUES (?, 's', ?, ?, 'A', 'A', 'Alb', 0, 1)`)
  paths.forEach((path, i) => ins.run(`t${i}`, path, `Track ${i}`))
  return db
}

const under = (db: ReturnType<typeof open>, folder: string) =>
  listTracks(db, { folder }).items.map((t: any) => t.path).sort()

test('a folder takes what is under it and nothing beside it', () => {
  const db = fixture([
    'Podcasts/Radiolab/01.mp3',
    'Podcasts/Radiolab/02.mp3',
    'Podcasts/Radiolab Extra/01.mp3',
    'Podcasts/Other/01.mp3',
  ])
  // The trailing separator is the whole point: without it "Radiolab" would also
  // take "Radiolab Extra", which is a different show.
  assert.deepEqual(under(db, 'Podcasts/Radiolab'), ['Podcasts/Radiolab/01.mp3', 'Podcasts/Radiolab/02.mp3'])
  assert.deepEqual(under(db, 'Podcasts/Radiolab/'), ['Podcasts/Radiolab/01.mp3', 'Podcasts/Radiolab/02.mp3'])
  assert.equal(countTracks(db, { folder: 'Podcasts' }), 4)
})

test('an underscore is a character, not a wildcard', () => {
  const db = fixture(['Live_Sets/01.mp3', 'LiveXSets/01.mp3'])
  // Unescaped, `Live_Sets/%` matches `LiveXSets/` too — the classic LIKE trap,
  // and folder names are full of underscores.
  assert.deepEqual(under(db, 'Live_Sets'), ['Live_Sets/01.mp3'])
})

test('the folder list is every folder, with the library’s own counts', () => {
  const db = fixture([
    'Podcasts/Radiolab/01.mp3',
    'Podcasts/Radiolab/02.mp3',
    'Music/Air/Moon Safari/01.flac',
    'loose.mp3',
  ])
  assert.deepEqual(
    facets(db, {}).folders.map((f) => [f.value, f.count]),
    [
      ['Music/Air/Moon Safari/', 1],
      ['Podcasts/Radiolab/', 2],
    ],
  )
})

test('a file at the root of a source is in no folder, and says so by being absent', () => {
  const db = fixture(['loose.mp3'])
  assert.deepEqual(facets(db, {}).folders, [])
})

test('the folder list is scoped like every other facet', () => {
  const db = fixture(['Podcasts/Radiolab/01.mp3'])
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('other','local','O','/o',1)`)
  db.exec(`INSERT INTO tracks (id, sourceId, path, name, artist, albumArtist, album, dateAdded, rev)
           VALUES ('x','other','Secret/Show/01.mp3','X','A','A','Alb',0,1)`)
  const visible = facets(db, { sourceIds: ['s'] }).folders.map((f) => f.value)
  assert.deepEqual(visible, ['Podcasts/Radiolab/'])
})
