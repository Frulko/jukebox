---
title: Jukebox
description: Self-hosted manager for your own music library, with an iTunes-style interface.
template: splash
hero:
  tagline: |
    Self-hosted manager for your own music library. The server indexes,
    transcodes and serves; the players live elsewhere.
---

**Work in progress.** The server core and the interface prototype run; most of
the backlog is still to be written.

Three directions kept apart, where most projects conflate them: a **renderer**
plays right now, a **device** holds a copy, an **emitter** lets others read the
library. Everything in these pages follows from that split.

- [Architecture](./architecture.md) — topology, plugins, satellites, audio routing
- [Stack](./stack.md) — technical choices and deployment targets
- [API](./api.md) — the target spec, existing routes marked ✅
- [UI evolution](./ui-evolution.md) — iTunes 8 → iTunes 12 → Apple Music

The [system map](/jukebox/map/) shows inputs, core and outputs on one page.
