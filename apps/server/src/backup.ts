import type { DB } from './db.ts'
import { nextRev } from './db.ts'

/**
 * Backup and restore.
 *
 * What is worth saving is what a scan cannot rebuild. The track table is
 * derived — point the scanner at the files again and it comes back. Ratings,
 * play counts, playlists, subscriptions and sync rules are not derived from
 * anything, and losing them is losing years.
 *
 * So this exports the curation, not the library, and it stays small: a hundred
 * thousand tracks with no ratings produce a nearly empty backup, because there
 * is nothing about them a rescan would not recover.
 *
 * Tracks are referenced by `sourceId` **and** by their metadata. A restore onto
 * the same machine matches on the path; a restore onto a rebuilt library whose
 * files moved matches on artist, title and duration. Keying on the internal id
 * alone would work only in the first case, and the second is the one people
 * actually need after losing a disk.
 */

export const BACKUP_VERSION = 1

/** The per-track fields nothing but a human produces. */
const USER_FIELDS = [
  'rating', 'loved', 'enabled', 'comments', 'grouping', 'bpm',
  'playCount', 'skipCount', 'dateAdded', 'lastPlayed',
] as const

export type Backup = {
  version: number
  createdAt: number
  /** True when source credentials were left out, which is the default. */
  redacted: boolean
  sources: any[]
  tracks: any[]
  playlists: any[]
  radios: any[]
  podcasts: any[]
  schedules: any[]
  devices: any[]
}

const isDefault = (t: any) =>
  !t.rating && !t.loved && t.enabled === 1 && !t.comments && !t.grouping && !t.bpm &&
  !t.playCount && !t.skipCount && !t.lastPlayed &&
  // A tag is the purest case of what this file is for: a human typed it, and
  // no rescan anywhere will ever produce it again.
  !(t.tags && t.tags.length)

export function exportBackup(db: DB, opts: { secrets?: boolean } = {}): Backup {
  const secrets = Boolean(opts.secrets)

  const sources = (db.prepare(`SELECT id, kind, name, root, writable, config FROM sources`).all() as any[])
    .map((s) => ({
      ...s,
      // Credentials are the one thing a backup file is likely to be emailed
      // with. Out by default; the caller has to ask.
      config: secrets ? s.config : '{}',
    }))

  // Only tracks carrying something a rescan would not recover. On a fresh
  // library this is the empty list, and the backup is a few kilobytes.
  const tagsOf = new Map<string, string[]>()
  for (const row of db.prepare(`SELECT trackId, tag FROM track_tags`).all() as any[]) {
    tagsOf.set(row.trackId, [...(tagsOf.get(row.trackId) ?? []), row.tag])
  }

  const tracks = (db.prepare(
    `SELECT id, sourceId, path, artist, albumArtist, album, name, duration, fingerprint,
            ${USER_FIELDS.join(', ')}
     FROM tracks WHERE deletedAt IS NULL`).all() as any[])
    .map((t) => {
      const tags = tagsOf.get(t.id)
      // `id` is only used to look the tags up; it must not travel, because a
      // library rebuilt under a new source has different ids and a restore that
      // trusted them would match nothing.
      const { id, ...rest } = t
      return tags?.length ? { ...rest, tags } : rest
    })
    .filter((t) => !isDefault(t))

  // Playlist membership travels as (sourceId, path) rather than track ids: ids
  // are a hash of the source and the path, so a library rebuilt under a new
  // source id would restore playlists pointing at nothing.
  const playlists = (db.prepare(`SELECT * FROM playlists WHERE deletedAt IS NULL`).all() as any[])
    .map((p) => ({
      ...p,
      tracks: db.prepare(
        `SELECT t.sourceId, t.path, t.artist, t.name, t.duration, pt.position
         FROM playlist_tracks pt JOIN tracks t ON t.id = pt.trackId
         WHERE pt.playlistId = ? ORDER BY pt.position`).all(p.id),
    }))

  const podcasts = (db.prepare(`SELECT * FROM podcasts WHERE deletedAt IS NULL`).all() as any[])
    .map((p) => ({
      ...p,
      // Episode rows are rebuilt by the next refresh; what you listened to is
      // not, so only that travels.
      progress: db.prepare(
        `SELECT guid, played, position FROM episodes
         WHERE podcastId = ? AND (played = 1 OR position > 0)`).all(p.id),
    }))

  return {
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    redacted: !secrets,
    sources,
    tracks,
    playlists,
    radios: db.prepare(`SELECT * FROM radios WHERE deletedAt IS NULL`).all() as any[],
    podcasts,
    schedules: db.prepare(`SELECT * FROM schedules`).all() as any[],
    // Only the parts of a device a human set. Battery and capacity come from
    // the hardware, and restoring a stale reading would be a lie.
    devices: (db.prepare(
      `SELECT id, name, autoSync, syncMode, syncPlaylistIds FROM devices`).all() as any[])
      .map((d) => ({
        ...d,
        // The hand-picked tracks. `device_tracks` is what is *on* the device
        // and comes back by plugging it in; `device_wanted` is what somebody
        // chose to put there, which is curation and comes back from nowhere.
        wanted: db.prepare(
          `SELECT t.sourceId, t.path, t.artist, t.name, t.duration
           FROM device_wanted w JOIN tracks t ON t.id = w.trackId
           WHERE w.deviceId = ? AND t.deletedAt IS NULL`).all(d.id) as any[],
      })),
  }
}

