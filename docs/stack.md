# Stack — settled

One principle governs half the choices here: **zero native modules in what
ships.** No `node-gyp`, no prebuilt-binary roulette, an identical install on x64,
ARM, NAS and Raspberry Pi. That is the real constraint on self-hosted software,
and it is worth more than a marginal performance gain.

The project's only binaries are `rclone` and `ffmpeg`, owned as sidecars and
shipped separately.

---

## Deployment targets — what constrains everything else

x86, arm64, armhf, Synology NAS, Raspberry Pi.

| Target | Arch | Official Node | Verdict |
|---|---|---|---|
| PC, server, Intel NAS | `x64` | all versions | OK |
| Pi 3/4/5, recent Synology, ARM NAS | `arm64` | all versions | OK |
| Pi 2, Pi 3/4 on a 32-bit OS, older ARM Synology | `armv7l` (armhf) | **up to and including Node 22 LTS** | **ceiling** |
| Pi Zero, Pi 1 | `armv6l` | never official | out of scope |

**Node 24 no longer publishes a `linux-armv7l` binary.** Node 22 LTS is the last
line that does — verified on `nodejs.org/dist`. Direct consequences:

1. **We target Node 22 LTS**, not 24. No API reserved for 24+.
2. `node:sqlite` works without a flag since **22.13**, while printing an
   "experimental" warning. The API is frozen (it is *release candidate* in 24, so
   it will not move) — we silence the warning, we do not change driver.
3. **Multi-arch Docker is the primary install path.** A `node:22` image covers
   x64, arm64 and armv7 in one go, and incidentally removes the old-glibc
   problem on DSM.
4. **armv6 is documented as unsupported** rather than discovered by the user.

### The 32-bit constraint, and what it costs in the code

On armhf, the V8 heap is capped around a gigabyte. A 100,000-track library does
not fit in memory. This is not a setting, it is a writing rule:

- **The scan is a stream**, never a complete array in memory.
- **The API paginates**, always. No route returns "the whole library".
- **Aggregates are computed in SQL**, not in JavaScript.
- The frontend already virtualizes, so it never needs to receive everything.

It is also what will make the server pleasant on a big machine.

---

## Server

| Role | Choice | Why |
|---|---|---|
| Runtime | **Node 22 LTS** | Last line with an armv7l binary. `fetch`, `node:test`, `--watch` built in |
| HTTP | **Hono** | Essential middleware built in, WebSocket, multi-runtime if it ever matters |
| API + validation | Bare Hono today · **`@hono/zod-openapi` + Zod** targeted | The goal: generate the OpenAPI *from* the validation schemas, so it cannot drift. **Not done yet** — the contracts are hand-written in `packages/api-types` and can therefore drift from the routes |
| Database | **`node:sqlite`**, raw SQL | SQLite compiled into the Node binary. Zero install, zero `node-gyp`, so identical on armhf |
| Migrations | *to do* — a runner for numbered `.sql` files | ~20 lines; see the Drizzle write-off below |
| Audio tags | **`node-taglib-sharp`** | Reading **and** writing, pure JS, v6 actively maintained |
| Metadata scanning | **`music-metadata`** | Pure JS, fast in batch, for indexing |
| Transcoding | **ffmpeg** | A binary, `spawn`. Nobody does it any other way |
| File sources | **rclone** | Sidecar binary, `rclone rcd` HTTP API on localhost |
| Scheduling | **`croner`** | A few kilobytes, no dependencies |
| Logging | **`pino`** | |
| Passwords | **`node:crypto` → `scrypt`** | Built-in KDF. bcrypt and argon2 are native — excluded by the principle |
| Session | **`hono/jwt`** | |
| Tests | **`node:test`** | Built in, no framework to install |

### Drizzle, evaluated then dropped

The initial plan was Drizzle on `node:sqlite`, with `drizzle-kit` as a
`devDependency` to generate migrations — since `drizzle-kit` does not support
`node:sqlite`, that would have meant `better-sqlite3` alongside it, for
development only.

