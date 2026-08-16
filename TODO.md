# Backlog

A living list, reprioritized by milestone: whatever unblocks the most goes first,
and visible wins float up.

**Docs** · [architecture](docs/architecture.md) · [stack](docs/stack.md) ·
[API](docs/api.md) · [map](docs/map.html) ·
[iTunes interfaces](docs/ui-evolution.md)

**Settled** — one API plus a static frontend, no privileged routes · Node 22 LTS + Hono + `node:sqlite` · nothing native ships · Node plugins, contract
first, Home Assistant / Volumio model · sources through an embedded userspace
rclone · nothing is ever copied except onto the iPod · a single job queue, with
the satellite protocol as its remote view · the server never pushes audio, it
hands out a URL.

---

## M1 · Foundation — nothing works without it

- [x] **1.1** Monorepo `apps/{server,web}` + `packages/{api-types,client-sdk}` *(`plugin-kit` comes with M5)*
- [x] **1.2** Hono server + stable error format *(the generated OpenAPI is 1.8b, not done)*
- [~] **1.3** **The five network rules, in place from the very first route** — cursor, `delta?since=`,
      `ETag`, a full page in one round trip, SSE. Retrofitting this costs ten times as much.
- [x] **1.4** Raw SQL schema on `node:sqlite` — WAL, covering indexes, FTS5. Drizzle evaluated
      then dropped (see `docs/stack.md`)
- [x] **1.4b** Migration runner — an ordered array + `PRAGMA user_version`, one transaction each.
      Not `.sql` files: the server runs from TS sources, so loose files mean runtime path
      resolution for no gain
- [x] **1.5** **Job system** — persisted, resumable, pausable, per-kind concurrency,
      idempotent, aggregates
- [x] **1.5b** Per-item job detail — `ctx.item()` records every outcome, `GET /jobs/:id/items`
      paginates them with counts over the whole job
- [x] **1.6** Local folder source — **streaming** scan, never the whole thing in memory
- [x] **1.7** Tag read/write + fingerprints — disk write-back as a job, read-only sources
      respected
- [x] **1.8** Client SDK — `packages/api-types` (contracts) + `packages/client-sdk` (transport,
      ETag cache, `paginate`, typed errors, SSE). Tested against the real app as `Request →
      Response`, no port involved: if server and client drift apart, the test breaks before the
      interface does.
- [ ] **1.8b** Generate the SDK from the spec too — the paths are generated now, the schemas
      are still prose. Today the types
      are hand-written in `api-types`, so they can drift from the routes.
- [~] **1.9** Frontend on the real API — the `Track` shape matches the server and
      `apps/web/src/api.ts` carries the TanStack Query hooks; what remains is swapping the data
      source in `App.tsx`
- [x] **1.10** Guardrail: fail if a runtime dependency drags in a `.node` file, a `binding.gyp`
      or an install script

> **M1 in progress.** 49 tests green (`npm test` builds its own audio fixtures),
> guardrail green, CI in place. The server scans real files, serves the library,
> and edits tags in the database *and* on disk; the client SDK talks to the real
> API; the frontend now shares the server's `Track` shape.
> Left to do: point the frontend at real data.

## M2 · Devices — the feature that sets us apart

- [x] **2.1** Satellite contract + local fake satellite — `apps/satellite`, announces itself,
      serves the device contents and the bytes
- [x] **2.2** `GET /devices/:id/tracks` — **see the device independently of the library**
- [x] **2.3** **Import from the device** — the tracks with `libraryTrackId: null` are the
      feature: pulling music back off an old iPod. Matched by fingerprint.
- [x] **2.4** **Presence column** — one dot per device, hidden when none is connected
- [x] **2.5** **`onDevice` / `notOnDevice` filters** — computed in SQL, never over a page already
      received. They combine with `kind=` for playlists, audiobooks, podcasts
- [x] **2.6** Sync job + `dryRun` (plan before writing) + atomic iTunesDB commit
- [x] **2.7** Device management — rename, sync options, eject, stats, orphans, plan preview
- [x] **2.8** Add by right-click and by dropzone — `device_wanted`, joined to the sync rules
- [x] **2.9** Drop Movies and TV Shows

## M3 · Audio output

- [~] **3.1** `GET /stream/:id` — `Range` and the per-renderer profile (`?accept=`) are done.
      Left: transcoding on the fly for a format the library does not hold, and the token
      (nothing is authenticated yet, so it would guard nothing)
- [~] **3.2** Browser renderer done — one `<audio>` on `/stream/:id`, state read from the
      element. Left: the `output` contract that lets a renderer live elsewhere
- [x] **3.3** UPnP/DLNA — SSDP discovery, description parsing, `SetAVTransportURI`, play,
      pause, stop, volume. Verified against five real Sonos speakers on the LAN.
      Sonos-specific grouping and its own queue are still to come
- [ ] **3.4** Play queue shared between controllers
- [ ] **3.5** AirPlay · **3.6** Satellite renderer (tablet, Pi + DAC) · **3.7** Chromecast
- [ ] **3.8** `live` family — YouTube/Twitch + ffmpeg relay (a job like any other)

## M4b · One song, several files

- [x] **4b.1** `renditions` — a track is the song, a rendition is a file of it. Backfilled by
      migration; the flat format/size/bitRate on tracks stay as the preferred one's copy
- [x] **4b.2** Sync picks a rendition the device already plays before deciding to convert
- [x] **4b.3** `POST /transcode` — { ids, format, quality?, replace }. ffmpeg is a binary on
      PATH, not a dependency; `GET /transcode/capabilities` says whether it is there