export type RestoreReport = {
  tracks: { matched: number; missing: number }
  playlists: { created: number; skipped: number }
  radios: { created: number; skipped: number }
  podcasts: { created: number; skipped: number }
  schedules: { created: number; skipped: number }
  devices: { updated: number }
}

/**
 * Applies a backup, adding rather than replacing.
 *
 * A restore is normally run onto a library that already has something in it —
 * a rescan finished before the backup was found, a partial recovery. Wiping
 * first would turn "I got my ratings back" into "I lost the rest".
 */
export function importBackup(db: DB, backup: Backup): RestoreReport {
  if (backup?.version !== BACKUP_VERSION) {
    throw new Error(`unsupported backup version: ${backup?.version}`)
  }

  const report: RestoreReport = {
    tracks: { matched: 0, missing: 0 },
    playlists: { created: 0, skipped: 0 },
    radios: { created: 0, skipped: 0 },
    podcasts: { created: 0, skipped: 0 },
    schedules: { created: 0, skipped: 0 },
    devices: { updated: 0 },
  }

  const byPath = db.prepare(`SELECT id FROM tracks WHERE sourceId = ? AND path = ? AND deletedAt IS NULL`)
  const byMeta = db.prepare(
    `SELECT id FROM tracks WHERE lower(artist) = lower(?) AND lower(name) = lower(?)
       AND abs(duration - ?) <= 3 AND deletedAt IS NULL LIMIT 1`)

  /** Path first, metadata second — the second is what survives a reorganisation. */
  const find = (t: any): string | null =>
    ((byPath.get(t.sourceId, t.path) as any)?.id
      ?? (byMeta.get(t.artist ?? '', t.name ?? '', t.duration ?? 0) as any)?.id
      ?? null)

  const rev = nextRev(db)
  const setUser = db.prepare(
    `UPDATE tracks SET ${USER_FIELDS.map((f) => `${f} = ?`).join(', ')}, rev = ? WHERE id = ?`)

  const addTag = db.prepare(
    `INSERT OR IGNORE INTO track_tags (trackId, tag, addedAt) VALUES (?, ?, ?)`)

  for (const t of backup.tracks ?? []) {
    const id = find(t)
    if (!id) { report.tracks.missing++; continue }
    setUser.run(...([...USER_FIELDS.map((f) => t[f] ?? null), rev, id] as never[]))
    // Added, never replaced: a restore onto a library that has been tagged
    // since should not throw away the newer tags to reinstate the older set.
    for (const tag of t.tags ?? []) addTag.run(id, String(tag), Date.now())
    report.tracks.matched++
  }

  for (const p of backup.playlists ?? []) {
    // Not by id alone. The preset smart playlists are seeded on every first
    // start with fresh random ids, so an id check finds nothing and restores
    // a second "Recently Added" beside the first. `smart` is their stable key;
    // the name catches manual ones, where skipping is the safe half of
    // "add, never replace".
    const clash = db.prepare(
      `SELECT id FROM playlists WHERE deletedAt IS NULL
         AND (id = ? OR name = ? OR (smart IS NOT NULL AND smart = ?))`)
      .get(p.id, p.name, p.smart ?? null)
    if (clash) { report.playlists.skipped++; continue }
    db.prepare(`INSERT INTO playlists (id, name, smart, rules, createdAt, rev) VALUES (?,?,?,?,?,?)`)
      .run(p.id, p.name, p.smart ?? null, p.rules ?? null, p.createdAt ?? Date.now(), rev)
    const ins = db.prepare(`INSERT OR IGNORE INTO playlist_tracks (playlistId, trackId, position) VALUES (?,?,?)`)
    let position = 0
    for (const entry of p.tracks ?? []) {
      const id = find(entry)
      // A playlist restores with the tracks that exist, renumbered without
      // gaps. Keeping the original positions would leave holes wherever a file
      // is still missing.
      if (id) ins.run(p.id, id, position++)
    }
    report.playlists.created++
  }

  for (const r of backup.radios ?? []) {
    if (db.prepare(`SELECT id FROM radios WHERE id = ? OR streamUrl = ?`).get(r.id, r.streamUrl)) {
      report.radios.skipped++
      continue
    }
    db.prepare(`INSERT INTO radios (id, name, streamUrl, homepageUrl, imageUrl, genre, country,
                  bitrate, codec, favorite, createdAt, rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(r.id, r.name, r.streamUrl, r.homepageUrl, r.imageUrl, r.genre, r.country,
        r.bitrate, r.codec, r.favorite, r.createdAt ?? Date.now(), rev)
    report.radios.created++
  }

  for (const p of backup.podcasts ?? []) {
    const existing = db.prepare(`SELECT id FROM podcasts WHERE feedUrl = ?`).get(p.feedUrl) as any
    const id = existing?.id ?? p.id
    if (existing) {
      report.podcasts.skipped++
    } else {
      db.prepare(`INSERT INTO podcasts (id, feedUrl, title, description, author, imageUrl, siteUrl,
                    cron, keepLast, autoDownload, targetSourceId, targetPath, createdAt, rev)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(p.id, p.feedUrl, p.title, p.description, p.author, p.imageUrl, p.siteUrl,
          p.cron, p.keepLast, p.autoDownload, p.targetSourceId, p.targetPath,
          p.createdAt ?? Date.now(), rev)
      report.podcasts.created++
    }
    // Progress is applied whether or not the subscription was new: the episodes
    // may already be there from a refresh that ran before the restore.
    const mark = db.prepare(`UPDATE episodes SET played = ?, position = ?, rev = ? WHERE podcastId = ? AND guid = ?`)
    for (const e of p.progress ?? []) mark.run(e.played, e.position, rev, id, e.guid)
  }

  for (const s of backup.schedules ?? []) {
    if (db.prepare(`SELECT id FROM schedules WHERE id = ?`).get(s.id)) { report.schedules.skipped++; continue }
    db.prepare(`INSERT INTO schedules (id, name, cron, kind, payload, enabled, createdAt)
                VALUES (?,?,?,?,?,?,?)`)
      .run(s.id, s.name, s.cron, s.kind, s.payload, s.enabled, s.createdAt ?? Date.now())
    report.schedules.created++
  }

  const want = db.prepare(
    `INSERT OR IGNORE INTO device_wanted (deviceId, trackId, addedAt) VALUES (?, ?, ?)`)

  for (const d of backup.devices ?? []) {
    for (const entry of d.wanted ?? []) {
      const id = find(entry)
      if (id) want.run(d.id, id, Date.now())
    }
    const r = db.prepare(`UPDATE devices SET name = ?, autoSync = ?, syncMode = ?, syncPlaylistIds = ?, rev = ?
                          WHERE id = ?`)
      .run(d.name, d.autoSync, d.syncMode, d.syncPlaylistIds, rev, d.id)
    if (r.changes) report.devices.updated++
  }

  return report
}
