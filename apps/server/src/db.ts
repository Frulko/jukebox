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

-- Tracks the user put on a device by hand -- dropped on it in the sidebar, or
-- sent there from the context menu. iTunes called this manual management and
-- made it exclusive with syncing; here it is simply added to whatever the sync
-- rules already want, so dragging one album onto an iPod does not silently
-- disable its playlist sync.
CREATE TABLE IF NOT EXISTS device_wanted (
  deviceId TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  trackId  TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  addedAt  INTEGER NOT NULL,
  PRIMARY KEY (deviceId, trackId)
);

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

-- Installed plugins. "enabled" is the user's choice and survives a reinstall;
-- "state" is what the host last observed, and "error" is why it is not running.
-- (No backticks in here: SCHEMA is a template literal and they would end it.)
CREATE TABLE IF NOT EXISTS plugins (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  version     TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  contributes TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  state       TEXT NOT NULL DEFAULT 'installed',
  error       TEXT,
  config      TEXT NOT NULL DEFAULT '{}',
  installedAt INTEGER NOT NULL
);

-- Every file a reorganisation moved. This is both the log the user reads and
-- the only thing that makes the operation undoable, so it is written per move
-- rather than per job -- an interrupted run is undoable up to where it stopped.
CREATE TABLE IF NOT EXISTS moves (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  jobId     TEXT NOT NULL,
  trackId   TEXT NOT NULL,
  sourceId  TEXT NOT NULL,
  fromPath  TEXT NOT NULL,
  toPath    TEXT NOT NULL,
  movedAt   INTEGER NOT NULL,
  undoneAt  INTEGER
);
CREATE INDEX IF NOT EXISTS moves_job ON moves (jobId, id DESC);

-- Internet radio. A station is a URL plus whatever the stream, its homepage and
-- the community directory could tell us about it.
CREATE TABLE IF NOT EXISTS radios (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  streamUrl   TEXT NOT NULL,
  homepageUrl TEXT,
  imageUrl    TEXT,
  genre       TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  bitrate     INTEGER NOT NULL DEFAULT 0,
  codec       TEXT NOT NULL DEFAULT '',
  favorite    INTEGER NOT NULL DEFAULT 0,
  createdAt   INTEGER NOT NULL,
  rev         INTEGER NOT NULL,
  deletedAt   INTEGER
);

CREATE TABLE IF NOT EXISTS podcasts (
  id             TEXT PRIMARY KEY,
  feedUrl        TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  author         TEXT NOT NULL DEFAULT '',
  imageUrl       TEXT,
  siteUrl        TEXT,
  cron           TEXT,                        -- per-feed refresh; NULL = manual only
  keepLast       INTEGER NOT NULL DEFAULT 0,  -- 0 = keep every downloaded episode
  autoDownload   INTEGER NOT NULL DEFAULT 0,
  targetSourceId TEXT REFERENCES sources(id),
  targetPath     TEXT NOT NULL DEFAULT 'Podcasts',
  -- Kept from the last fetch so the next one can be conditional. A feed polled
  -- hourly that has not changed should cost a 304 and no body.
  etag           TEXT,
  lastModified   TEXT,
  lastFetchAt    INTEGER,
  lastError      TEXT,
  createdAt      INTEGER NOT NULL,
  rev            INTEGER NOT NULL,
  deletedAt      INTEGER
);

-- The guid identifies an episode, never the URL: a feed moving to a new CDN
-- rewrites every enclosure URL and keeps its guids.
CREATE TABLE IF NOT EXISTS episodes (
  id              TEXT PRIMARY KEY,
  podcastId       TEXT NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  guid            TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  pubDate         INTEGER,
  duration        INTEGER NOT NULL DEFAULT 0,
  episodeNumber   INTEGER,
  season          INTEGER,
  enclosureUrl    TEXT,
  enclosureLength INTEGER NOT NULL DEFAULT 0,
  enclosureType   TEXT NOT NULL DEFAULT '',
  imageUrl        TEXT,
  trackId         TEXT REFERENCES tracks(id) ON DELETE SET NULL,  -- set once downloaded
  played          INTEGER NOT NULL DEFAULT 0,
  position        INTEGER NOT NULL DEFAULT 0,   -- resume point, seconds
  rev             INTEGER NOT NULL,
  UNIQUE (podcastId, guid)
);
CREATE INDEX IF NOT EXISTS ep_by_date ON episodes (podcastId, pubDate DESC, id);

