import type { DB } from './db.ts'
import { nextRev } from './db.ts'
import { DURATION_TOLERANCE } from './tags.ts'

/**
 * The same song, twice in the library.
 *
 * Usually because it was ripped once and downloaded once, or converted before
 * renditions existed. Merging turns two rows into one track with two files,
 * which is what the rest of the app already expects: an iPod that takes AAC and
 * a browser that wants the FLAC are asking for the same song.
 *
 * The dangerous half is **grouping**, not merging. Two different songs sharing
 * a title is ordinary — every band has a "Intro", every live album repeats the
 * studio tracklist — so the rule is deliberately strict:
 *
 * - identical acoustic fingerprints match outright, because that compared the
 *   audio itself;
 * - otherwise artist *and* title must match after normalisation, **and** the
 *   durations must be within a few seconds. A studio take and a live take of
 *   the same song differ by more than that, which is exactly the pair that must
 *   not be merged.
 *
 * Nothing merges without being asked. `GET /duplicates` proposes, and each
 * merge names the track to keep.
 */

export type DuplicateGroup = {
  /** Suggested keeper: the one with the most to lose. */
  keeperId: string
  reason: 'fingerprint' | 'metadata'
  tracks: {
    id: string
    name: string
    artist: string
    album: string
    duration: number
    format: string
    size: number
    bitRate: number
    rating: number
    playCount: number
    renditions: number
  }[]
}

/**
 * Normalised for comparison only — never written anywhere.
 *
 * Strips the things that differ between two copies of one song and mean
 * nothing: case, accents, punctuation, and the bracketed suffixes that a
 * download picks up. `(Remastered 2011)` is deliberately *kept*: a remaster is
 * a different recording, and merging it away loses the one the user chose.
 */
