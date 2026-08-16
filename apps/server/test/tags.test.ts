import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprint, matches, readTags, writeTags } from '../src/tags.ts'

const FIXTURES = process.env.JUKEBOX_FIXTURES ?? ''
const skip = FIXTURES ? false : 'JUKEBOX_FIXTURES is not set'

test('tags are read from mp3, flac and m4a', { skip }, async () => {
  for (const [file, format] of [['Daft Punk/Discovery/01.mp3', 'mpeg'],
                                ['Daft Punk/Discovery/03.flac', 'flac'],
                                ['Radiohead/Kid A/01.m4a', 'm4a']] as const) {
    const r = await readTags(join(FIXTURES, file))
    assert.ok(r.tags.name, `${file} — title read`)
    assert.ok(r.tags.artist, `${file} — artist read`)
    assert.ok(r.audio.duration > 0, `${file} — duration read`)
    assert.match(r.audio.format, new RegExp(format, 'i'), `${file} — format`)
  }
})

test('tags are written in place and read back from the file', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-tags-'))
  try {
    for (const src of ['Daft Punk/Discovery/01.mp3', 'Daft Punk/Discovery/03.flac', 'Radiohead/Kid A/01.m4a']) {
      const copy = join(dir, src.split('/').pop()!)
      await copyFile(join(FIXTURES, src), copy)

      const before = await readTags(copy)
      await writeTags(copy, {
        name: 'Rewritten Title',
        artist: 'Rewritten Artist',
        albumArtist: 'Rewritten Album Artist',
        album: 'Rewritten Album',
        genre: 'Trip Hop',
        year: 1994,
        trackNumber: 7,
        discNumber: 2,
        comments: 'Ripped from vinyl',
        grouping: 'Party',
      })
      const after = await readTags(copy)

      assert.equal(after.tags.name, 'Rewritten Title', `${src} — title`)
      assert.equal(after.tags.artist, 'Rewritten Artist', `${src} — artist`)
      assert.equal(after.tags.album, 'Rewritten Album', `${src} — album`)
      assert.equal(after.tags.year, 1994, `${src} — year`)
      assert.equal(after.tags.trackNumber, 7, `${src} — track number`)
      assert.equal(after.tags.genre, 'Trip Hop', `${src} — genre`)
      // Writing tags must not touch the audio signal.
      assert.equal(after.audio.duration, before.audio.duration, `${src} — duration untouched`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the fingerprint survives a re-encode and rewritten tags', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-fp-'))
  try {
    const src = join(FIXTURES, 'Daft Punk/Discovery/01.mp3')
    const copy = join(dir, 'copy.mp3')
    await copyFile(src, copy)
    const original = await fingerprint(src)

    // Completely different tags must not change the fingerprint: that is the
    // whole point when matching a track back on an old iPod.
    await writeTags(copy, { name: 'Nothing Alike', artist: 'Unknown', album: 'Other' })
    assert.equal(await fingerprint(copy), original, 'tags do not feed into the acoustic fingerprint')
    assert.ok(original.startsWith('cp:'), 'fpcalc is available here')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('without fpcalc, the weak fingerprint does not depend on the duration', async () => {
  const [fa, fb, fc] = await Promise.all([
    fingerprint('/no-such-file', { artist: 'Daft Punk', name: 'One More Time', duration: 320 }),
    fingerprint('/no-such-file', { artist: 'Daft Punk', name: 'One More Time', duration: 321 }),
    fingerprint('/no-such-file', { artist: 'Daft Punk', name: 'Aerodynamic', duration: 320 }),
  ])
  assert.equal(fa, fb, 'one second of encoding difference does not split two copies apart')
  assert.notEqual(fa, fc, 'two different tracks stay distinct')
  assert.ok(fa.startsWith('wk:'), 'the fallback is flagged as weak')
})

test('matching confirms a weak fingerprint with the duration, but never a strong one', async () => {
  const fp = await fingerprint('/no-such-file', { artist: 'A', name: 'B', duration: 200 })
  assert.ok(matches({ fingerprint: fp, duration: 200 }, { fingerprint: fp, duration: 202 }),
    '2 s apart: same track')
  assert.ok(!matches({ fingerprint: fp, duration: 200 }, { fingerprint: fp, duration: 260 }),
    '1 minute apart: a live version is not the studio version')
  // An acoustic fingerprint does not need the duration: it compared the signal.
  assert.ok(matches({ fingerprint: 'cp:xyz', duration: 200 }, { fingerprint: 'cp:xyz', duration: 260 }))
})
