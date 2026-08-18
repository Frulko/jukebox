import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'

/** A dropped file: raw body, kind and name in the query. */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-up-'))
  const { app, jobs, db } = createApp(join(dir, 'db.sqlite'))
  const call = (path: string, body?: BodyInit) =>
    app.fetch(new Request(`http://x/api/v1${path}`, { method: 'POST', body }))
  return { call, db, dir, cleanup: () => { jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

test('a dropped file lands at the kind’s favorite folder and is indexed', async () => {
  const h = await harness()
  const root = await mkdtemp(join(tmpdir(), 'jukebox-up-lib-'))
  try {
    // Nowhere to write: refused before any byte lands.
    const refused = await h.call('/upload?kind=podcast&name=ep.mp3', 'x')
    assert.equal(refused.status, 400)
    assert.equal((await refused.json() as any).error.code, 'no_writable_source')

    await h.call('/sources', JSON.stringify({ name: 'lib', root, writable: true }))
    // The favorites mapping, straight in the row: this test is about reading
    // it, not about the API that writes it.
    h.db.prepare(`UPDATE sources SET favorites = ? WHERE name = 'lib'`)
      .run(JSON.stringify([{ path: 'Casts', kind: 'podcast' }]))

    const ok = await h.call('/upload?kind=podcast&name=Episode%20One.mp3', Buffer.from('not really an mp3'))
    assert.equal(ok.status, 201)
    const track = await ok.json() as any
    assert.ok(track.path.startsWith('Casts/'), `favorite folder chosen, got ${track.path}`)
    await stat(join(root, track.path))
    const row = h.db.prepare(`SELECT kind, name FROM tracks WHERE id = ?`).get(track.id) as any
    assert.equal(row.kind, 'podcast')
    assert.equal(row.name, 'Episode One')

    // Music has no favorite here: the conventional folder serves.
    const music = await h.call('/upload?kind=music&name=song.flac', Buffer.from('not a flac either'))
    assert.equal(music.status, 201)
    assert.ok(((await music.json() as any).path as string).startsWith('Music/'))

    // What the scanner would never read is refused, not filed.
    const bad = await h.call('/upload?kind=music&name=notes.txt', Buffer.from('hello'))
    assert.equal(bad.status, 400)
    assert.equal((await bad.json() as any).error.code, 'bad_file')
  } finally {
    await h.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
