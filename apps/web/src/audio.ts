import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Real playback.
 *
 * Until now the position advanced on a `setInterval`, which looks right and is
 * a lie: it drifts from the audio it claims to describe, and nothing comes out
 * of the speakers. This drives one `<audio>` element instead and reads the time
 * back from it, so the scrubber shows where the sound actually is.
 *
 * The element is created once and kept for the life of the app rather than
 * mounted per track. Swapping `src` on a live element is what lets a browser
 * reuse its connection and its decoder; a fresh element per track drops both,
 * and on Safari it also loses the user-gesture permission that allowed playback
 * in the first place.
 */

export const streamUrl = (base: string, id: string) => `${base}/stream/${id}`

export type Audio = {
  /**
   * Whether the element is playing — read from its own `play`/`pause` events,
   * never assumed. `play()` can be refused (autoplay policy, a codec the
   * browser will not decode), and a button that says "playing" over silence is
   * worse than one that admits nothing happened.
   */
  playing: boolean
  position: number
  duration: number
  /** Non-null when the browser refused the file — a codec it cannot decode, usually. */
  error: string | null
  play: (id: string) => void
  resume: () => void
  pause: () => void
  seek: (seconds: number) => void
}

export function useAudio({
  base,
  volume,
  onEnded,
  onPlayed,
}: {
  base: string
  /** 0–100, as the UI slider reports it. */
  volume: number
  onEnded: () => void
  /**
   * How long a track was actually listened to, once it ends or is replaced.
   *
   * Seconds listened, not the position reached: seeking forward through a song
   * is not listening to it, and the server's counting rule would be wrong from
   * the first argument if we sent `currentTime`.
   */
  onPlayed: (id: string, seconds: number, startedAt: number) => void
}): Audio {
  const el = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // `onEnded` closes over the queue, which changes on every view; keeping it in
  // a ref means the listener is attached once instead of being torn down and
  // rebuilt on each render -- and a listener rebuilt mid-track can miss the
  // `ended` event entirely, which is how a queue stops after one song.
  const ended = useRef(onEnded)
  ended.current = onEnded
  const played = useRef(onPlayed)
  played.current = onPlayed

  // What is on the element right now, and how much of it has gone past the
  // speakers. `last` is the previous `timeupdate` position, which is how a seek
  // is told apart from listening: a jump is not time spent.
  const current = useRef<{ id: string; listened: number; startedAt: number; last: number } | null>(null)

  const report = useCallback(() => {
    const c = current.current
    current.current = null
    // Under a second is a mis-click, and the server would refuse it anyway.
    if (c && c.listened >= 1) played.current(c.id, Math.round(c.listened), c.startedAt)
  }, [])

  if (el.current === null && typeof Audio !== 'undefined') {
    el.current = new Audio()
    el.current.preload = 'metadata'
    // In the document, not detached: it costs nothing, and an element the page
    // can see is one the browser lists in its media controls and that anything
    // debugging playback can actually find.
    el.current.setAttribute('data-jukebox', 'player')
    document.body.appendChild(el.current)
  }

  useEffect(() => {
    const a = el.current
    if (!a) return
    const time = () => {
      const c = current.current
      if (c) {
        const step = a.currentTime - c.last
        // A normal tick is a quarter second. Anything larger is a seek, and
        // anything negative is a seek backwards; neither is listening.
        if (step > 0 && step < 2) c.listened += step
        c.last = a.currentTime
      }
      setPosition(a.currentTime)
    }
    const meta = () => setDuration(a.duration || 0)
    const done = () => {
      report()
      ended.current()
    }
    // The tag's duration is what the list shows; the decoder's is the truth, and
    // they disagree on VBR files whose header lies.
    const fail = () => { setError('This file could not be played'); setPlaying(false) }
    const started = () => setPlaying(true)
    const stopped = () => setPlaying(false)
    a.addEventListener('play', started)
    a.addEventListener('pause', stopped)
    a.addEventListener('timeupdate', time)
    a.addEventListener('loadedmetadata', meta)
    a.addEventListener('ended', done)
    a.addEventListener('error', fail)
    return () => {
      a.removeEventListener('play', started)
      a.removeEventListener('pause', stopped)
      a.removeEventListener('timeupdate', time)
      a.removeEventListener('loadedmetadata', meta)
      a.removeEventListener('ended', done)
      a.removeEventListener('error', fail)
    }
  }, [report])

  useEffect(() => {
    if (el.current) el.current.volume = Math.min(1, Math.max(0, volume / 100))
  }, [volume])

  const play = useCallback((id: string) => {
    const a = el.current
    if (!a) return
    // Whatever was playing is over as far as counting goes, however far it got.
    report()
    current.current = { id, listened: 0, startedAt: Date.now(), last: 0 }
    setError(null)
    setPosition(0)
    a.src = streamUrl(base, id)
    // A rejected play() is normal: autoplay policy before any user gesture, or
    // a track replaced while it was still loading. Neither deserves an error in
    // the UI, and an unhandled rejection here would be noise in the console.
    void a.play().catch(() => {})
  }, [base, report])

  const resume = useCallback(() => { void el.current?.play().catch(() => {}) }, [])
  const pause = useCallback(() => el.current?.pause(), [])

  const seek = useCallback((seconds: number) => {
    const a = el.current
    if (!a) return
    a.currentTime = seconds
    // Update immediately rather than waiting for `timeupdate`: the scrubber has
    // to follow the pointer, not lag a quarter second behind it.
    setPosition(seconds)
  }, [])

  return { playing, position, duration, error, play, resume, pause, seek }
}