**Dropped once the schema was written.** It is 170 lines of SQL, `node:sqlite`
prepares statements just fine, and this project's queries — lexicographic cursor
comparison, `EXISTS` on device presence, FTS5 — read better as SQL than as a
builder. Drizzle added a runtime dependency, a tool that does not speak our
driver, and a translation layer for no benefit here.

What is left to write: a migration runner. Numbered `.sql` files, a
`schema_version` table, a loop. Roughly twenty lines.

## Frontend

| Role | Choice | Note |
|---|---|---|
| Base | **React 19 + Vite** | already in place |
| Table | **TanStack Table v9 + Virtual** | already in place |
| Server state | **TanStack Query** | cache, invalidation, concurrent requests |
| Client SDK | **`packages/client-sdk`**, hand-written | zero dependencies. To be replaced by generation once the routes move to `@hono/zod-openapi` |

The frontend consumes the generated SDK. No privileged routes: whatever the
in-house frontend can do, a third party can too.

## Monorepo

**npm workspaces** — already on npm, zero migration. `npm run check` runs `tsc -p`
on each project; TypeScript project references are still to be set up.

```
apps/
  server/            Hono, DB, plugin host, scheduler
  web/               React + TanStack
packages/
  api-types/         shared contracts
  client-sdk/        client SDK
docs/
scripts/             guardrails and fixtures

# to come
packages/plugin-kit/ host API types, manifest schema
plugins/             plugins shipped with the app
site/                Astro — documentation + demo
```

## Later

**Tauri** for the native app rather than Electron: lighter, and the server runs
inside it as an embedded sidecar — the same binary as on a server, the same API.
That is what enables the two modes you want, standalone or detached, without two
codebases.

## A runtime constraint: no emitting TypeScript

The server runs directly with `--experimental-strip-types`, which **erases**
types without generating code. Anything requiring a transform is therefore off
limits:

| Forbidden | Instead |
|---|---|
| `constructor(readonly x: T)` — parameter property | declared field + assignment in the body |
| `enum` | `const X = { … } as const` + derived type |
| `namespace` | a module |
| decorators | a higher-order function |

This breaks **neither at typecheck nor at lint** — only at runtime, often in a
file nobody has re-run in a while. So `npm run no-native` checks this rule across
all sources too.

In exchange: no compilation step on the server side, in development or in
production. The repository runs as it is.

## Verified, not asserted

The runtime dependency tree has been installed and audited:

```
45 packages · 0 .node files · 0 binding.gyp · 0 install/postinstall script
sources · 0 emitting TS syntax
```

No compiler is required. That is what makes the install identical on armhf,
arm64 and x64. **To be re-run on every dependency addition** — a single native
dependency brings `node-gyp` back for everyone.

## What we do not install, and why

| | |
|---|---|
| `better-sqlite3` | native; on armhf it would compile from source. `node:sqlite` installs everywhere |
| Drizzle | evaluated then dropped, see above |
| `bcrypt` / `argon2` | native; `scrypt` is in `node:crypto` |
| Prisma | a binary engine to ship, against the principle |
| A test framework | `node:test` does the job |
| An SMB/FTP/S3 client in JS | rclone covers them all, in one binary |
| A plugin sandbox | contract first; see `architecture.md` §3 |

---

## Sources

- [`node:sqlite` — status in Node 24](https://www.hirenodejs.com/blog/nodejs-builtin-sqlite-node-sqlite-2026) (Stability 1.2, release candidate)
- [Drizzle — Node SQLite driver](https://orm.drizzle.team/docs/connect-node-sqlite)
- [drizzle-kit does not support `node:sqlite`](https://github.com/drizzle-team/drizzle-orm/issues/5471)
- [Drizzle vs Kysely 2026 — PkgPulse](https://www.pkgpulse.com/guides/drizzle-vs-kysely-2026)
- [node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp)
- [rclone — Remote Control API](https://rclone.org/rc/) · [downloads](https://rclone.org/downloads/): amd64, 386, arm-v6, arm-v7, arm64
- [`nodejs.org/dist/latest-v22.x`](https://nodejs.org/dist/latest-v22.x/) — `linux-armv7l` present
- [`nodejs.org/dist/latest-v24.x`](https://nodejs.org/dist/latest-v24.x/) — `linux-armv7l` absent
