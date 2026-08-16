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
- [x] **1.3** **The five network rules** — cursor and never OFFSET, `delta?since=`, collection
      `ETag`, a full page in one round trip, SSE. Audited rather than asserted, and the audit
      found a real one: every ETag was keyed on the *library* revision, including for
      collections the revision does not describe. Adding a schedule bumped no counter it
      tracks, so the server answered 304 and a client went on showing a list without the row
      it had just created — stale not by a second but until something unrelated happened.
      Those collections now key on the answer itself. `apps/server/test/etag.test.ts` asks the
      only version of the question worth asking — *does the ETag change when the answer does* —
      and reads the collection list off the router, so one added later is covered without
      anyone remembering. The delta had a worse one: `PUT /devices/:id/tracks` bumped the
      global counter without stamping any track, so `delta?since=` returned an empty list
      *with a higher revision* — the client concluded it was up to date and kept presence data
      that was wrong from then on. Device presence travels with the track, so it is a change
      to the track; the symmetric difference is stamped, so a satellite re-reporting the same
      contents on every heartbeat still costs nothing. `apps/server/test/delta.test.ts` replays
      every delta from zero and asserts the result equals the page
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
- [x] **1.8b** The spec now describes shapes, not just paths. `scripts/api-schemas.mjs` reads
      `@jukebox/api-types` with the TypeScript compiler that is already a devDependency and
      emits `components.schemas` — 40 types, doc comments and all. Committed rather than
      generated at boot, so the server never loads the compiler to document itself, with a
      test that fails when the two drift. The direction is deliberate: the types stay the
      source and the spec is derived, because the types are what the server is checked
      against and a spec is not
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

- [x] **3.1** `GET /stream/:id` — `Range`, the per-renderer profile (`?accept=`), and now
      conversion on the fly when the library holds nothing the client can play. Piped rather
      than written to disk, which is what makes the container the interesting part: an `.m4a`
      is an MP4 and MP4 rewrites its index at the front on close, so AAC goes out as ADTS and
      ALAC is refused outright rather than dying halfway through a 200. No `Content-Length`
      and `Accept-Ranges: none`, because a player told it can seek would restart the track;
      `?seek=` re-encodes from an offset instead. The encoder is killed when the client hangs
      up — three abandoned ffmpegs is a Raspberry Pi. Local sources only: a remote one would
      mean ffmpeg opening an authenticated URL, and it answers 501 saying so
- [~] **3.2** Browser renderer done — one `<audio>` on `/stream/:id`, state read from the
      element. Left: the `output` contract that lets a renderer live elsewhere
- [x] **3.3** UPnP/DLNA — SSDP discovery, description parsing, `SetAVTransportURI`, play,
      pause, stop, volume. Verified against five real Sonos speakers on the LAN.
      Sonos-specific grouping and its own queue are still to come
- [x] **3.4** Play queue shared between controllers — the server holds the intent, a renderer
      executes it and reports back, and every controller sees the same queue
- [x] **3.6** Satellite renderer — registers as an output, follows the shared queue, plays
      through mpv/ffplay/vlc and reports back. It pulls; the server never pushes audio
- [~] **3.5** AirPlay — discovery is done and real: `mdns.ts` is a hand-written multicast DNS
      reader (compression pointers and all, no dependency) and `airplay.ts` drives the HTTP
      profile, so the receiver fetches the stream URL exactly as a UPnP renderer does. Both
      protocols now dispatch through one `Output` union. Verified against the two real
      receivers on this LAN. **The wall is pairing**: anything AirPlay 2 answers 403 to the
      control routes until a HomeKit pairing is done (SRP6a, Curve25519, ChaCha20-Poly1305,
      a PIN on a television) — found, named in the error, not yet performed. RAOP is
      deliberately out: it would put an ALAC encoder and an RTP clock in the server
- [x] **3.7** Chromecast — `castv2.ts` is the wire protocol by hand: seven protobuf fields,
      four-byte framing, varints. The framing is tested at every possible split point, which
      is the bug that works on a desk and breaks the first time a status payload gets long.
      `chromecast.ts` does the four steps in the order the device demands — connect, launch,
      connect *again* to the app's transport id, load — the third being the one that fails
      silently when skipped. Volume works here, unlike AirPlay. Tested against a faithful
      fake device over a plain socket; **not yet against real hardware**, since there is no
      Chromecast on this network (the mDNS reader itself is proven here: it finds the six
      Sonos and both AirPlay endpoints)