- [x] **4b.4** Streaming picks a rendition — `?rendition=`, `?format=`, or `?accept=mp3,aac`
      as a renderer profile. That is also the per-renderer half of 3.1
- [x] **4b.5** Duplicate detection — fingerprint or artist+title+duration, proposed never
      applied; merging repoints playlists, devices and picks, and adds up the history

## M4 · Sources and file organization

- [x] **4.1** rclone sidecar (`rclone rcd --rc-serve`) — listing, walking and range-streaming.
      Scanning and `/stream/:id` both work against a remote; tested against a real daemon.
      Left: artwork extraction for remote tracks, and writing back to a remote
- [ ] **4.2** Optional OS mount (NFS, pre-existing mounts)
- [ ] **4.3** Plex / Emby / Jellyfin — read + metadata import
- [x] **4.4** **Reorganization tool** — pattern with padding, dry run by default, conflicts
      refused rather than resolved, every move logged, undo in reverse order. Local sources
      only for now; the two-column preview is the front session's
- [~] **4.5** Settings / admin — server side done: `GET /stats` (totals in SQL),
      `GET /tracks/missing`, backup/restore. The UI pane is the front session’s
- [x] **4.6** Backup / restore — the curation, not the library; matched back by path then by
      metadata; adds and never replaces; secrets excluded by default
- [x] **4.7** Cron scheduler — five-field expressions matched against the wall clock, no
      dependency, no catch-up. Named workflows (chained jobs) still to come

## M5b · Accounts

- [x] **5b.1** Users and bearer tokens — scrypt passwords, open until the first account
      exists, tokens stored as hashes and accepted in the query string for `<audio>`
- [x] **5b.2** OpenSubsonic emitter — ping, browse, search, playlists, stream, cover art,
      star, rate and scrobble. Both auth schemes, JSON and XML
- [ ] **5b.3** Per-user libraries and roles beyond admin/user

## M5 · Plugins and store

- [x] **5.1** Plugin host — manifest, lifecycle, semver `hostApi`, failure isolation.
      Sidecars (a plugin owning a child process) still to come
- [x] **5.2** Host-provided transports — `http`, `ws`, `tcp`, `udp`, plus timers, all closed
      when the plugin stops. No `mqtt`: it would be the first runtime dependency added for
      something nothing uses, and a plugin can carry its own client. The host takes it over
      when several plugins want to share one broker connection
- [~] **5.3** Declarative settings and UI zones — `contributes` carries both, and
      `POST /plugins/:id/command` runs what a zone offers. The zones themselves are drawn
      by the front session
- [x] **5.4** Store — a JSON index at a URL the user chooses (no default: installing runs
      someone else's code). sha256 checked, the archive read by an extractor that refuses
      links and climbing paths, and the manifest's own id matched against the index's
- [~] **5.5** Installed plugins — the API is there (`GET /plugins`, install, uninstall);
      the Purchased pane that renders it is the front session's
- [x] **5.6b** ListenBrainz scrobbler — the first real plugin, shipped in `plugins/`, with a
      queue that survives an unreachable server
- [ ] **5.6** Last.fm scrobble (same shape, plus an MD5-signed parameter dance)
- [ ] **5.7** AudioMuse · **5.8** Home Assistant + MQTT
- [ ] **5.10** Spotify Connect · **5.11** Acquisition
- [ ] **5.12** Sandboxed iframe for rich UI contributions
- [ ] **5.13** Extism as an option once the store opens up to unknown authors

## M6 · Podcasts and radios

- [x] **6.1** Podcasts — RSS subscription with conditional GET, episodes keyed by guid,
      channel metadata and artwork from the feed
- [x] **6.2** Per-feed cron + `keepLast: N` — pruning clears the file, keeps the episode row
- [ ] **6.3** Destination set in the settings UI (the API takes `targetSourceId` already)
- [x] **6.4** Radios CRUD
- [x] **6.5** Auto cover — ICY headers, then the homepage favicon, then Radio-Browser.
      Known gap: Shoutcast v1 answers `ICY 200 OK` rather than an HTTP status line and
      no HTTP client will parse it; those stations report the reason and are still added

## M7 · Distribution

- [ ] **7.1** Keyboard shortcuts + shortcut sheet (carried over from `trieur`)
- [ ] **7.2** Astro site — docs + playable demo on a fake backend
- [x] **7.3** OpenAPI at `GET /openapi.json` — generated from the router, so it cannot claim
      routes that do not exist or omit ones that do. A test fails on any undocumented route
- [x] **7.4** Docker image + compose — `node:22-bookworm-slim` because the alpine images do
      not publish `linux/arm/v7`, which is the platform the Node 22 ceiling exists for.
      Built locally for this arch; the multi-arch push is a CI step (7.5)
- [x] **7.5** CI — a smoke job that runs the image and checks it serves the app, the API,
      a deep link, ffmpeg, rclone and a non-root user; then buildx pushes all three arches

## Frontend leftovers

- [ ] Inline album detail under the clicked row
- [ ] Listen Now / Browse (Apple Music) · Love / Dislike on the `music` theme
- [ ] Multi-select column browser · per-playlist column layout

## Done — phase 1, frontend prototype

Full iTunes prototype: TanStack Table v9, selection, multi DnD, single/multi modal,
IndexedDB · virtualization · scroll memory · consistent SVG icons · three structural
themes · generated artwork + quilt · Devices view · every media source ·
interface docs. Details in the git history.
