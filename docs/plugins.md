---
title: Plugins
description: What a plugin can do, what it cannot, and how it reaches the person using the app.
---

A plugin is an ordinary Node module that the server loads into its own process.
That sentence contains both the capability and the limit, so it is worth reading
twice before writing one.

## The bargain

**A plugin can do anything the server can do.** It runs with the server's
process, its file access and its network. The `permissions` in a manifest are
shown to whoever installs it and are **not enforced by anything**.

This is a deliberate choice with a known cost. Home Assistant and Volumio both
landed here after trying harder, because the plugins people actually want are
wrappers around HTTP, MQTT and hardware — and every real sandbox either blocks
those or becomes a process boundary with its own IPC to maintain. The
[architecture](./architecture.md) sets out when that changes: the day the store
opens to unknown authors, the families that only need `fetch` get sandboxed and
sources stay in reviewed Node.

What the host *does* guarantee:

- **A plugin cannot take the server down.** Loading, activating and deactivating
  are isolated; one that throws is recorded as `failed` and everything else
  carries on.
- **Turning it off turns it off**, if it used the host's transports — see below.
- **A plugin written for an older host is refused, not half-run.** `hostApi` is a
  semver range against the host's version, and a plugin calling a method that no
  longer exists fails at the worst possible moment otherwise.

## The manifest

```jsonc
{
  "id": "listenbrainz",
  "name": "ListenBrainz",
  "version": "1.0.0",
  "hostApi": "^1.0.0",          // range against the host, refused if it does not match
  "main": "index.mjs",
  "description": "Sends your listening history to ListenBrainz.",
  "author": "jukebox",
  "permissions": ["network:api.listenbrainz.org", "events:play"],
  "contributes": { /* where it appears in the UI — see below */ }
}
```

## What the host hands you

```ts
export function activate(host) { /* … */ }
export function deactivate() { /* … */ }
```

| | |
|---|---|
| `host.log(…)` | Prefixed with the plugin id, so a noisy plugin is identifiable |
| `host.config` / `host.setConfig(next)` | The plugin's own settings, as stored by the server |
| `host.registerJob(name, handler)` | A job kind, namespaced to the plugin so two cannot collide |
| `host.registerCommand(name, handler)` | Something the user can invoke — see *Reaching the user* |
| `host.createPlaylist(name, trackIds)` | So a command can return a playlist it just built |
| `host.net` | Sockets, requests and timers the host closes when the plugin stops |
| `host.on('play', handler)` | Server events; returns an unsubscribe the host also calls for you |

`host.net` deserves the emphasis. A plugin can reach `fetch` and `net.connect`
directly — it is in the same process. Using the host's transports instead is
what makes disabling the plugin actually stop its traffic, and it is the
difference between a plugin you can turn off and one you have to restart the
server to be rid of.

## Reaching the user

A plugin **never renders anything**. It declares *where* it wants to appear and
*what* the entry says; the host draws it. No plugin code runs in the page, which
is why a third-party plugin cannot break the interface, restyle it, or read what
is on screen.

### `contributes.settings`

A list of fields the admin page renders as a form:

```jsonc
"settings": [
  { "key": "token", "label": "User token", "type": "password",
    "help": "From listenbrainz.org/profile — the plugin does nothing until this is set." },
  { "key": "url", "label": "Server", "type": "text", "default": "https://api.listenbrainz.org" }
]
```

Whatever the user saves arrives as `host.config`.

### `contributes["track.contextMenu"]`

Entries in the right-click menu of a track or a selection:

```jsonc
"track.contextMenu": [
  { "id": "lb.similar", "label": "Find similar tracks", "command": "similar" }
]
```

Each entry names a `command` registered with `host.registerCommand`. The menu
shows which plugin an entry came from, and **greys out any entry the plugin
cannot currently run** — a stopped plugin still has a manifest, so contributing
and being able to run are different facts and the menu says which is which.

### `contributes["track.tab"]`

A tab in a track's information window:

```jsonc
"track.tab": [
  { "id": "lyrics.words", "label": "Lyrics", "command": "words" }
]
```

The command runs when the tab is *opened*, not when the window is — a plugin
that reaches a third party costs nothing to someone who only wanted to fix a
track number. It is asked about **one** track: "the lyrics of these nine songs"
is not a question, so the window keeps only its own tabs when several are
selected.

