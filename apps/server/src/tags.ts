import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseFile } from 'music-metadata'

/**
 * Tag reading and writing.
 *
 * Reading goes through `music-metadata` — pure JS, fast in bulk, and what the
 * scanner uses. Writing goes through `node-taglib-sharp`, also pure JS, loaded
 * **lazily**: most installs never rewrite a tag, and the module is not small.
 */

export type Tags = {
  name?: string
  artist?: string
  albumArtist?: string
  album?: string
  genre?: string
  composer?: string
  year?: number
  trackNumber?: number
  trackCount?: number
  discNumber?: number
  bpm?: number
  comments?: string
  grouping?: string
  compilation?: boolean
}

/** The fields we agree to write to disk, and nothing else. */
export const WRITABLE: (keyof Tags)[] = [
  'name', 'artist', 'albumArtist', 'album', 'genre', 'composer',
  'year', 'trackNumber', 'trackCount', 'discNumber', 'bpm', 'comments', 'grouping', 'compilation',
]

/**
 * The short codec name everything else in the app speaks: `mp3`, `aac`, `alac`.
 *
 * `format.container` cannot be used directly — it answers `MPEG` for an mp3 and
 * `M4A/isom/iso2` for an m4a, neither of which appears in the format list a
 * device declares. Comparing containers against that list marked every mp3 as
 * unplayable, and a sync would have transcoded a whole library to ALAC for
 * nothing.
 */
export function shortFormat(container = '', codec = ''): string {
  const s = `${codec} ${container}`.toLowerCase()
  if (s.includes('layer 3') || s.includes('mp3')) return 'mp3'
  if (s.includes('alac')) return 'alac'
  if (s.includes('aac')) return 'aac'
  if (s.includes('flac')) return 'flac'
  if (s.includes('opus')) return 'opus'
  if (s.includes('vorbis')) return 'vorbis'
  if (s.includes('wave') || s.includes('wav')) return 'wav'
  if (s.includes('aiff')) return 'aiff'
  return container.toLowerCase()
}

export async function readTags(path: string) {
  const parsed = await parseFile(path, { duration: true, skipCovers: false })
  const c = parsed.common
  const f = parsed.format
  return {
    tags: {
      name: c.title,
      artist: c.artist,
      albumArtist: c.albumartist,
      album: c.album,
      genre: c.genre?.[0],
      composer: c.composer?.[0],
      year: c.year,
      trackNumber: c.track?.no ?? undefined,
      trackCount: c.track?.of ?? undefined,
      discNumber: c.disk?.no ?? undefined,
      bpm: c.bpm,
      comments: c.comment?.[0]?.text,
      grouping: c.grouping,
      compilation: c.compilation ?? false,
    } satisfies Tags,
    audio: {
      duration: Math.round(f.duration ?? 0),
      bitRate: Math.round((f.bitrate ?? 0) / 1000),
      sampleRate: f.sampleRate ?? 0,
      channels: f.numberOfChannels ?? 2,
      format: shortFormat(f.container, f.codec),
      lossless: f.lossless ?? false,
    },
    picture: c.picture?.[0] ?? null,
  }
}

let taglib: any = null
async function lib() {
  // Lazy import: the module only loads if we actually write.
  taglib ??= await import('node-taglib-sharp')
  return taglib
}

/**
 * Writes tags **into the source file**, in place. Nothing is copied: that is the
 * project rule, the iPod aside.
 *
 * A non-writable source never reaches this function — the check happens at the
 * source level, before the call.
 */
export async function writeTags(path: string, tags: Partial<Tags>): Promise<void> {
  const { File } = await lib()
  const file = File.createFromPath(path)
  try {
    const t = file.tag
    const set = <K extends keyof Tags>(key: K, apply: (v: NonNullable<Tags[K]>) => void) => {
      const v = tags[key]
      if (v !== undefined && v !== null) apply(v as NonNullable<Tags[K]>)
    }
    set('name', (v) => (t.title = String(v)))
    set('artist', (v) => (t.performers = [String(v)]))
    set('albumArtist', (v) => (t.albumArtists = [String(v)]))
    set('album', (v) => (t.album = String(v)))
    set('genre', (v) => (t.genres = [String(v)]))
    set('composer', (v) => (t.composers = [String(v)]))
    set('year', (v) => (t.year = Number(v)))
    set('trackNumber', (v) => (t.track = Number(v)))
    set('trackCount', (v) => (t.trackCount = Number(v)))
    set('discNumber', (v) => (t.disc = Number(v)))
    set('bpm', (v) => (t.beatsPerMinute = Number(v)))
    set('comments', (v) => (t.comment = String(v)))
    set('grouping', (v) => (t.grouping = String(v)))
    set('compilation', (v) => (t.isCompilation = Boolean(v)))
    file.save()
  } finally {
    file.dispose()
  }
}

/**
 * Acoustic fingerprint.
 *
 * Matching a track between the library and an iPod cannot rely on metadata: a
 * re-encode or rewritten tags break equality, and that is exactly what happens
 * to a fifteen-year-old library. Chromaprint compares the signal itself.
 *
 * `fpcalc` is an optional binary. Without it we fall back to a weak fingerprint
 * derived from artist and title — less reliable, confirmed by duration in
 * `matches()`, but it blocks nobody. Computing this belongs to the server, never
 * the satellite: the server is the one with the files and the CPU.
 */
export async function fingerprint(path: string, meta?: { artist?: string; name?: string; duration?: number }): Promise<string> {
  const chroma = await chromaprint(path)
  if (chroma) return `cp:${chroma}`

  // Duration does NOT go into the hash. Any bucketing has boundaries, and two
  // copies of the same track one second apart land on either side of one —
  // precisely the case this fingerprint exists to cover. A tolerance does not
  // belong in a hash: duration is compared separately, in `matches()`.
  const basis = [
    (meta?.artist ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    (meta?.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''),
  ].join('|')
  return `wk:${createHash('sha1').update(basis).digest('base64url').slice(0, 22)}`
}

async function chromaprint(path: string): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('fpcalc', ['-json', '-length', '120', path], { timeout: 30000 })
    const parsed = JSON.parse(stdout)
    return parsed.fingerprint
      ? createHash('sha1').update(String(parsed.fingerprint)).digest('base64url').slice(0, 22)
      : null
  } catch {
    return null // fpcalc missing or file unreadable: the weak fingerprint takes over
  }
}

/** Duration tolerance between two copies of the same track, in seconds. */
export const DURATION_TOLERANCE = 3

/**
 * Are two tracks the same recording?
 *
 * An acoustic fingerprint (`cp:`) stands alone — it compares the signal, so
 * neither format nor tags matter. A weak fingerprint (`wk:`) rests only on
 * artist and title, so it needs duration to confirm it, otherwise two live
 * versions of the same song would be conflated.
 */
export function matches(
  a: { fingerprint: string; duration: number },
  b: { fingerprint: string; duration: number },
): boolean {
  if (a.fingerprint !== b.fingerprint) return false
  if (a.fingerprint.startsWith('cp:')) return true
  return Math.abs(a.duration - b.duration) <= DURATION_TOLERANCE
}

export const hasChromaprint = async (): Promise<boolean> => (await chromaprint('/dev/null')) !== null

/** Content hash of a cover — used as an immutable URL, hence a one-year cache. */
export async function artworkHash(data: Uint8Array): Promise<string> {
  return createHash('sha256').update(data).digest('base64url').slice(0, 24)
}

export async function fileHash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('base64url').slice(0, 24)
}