-- Scheduled work: the overnight sync, the podcast refresh. The cron expression
-- is stored as written rather than as a computed next-fire time, so a schedule
-- means the same thing across a restart and across a DST boundary.
CREATE TABLE IF NOT EXISTS schedules (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  cron      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  payload   TEXT NOT NULL DEFAULT '{}',
  enabled   INTEGER NOT NULL DEFAULT 1,
  lastRunAt INTEGER,
  -- The local wall-clock minute of the last run, e.g. 2026-10-25T02:30. Not the
  -- epoch: on the night the clocks go back that minute happens twice, and a
  -- nightly job must run once.
  lastRunKey TEXT,
  lastJobId TEXT,
  createdAt INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  name, artist, album, albumArtist, composer, genre,
  content='tracks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
`

/**
 * Migrations, in order. Append only; never edit or reorder one that has shipped.
 *
 * `SCHEMA` above is `CREATE TABLE IF NOT EXISTS`, which is exactly right for a
 * fresh database and silently does nothing to an existing one. Adding a column
 * there would apply to new installs and to no one else's — their database would
 * keep working right up to the first query that reads the column. That is the
 * gap this closes.
 *
 * The version lives in `PRAGMA user_version`, a counter SQLite already keeps per
 * database. A `schema_version` table would hold the same integer and need
 * creating, reading and writing.
 *
 * Kept as SQL in this file rather than numbered `.sql` files on disk: the server
 * runs from TypeScript sources under `--experimental-strip-types`, so shipping
 * loose files means resolving a path relative to the module at runtime and
 * keeping them in the package. An array costs neither, and the ordering is just
 * as explicit.
 */
type Migration = string | ((db: DB) => void)

const MIGRATIONS: Migration[] = [
  // 1 — the baseline. Everything in SCHEMA up to this point; nothing to do, it
  // exists only so a database created before migrations lands on a known number.
  ``,

  // 2 — when the scanner last saw each file. Without it a scan can clear
  // `deletedAt` on what it found but never set it on what vanished, so a
  // deleted file stayed in the library for ever.
  //
  // Written as a function because SQLite has no `ADD COLUMN IF NOT EXISTS`, and
  // the day someone adds `lastSeenAt` to SCHEMA as well -- the obvious thing to
  // do for new installs -- a bare ALTER would throw `duplicate column name` and
  // leave the database unopenable. A migration may only be skipped by checking,
  // never by swallowing the error, which would hide a genuine failure too.
  (db) => {
    const has = (db.prepare(`PRAGMA table_info(tracks)`).all() as any[])
      .some((c) => c.name === 'lastSeenAt')
    if (!has) db.exec(`ALTER TABLE tracks ADD COLUMN lastSeenAt INTEGER`)
    db.exec(`CREATE INDEX IF NOT EXISTS tracks_seen ON tracks (sourceId, lastSeenAt)`)
  },
]

/**
 * Brings a database up to the current schema.
 *
 * Each migration runs in its own transaction: a failure halfway leaves the
 * version where it was, so a fixed build re-runs the same step rather than
 * finding a half-applied one.
 */
export function migrate(db: DB, list: Migration[] = MIGRATIONS): number {
  const at = (db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version
  for (let v = at; v < list.length; v++) {
    const sql = list[v]
    db.exec('BEGIN')
    try {
      if (typeof sql === 'function') sql(db)
      else if (sql.trim()) db.exec(sql)
      // Interpolated, not bound: PRAGMA does not take parameters. The value is a
      // loop index over a literal array, so there is nothing to inject.
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${v + 1} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  return list.length
}

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
  migrate(db)
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
