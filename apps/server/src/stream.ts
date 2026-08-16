/**
 * Serving the audio itself.
 *
 * The whole endpoint is one rule: honour `Range`. A browser given a 200 with the
 * full body will play the track, but seeking inside it means re-downloading from
 * zero — on a 40 MB FLAC over wifi that is a visible stall on every drag of the
 * scrubber. With 206 responses the same drag costs a few kilobytes.
 *
 * Nothing here loads a file into memory: the response is a stream over the range
 * that was asked for, so a 100 MB track and a 3 MB one cost the server the same.
 */

/** The types browsers actually match on. Not a full IANA table — the formats we index. */
const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  alac: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  vorbis: 'audio/ogg',
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
}

export const mimeFor = (format: string) => MIME[format.toLowerCase()] ?? 'application/octet-stream'

export type Range = { start: number; end: number }

/**
 * Parses one `Range` header against a known size.
 *
 * Returns `null` for "no range, send everything" and `'unsatisfiable'` for a
 * range that falls outside the file, which is a 416 rather than a silent
 * clamp — a client asking for byte 900 of an 800-byte file has stale metadata
 * and needs to hear so.
 *
 * Multi-range requests are answered with their first range only. The spec allows
 * it, and no audio element has ever sent one.
 */
export function parseRange(header: string | undefined | null, size: number): Range | null | 'unsatisfiable' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  if (size === 0) return 'unsatisfiable'

  // `bytes=-500` is the *last* 500 bytes, not "from 0 to 500". Getting this
  // backwards serves the header of a file where its tail was asked for, which
  // is how a seek to the end plays the beginning again.
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!suffix) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}
