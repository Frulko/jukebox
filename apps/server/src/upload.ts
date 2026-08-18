import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { dirname, extname, join } from 'node:path'
import type { DB } from './db.ts'
import { nextRev } from './db.ts'
import { AUDIO } from './scan.ts'
import { readTags } from './tags.ts'

/**
 * A file dropped on the window.
 *
 * The view it was dropped on names the kind — a file dropped on Podcasts is a
 * podcast — and the kind names the destination: a source's favorite folder
 * tagged with that kind, which is what the favorites mapping is *for*. With no
 * favorite tagged, a conventional folder at the first writable local source.
 */

const FALLBACK_DIR: Record<string, string> = { music: 'Music', podcast: 'Podcasts', audiobook: 'Audiobooks' }

export const UPLOAD_KINDS = new Set(Object.keys(FALLBACK_DIR))

// ponytail: mirrors app.ts's favoritesOf, which lives as a closure inside
// createApp — extract a shared one when a third reader appears.
const favoriteFor = (raw: unknown, kind: string): string | null => {
  try {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : '[]')
    if (!Array.isArray(parsed)) return null
    const hit = parsed.find((f) => f && typeof f === 'object' && f.kind === kind && typeof f.path === 'string')
    return hit ? hit.path : null
  } catch {
    return null
  }
}

/** Where a dropped file of this kind lands: `{ source, dir }`, or null with nowhere to write. */
export function dropTarget(db: DB, kind: string): { source: any; dir: string } | null {
  const sources = db.prepare(`SELECT * FROM sources WHERE kind = 'local' AND writable = 1 ORDER BY id`).all() as any[]
  for (const s of sources) {
    const dir = favoriteFor(s.favorites, kind)
    if (dir) return { source: s, dir }
  }
  return sources.length ? { source: sources[0], dir: FALLBACK_DIR[kind] } : null
}

const safe = (s: string) => (s || 'Unknown').replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 120)

/**
 * Writes the body to the target and indexes it, answering the new track.
 *
 * Temp then rename, as everywhere else. The file is written before its resting
 * place is known, because the resting place comes from the tags and the tags
 * are in the file.
 */
export async function receiveUpload(
  db: DB,
  body: ReadableStream<Uint8Array>,
  opts: { kind: string; name: string; target: { source: any; dir: string } },
): Promise<{ id: string; path: string } | { error: string }> {
  const ext = extname(opts.name).toLowerCase()
  if (!AUDIO.has(ext)) return { error: `not an audio file the scanner would read: ${ext || 'no extension'}` }

  const { source, dir } = opts.target
  const tmp = join(source.root, dir, `.upload-${createHash('sha1').update(opts.name + Date.now()).digest('hex').slice(0, 8)}.part`)
  await mkdir(dirname(tmp), { recursive: true })
  await pipeline(Readable.fromWeb(body as any), createWriteStream(tmp))

  const size = (await stat(tmp)).size
  if (!size) {
    await unlink(tmp).catch(() => {})
    return { error: 'the file was empty' }
  }

  let meta: any = {}
  try { meta = await readTags(tmp) } catch { /* still enters the library */ }

  const tags = meta.tags ?? {}
  const stem = safe(opts.name.slice(0, opts.name.length - ext.length))
  // Music files under artist/album like an import; shows and books under the
  // album (the show, the book) so chapters stay together.
  const rel = opts.kind === 'music'
    ? join(dir, safe(tags.albumArtist || tags.artist), safe(tags.album), `${tags.name ? safe(tags.name) : stem}${ext}`)
    : join(dir, tags.album ? safe(tags.album) : stem, `${tags.name ? safe(tags.name) : stem}${ext}`)
  const abs = join(source.root, rel)
  await mkdir(dirname(abs), { recursive: true })
  await rename(tmp, abs)

  const trackId = createHash('sha1').update(`${source.id}\0${rel}`).digest('base64url').slice(0, 16)
  db.prepare(`
    INSERT INTO tracks (id, sourceId, path, kind, name, artist, albumArtist, album,
      duration, format, size, mtime, dateAdded, rev)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (sourceId, path) DO UPDATE SET deletedAt = NULL, rev = excluded.rev`)
    .run(trackId, source.id, rel, opts.kind, tags.name || stem, tags.artist || '',
      tags.albumArtist || tags.artist || '', tags.album || '',
      meta.audio?.duration ?? 0, meta.audio?.format ?? ext.slice(1),
      size, Date.now(), Date.now(), nextRev(db))

  db.prepare(`
    INSERT INTO renditions (id, trackId, sourceId, path, format, size, mtime, preferred, createdAt)
    VALUES (?,?,?,?,?,?,?,1,?)
    ON CONFLICT (sourceId, path) DO UPDATE SET
      format = excluded.format, size = excluded.size, mtime = excluded.mtime`)
    .run(`r-${trackId}`, trackId, source.id, rel,
      meta.audio?.format ?? ext.slice(1), size, Date.now(), Date.now())

  db.exec(`INSERT INTO tracks_fts (tracks_fts) VALUES ('rebuild')`)
  return { id: trackId, path: rel }
}
