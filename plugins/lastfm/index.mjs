import { createHash } from 'node:crypto'

/**
 * Last.fm scrobbling.
 *
 * The same shape as the ListenBrainz plugin — watch `play`, queue, submit —
 * with one genuine difference, and it is the reason this took a second plugin
 * rather than a second URL: **every authenticated call is signed**.
 *
 * The signature is an MD5 of the parameters, sorted by name, concatenated as
 * `nameValue` with no separators at all, with the shared secret glued on the
 * end. Three things about that are easy to get wrong and all of them produce
 * the same unhelpful error:
 *
 *   - `format=json` and `api_sig` itself are **not** part of the signature.
 *   - The sort is over the parameter *names*, byte-wise, not the order they
 *     were written in.
 *   - It is the raw UTF-8 bytes that are hashed, not the URL-encoded form, so
 *     a track called "Café" signs differently if you encode first.
 *
 * Get any of those wrong and Last.fm answers "Invalid method signature
 * supplied", which says nothing about which part was wrong. Hence the test.
 */

const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/'
const MAX_QUEUE = 500

/**
 * The signature, and the only interesting function in this file.
 *
 * Exported so the tests can check it against Last.fm's own worked example
 * rather than against itself.
 */
export function sign(params, secret) {
  const signable = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'api_sig')
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('')
  return createHash('md5').update(`${signable}${secret}`, 'utf8').digest('hex')
}

export function activate(host) {
  const cfg = () => ({
    apiKey: host.config.apiKey,
    apiSecret: host.config.apiSecret,
    sessionKey: host.config.sessionKey,
  })

  const pending = []
  let sending = false

  /** A signed POST. Unsigned calls exist in this API but none of ours are. */
  const call = async (method, params) => {
    const { apiKey, apiSecret, sessionKey } = cfg()
    const body = { method, api_key: apiKey, sk: sessionKey, ...params }
    const signed = { ...body, api_sig: sign(body, apiSecret), format: 'json' }

    const res = await host.net.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(signed).toString(),
    })

    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = null }

    if (!res.ok || json?.error) {
      // Last.fm's own error numbers, because the difference matters: 9 means
      // the session is dead and no amount of retrying will fix it, where 16 is
      // "try again in a minute".
      const code = json?.error
      const permanent = code === 4 || code === 6 || code === 9 || code === 10 || code === 13 || code === 26
      throw Object.assign(
        new Error(json?.message ?? `Last.fm answered ${res.status}`),
        { permanent, code },
      )
    }
    return json
  }

  /**
   * Exchanges a username and password for a session key, once.
   *
   * Offered because the alternative is the browser dance, and a self-hosted
   * server with no public URL cannot receive the callback. The password is used
   * here and never stored — the session key it returns is what gets kept, and
   * it can be revoked from Last.fm without changing the password.
   */
  const authenticate = async (username, password) => {
    const { apiKey, apiSecret } = cfg()
    const params = { method: 'auth.getMobileSession', api_key: apiKey, username, password }
    const res = await host.net.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, api_sig: sign(params, apiSecret), format: 'json' }).toString(),
    })
    const json = await res.json().catch(() => null)
    if (!json?.session?.key) throw new Error(json?.message ?? 'Last.fm refused those credentials')

    host.setConfig({ ...host.config, sessionKey: json.session.key, username: json.session.name })
    return json.session.name
  }

  const flush = async () => {
    const { apiKey, apiSecret, sessionKey } = cfg()
    if (sending || !pending.length || !apiKey || !apiSecret || !sessionKey) return
    sending = true
    try {
      // Up to fifty per request, indexed by position -- `artist[0]`,
      // `artist[1]` -- which is how this API takes a batch.
      const batch = pending.slice(0, 50)
      const params = {}
      batch.forEach((s, i) => {
        params[`artist[${i}]`] = s.artist
        params[`track[${i}]`] = s.track
        params[`timestamp[${i}]`] = String(s.timestamp)
        if (s.album) params[`album[${i}]`] = s.album
        if (s.duration) params[`duration[${i}]`] = String(s.duration)
      })

      await call('track.scrobble', params)
      pending.splice(0, batch.length)
      if (pending.length) host.log(`${pending.length} scrobbles still queued`)
    } catch (err) {
      if (err.permanent) {
        host.log(`dropping ${pending.length} scrobbles: ${err.message}`)
        pending.length = 0
      } else {
        host.log(`will retry: ${err.message}`)
      }
    } finally {
      sending = false
    }
  }

  host.on('play', (e) => {
    if (!e.artist || !e.name) return
    pending.push({
      artist: e.artist,
      track: e.name,
      album: e.album || undefined,
      duration: e.duration || undefined,
      // Seconds, and the moment the track *started*, which is what Last.fm
      // orders a listening history by.
      timestamp: Math.floor((e.startedAt ?? Date.now()) / 1000),
    })
    // The oldest go first: a queue that grew while the network was down should
    // lose its stalest entries, not its newest.
    if (pending.length > MAX_QUEUE) pending.splice(0, pending.length - MAX_QUEUE)
    void flush()
  })

  // A retry that is not tied to listening: a queue stuck behind a dead network
  // would otherwise wait for the next song, which on a quiet evening is hours.
  const timer = host.net.setInterval(() => void flush(), 60_000)

  host.registerCommand('connect', async () => {
    const { username, password } = host.config
    if (!username || !password) {
      return { kind: 'text', title: 'Last.fm', body: 'Set a username and password first, then run this once. The password is exchanged for a session key and not stored.' }
    }
    try {
      const name = await authenticate(username, password)
      // Cleared immediately: the session key is what authenticates from now on,
      // and keeping the password beside it buys nothing and risks everything.
      host.setConfig({ ...host.config, password: '' })
      return { kind: 'text', title: 'Last.fm', body: `Connected as ${name}. The password has been cleared; the session key is what is used from here.` }
    } catch (err) {
      return { kind: 'text', title: 'Last.fm', body: err.message }
    }
  })

  host.registerCommand('flush', async () => {
    const before = pending.length
    await flush()
    return { kind: 'done', message: before ? `${before - pending.length} of ${before} sent` : 'nothing queued' }
  })

  return () => host.net.clearInterval(timer)
}

export function deactivate() {
  // The teardown returned by activate is what runs; the host clears the timer
  // either way.
}
