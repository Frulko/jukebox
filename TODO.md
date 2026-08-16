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
- [ ] **1.4b** Migration runner — numbered `.sql` files + `schema_version`, ~20 lines
- [x] **1.5** **Job system** — persisted, resumable, pausable, per-kind concurrency,
      idempotent, aggregates
- [ ] **1.5b** Per-item job detail — the `job_items` table exists but is neither written
      nor read; `GET /jobs/:id/items` is not mounted
- [x] **1.6** Local folder source — **streaming** scan, never the whole thing in memory
- [x] **1.7** Tag read/write + fingerprints — disk write-back as a job, read-only sources
      respected
- [x] **1.8** Client SDK — `packages/api-types` (contracts) + `packages/client-sdk` (transport,
      ETag cache, `paginate`, typed errors, SSE). Tested against the real app as `Request →
      Response`, no port involved: if server and client drift apart, the test breaks before the
      interface does.
- [ ] **1.8b** Move the routes to `@hono/zod-openapi` and **generate** the SDK — today the types
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
- [ ] **2.7** Device management — rename, sync options, eject, stats, orphans
- [x] **2.8** Add by right-click and by dropzone — `device_wanted`, joined to the sync rules
- [x] **2.9** Drop Movies and TV Shows

## M3 · Audio output

- [ ] **3.1** `GET /stream/:id` — `Range`, token, **per-renderer profile**, transcode cache
- [ ] **3.2** `output` contract + browser renderer
- [ ] **3.3** UPnP/DLNA (SSDP + `SetAVTransportURI`) then Sonos
- [ ] **3.4** Play queue shared between controllers
- [ ] **3.5** AirPlay · **3.6** Satellite renderer (tablet, Pi + DAC) · **3.7** Chromecast
- [ ] **3.8** `live` family — YouTube/Twitch + ffmpeg relay (a job like any other)

## M4 · Sources and file organization

- [ ] **4.1** rclone sidecar (`rclone rcd`) — SMB, S3, Drive, Dropbox, Mega, WebDAV, FTP
- [ ] **4.2** Optional OS mount (NFS, pre-existing mounts)
- [ ] **4.3** Plex / Emby / Jellyfin — read + metadata import
- [ ] **4.4** **Reorganization tool** — pattern, two-column preview, conflicts up top,
      dry run by default, log and undo
- [ ] **4.5** Settings / admin — sources, destination folders, write capabilities
- [ ] **4.6** Backup / restore — secrets excluded by default
- [ ] **4.7** Cron scheduler + named workflows (overnight sync)

## M5 · Plugins and store

- [ ] **5.1** Plugin host — manifest, lifecycle, semver `hostApi`, sidecars
- [ ] **5.2** Host-provided transports — `http`, `ws`, `mqtt`, `tcp`, `udp`
- [ ] **5.3** Declarative settings (`ui.json`) + UI extension zones
- [ ] **5.4** Store — git index with tagged releases, permissions shown before install
- [ ] **5.5** Installed plugins (replaces Purchased)
- [ ] **5.6** Last.fm scrobble · ListenBrainz · **5.7** AudioMuse · **5.8** Home Assistant + MQTT
- [ ] **5.9** OpenSubsonic (emitter) · **5.10** Spotify Connect · **5.11** Acquisition
- [ ] **5.12** Sandboxed iframe for rich UI contributions
- [ ] **5.13** Extism as an option once the store opens up to unknown authors

## M6 · Podcasts and radios

- [ ] **6.1** Podcasts — folder or RSS feed, covers, metadata, manual editing
- [ ] **6.2** Per-feed cron + `keepLast: N` · **6.3** Destination set in the settings
- [ ] **6.4** Radios CRUD · **6.5** Auto cover (favicon, ICY, Radio-Browser) or upload

## M7 · Distribution

- [ ] **7.1** Keyboard shortcuts + shortcut sheet (carried over from `trieur`)
- [ ] **7.2** Astro site — docs + playable demo on a fake backend
- [ ] **7.3** Published OpenAPI reference
- [ ] **7.4** Multi-arch Docker images `amd64` / `arm64` / `arm/v7`

## Frontend leftovers

- [ ] Inline album detail under the clicked row
- [ ] Listen Now / Browse (Apple Music) · Love / Dislike on the `music` theme
- [ ] Multi-select column browser · per-playlist column layout

## Done — phase 1, frontend prototype

Full iTunes prototype: TanStack Table v9, selection, multi DnD, single/multi modal,
IndexedDB · virtualization · scroll memory · consistent SVG icons · three structural
themes · generated artwork + quilt · Devices view · every media source ·
interface docs. Details in the git history.
