import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = DatabaseSync

/**
 * The revision counter is the keystone of the protocol: every write bumps it and
 * stamps the row, which gives `delta?since=` and collection `ETag`s for free.
 * Without it, every client re-downloads the whole library.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,              -- local | rclone | plex | emby | jellyfin
  name         TEXT NOT NULL,
  root         TEXT NOT NULL,
  writable     INTEGER NOT NULL DEFAULT 0, -- write capability, denied by default
  config       TEXT NOT NULL DEFAULT '{}',
  lastScanAt   INTEGER,
  rev          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id           TEXT PRIMARY KEY,
  sourceId     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'music',   -- music | audiobook | podcast
  name         TEXT NOT NULL,
  artist       TEXT NOT NULL DEFAULT '',
  albumArtist  TEXT NOT NULL DEFAULT '',
  album        TEXT NOT NULL DEFAULT '',
  genre        TEXT NOT NULL DEFAULT '',
  composer     TEXT NOT NULL DEFAULT '',
  year         INTEGER NOT NULL DEFAULT 0,
  trackNumber  INTEGER NOT NULL DEFAULT 0,
  trackCount   INTEGER NOT NULL DEFAULT 0,
  discNumber   INTEGER NOT NULL DEFAULT 1,
  duration     INTEGER NOT NULL DEFAULT 0,
  bitRate      INTEGER NOT NULL DEFAULT 0,
  sampleRate   INTEGER NOT NULL DEFAULT 0,
  channels     INTEGER NOT NULL DEFAULT 2,
  format       TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  mtime        INTEGER NOT NULL DEFAULT 0,
  rating       INTEGER NOT NULL DEFAULT 0,
  loved        INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  comments     TEXT NOT NULL DEFAULT '',
  grouping     TEXT NOT NULL DEFAULT '',
  bpm          INTEGER NOT NULL DEFAULT 0,
  compilation  INTEGER NOT NULL DEFAULT 0,
  playCount    INTEGER NOT NULL DEFAULT 0,
  skipCount    INTEGER NOT NULL DEFAULT 0,
  dateAdded    INTEGER NOT NULL,
  lastPlayed   INTEGER,
  fingerprint  TEXT,
  artworkHash  TEXT,
  rev          INTEGER NOT NULL,
  deletedAt    INTEGER,
  UNIQUE (sourceId, path)
);

-- Covering indexes: every sort order the API exposes needs one, otherwise
-- cursor pagination degrades into a full table scan.
CREATE INDEX IF NOT EXISTS tracks_rev      ON tracks (rev);
CREATE INDEX IF NOT EXISTS tracks_artist   ON tracks (artist, album, discNumber, trackNumber, id);
CREATE INDEX IF NOT EXISTS tracks_album    ON tracks (album, discNumber, trackNumber, id);
CREATE INDEX IF NOT EXISTS tracks_name     ON tracks (name, id);
CREATE INDEX IF NOT EXISTS tracks_added    ON tracks (dateAdded DESC, id);
CREATE INDEX IF NOT EXISTS tracks_kind     ON tracks (kind, artist, id);
CREATE INDEX IF NOT EXISTS tracks_source   ON tracks (sourceId, path);

CREATE TABLE IF NOT EXISTS playlists (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  smart     TEXT,
  rules     TEXT,
  createdAt INTEGER NOT NULL,
  rev       INTEGER NOT NULL,
  deletedAt INTEGER
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlistId TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  trackId    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  PRIMARY KEY (playlistId, trackId)
);
CREATE INDEX IF NOT EXISTS pl_order ON playlist_tracks (playlistId, position);

CREATE TABLE IF NOT EXISTS devices (
  id              TEXT PRIMARY KEY,
  satelliteId     TEXT,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  model           TEXT NOT NULL DEFAULT '',
  serial          TEXT NOT NULL DEFAULT '',
  firmware        TEXT NOT NULL DEFAULT '',
  capacity        INTEGER NOT NULL DEFAULT 0,
  used            TEXT NOT NULL DEFAULT '{}',
  battery         INTEGER,
  acceptedFormats TEXT NOT NULL DEFAULT '[]',
  charging        INTEGER NOT NULL DEFAULT 0,
  syncPlaylistIds TEXT NOT NULL DEFAULT '[]',
  autoSync        INTEGER NOT NULL DEFAULT 0,
  syncMode        TEXT NOT NULL DEFAULT 'playlists',
  connected       INTEGER NOT NULL DEFAULT 0,
  lastSync        INTEGER,
  lastBackup      INTEGER,
  rev             INTEGER NOT NULL
);

-- Device presence is a join, indexed both ways: "what is on the iPod" and
-- "what is missing from the iPod" must cost the same.
CREATE TABLE IF NOT EXISTS device_tracks (
  deviceId      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  deviceLocalId TEXT NOT NULL,
  trackId       TEXT REFERENCES tracks(id) ON DELETE SET NULL,  -- NULL = not in the library
  name          TEXT NOT NULL DEFAULT '',
  artist        TEXT NOT NULL DEFAULT '',
  album         TEXT NOT NULL DEFAULT '',
  duration      INTEGER NOT NULL DEFAULT 0,
  size          INTEGER NOT NULL DEFAULT 0,
  format        TEXT NOT NULL DEFAULT '',
  fingerprint   TEXT,
  sourceUrl     TEXT,                  -- where the satellite will serve the bytes
  syncedAt      INTEGER,
  PRIMARY KEY (deviceId, deviceLocalId)
);
CREATE INDEX IF NOT EXISTS dt_by_track  ON device_tracks (trackId, deviceId);
CREATE INDEX IF NOT EXISTS dt_orphans   ON device_tracks (deviceId, trackId);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  state        TEXT NOT NULL,            -- queued running paused done failed cancelled
  priority     INTEGER NOT NULL DEFAULT 0,
  parentId     TEXT,
  payload      TEXT NOT NULL DEFAULT '{}',
  cursor       TEXT,                     -- resume point, specific to each kind
  done         INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  createdAt    INTEGER NOT NULL,
  startedAt    INTEGER,
  finishedAt   INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_pick ON jobs (state, priority DESC, createdAt);
CREATE INDEX IF NOT EXISTS jobs_kind ON jobs (kind, createdAt DESC);

CREATE TABLE IF NOT EXISTS job_items (
  jobId   TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  ref     TEXT NOT NULL,
  state   TEXT NOT NULL,
  bytes   INTEGER NOT NULL DEFAULT 0,
  error   TEXT,
  PRIMARY KEY (jobId, idx)
);

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  name, artist, album, albumArtist, composer, genre,
  content='tracks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
`

export function open(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  // WAL: reads no longer block the writer. On a one-hour scan that is the
  // difference between a live UI and a frozen one.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('revision', '0')`)
  return db
}

/** Next revision. Every write goes through here — that is what makes the delta trustworthy. */
export function nextRev(db: DB): number {
  db.exec(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'`)
  return revision(db)
}

export function revision(db: DB): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'revision'`).get() as { value: string }
  return Number(row.value)
}
