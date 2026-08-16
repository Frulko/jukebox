---
title: API
description: The /api/v1 specification — target routes, with the existing ones marked.
---

`/api/v1`.

> **This page is the reasoning, not the inventory.** It explains the rules the
> API is built on and why they are what they are. The exhaustive list of routes
> lives in **[the API reference](./api-reference.md)**, which is generated from
> the router itself and cannot fall behind it — this page once described 42 of
> the server's 102 routes, and a reader could reasonably have concluded there
> was no authentication, no player and no plugin store. Prose revised
> deliberately does not drift; a route table maintained by hand always does.

> **Status.** This document is the **target**, not the current state. Routes
> marked ✅ exist; the rest are still to be implemented. The spec will be
> *generated* from the Zod schemas via `@hono/zod-openapi` — until that is done,
> this file can drift from the code, and that is the main risk on this page.

**No privileged routes.** Whatever the in-house frontend can do, a third-party
frontend or a device can do too. That is the only guarantee of a genuinely open
API.

---

## 1. The five rules that make the network bearable

They apply everywhere, without exception. They decide whether the interface is
smooth across 100,000 tracks over mediocre Wi-Fi.

### 1.1 Cursor pagination, never `OFFSET`

```
GET /tracks?limit=200&cursor=eyJrIjpbIkFpciIsMTk5OF19
→ { items: [...], next: "eyJrIjpb…", revision: 48213 }
```

The total count lives on a separate route — `GET /tracks/count` — because a
filtered `COUNT(*)` costs far more than a page and is not always useful.

`OFFSET 90000` makes SQLite re-read 90,000 rows. A cursor encodes the last sort
key and becomes a `WHERE (sort_key) > (…)` — constant cost no matter how deep you
are.

### 1.2 Sync by revision — the real win

The library carries a monotonic counter. Every write increments it and stamps the
row.

```
GET /tracks/delta?since=48120
→ { revision: 48213, changed: [...], deleted: ["t91", "t402"] }
```

A client coming back after five minutes gets **what changed**, not the library.
That is the difference between 40 MB and 3 kB. The client keeps its local cache;
the API never returns the entirety of anything.

### 1.3 `ETag` on every collection

```
GET /playlists          → 200  ETag: "rev-48213"
GET /playlists          → 304  (If-None-Match)
```

A collection's `ETag` is its maximum revision. Free to compute, and it removes
nearly all refresh traffic.

### 1.4 One page = one round trip

A track row arrives complete: metadata, device presence, artwork URL, playback
state. **Never N+1** — no per-track call just to find out whether it is on the
iPod.

### 1.5 No polling

Progress goes over SSE. The client opens a stream, not a loop.

---

## 2. Conventions

| | |
|---|---|
| Errors | `{ error: { code, message, details? } }`, stable and documented codes |
| Dates | epoch milliseconds, integer |
| Sorting | `?sort=artist,-year` — `-` prefix for descending |
| Filters | `?genre=Rock&year=1970..1979&rating=>=4` |
| Fields | `?fields=id,name,artist` — trims long lists |
| Idempotency | `Idempotency-Key` on every `POST` that creates a job |
| Compression | brotli, gzip |

## 3. Authentication

```
POST   /auth/login                 → { token, refresh, user }
POST   /auth/refresh
POST   /auth/logout
GET    /auth/me
POST   /auth/tokens                device tokens, scope + expiry
DELETE /auth/tokens/:id            revocation
```

Device tokens are **narrowly scoped and long-lived**: a satellite transferring
for three hours must not expire halfway through (§8.3).

## 4. Library

```
GET    /health                  ✅ state + current revision
GET    /tracks                  ✅ paginated list, filterable, sortable
GET    /tracks/count            ✅ filtered count
GET    /tracks/delta?since=N    ✅ delta by revision
GET    /tracks/:id              ✅
GET    /artwork/:trackId        ✅ artwork extracted on demand, ETag mtime+size
PATCH  /tracks                  ✅ single **and** bulk editing — { ids, patch, writeToFiles? }
                                   `writeToFiles: false` updates the database without touching the disk
DELETE /tracks                     { ids: [], fromLibrary|fromPlaylist }
GET    /albums · /albums/:id/tracks
GET    /artists · /artists/:id/albums
GET    /genres · /composers
GET    /search?q=…&types=track,album,artist   FTS5, one query
```