Unlike a menu entry, a stopped plugin's tab is **not drawn at all**. A greyed
entry says "this exists and is switched off", which is worth saying; an empty
tab is worse than a window with one tab fewer.

### `contributes["home.section"]`

A strip on the home page. The host renders it as data — a title and rows — never
as markup.

### `contributes.theme`

A whole skin for the app, declared as data:

```jsonc
"theme": {
  "label": "Hot Dog",              // what the picker shows
  "rowHeight": 21,                 // must match --row-h; the virtualiser needs it
  "playlistArt": false,            // generated art next to sidebar playlists
  "tokens": { "--accent": "#c40000", "--content": "#fffef0" /* … */ },
  "css": ""                        // optional, for rules beyond tokens
}
```

`tokens` is the whole story for most skins — the app's components read CSS
custom properties and nothing else, so a theme *is* a block of token
redefinitions, and the host writes that block itself. Only keys starting with
`--` are kept: the tokens door does not accept arbitrary declarations.

`css` exists for skins that also move furniture. It is injected as-is, so it
must scope every rule under `[data-theme="plugin-<id>"]` — the theme registers
under that prefixed id precisely so a plugin can never shadow a built-in skin
or another plugin's.

A theme is styling, not script: everything lands in a `<style>` element and
none of it runs. It follows the plugin's switch — disable the plugin and the
skin leaves the picker; whoever was wearing it falls back to the base skin.
The `hotdog` plugin in this repository is a complete working example.

## What a command may answer

`host.registerCommand` handlers return one of four shapes, and the interface does
something different with each:

| Result | What the app does |
|---|---|
| `{ kind: 'done', message? }` | Says so in the status line |
| `{ kind: 'job', job }` | Sends it to the display that cycles through running jobs |
| `{ kind: 'playlist', id, name }` | Opens the playlist that was just built |
| `{ kind: 'tracks', ids }` | **Selects** them and scrolls there — not saved |
| `{ kind: 'text', title?, body }` | Renders it in the tab that asked, as text |

`text` is plain text and the host renders it as such. A plugin that could answer
with markup would be a plugin that can restyle the window and read what is
around it, which is the one thing `contributes` exists to prevent — so what a
tab can do to the interface ends at line breaks.

The `tracks` kind is the other one worth understanding. "Find me more like this" produces a
selection, not a playlist: an exploratory command should not leave something
behind for the user to delete. Saving it is then their decision rather than the
plugin's.

A command has **thirty seconds**. A plugin that hangs would otherwise hang the
menu with it; after that the app is told `command_timeout` with the plugin's
name. Failures are separated so the interface can name the right culprit —
`plugin_disabled`, `unknown_command`, `command_failed` with the plugin's own
message — and a `500` means the *server* broke, which sends someone to debug a
different thing.

## Lifecycle and failure

`installed` → `active` when it loads and activates. `failed` if either throws,
with the reason kept and shown in the admin page. `disabled` when switched off,
which stops its listeners, closes its transports and cancels its timers.

A failing plugin is ordinary and the interface treats it that way: it stays
listed, with its error, next to a button that enables it again.

## Installing

From a store index — a URL, asked for every time and never defaulted, because
installing runs someone else's code as the server and which store to trust is a
decision the user makes rather than inherits. Entries that need a newer host say
so before the install rather than failing after it.

## A worked example

The shipped [`plugins/listenbrainz`](https://github.com/Frulko/jukebox/tree/main/plugins/listenbrainz)
is deliberately small and exercises the whole surface: it takes a token through
`contributes.settings`, subscribes with `host.on('play')`, queues listens through
`host.net` so disabling it stops the traffic, and registers a `flush` command
that returns `{ kind: 'done', message: '3 listens sent.' }`.

[`plugins/lyrics`](https://github.com/Frulko/jukebox/tree/main/plugins/lyrics)
covers the other half: it contributes a *place* rather than an action. Thirty
lines, one `track.tab`, one command that answers `{ kind: 'text' }` — and it
shows what a lookup plugin should do when the lookup fails. A track LRCLIB has
never heard of, an entry that exists but holds no words, and a server that
cannot be reached are three different sentences, and none of them throws: a
command that throws marks the plugin `failed`, and a lyrics server being down
for a minute is not a broken plugin.