- [ ] **3.8** `live` family — YouTube/Twitch + ffmpeg relay (a job like any other). **Needs a
      decision that is not mine**: resolving those URLs means shipping `yt-dlp`, the same tool
      used for the acquisition path already ruled out. Relaying a live broadcast is playback
      and keeps nothing, which is a different thing from ripping a catalogue — but it is the
      same binary in the image, so the call belongs upstairs

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
- [x] **4.2** OS mounts (NFS, SMB, anything already mounted) — a share is just a local source,
      because the kernel already did the hard part. What it needed was the *other* half:
      `mounts.ts` reads the real mount table (`/proc/self/mounts` on Linux, `mount` elsewhere)
      so `GET /sources` can say "this NFS share is not mounted" instead of showing an empty
      library. And the scan now refuses to sweep when it finds nothing where a library used
      to be — an unmounted share is shaped exactly like a deleted library, the two cannot be
      told apart from there, and the costs are not symmetric: a wrong refusal leaves stale
      rows, a wrong sweep empties the library. `?prune=true` is how to mean it
- [x] **4.3** Jellyfin / Emby / **Plex** — indexed from their own metadata, so it downloads
      nothing; streaming proxied with Range through one shared proxy. Plex's differences are
      all in the details: milliseconds not ticks, JSON only if asked, the file three levels
      down in `Media[].Part[]`, and the Part key — not the track's — is what streams
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
- [x] **5b.2** OpenSubsonic emitter — ping, browse (both the modern and the folder-shaped
      pair), search2 and search3, genres, random songs, playlists, stream, download, cover
      art, star, rate, scrobble, `getUser` and scan status. Both auth schemes, JSON and XML.
      `download` never converts and `stream` may: that distinction is what stops an archiver
      quietly replacing a FLAC library with MP3s
- [x] **5b.3** Per-user libraries and roles — three roles, not more: `admin` runs the server,
      `user` lives there, `guest` plays and nothing else. Enforced as *capabilities*
      (`admin`/`write`/`curate`/`play`) from one table, by prefix and method, so a route added
      later inherits the safe default instead of nothing; `/auth/me` returns the same list the
      server enforces with, so a UI cannot offer a button the server refuses. Per-account
      libraries scope `sourceIds` in SQL through the listing, the count, the facets, the delta
      and the source list — each is a separate query, and hiding one proves nothing about the
      others. Absence means everything, so a one-library household configures nothing. Two
      bugs found by writing the tests: `GET /users` was readable by any account, and a
      cascading foreign key meant deleting a source *widened* the account narrowed to it

## M5 · Plugins and store

- [x] **5.1** Plugin host — manifest, lifecycle, semver `hostApi`, failure isolation, and
      **sidecars**: `net.spawn` gives a plugin a child process the host owns. Output drained
      whether or not anyone listens (a full stdout pipe blocks the program mid-write and looks
      like a hang), unref'd so a running sidecar is never why SIGTERM does nothing, SIGTERM on
      stop, and an opt-in restart with a growing delay — restarting something that exits
      immediately, immediately, is a fork bomb with good intentions. Host API 1.2.0
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
- [x] **5.6** Last.fm scrobble — the same queue-and-batch shape as ListenBrainz, plus the
      signature: MD5 over the parameters sorted by *name*, joined as `nameValue` with no
      separators, secret on the end, with `format` and `api_sig` themselves excluded and the
      raw UTF-8 hashed rather than the encoded form. Every expected signature in the tests was
      computed outside the code, since a test that signs with the function it is testing only
      proves the function is deterministic. Their error numbers are read rather than the HTTP
      status: 9 is a dead session, 16 is come back later, and retrying the first blocks
      everything behind it
- [~] **5.7** AudioMuse — **the half that could be verified is done, the half that could not
      is not started.** AudioMuse indexes a library by pointing at a media server it supports,
      and this one already speaks Subsonic, so the actionable question was whether the emitter
      is complete enough to be walked. It was not: `getIndexes`, `getMusicDirectory`,
      `search2`, `getGenres`, `getRandomSongs`, `getUser` and `getScanStatus` were all
      missing, and `download.view` passed `format` through — so a client asking to download a
      FLAC could receive an MP3, which would have an analyser measuring the encoder rather
      than the music. All added and tested. What is *not* built is the client that asks
      AudioMuse for similar tracks: its endpoints are behind a Swagger page on a running
      instance, two fetches did not produce them, and inventing them would be fiction
- [x] **5.8** Home Assistant + MQTT — the player publishes itself as a `media_player` entity
      through MQTT discovery, so nobody edits a YAML file, and accepts its commands back.
      MQTT 3.1.1 written by hand inside the plugin (QoS 0, keepalive, reconnect): its packet
      format is a byte, a varint and length-prefixed strings, where the popular client also
      carries QoS 2, sessions, websockets and a browser build. Needed host API 1.1.0 — a minor
      bump adding `on('player')` and `host.player`, since a plugin that can watch but not act
      is the useless half of a home-automation integration
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