export function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(feat|ft|featuring)\b.*$/, '')
    .replace(/[‘’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Groups of rows that are the same song. Never merges anything itself. */
export function findDuplicates(db: DB, opts: { limit?: number } = {}): DuplicateGroup[] {
  const rows = db.prepare(
    `SELECT t.id, t.name, t.artist, t.albumArtist, t.album, t.duration, t.format, t.size,
            t.bitRate, t.rating, t.playCount, t.loved, t.fingerprint, t.dateAdded,
            (SELECT COUNT(*) FROM renditions r WHERE r.trackId = t.id) AS renditions
     FROM tracks t WHERE t.deletedAt IS NULL AND t.kind = 'music'`).all() as any[]

  const byKey = new Map<string, { reason: DuplicateGroup['reason']; rows: any[] }>()

  for (const r of rows) {
    // A strong fingerprint compared the audio; nothing else needs checking.
    // A weak one (`wk:`) is derived from the tags, so it would only restate the
    // metadata match and is left to that path.
    if (r.fingerprint?.startsWith('cp:')) {
      const key = `fp:${r.fingerprint}`
      const g = byKey.get(key) ?? { reason: 'fingerprint' as const, rows: [] }
      g.rows.push(r)
      byKey.set(key, g)
      continue
    }
    const artist = normalize(r.albumArtist || r.artist)
    const title = normalize(r.name)
    if (!artist || !title) continue
    const key = `md:${artist}|${title}`
    const g = byKey.get(key) ?? { reason: 'metadata' as const, rows: [] }
    g.rows.push(r)
    byKey.set(key, g)
  }

  const groups: DuplicateGroup[] = []
  for (const { reason, rows: candidates } of byKey.values()) {
    if (candidates.length < 2) continue

    // Metadata matches still have to agree on length. Two songs with one title
    // is ordinary; two recordings of one song three minutes apart are not the
    // same recording.
    const clusters = reason === 'fingerprint' ? [candidates] : clusterByDuration(candidates)

    for (const cluster of clusters) {
      if (cluster.length < 2) continue
      groups.push({ keeperId: pickKeeper(cluster).id, reason, tracks: cluster.map(publicRow) })
      if (opts.limit && groups.length >= opts.limit) return groups
    }
  }
  return groups
}

/** Splits candidates into runs whose durations are within tolerance of each other. */
function clusterByDuration(rows: any[]): any[][] {
  const sorted = [...rows].sort((a, b) => a.duration - b.duration)
  const out: any[][] = []
  let current: any[] = []
  for (const r of sorted) {
    if (!current.length || Math.abs(r.duration - current[0].duration) <= DURATION_TOLERANCE) {
      current.push(r)
    } else {
      out.push(current)
      current = [r]
    }
  }
  if (current.length) out.push(current)
  return out
}

/**
 * Which row to keep.
 *
 * The one carrying the most that cannot be recovered: play counts and a rating
 * are a history, and a bitrate is not. Between two equals, the one added first,
 * because that is the one playlists are most likely to point at.
 */
function pickKeeper(rows: any[]): any {
  return [...rows].sort((a, b) =>
    (b.playCount - a.playCount)
    || (b.rating - a.rating)
    || (b.loved - a.loved)
    || (b.bitRate - a.bitRate)
    || (a.dateAdded - b.dateAdded))[0]
}

const publicRow = (r: any) => ({
  id: r.id, name: r.name, artist: r.albumArtist || r.artist, album: r.album,
  duration: r.duration, format: r.format, size: r.size, bitRate: r.bitRate,
  rating: r.rating, playCount: r.playCount, renditions: r.renditions,
})

export type MergeResult = { keeperId: string; merged: number; renditions: number }

/**
 * Folds several tracks into one.
 *
 * Everything that pointed at a merged track is repointed rather than dropped:
 * playlists, what is on a device, and what is waiting for one. A merge that
 * silently emptied a playlist would be worse than the duplicate it fixed.
 *
 * The merged rows are soft deleted, not removed. Their files are untouched —
 * they become renditions of the keeper, which is the entire point.
 */
export function mergeTracks(db: DB, keeperId: string, mergeIds: string[]): MergeResult | null {
  const keeper = db.prepare(`SELECT * FROM tracks WHERE id = ? AND deletedAt IS NULL`).get(keeperId) as any
  if (!keeper) return null

  const others = mergeIds
    .filter((id) => id !== keeperId)
    .map((id) => db.prepare(`SELECT * FROM tracks WHERE id = ? AND deletedAt IS NULL`).get(id) as any)
    .filter(Boolean)
  if (!others.length) return { keeperId, merged: 0, renditions: 0 }

  const rev = nextRev(db)
  let moved = 0

  for (const other of others) {
    // The files come across. `INSERT OR IGNORE` on the way in: a rendition of
    // the same (sourceId, path) already under the keeper is the same file.
    const rends = db.prepare(`SELECT id FROM renditions WHERE trackId = ?`).all(other.id) as any[]
    for (const r of rends) {
      // No conflict is possible: (sourceId, path) is unique across the table,
      // so one file can only ever belong to one track. `preferred = 0` because
      // the keeper already has one and there is exactly one per track.
      db.prepare(`UPDATE renditions SET trackId = ?, preferred = 0 WHERE id = ?`).run(keeperId, r.id)
      moved++
    }
    // A track with no rendition row still has a file, described by its flat
    // columns. Losing it here would delete music.
    if (!rends.length && other.path) {
      db.prepare(
        `INSERT OR IGNORE INTO renditions (id, trackId, sourceId, path, format, bitRate,
           sampleRate, channels, size, mtime, preferred, createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`)
        .run(`r-${other.id}`, keeperId, other.sourceId, other.path, other.format,
          other.bitRate, other.sampleRate, other.channels, other.size, other.mtime, Date.now())
      moved++
    }

    // Anything pointing at the old row now points at the keeper. `OR IGNORE`
    // throughout: the keeper may already be in that playlist or on that device,
    // and a duplicate key there is the merge succeeding, not failing.
    db.prepare(`UPDATE OR IGNORE playlist_tracks SET trackId = ? WHERE trackId = ?`).run(keeperId, other.id)
    db.prepare(`DELETE FROM playlist_tracks WHERE trackId = ?`).run(other.id)
    db.prepare(`UPDATE OR IGNORE device_tracks SET trackId = ? WHERE trackId = ?`).run(keeperId, other.id)
    db.prepare(`UPDATE OR IGNORE device_wanted SET trackId = ? WHERE trackId = ?`).run(keeperId, other.id)
    db.prepare(`DELETE FROM device_wanted WHERE trackId = ?`).run(other.id)

    // A history is added up rather than picked between: the song really was
    // played that many times, whichever copy was playing.
    db.prepare(`
      UPDATE tracks SET
        playCount = playCount + ?,
        skipCount = skipCount + ?,
        rating = MAX(rating, ?),
        loved = MAX(loved, ?),
        dateAdded = MIN(dateAdded, ?),
        lastPlayed = MAX(COALESCE(lastPlayed, 0), COALESCE(?, 0)),
        rev = ?
      WHERE id = ?`)
      .run(other.playCount, other.skipCount, other.rating, other.loved,
        other.dateAdded, other.lastPlayed, rev, keeperId)

    // `mergedInto` rather than `deletedAt` alone: the Missing page asks for
    // soft-deleted rows, so without it every duplicate folded away here was
    // reported to the reader as a file lost off a disk.
    db.prepare(`UPDATE tracks SET deletedAt = ?, mergedInto = ?, rev = ? WHERE id = ?`)
      .run(Date.now(), keeperId, rev, other.id)
  }

  // `lastPlayed` of 0 means never; MAX above can only have produced it if
  // neither side had one.
  db.prepare(`UPDATE tracks SET lastPlayed = NULL WHERE id = ? AND lastPlayed = 0`).run(keeperId)
  db.exec(`INSERT INTO tracks_fts (tracks_fts) VALUES ('rebuild')`)

  return { keeperId, merged: others.length, renditions: moved }
}

/**
 * "That file is gone; this one is the same song."
 *
 * The other half of a merge, and deliberately not the same function. A merge
 * folds two rows that both have files; a substitution has exactly one file left
 * — so the missing row's history crosses over and its **rendition never does**.
 * Carrying it would hand the keeper a path that is not on any disk, which is
 * the one thing the Missing page exists to complain about.
 *
 * What crosses: the rating, the play and skip counts, the date it was added,
 * the last time it played, and every playlist and device that pointed at it.
 * That is the whole reason the row was worth keeping rather than tidying away.
 */
export function substituteMissing(db: DB, keeperId: string, missingIds: string[]): MergeResult | null {
  const keeper = db.prepare(`SELECT * FROM tracks WHERE id = ? AND deletedAt IS NULL`).get(keeperId) as any
  if (!keeper) return null

  const gone = missingIds
    .filter((id) => id !== keeperId)
    // Soft-deleted *and* not already substituted: repeating the call must not
    // add the same play count twice, and a UI with a stale list will repeat it.
    .map((id) => db.prepare(
      `SELECT * FROM tracks WHERE id = ? AND deletedAt IS NOT NULL AND mergedInto IS NULL`).get(id) as any)
    .filter(Boolean)
  if (!gone.length) return { keeperId, merged: 0, renditions: 0 }

  const rev = nextRev(db)
  for (const other of gone) {
    db.prepare(`UPDATE OR IGNORE playlist_tracks SET trackId = ? WHERE trackId = ?`).run(keeperId, other.id)
    db.prepare(`DELETE FROM playlist_tracks WHERE trackId = ?`).run(other.id)
    db.prepare(`UPDATE OR IGNORE device_tracks SET trackId = ? WHERE trackId = ?`).run(keeperId, other.id)
    db.prepare(`UPDATE OR IGNORE device_wanted SET trackId = ? WHERE trackId = ?`).run(keeperId, other.id)
    db.prepare(`DELETE FROM device_wanted WHERE trackId = ?`).run(other.id)

    db.prepare(`
      UPDATE tracks SET
        playCount = playCount + ?,
        skipCount = skipCount + ?,
        rating = MAX(rating, ?),
        loved = MAX(loved, ?),
        dateAdded = MIN(dateAdded, ?),
        lastPlayed = MAX(COALESCE(lastPlayed, 0), COALESCE(?, 0)),
        rev = ?
      WHERE id = ?`)
      .run(other.playCount, other.skipCount, other.rating, other.loved,
        other.dateAdded, other.lastPlayed, rev, keeperId)

    // The row stays, pointing at where its history went. It leaves the Missing
    // page because it is no longer missing — it was answered.
    db.prepare(`UPDATE tracks SET mergedInto = ?, rev = ? WHERE id = ?`).run(keeperId, rev, other.id)
  }

  db.prepare(`UPDATE tracks SET lastPlayed = NULL WHERE id = ? AND lastPlayed = 0`).run(keeperId)
  return { keeperId, merged: gone.length, renditions: 0 }
}
