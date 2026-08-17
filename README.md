# jukebox

Self-hosted manager for your own music library, with an iTunes-style interface.
The server indexes, transcodes and serves; the players live elsewhere — browser,
Sonos, UPnP, AirPlay, Chromecast — and iPods sync through satellites.

> **Work in progress**, but past the prototype: the server is functionally
> complete and the interface runs on the real API. What is left is mostly
> peripheral — see [TODO.md](TODO.md) for the milestone list and what each
> remaining item is waiting on.

```bash
npm install
npm run dev          # server (8787) + interface (5173)
npm run verify       # types + tests + guardrail, stops at the first red
npm test             # 435 tests — builds its audio fixtures with ffmpeg
npm run check        # type-checks the five projects
npm run no-native    # guardrail: no native modules, no emitting TS syntax
```

Node ≥ 22.13 required, and 22 is also the ceiling: it is the last line with an
official `armv7l` binary, which is what keeps 32-bit NAS boxes and older Pis a
target. `ffmpeg` and `fpcalc` are optional in development — without them the
tag and fingerprint tests skip themselves and say so.

## What works today

**Library** — streaming scan that never holds the whole library in memory,
cursor pagination that never uses `OFFSET`, FTS5 search, tag reading and
in-place writing, acoustic fingerprints, user tags with smart-playlist rules,
manual and smart playlists, backup and restore of the curation.

**Sources** — a local folder, OS mounts (NFS, SMB) with a scan that refuses to
sweep a share that is merely unmounted, rclone, and Jellyfin, Emby and Plex
indexed from *their* metadata so nothing is downloaded to index it.

**Playback** — `Range` streaming, per-renderer format profiles, and conversion
on the fly when the library holds nothing the client can play. Outputs: the
browser, UPnP/DLNA and Sonos, AirPlay and Chromecast (both found over multicast
DNS), and satellites that pull rather than being pushed to.

**Accounts** — three roles enforced as capabilities, per-account libraries
filtered in SQL rather than over a fetched page, and an OpenSubsonic API at
`/rest` that twenty years of clients already speak.

**Plumbing** — a job queue that resumes after a crash, revision-based
differential sync, `ETag` on collections, an SSE stream so nothing has to poll,
a plugin host with sidecars, and a Docker image for `amd64`, `arm64` and
`armv7`.

**Interface** — virtualized TanStack table, multi-selection, drag and drop,
single and bulk editing, four themes (iTunes 8, iTunes 12, Apple Music, Studio),
generated artwork — on the real API.

### What is a stand-in

The satellite in `apps/satellite` is a **reference implementation, not iPod
support**. It speaks the whole device contract — pull with `Range` resume,
one commit after every file has landed, cancellation mid-transfer — against a
folder of files. Writing a real iTunesDB is not done, and no physical iPod has
ever been synced. Replacing `readDevice` and the job runner is the work; the
contract, the queue and the state machine are meant to survive it unchanged.

## Layout

```
apps/server    the API — library, files, jobs
apps/web       the React + TanStack interface
apps/satellite the device contract, and an optional renderer
apps/docs      the Astro + Starlight site that publishes docs/
packages/      shared contracts and client SDK
plugins/       bundled plugins, loaded at startup
docs/          architecture, stack, API, map
scripts/       guardrails and fixtures
```

## Documentation

Published at **[frulko.github.io/jukebox](https://frulko.github.io/jukebox)** —
built from `docs/` on every push to `main`. Locally:
`npm run dev --workspace @jukebox/docs`.

| | |
|---|---|
| [architecture.md](docs/architecture.md) | topology, plugins, satellites, audio routing |
| [stack.md](docs/stack.md) | technical choices and deployment targets |
| [api-reference.md](docs/api-reference.md) | generated from the router — every route, always current |
| [api.md](docs/api.md) | the API by hand: shapes, conventions, the five network rules |
| [plugins.md](docs/plugins.md) | writing one, and what the host provides |
| [map.html](docs/map.html) | overview: inputs / core / outputs |
| [ui-evolution.md](docs/ui-evolution.md) | iTunes 8 → iTunes 12 → Apple Music |

## Environment variables

| | |
|---|---|
| `PORT` | server port, 8787 by default |
| `JUKEBOX_DB` | database path, `./data/library.db` by default |
| `JUKEBOX_PLUGINS` | plugin folder, `./plugins` by default |
| `JUKEBOX_FIXTURES` | audio fixture folder for tests — `npm test` handles it |
| `SATELLITE_PORT` | satellite port, 8899 by default |
| `SATELLITE_ROOT` | the folder a satellite presents as its device |

## Dependencies

Five, at runtime, on purpose: [Hono](https://hono.dev) and its Node server,
[music-metadata](https://github.com/borewit/music-metadata) and
[node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp) for tags, and
[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser). The
database is `node:sqlite`, the scheduler is a five-field cron parser in this
repository, and SSDP, multicast DNS, the Chromecast protobuf channel and MQTT
are all written here rather than depended on.

**Zero native modules**, enforced by `npm run no-native` in CI as well as
locally: a compiled addon is only a problem on the machines nobody develops on,
so a rule enforced by whoever remembers is not enforced.

Off-process: [ffmpeg](https://ffmpeg.org) for conversion and test fixtures,
[Chromaprint](https://acoustid.org/chromaprint) for acoustic fingerprints,
[rclone](https://rclone.org) for remote sources.

Interface: [React](https://react.dev), [TanStack](https://tanstack.com),
[Vite](https://vite.dev).

Planned satellites lean on
[iOpenPod](https://github.com/TheRealSavi/iOpenPod) for iPods and
[AudioMuse](https://github.com/NeptuneHub/AudioMuse-AI) for sonic analysis.

The interface owes its shape to iTunes — Apple's, not ours.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`.

Types in use: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`,
`chore`. Scopes follow the workspace: `server`, `web`, `sdk`, `devices`,
`playlists`.

The body is where the value is. Record *why* a decision was taken and which trap
it avoids, not what the diff already shows.
