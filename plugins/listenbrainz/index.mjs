/**
 * ListenBrainz scrobbling.
 *
 * The first real plugin, and deliberately a small one: its job is to prove the
 * host contract carries an actual integration end to end — settings, an event
 * subscription, network through the host, and a clean stop.
 *
 * ListenBrainz rather than Last.fm first because its API is a token and a JSON
 * body, where Last.fm needs an API key, a secret and an MD5-signed parameter
 * dance. Same shape either way; this one fits in a file you can read.
 *
 * The queue is the part worth having. A listen submitted while the network is
 * down is not lost: it waits, and goes out with the next one. Anyone who has
 * lost a week of scrobbles to a flaky connection knows why.
 */

const MAX_QUEUE = 500

export function activate(host) {
  const cfg = () => ({
    url: (host.config.url || 'https://api.listenbrainz.org').replace(/\/$/, ''),
    token: host.config.token,
  })

  /** Listens that have not been accepted yet. Oldest first. */
  const pending = []
  let sending = false

  const submit = async (listens) => {
    const { url, token } = cfg()
    const res = await host.net.fetch(`${url}/1/submit-listens`, {
      method: 'POST',
      headers: { authorization: `Token ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ listen_type: listens.length > 1 ? 'import' : 'single', payload: listens }),
    })
    if (!res.ok) {
      // 4xx means this listen will never be accepted -- a bad token, a
      // malformed body. Retrying it for ever would block everything behind it.
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429
      throw Object.assign(new Error(`ListenBrainz answered ${res.status}`), { permanent })
    }
  }

  const flush = async () => {
    if (sending || !pending.length || !cfg().token) return
    sending = true
    try {
      // Submitted as one batch: fifty listens after a plane journey should be
      // one request, not fifty.
      const batch = pending.slice(0, 50)
      await submit(batch)
      pending.splice(0, batch.length)
      if (pending.length) host.log(`${pending.length} listens still queued`)
    } catch (err) {
      if (err.permanent) {
        host.log(`dropping ${pending.length} listens: ${err.message}`)
        pending.length = 0
      } else {
        host.log(`will retry: ${err.message}`)
      }
    } finally {
      sending = false
    }
  }

  host.on('play', (e) => {
    if (!cfg().token) return // configured off; nothing to queue for later either

    pending.push({
      listened_at: Math.floor(e.startedAt / 1000),
      track_metadata: {
        artist_name: e.track.artist || e.track.albumArtist,
        track_name: e.track.name,
        release_name: e.track.album || undefined,
        additional_info: {
          duration: e.track.duration || undefined,
          tracknumber: e.track.trackNumber || undefined,
          media_player: 'jukebox',
          submission_client: 'jukebox listenbrainz plugin',
        },
      },
    })

    // Bounded: an unreachable server for a month must not grow without limit.
    // The oldest go, because the newest are the ones still worth having.
    if (pending.length > MAX_QUEUE) pending.splice(0, pending.length - MAX_QUEUE)
    void flush()
  })

  // Retry loop for what the network refused. Through the host, so it stops when
  // the plugin does.
  host.net.setInterval(() => void flush(), 60_000)

  host.log(cfg().token ? 'ready' : 'waiting for a user token')
}

export function deactivate() {
  // Nothing to do: the listener and the timer both belong to the host, and it
  // has already taken them back by the time this runs.
}