`PATCH /tracks` is the modal's bulk edit — one call, and a job if writing tags to
disk takes a while.

### The shape of a track

```jsonc
{
  "id": "t9134", "rev": 48120,
  "name": "…", "artist": "…", "album": "…", "albumArtist": "…",
  "genre": "…", "year": 1977, "trackNumber": 5, "discNumber": 1,
  "duration": 384, "bitRate": 320, "size": 15360000, "format": "flac",
  "rating": 4, "loved": false, "playCount": 23, "lastPlayed": 1755300000000,
  "sourceId": "src-nas", "path": "Music/Fleetwood Mac/Rumours/05 …flac",
  "artwork": "/api/v1/artwork/t9134",      // extracted on demand, ETag mtime+size
  "devices": ["dev-classic"],              // §5 — presence, embedded
  "kind": "music"                          // music | audiobook | podcast
}
```

## 5. Device presence — column *and* filter

Both, because they answer two different needs.

**The column answers "where is this track?"** — it is passive, you consult it.
Each track's `devices` field carries the ids of the devices holding it. The
frontend turns that into a compact column (one dot per device), hidden when no
device is connected.

**The filter answers "what is left for me to sync?"** — that is the working tool,
and it has to be computed server side, never by filtering a page already
received.

```
GET /tracks?onDevice=dev-classic          present on this device
GET /tracks?notOnDevice=dev-classic       missing — the real question
GET /tracks?onDevice=dev-classic,dev-nano&match=all
```

The filter also applies to playlists, audiobooks and podcasts: `kind=` combines
with `notOnDevice=`.

All of it rests on a join table `device_track (device_id, track_id,
device_local_id, state, synced_at)`, indexed in both directions.

## 6. Playlists

```
GET    /playlists ✅ · POST /playlists ✅ · PATCH /playlists/:id ✅ · DELETE /playlists/:id ✅
GET    /playlists/:id ✅ · GET /playlists/:id/tracks ✅
POST   /playlists/:id/tracks    ✅ { ids: [], position? }   deduplicated
DELETE /playlists/:id/tracks    ✅ { ids: [] }
PUT    /playlists/:id/order     ✅ { ids: [], toIndex }     preserves the batch's relative order
POST   /playlists/:id/duplicate
GET    /playlists/:id/cover        generated 2×2 quilt, immutable cache
```

Smart playlists carry `rules` and are **evaluated in SQL**: "the 25 most played"
over 100,000 tracks does not load 100,000 rows to keep 25. They reject track
`POST`/`DELETE` with a 409 — their content changes through their rules.

```jsonc
{ "all": [{ "field": "rating", "op": "gte", "value": 4 }],
  "any": [{ "field": "genre", "op": "is", "value": "Rock" }],
  "sort": "rating", "limit": 25 }
```

A rule's field is validated against a closed list before it reaches the SQL —
this is the only point in the project where an injection would be possible.

## 7. Sources

```
GET    /sources ✅ · POST /sources ✅ · PATCH /sources/:id · DELETE /sources/:id
POST   /sources/:id/test           connection test, no side effects
POST   /sources/:id/scan        ✅ → job
GET    /sources/:id/browse?path=   raw tree, for the organization tool
POST   /sources/:id/move           { ops: [{from, to}] }  → job, logged
```

Write capabilities are **per source and disabled by default**: a read-only source
exposes neither `move` nor `DELETE`.

## 8. Jobs — the central mechanism

```
GET    /jobs?state=running&kind=scan   ✅
GET    /jobs/:id                       ✅ state + aggregates, never the item list
PATCH  /jobs/:id                       ✅ { action: "pause" | "resume" }
DELETE /jobs/:id                       ✅ cancellation
POST   /jobs                           idempotent on Idempotency-Key
GET    /jobs/:id/items                 paginated detail
GET    /jobs/:id/events                SSE
```

```
job    queued → running → done | failed | cancelled
                   ↕ paused
```

`kind` ∈ `scan · transcode · fingerprint · podcast · sync · acquire · analyze ·
relay · move · backup`. **One implementation for all of them.**

## 9. Devices and satellites

```
GET    /satellites · POST /satellites            mDNS discovery or a URL entered by hand
GET    /devices                                  all devices, all satellites
GET    /devices/:id                              capacity, serial, firmware,
                                                 acceptedFormats, battery
PATCH  /devices/:id                              name, autoSync, syncMode, playlists
```

