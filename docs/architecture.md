---
title: Architecture
description: Topology, plugins, satellites and audio routing — what is decided and why.
---

The goal: host your music library on a server, sync iPods, and eventually have
either a standalone app or one detached from the server — both are on the table.
Everything below follows from that.

Status: **decided** for §1–5, still waiting on a call about build order.

---

## Map

Visual version: **[the map](https://frulko.github.io/jukebox/map/)**.

Three directions, routinely conflated elsewhere, kept apart here:

- **Renderer** — plays *right now*. A browser, a Sonos, a tablet.
- **Device** — *holds a copy*. An iPod. Files have to be transferred to it.
- **Emitter** — lets *others read* our library. An OpenSubsonic server.

```
INPUTS                         CORE                          OUTPUTS
─────────────────────────      ──────────────────────        ─────────────────────────
Storage                        Index (SQLite)                Renderers
  local, rclone (SMB, S3,       Jobs — single queue            browser
  Drive, Dropbox, Mega,         Transcoder (ffmpeg)            tablet satellite
  WebDAV, FTP, SFTP…)           Fingerprints (Chromaprint)     Pi + DAC satellite
  Plex, Emby, Jellyfin          Streaming endpoint             UPnP / DLNA
                                Plugin host                    Sonos
Streams                         Scheduler                      AirPlay
  radios (ICY, HLS)             Settings + backup              Chromecast (later)
  podcasts (RSS)                                               local sound card (if any)
  YouTube, Twitch lives
                                                              Devices
Acquisition                                                     iPod (via satellite)
  third-party plugins
                                                              Emitters
Metadata                                                        OpenSubsonic
  MusicBrainz, Last.fm                                          DLNA
  ListenBrainz, AudioMuse                                       outgoing radio stream

                                                              Side channels
                                                                scrobble (Last.fm, LB)
                                                                Home Assistant, MQTT
```

**The positioning, in one sentence:** Volumio *is* a player, bound to its sound
card. We are a library surrounded by players. A Raspberry Pi with a DAC becomes
one of our renderers instead of being the whole system.

## 1. Topology — decided

One API, one static frontend.

```
apps/server   Hono — the public API. Library, files, plugins,
              scheduler, DB.
apps/web      React + TanStack, static build. One client among many.
packages/*    shared contracts — `api-types`, `client-sdk`; `plugin-kit` to come
```

**No privileged route for the in-house frontend.** If the official frontend can
do it, a third-party frontend or a device can too. That is what makes the API
open — not splitting processes apart. A separate rendering server would only be
justified for SSR, which is moot behind a login.

The API and the static file serving stay two Hono modules mounted together:
splitting them later means changing a mount point.

## 2. Runtime — decided

**Node**, with **Hono** and **SQLite**.

| | |
|---|---|
| Node | No lock-in. A self-hosted server has to run on a NAS, a Pi, a Node Docker image. Bun stays possible — Hono is multi-runtime — but nothing depends on it. |
| Hono | Essential middleware built in (CORS, JWT, compress, etag), WebSocket. `@hono/zod-openapi` should eventually generate the spec from the validation schemas — **not wired up yet**, the contracts are hand-written. |
| SQLite | `node:sqlite`, zero dependencies. The default across self-hosted music (Navidrome, Jellyfin). |

The performance gap between HTTP frameworks is irrelevant here: the bottleneck
is disk and network.

## 3. Plugins — decided

### What comparable ecosystems do

The two most mature plugin systems in this space **do not sandbox**.

**Home Assistant** — ~3000 Python integrations. Each has a `manifest.json`
(domain, version, pip `requirements`, codeowners, `integration_type`). HACS, the
community store, pulls GitHub *release tags* and validates manifest
completeness. Custom integrations run with full Python privileges. This is not
an oversight: a public security disclosure has documented vulnerabilities in
custom integrations. The cost is known and accepted.

**Volumio** — Node plugins. A folder with `package.json` (a `volumio_info`
block: prettyName, icon, `plugin_type`), `index.js`, `UIConfig.json`,
`config.json`. Categories: music_service, audio_interface, system_hardware,
user_interface. No sandbox at all.

What holds the diversity together in both cases is not isolation, it is **the
domain model**: HA projects everything into shared entities (light, switch,
media_player), Volumio into a `plugin_type`. And settings are **declarative** —
`UIConfig.json`, config flows — so the host renders the form and the plugin
ships no UI.

### Our model: contract first

**Node** plugins, installable from a git repository with tagged releases.
Manifest, lifecycle, declarative settings. **No sandbox to begin with.**

```
manifest.json
  id, version, hostApi: "^1.0", family, permissions, sidecars[], contributes{}
index.js
  onInstall / onStart / onStop / onUninstall
ui.json
  settings described as data — the host renders the form
```

**Nearly every plugin is a protocol client.** The host provides the transports;
the plugin never opens them itself:

```ts
host.http(url, init)        // HTTP / HTTPS
host.ws(url)                // WebSocket
host.mqtt(broker, opts)     // MQTT — Home Assistant's native transport
host.tcp(host, port)        // raw socket
host.udp(port)              // datagrams, SSDP discovery
```

Providing them from the host rather than letting the plugin open them has two
immediate effects: accesses are logged and filterable by the manifest starting
today, and the day we sandbox a family, the contract does not change by a single
line.

Three reasons, the first would be enough:

1. **QuickJS rules out npm.** Our source plugins need npm and raw sockets. A
   sandbox that excludes half the plugin population does not protect, it
   amputates.
2. It is proven at 3000 integrations in our exact domain.
3. It is far less work.

### The sandbox, later, without breaking anything

[Extism](https://github.com/extism/extism) — polyglot WASM plugins, Node host
SDK, and a JavaScript PDK that embeds QuickJS — stays available. A plugin that
only speaks through `host.*` runs in both worlds: **the contract decides, not
the engine.** The day the store opens up to unknown authors, we sandbox the
families that only need `fetch` (`analysis`, `scrobble`, `player`) and sources
stay in reviewed Node. That is also Figma's model, sandboxing in QuickJS-WASM
because its marketplace is public and its code entirely unknown.

### Python?

Home Assistant proves a Python plugin system works, and Python has the best
libraries in the domain. But the server is Node and the frontend TypeScript: a
Python plugin system would mean either switching the server or building a
permanent bridge. Python stays where it is already excellent — **in a sidecar**.

### Satellites — devices on other machines

A sidecar runs next to the server. A **satellite** runs somewhere else on the
network, usually because it has to be physically near something: an iPod dock, a
sound card, an isolated network.

The concrete case: **an iPod sync satellite on a Raspberry Pi 1.** The Pi does
not run the server — it is armv6, outside Node's reach. It runs the satellite,
written in whatever runs on armv6 (Python fits: iOpenPod already is, and 32-bit
Raspberry Pi OS still supports armv6). The server is only its HTTP client.

This is exactly what a satellite architecture makes possible: in a monolith,
that machine would simply be excluded.

#### Splitting the work

The satellite is near the device, not near the horsepower. So:

| | Where |
|---|---|
| Transcoding (FLAC → ALAC) | **server** — an iPod cannot play FLAC, and a 700 MHz core would take hours |
| Chromaprint fingerprints | **server** — it has the files and the CPU |
| Writing the iTunesDB, copying to the device | **satellite** — that is its only job |

#### The satellite pulls, it does not receive

The server sends a list of URLs and a token; the satellite fetches the files
from the streaming endpoint that already exists for the web player.

Three consequences, all good: the satellite sets its own pace, it resumes after
an outage without the server having to track anything, and the server holds no
long-lived connection.

On a Pi 1 Model B, USB is shared with the 100 Mbit Ethernet — roughly 5 to
8 MB/s in practice, so a few hours to fill a 74 GB iPod classic. Irrelevant for
a sync scheduled overnight, which is the intended use.

#### The contract, shared by every satellite

```
GET    /satellite                 identity, families served, API version
GET    /devices                   connected devices
GET    /devices/:id               capacity, serial, firmware, accepted formats
GET    /devices/:id/tracks        what is actually on the device (paginated)
POST   /devices/:id/jobs          creation — idempotent on `id`
GET    /devices/:id/jobs/:job     state + aggregates
GET    /devices/:id/jobs/:job/items   detail, paginated
GET    /devices/:id/jobs/:job/events  progress (SSE)
PATCH  /devices/:id/jobs/:job     { action: "pause" | "resume" }
DELETE /devices/:id/jobs/:job     cancellation, tokens revoked
```

Discovery over mDNS on the local network, or a URL entered in the settings. The
same contract serves Sonos and any future device — the `device` family of the
plugin system, server side, is its client.

#### The device declares, the server converts

```jsonc
GET /devices/:id
{ "acceptedFormats": ["mp3", "aac", "alac", "aiff"], "capacity": …, "free": … }
```

The server compares track by track and only transcodes what would not pass. The
satellite has no idea conversion even exists. That is what lets it run on a
Pi 1.

#### The queue and the state

The queue belongs to the satellite. The server fills it and watches it; it does
not drive it.

```
job    queued → transferring → committing → done | failed | cancelled
item   pending → fetching → writing → done | failed | skipped
```

- **Idempotent on the job's `id`**, supplied by the server. Re-posting the same
  `id` returns the existing job. Without that, a server-side timeout while the
  satellite did receive the request triggers a double sync.
- **Persisted queue** — SQLite or a log on the satellite. A power cut at 3am does
  not lose the queue: on restart, `fetching` and `writing` go back to `pending`.
- **Resumable transfers** — HTTP `Range`, partial file kept, resume at the
  offset. Over a three-hour transfer, that is not a luxury.
- **Tokens that live as long as the job**, plus a margin, and revoked on
  cancellation. One-hour tokens kill a three-hour transfer at 33%.
- **`committing` is atomic and separate.** We do not rewrite the iTunesDB per
  track: copy everything, then write the database once — temp file, `fsync`,
  atomic rename. This is the dangerous phase, the one where an outage corrupts
  the device.
- **Concurrency decided by the satellite** — one or two simultaneous fetches on a
  Pi 1. The server does not impose a pace on it.
- **`GET …/jobs/:job` returns aggregates**, not the item list: a 10,000-track
  sync must not return 10,000 entries on every poll. The detail lives on a
  separate paginated route. SSE for live, `GET` to recover after the stream
  drops.

### Heavy engines stay sidecars

ffmpeg, Chromaprint, [soco-cli](https://pypi.org/project/soco-cli/),
[iOpenPod](https://github.com/TheRealSavi/iOpenPod),
[AudioMuse](https://github.com/NeptuneHub/AudioMuse-AI) run as services. The
plugin is their HTTP client.

### The store

| | |
|---|---|
| Registry | a JSON index — a git repo with tagged releases is enough, like HACS. Zero infrastructure |
| Compatibility | the plugin declares `hostApi: "^1.0"`, the host refuses anything incompatible |
| Integrity | SHA-256 of the artifact in the index |
| Consent | required permissions and sidecars shown before install |
| Installation | `~/.config/<app>/plugins/<id>/<version>/`, atomic switch |
| Settings | rendered by the host from `ui.json` — no third-party code in the frontend |

### Sources — nothing gets copied, and we write no protocol client

Infuse implements SMB, NFS, FTP, SFTP and WebDAV **in userspace**, in its own
code. Not by choice: on tvOS it can neither mount a filesystem nor launch a
binary. It has no other option — hence its "SMB Legacy" setting and its SMB
behaving differently on iOS and tvOS.

On all of our targets — server, Electron, Tauri — **we can ship and launch a
binary**. That is the only difference that matters, and it changes everything:
we do not write the protocol stack, we embed rclone's.

**Local disk first.** The most common and simplest case: the library is on the
server, on its internal disk, on a USB drive, or on a volume the system already
mounted. That is `node:fs` and nothing else, and it is the fastest path — no
sidecar, no network latency. Everything below only exists to *reduce a remote
source to that case*.

**For remote: rclone as a userspace sidecar.**
[`rclone rcd`](https://rclone.org/rc/) exposes an HTTP API on localhost. No
FUSE, no admin rights, no kernel mount, and **the same code path on the server
and in the native app**. Natively covers SMB (the `smb` backend since 1.60, via
go-smb2), S3, Google Drive, Dropbox, Mega, OneDrive, Box, pCloud, Backblaze,
WebDAV, FTP, SFTP — around seventy backends.

**Option: OS mount.** For NFS — rclone's only gap — and for anyone who already
has their mounts set up. `mount.nfs`, `mount.cifs`. A mounted source becomes a
local path, so it is a special case of the foundation, not a second system.

**Native Node.** Plex, Emby, Jellyfin: these are not filesystems but indexed
libraries. HTTP client + metadata import.

#### Nothing is copied

`--vfs-cache-mode full` maintains a **sparse file per open file, containing only
the byte ranges actually read**. It is a range cache, bounded by
`--vfs-cache-max-size` — not a copy of the library. That is what makes seeking
smooth without pulling anything down wholesale.

**We read and modify at the source.** In-place tag writing, renaming and moving
on the source. The only copy in the project is the iPod sync, because an iPod
has its own storage.

```ts
interface Source {
  list(path): Entry[]
  stat(path): Entry
  read(path, range?): ReadableStream
  // only if the source is declared writable
  write?(path, stream): void
  rename?(from, to): void
  delete?(path): void
  watch?(path): AsyncIterable<Change>
}
```

#### What it costs, said plainly

- **An unreachable remote must time out, not block.** Every source operation goes
  through a maximum delay; no blocking call on a request path.
- **Latency.** Listing Google Drive through rclone is slower than through its
  native API, and change detection degrades to polling. If it shows up in
  measurements, we add a native backend — but only once measured.
- **rclone becomes a first-class dependency.** One more binary to ship and keep
  up to date across all three targets.

### The families

| Family | Plugins |
|---|---|
| `source` | a local path, fed by an OS mount or rclone; plus Plex/Emby/Jellyfin natively |
| `emitter` | OpenSubsonic (open spec, the whole mobile client ecosystem speaks it), radio, DLNA later |
| `player` | Sonos (soco-cli sidecar, or `node-sonos-http-api` without Python), Spotify Connect |
| `analysis` | ListenBrainz, AudioMuse |
| `scrobble` | Last.fm, ListenBrainz |
| `device` | iPod sync — via satellite |
| `output` | UPnP/DLNA, Sonos, AirPlay, Chromecast, browser, satellite |
| `live` | YouTube and Twitch stream resolution, ffmpeg relay |
| `acquisition` | see §7 |

## 4. The job system

Everything long-running in this project has the same shape: scanning a source,
batch transcoding, fingerprinting the library, downloading episodes, syncing a
device, acquisition, sonic analysis, backup. **One implementation**, in the core.

```
Job { id, kind, state, priority, parentId?, progress{done,total,bytes}, error? }

     queued → running → done | failed | cancelled
                ↕
             paused
```

- **Persisted in SQLite.** A restart does not lose the queue; `running` jobs go
  back to `queued` on startup.
- **Resumable.** Each job kind defines its own resume point — a transfer offset,
  a scan cursor, a batch index.
- **Concurrency per kind.** Transcoding takes the available cores, a scan stays
  alone per source, network is capped at two. On a Pi those caps are the
  difference between "slow" and "unusable".
- **Idempotent on `id`.** Re-posting the same job returns the existing one.
- **Progress as aggregates**, detail paginated separately. 32-bit discipline.
- **Log** — the history is what tells you why an overnight sync failed at 4am.

**The satellite protocol is this same contract, seen remotely.** A local job and
a job on the iPod satellite are the same thing to the interface: `POST` to
create, `GET` for state, SSE for live, `PATCH` to pause. This is not an analogy,
it is the same schema and the same display component.

## 5. Routing audio

The server may not have a sound card, and it does not matter: it does not have
to *produce* sound to make sound *play*.

Three distinct roles:

| Role | Who | Does what |
|---|---|---|
| **Controller** | server, web interface, tablet satellite | decides what plays, holds the play queue |
| **Renderer** | browser, Sonos, UPnP, AirPlay, tablet, Pi + DAC, local sound card | turns bytes into sound |
| **Origin** | the server's streaming endpoint | serves the bytes |

### The server does not push audio, it hands out a URL

Same mechanism as the iPod satellite, and it works because Sonos, UPnP and
AirPlay all operate this way: "here is a URL, go get it".

```
GET /stream/:trackId?token=…&profile=sonos
```

No audio byte passes through the server's memory *as audio* — it is HTTP with
`Range`. The renderer handles its own buffering.

### The device declares, the server converts

Exactly the iPod rule, applied to sound. A Sonos does not necessarily play
24/192 FLAC, an old UPnP renderer does not play Opus. The streaming endpoint's
profile decides on-the-fly transcoding, per renderer.

### The `output` contract

```ts
interface Output {
  discover(): Renderer[]                    // SSDP, mDNS, Bonjour
  play(renderer, url, meta): void
  pause / resume / stop / seek / volume
  state(renderer): PlaybackState            // events, or polling
}
```

A single contract for UPnP, Sonos, AirPlay and Chromecast. The browser and the
satellites implement it too — a local renderer is just a special case.

### Live streams

YouTube and Twitch need resolving before playback (`yt-dlp`, `streamlink`, as
sidecars). After that, two paths:

- The renderer can play HLS → hand it the resolved URL, nothing more.
- It cannot (most UPnP renderers, and Sonos depending on the case) → **the server
  relays**: `ffmpeg` remuxes to an acceptable format, served on
  `/live/:sessionId`.

That relay is long-running, interruptible and worth watching: **it is a job**,
like everything else.

## 6. Interface extensions

A plugin can contribute to the interface. Two levels, like VS Code and Figma,
and the first covers the vast majority of cases.

### Declarative — named zones

The plugin declares its contributions **as data** in its manifest. The host
renders; the plugin ships no interface code.

```jsonc
"contributes": {
  "sidebar.section":    [{ "id": "lastfm.recent", "title": "Recent scrobbles" }],
  "library.tab":        [{ "id": "audiomuse.map", "title": "Sound map" }],
  "track.contextMenu":  [{ "id": "lastfm.love", "label": "Love", "command": "love" }],
  "track.column":       [{ "id": "audiomuse.bpm", "header": "Real BPM" }],
  "album.action":       [{ "id": "import.folder", "label": "Import" }],
  "nowPlaying.panel":   [{ "id": "lastfm.similar", "title": "Similar" }],
  "settings.panel":     [{ "id": "sonos.rooms", "title": "Sonos rooms" }],
  "statusbar.item":     [{ "id": "sync.state" }]
}
```

The content of those zones is **model**, not DOM: lists, values, actions. The
theme applies itself, and a plugin cannot break the interface or style outside
its own zone.

### Sandboxed iframe — for everything else

When a contribution needs a real interface (an interactive map, a graph), the
plugin ships HTML in a **sandboxed iframe** that talks to the host over
`postMessage`. This is exactly Figma's model, and the isolation is the browser's
— free and battle-tested. The theme is passed into the iframe as CSS variables.

## 7. Reorganizing files

Everything happens **at the source**, with no copy. This tool is where we can
genuinely stand out visually, because it is where everyone else is bad.

The principle: a **naming pattern** and a preview before acting.

```
{albumartist}/{year} - {album}/{disc:}{track:02} - {title}.{ext}
```

- **Two-column preview** — current path on the left, resulting path on the right,
  the changing part highlighted. Nothing moves until you confirm.
- **The pattern is edited live**, the preview recomputes as you type. You see
  immediately what one more brace does across 400 files.
- **Conflicts first.** Two tracks landing on the same path, a forbidden character
  on the target, a non-writable folder: surfaced at the top of the list, not
  discovered halfway through.
- **Row-by-row selection** — you can exclude a file from the operation without
  changing the pattern.
- **Dry run by default.** The button says what it will do: "Move 213 files,
  4 conflicts skipped".
- **Log and undo.** Every operation records its source → destination pairs: a
  botched reorganization can be replayed backwards.
- **Drag and drop** within the source tree for one-off moves, with the same
  confirmation.

A source declared read-only simply does not expose the tool.

## 8. Settings and administration

Sources (adding, connection test, capabilities), destination folders — each one a
*source + path* pair, one for podcasts, one for audio — plugins, scheduling,
backup.

**Backup**: JSON export of the whole configuration. Source credentials are
**excluded by default**; there is an option to include them encrypted with a
passphrase requested at export time. A backup file lying around must not contain
your Dropbox credentials.

## 9. Scheduling

Internal cron scheduler, no dependency, with named workflows: `iPod sync at 3am`,
`podcast feeds every 6h`, `rescan sources overnight`. Every job is **resumable
and logged** — an interrupted scan does not start over from zero.

## 10. Podcasts and radios

**Podcasts**: source = a folder via a source plugin *or* an RSS feed URL.
Parsing, covers, metadata, manual editing of whatever the feed fills in badly,
per-feed cron tuning, a "keep the last N episodes" option, destination set in the
settings.

**Radios**: full CRUD. Cover by automatic discovery (stream favicon, ICY
metadata, Radio-Browser) or upload.

## 11. Acquisition — held in reserve

The `acquisition` contract is neutral: a plugin declares a source, the host asks
it for files and files them into **your** library. The project ships only the
contract and the hook, never a download engine.

The supported sources are your own — local folders, network drives, mounted
media, device backups. A third-party plugin talking to a service **you** host is
just one more HTTP client, exactly like the Sonos plugin talking to soco-cli;
what it does on its side is not the host's business.

## 12. Frontend

- Movies and TV Shows to be dropped *(not done yet)*.
- **iTunes Store** → plugin store: catalogue, permissions shown before install,
  versions, required sidecars announced.
- **Purchased** → installed plugins: enable, configure, update, remove.
- **iPod view**: the device's real contents, which the original iTunes never
  showed. Add by right-click and by dropzone.
- **Keyboard shortcuts** everywhere, shortcut sheet carried over from `trieur`
  (`Kbd`, `Shortcuts`, `ShortcutsDialog` — keycaps with a thick bottom edge,
  Lucide glyphs for special keys, groups of icon + label + keys).

## 13. Documentation and demo

An **Astro** site: documentation + a playable demo on a fake backend — the same
deterministic generator as today. One page per plugin family, the generated
OpenAPI reference, and the interface log from `ui-evolution.md`.

---

## Sources

- [Hono vs Express vs Fastify vs Elysia 2026 — PkgPulse](https://www.pkgpulse.com/guides/hono-vs-express-vs-fastify-vs-elysia-2026)
- [OpenSubsonic — specification](https://opensubsonic.netlify.app/docs/)
- [soco-cli — Sonos HTTP server](https://pypi.org/project/soco-cli/)
- [node-sonos-http-api — the Python-free equivalent](https://github.com/jishi/node-sonos-http-api)
- [Sonos local UPnP API — svrooij](https://sonos.svrooij.io/sonos-communication)
- [iOpenPod — iPod engine](https://github.com/TheRealSavi/iOpenPod)
- [AudioMuse-AI](https://github.com/NeptuneHub/AudioMuse-AI)
- [rclone — Remote Control / API](https://rclone.org/rc/) and [`rclone serve webdav`](https://rclone.org/commands/rclone_serve_webdav/)
- [Infuse — supported protocols](https://firecore.com/infuse)
- [Extism — WASM plugin system](https://github.com/extism/extism)
- [How Figma built its plugin system](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/)
- [Home Assistant — integration manifest](https://developers.home-assistant.io/docs/creating_integration_manifest/) and [HACS](https://www.hacs.xyz/docs/publish/integration/)
- [Volumio — plugin structure](https://developers.volumio.com/plugins/plugin-structure)
- [node-taglib-sharp — tag reading and writing in pure JS](https://github.com/benrr101/node-taglib-sharp)
