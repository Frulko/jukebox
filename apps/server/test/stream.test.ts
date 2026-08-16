import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mimeFor, parseRange } from '../src/stream.ts'

const SIZE = 1000

test('no Range header means send the whole file', () => {
  assert.equal(parseRange(undefined, SIZE), null)
  assert.equal(parseRange('', SIZE), null)
  assert.equal(parseRange('bytes=-', SIZE), null)
})

test('an open-ended range runs to the last byte', () => {
  assert.deepEqual(parseRange('bytes=0-', SIZE), { start: 0, end: 999 })
  assert.deepEqual(parseRange('bytes=500-', SIZE), { start: 500, end: 999 })
})

test('a closed range is inclusive at both ends', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { start: 0, end: 99 })
  // 100 bytes, not 99: Content-Length is end - start + 1, and being one out
  // here truncates every chunk a player asks for.
  const r = parseRange('bytes=0-99', SIZE) as { start: number; end: number }
  assert.equal(r.end - r.start + 1, 100)
})

test('a range past the end is clamped, not refused', () => {
  assert.deepEqual(parseRange('bytes=900-99999', SIZE), { start: 900, end: 999 })
})

test('a suffix range is the tail of the file, not the head', () => {
  // `bytes=-500` means the last 500 bytes. Reading it as 0-500 serves the
  // beginning of the track when the end was asked for -- a seek to the last
  // minute would replay the first.
  assert.deepEqual(parseRange('bytes=-500', SIZE), { start: 500, end: 999 })
  assert.deepEqual(parseRange('bytes=-99999', SIZE), { start: 0, end: 999 })
})

test('a range that cannot be satisfied says so instead of guessing', () => {
  assert.equal(parseRange('bytes=1000-', SIZE), 'unsatisfiable')
  assert.equal(parseRange('bytes=2000-3000', SIZE), 'unsatisfiable')
  assert.equal(parseRange('bytes=500-100', SIZE), 'unsatisfiable')
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable')
})

test('only the first range of a multi-range request is honoured', () => {
  // Allowed by the spec, and no audio element has ever sent one.
  assert.deepEqual(parseRange('bytes=0-99,200-299', SIZE), { start: 0, end: 99 })
})

test('the content type names the container, not the codec', () => {
  // The distinction that matters: AAC inside an .m4a is audio/mp4, and a
  // browser handed audio/aac for it refuses to decode a perfectly good file.
  assert.equal(mimeFor('aac', 'a/b.m4a'), 'audio/mp4')
  assert.equal(mimeFor('alac', 'a/b.m4a'), 'audio/mp4')
  assert.equal(mimeFor('aac', 'a/b.aac'), 'audio/aac', 'raw ADTS really is audio/aac')
  assert.equal(mimeFor('opus', 'a/b.opus'), 'audio/ogg')

  // The filename wins over the stored codec, because it is the one that knows
  // what the bytes are wrapped in.
  assert.equal(mimeFor('flac', 'a/b.m4a'), 'audio/mp4')

  // Without a path, the codec's usual container is the best guess available.
  assert.equal(mimeFor('mp3'), 'audio/mpeg')
  assert.equal(mimeFor('flac'), 'audio/flac')
  assert.equal(mimeFor('alac'), 'audio/mp4')
  assert.equal(mimeFor('MP3'), 'audio/mpeg', 'case does not matter')
  assert.equal(mimeFor('nonsense'), 'application/octet-stream')
  assert.equal(mimeFor('nonsense', 'a/b.unknown'), 'application/octet-stream')
})