### 9.1 Seeing the device independently of the library

This is what the original iTunes did not do.

```
GET    /devices/:id/tracks?limit=200&cursor=…&orphansOnly=true   ✅ real contents
GET    /devices/:id/playlists
GET    /devices/:id/stats                       ✅ space, orphans
```

Every device track carries a `libraryTrackId` — or `null`. **The `null`s are the
feature**: that is the music present on the iPod and absent from the library.

```
POST   /devices/:id/import         { deviceTrackIds: [], targetSourceId,
                                     targetPath } → job
```

Recovering the music from an old iPod whose library is long gone. Matching uses
Chromaprint fingerprints, so a re-encode or rewritten tags do not stop a
duplicate from being recognized.

```
POST   /devices/:id/sync           { add: [], remove: [], dryRun? } → job
POST   /devices/:id/backup         → job
DELETE /devices/:id/tracks         { ids: [] }
POST   /devices/:id/eject
```

`dryRun` returns the plan — what would be added, removed, transcoded, and the
resulting free space — without writing anything.

### 9.2 The satellite pulls

The server creates the job and hands out signed URLs; the satellite fetches the
files at its own pace, resumes after an outage via `Range`, and only writes the
device's database once everything has transferred (the `committing` phase,
atomic).

### 9.3 Token lifetime

A job token lives **for the duration of the job plus a margin**, and it is
revoked on cancellation. One-hour tokens kill a three-hour transfer at 33% — the
kind of detail you only see in production.

## 10. Playback and outputs

```
GET    /outputs                              discovered renderers
POST   /outputs/:id/play                     { trackId | url, position? }
POST   /outputs/:id/{pause,resume,stop,next,previous}
PUT    /outputs/:id/volume · /seek
GET    /outputs/:id/state                    SSE

GET    /queue · PUT /queue · POST /queue/tracks · DELETE /queue/:index
```

**The play queue is shared between controllers**: what you queue from the browser
shows up on the tablet.

```
GET    /stream/:trackId?token=…&profile=sonos       Range, on-the-fly transcoding
GET    /artwork/:hash                                immutable cache, 1 year
POST   /live/sessions                                { url } → resolution + relay
GET    /live/:sessionId                              remuxed stream
```

## 11. Podcasts, radios, audiobooks

```
GET/POST/PATCH/DELETE  /podcasts               source = folder or RSS URL
POST   /podcasts/:id/refresh                   → job
GET    /podcasts/:id/episodes
POST   /podcasts/:id/episodes/:eid/download    → job
GET/POST/PATCH/DELETE  /radios
POST   /radios/:id/cover                       upload, or auto discovery
GET    /audiobooks · /audiobooks/:id/chapters
```

Each podcast carries its own schedule and its `keepLast: N`.

## 12. Plugins and store

```
GET    /plugins                      installed
POST   /plugins/:id/{enable,disable}
GET/PUT /plugins/:id/config          rendered by the host from `ui.json`
GET    /store/plugins?family=source  catalogue
POST   /store/plugins/:id/install    { version } → job
GET    /plugins/contributions        declared UI zones, for the frontend
```

## 13. Settings and backup

```
GET/PUT /settings
GET    /settings/backup?includeSecrets=false   secrets excluded by default
POST   /settings/restore
GET/POST/PATCH/DELETE  /schedules              named workflows
POST   /schedules/:id/run                      run right now
```

## 14. Events

```
GET /events    SSE
```

Emitted today: `hello`, `job.progress`. Planned: `library.changed`,
`device.connected`, `playback.state`. Filtering by `?topics=` is planned but
**not yet applied server side** — the SDK already sends it.

One stream. The client never polls in a loop.

---

## 15. Server-side optimizations

| | |
|---|---|
| SQLite | WAL mode, `synchronous=NORMAL`, covering indexes on the sort keys |
| Search | FTS5, external table, rebuilt by the scan job |
| Device presence | join indexed in both directions, never computed per track |
| Artwork | content hash in the URL → `Cache-Control: immutable`, one year |
| Streaming | `sendfile` when no transcoding is needed |
| Transcoding | cached by (track, profile), LRU eviction |
| 32-bit discipline | streaming scan, aggregates in SQL, no route returns everything |

---

Architecture detail: [`architecture.md`](architecture.md) ·
stack: [`stack.md`](stack.md) · overview: [the map](https://frulko.github.io/jukebox/map/)
