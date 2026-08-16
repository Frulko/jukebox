/**
 * Lyrics, in a tab the plugin asks for and the host draws.
 *
 * The second shipped plugin, and it exercises the half of the contract the
 * first one does not: contributing a *place* rather than an action, and
 * answering with something to read. It renders nothing itself — it returns
 * text, and the interface decides what that looks like.
 *
 * LRCLIB because it needs no account, no key and no signature: the plugin is
 * meant to be readable end to end, and a page of OAuth would bury the one
 * thing it is here to demonstrate.
 */

export function activate(host) {
  const cfg = () => ({
    url: (host.config.url || 'https://lrclib.net').replace(/\/$/, ''),
    synced: Boolean(host.config.synced),
  })

  host.registerCommand('words', async ({ tracks }) => {
    const t = tracks[0]
    if (!t) return { kind: 'text', body: 'No track.' }

    const q = new URLSearchParams({
      artist_name: t.artist || t.albumArtist,
      track_name: t.name,
    })
    // Both narrow the match, and both are wrong often enough to be worth
    // omitting when empty rather than sending a blank that matches nothing.
    if (t.album) q.set('album_name', t.album)
    if (t.duration) q.set('duration', String(Math.round(t.duration)))

    let res
    try {
      res = await host.net.fetch(`${cfg().url}/api/get?${q}`, {
        headers: { 'user-agent': 'jukebox lyrics plugin' },
      })
    } catch (err) {
      // Not thrown: a command that throws marks the plugin failed, and a lyrics
      // server being down for a minute is not a broken plugin. The tab says so
      // and the next track can try again.
      return { kind: 'text', body: `Could not reach ${cfg().url} — ${err.message}` }
    }

    if (res.status === 404) {
      return { kind: 'text', body: `No lyrics found for “${t.name}” by ${t.artist || t.albumArtist}.` }
    }
    if (!res.ok) return { kind: 'text', body: `LRCLIB answered ${res.status}.` }

    const found = await res.json()
    if (found.instrumental) return { kind: 'text', title: t.name, body: 'Instrumental.' }

    const body = (cfg().synced ? found.syncedLyrics || found.plainLyrics : found.plainLyrics) || ''
    if (!body.trim()) {
      // The entry exists but carries no words: a different answer from "no
      // entry", and worth saying so rather than showing an empty tab.
      return { kind: 'text', body: `LRCLIB knows “${found.trackName}” but holds no words for it.` }
    }

    return { kind: 'text', title: `${found.trackName} — ${found.artistName}`, body }
  })

  host.log('ready')
}

export function deactivate() {
  // Nothing kept: no queue, no timer, and the fetch belongs to the host.
}
