import { test } from 'node:test'
import assert from 'node:assert/strict'
import { open } from '../src/db.ts'
import { facets, listTracks, tagTracks } from '../src/library.ts'

/**
 * Tags the listener writes, which are not the tags in the file. `src/tags.ts`
 * is the other kind — ID3 and friends, read from and written to disk.
 */
function fixture() {
  const db = open(':memory:')
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('s','local','S','/',1)`)
  const ins = db.prepare(
    `INSERT INTO tracks (id, sourceId, path, name, artist, albumArtist, album, dateAdded, rev)
     VALUES (?, 's', ?, ?, 'A', 'A', 'Alb', 0, 1)`)
  for (const id of ['t1', 't2', 't3']) ins.run(id, `/p/${id}`, id.toUpperCase())
  return db
}

const tagsOf = (db: ReturnType<typeof open>, id: string) =>
  (listTracks(db, {}).items.find((t: any) => t.id === id) as any).tags

/** SQLite hands back null-prototype rows, which `deepEqual` will not match. */
const tagFacets = (db: ReturnType<typeof open>, scope = {}) =>
  facets(db, scope).tags.map((t) => [t.value, t.count])

test('a tag is trimmed and lowercased, so one tag stays one tag', () => {
  const db = fixture()
  tagTracks(db, ['t1'], ['  Chill '])
  tagTracks(db, ['t2'], ['CHILL'])
  assert.deepEqual(tagsOf(db, 't1'), ['chill'])
  assert.deepEqual(tagsOf(db, 't2'), ['chill'])
  assert.deepEqual(tagFacets(db), [['chill', 2]])
})

test('tagging is idempotent and counts only what moved', () => {
  const db = fixture()
  assert.deepEqual(tagTracks(db, ['t1', 't2'], ['road trip']), { tagged: 2, untagged: 0 })
  // Already carried by both: nothing to do, and nothing claimed.
  assert.deepEqual(tagTracks(db, ['t1', 't2'], ['road trip']), { tagged: 0, untagged: 0 })
  assert.deepEqual(tagTracks(db, ['t1'], [], ['road trip']), { tagged: 0, untagged: 1 })
  assert.deepEqual(tagsOf(db, 't1'), [])
})

test('add and remove in one call, which is what swapping a tag is', () => {
  const db = fixture()
  tagTracks(db, ['t1'], ['chill'])
  tagTracks(db, ['t1'], ['workout'], ['chill'])
  assert.deepEqual(tagsOf(db, 't1'), ['workout'])
})

test('the filter is the tag, not a substring of it', () => {
  const db = fixture()
  tagTracks(db, ['t1'], ['chill'])
  tagTracks(db, ['t2'], ['chillout'])
  const ids = listTracks(db, { tag: 'chill' }).items.map((t: any) => t.id)
  assert.deepEqual(ids, ['t1'])
})

test('a page carries its tags, and a track with none carries an empty list', () => {
  const db = fixture()
  tagTracks(db, ['t1'], ['b', 'a'])
  assert.deepEqual(tagsOf(db, 't1'), ['a', 'b']) // sorted, so a row is stable
  assert.deepEqual(tagsOf(db, 't3'), [])
})

test('the revision only moves for tracks that changed', () => {
  const db = fixture()
  tagTracks(db, ['t1', 't2'], ['chill'], [], 42)
  const before = listTracks(db, {}).items as any[]
  assert.deepEqual(before.filter((t) => t.rev === 42).map((t) => t.id), ['t1', 't2'])

  // t1 already has it; only t2 loses one, so only t2 is restamped.
  tagTracks(db, ['t1'], ['chill'], [], 43)
  tagTracks(db, ['t2'], [], ['chill'], 43)
  const after = listTracks(db, {}).items as any[]
  assert.deepEqual(after.filter((t) => t.rev === 43).map((t) => t.id), ['t2'])
})

test('a tag on a track that does not exist is refused, not orphaned', () => {
  const db = fixture()
  assert.deepEqual(tagTracks(db, ['ghost'], ['chill']), { tagged: 0, untagged: 0 })
  assert.deepEqual(tagFacets(db), [])
})

test('deleting a track takes its tags with it', () => {
  const db = fixture()
  tagTracks(db, ['t1'], ['chill'])
  db.exec(`DELETE FROM tracks WHERE id = 't1'`)
  assert.deepEqual(tagFacets(db), [])
})

test('the tag facet is scoped like every other, so it cannot name what is hidden', () => {
  const db = fixture()
  db.exec(`INSERT INTO sources (id, kind, name, root, rev) VALUES ('other','local','O','/o',1)`)
  db.exec(`INSERT INTO tracks (id, sourceId, path, name, artist, albumArtist, album, dateAdded, rev)
           VALUES ('t9','other','/o/9','Hidden','A','A','Alb',0,1)`)
  tagTracks(db, ['t9'], ['secret'])
  tagTracks(db, ['t1'], ['chill'])
  assert.deepEqual(tagFacets(db, { sourceIds: ['s'] }), [['chill', 1]])
})
