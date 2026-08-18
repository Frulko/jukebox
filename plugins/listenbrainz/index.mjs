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

  // Waiting up to a minute for the retry is fine for a background queue and
  // maddening when you are looking at it, so it is also a command.
  host.registerCommand('flush', async () => {
    if (!cfg().token) return { kind: 'done', message: 'No ListenBrainz token is set.' }
    if (!pending.length) return { kind: 'done', message: 'Nothing waiting to send.' }

    const waiting = pending.length
    await flush()
    return {
      kind: 'done',
      message: pending.length
        ? `${waiting - pending.length} sent, ${pending.length} still waiting.`
        : `${waiting} listens sent.`,
    }
  })

  // The health check: is the token actually accepted by the configured server.
  // ListenBrainz has an endpoint for exactly this question, so the answer is
  // theirs, not a guess from a status code.
  host.registerCommand('check', async () => {
    const { url, token } = cfg()
    if (!token) return { kind: 'check', ok: false, message: 'No user token is set.' }
    let res
    try {
      res = await host.net.fetch(`${url}/1/validate-token`, {
        headers: { authorization: `Token ${token}` },
      })
    } catch (err) {
      return { kind: 'check', ok: false, message: `Could not reach ${url} — ${err.message}` }
    }
    if (!res.ok) return { kind: 'check', ok: false, message: `${url} answered ${res.status}.` }
    const body = await res.json().catch(() => null)
    return body?.valid
      ? { kind: 'check', ok: true, message: `Token accepted — listens go to ${body.user_name}.` }
      : { kind: 'check', ok: false, message: 'ListenBrainz says that token is not valid.' }
  })

  /**
   * What the rest of ListenBrainz is listening to.
   *
   * The one recommender this plugin can honestly offer: sitewide statistics are
   * public, so it works before anybody has set a token, and it asks nothing
   * about the person reading. Personal recommendations need a user name and a
   * different set of endpoints; when this plugin knows one it can add a second
   * source rather than making this one quietly personal.
   *
   * Artists rather than tracks, because that is what the sitewide endpoint
   * ranks — and naming an artist you might not have is exactly what a
   * suggestion is for.
   */
  host.registerCommand('trending', async () => {
    const { url } = cfg()
    const res = await host.net.fetch(`${url}/1/stats/sitewide/artists?count=20&range=week`)
    if (res.status === 204) {
      // A real answer, not an error: the range has not been computed yet.
      return { kind: 'done', message: 'ListenBrainz has not published this week’s figures yet.' }
    }
    if (!res.ok) throw new Error(`ListenBrainz answered ${res.status}`)

    const body = await res.json()
    const rows = body?.payload?.artists ?? []

    // The same artist appears twice when MusicBrainz holds two ids for them —
    // the real answer this morning had BTS at both first and third place. The
    // list is a ranking, so the first entry is the one that means something and
    // the rest are the same name saying it again; the counts are not added,
    // because a number nobody published is not a number.
    const seen = new Set()
    const items = []
    for (const a of rows) {
      const name = a.artist_name
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      items.push({
        name,
        artist: name,
        why: a.listen_count ? `${a.listen_count.toLocaleString('en-US')} listens this week` : undefined,
      })
    }
    return { kind: 'suggestions', title: 'Most listened to this week, everywhere', items }
  })

  host.log(cfg().token ? 'ready' : 'waiting for a user token')
}

export function deactivate() {
  // Nothing to do: the listener and the timer both belong to the host, and it
  // has already taken them back by the time this runs.
}
