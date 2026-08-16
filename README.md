# jukebox

Self-hosted manager for your own music library, with an iTunes-style interface.
The server indexes, transcodes and serves; the players live elsewhere — browser,
Sonos, UPnP, AirPlay — and iPods sync through satellites.

> **Work in progress.** The server core and the interface prototype run; most of
> the backlog is still to be written. See [TODO.md](TODO.md).

```bash
npm install
npm run dev          # server (8787) + interface (5173)
npm run verify       # types + tests + guardrail, stops at the first red
npm test             # 49 tests — builds its audio fixtures with ffmpeg
npm run check        # type-checks the four projects
npm run no-native    # guardrail: no native modules, no emitting TS syntax
```

Node ≥ 22.13 required. `ffmpeg` and `fpcalc` are optional in development: without
them, the tag and fingerprint tests skip themselves and say so.

## What works today

**Server** — Hono on `node:sqlite`. Manual and smart playlists, streaming scan of
a local folder, tag reading and in-place writing, acoustic fingerprints, a job
queue resumable after a crash, cursor pagination, differential sync by revision,
`ETag` on collections, SSE event stream.

**Interface** — the full iTunes prototype: virtualized TanStack v9 table,
multi-selection, drag and drop, single and bulk editing with an adaptive modal,
three themes (iTunes 8, iTunes 12, Apple Music), generated artwork. It still runs
on fabricated data; wiring it to the API is in progress.

## Layout

```
apps/server    the API — library, files, jobs
apps/web       the React + TanStack interface
packages/      shared contracts and client SDK
docs/          architecture, stack, API, map
scripts/       guardrails and fixtures
```

## Documentation

| | |
|---|---|
| [architecture.md](docs/architecture.md) | topology, plugins, satellites, audio routing |
| [stack.md](docs/stack.md) | technical choices and deployment targets |
| [api.md](docs/api.md) | the API — target spec, existing routes marked ✅ |
| [map.html](docs/map.html) | overview: inputs / core / outputs |
| [ui-evolution.md](docs/ui-evolution.md) | iTunes 8 → iTunes 12 → Apple Music |

## Environment variables

| | |
|---|---|
| `PORT` | server port, 8787 by default |
| `JUKEBOX_DB` | database path, `./data/library.db` by default |
| `JUKEBOX_FIXTURES` | audio fixture folder for tests — `npm test` handles it |

## Credits

Standing on: [Hono](https://hono.dev) and `node:sqlite` for the server,
[Zod](https://zod.dev) for the contracts, [croner](https://github.com/hexagon/croner)
for the scheduler, [music-metadata](https://github.com/borewit/music-metadata) and
[node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp) for tags,
[React](https://react.dev), [TanStack](https://tanstack.com) and
[Vite](https://vite.dev) for the interface.

Off-process: [ffmpeg](https://ffmpeg.org) for transcoding and test fixtures,
[Chromaprint](https://acoustid.org/chromaprint) for acoustic fingerprints.

Planned sidecars and satellites lean on
[soco-cli](https://pypi.org/project/soco-cli/) for Sonos,
[iOpenPod](https://github.com/TheRealSavi/iOpenPod) for iPods, and
[AudioMuse](https://github.com/NeptuneHub/AudioMuse-AI) for sonic analysis.

The interface owes its shape to iTunes — Apple's, not ours.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`.

Types in use: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`,
`chore`. Scopes follow the workspace: `server`, `web`, `sdk`, `devices`,
`playlists`.

The body is where the value is. Record *why* a decision was taken and which trap
it avoids, not what the diff already shows.
