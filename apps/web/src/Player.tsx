import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Job, JobKind, PlayerState } from '@jukebox/client-sdk'
import { useAudioTime, type Audio } from './audio'
import { useJobs } from './api'
import { num, t, useLocale } from './i18n'
import { fmtBytes } from './media'
import { OutputPicker } from './Outputs'
import { fmtTime, type Track } from './data'
import { Icon } from './Icon'
import { Cover } from './Artwork'
import { albumSeed } from './albumSeed'

export type Repeat = 'off' | 'all' | 'one'

/**
 * A title that scrolls only if it has to.
 *
 * The panel is 420 px wide and track names are not. Ellipsis loses the end of
 * the name, which is exactly where "(Live at Montreux)" and "feat. …" live —
 * the part that distinguishes two rows that otherwise read the same.
 *
 * It moves back and forth rather than looping around: a title that wraps from
 * its end to its start reads as two different titles for a moment. The speed is
 * per pixel of overflow, so a slightly long name creeps and a very long one
 * does not take a minute to get to its end.
 */
function Marquee({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setOverflow(Math.max(0, el.scrollWidth - el.clientWidth))
    measure()
    // The panel is not a fixed width: it shrinks with the window and with the
    // theme. A title measured once would keep scrolling after it started
    // fitting, or sit still after it stopped.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])

  const scrolls = overflow > 2
  // SAFETY: `--shift` and `--dur` are custom properties the marquee keyframes
  // read. React.CSSProperties is closed over the standard names, but a `--*`
  // declaration is valid CSS on any element.
  const slide = scrolls
    ? ({ '--shift': `${-overflow}px`, '--dur': `${Math.max(5, overflow / 18)}s` } as React.CSSProperties)
    : undefined
  return (
    <div
      ref={ref}
      className={`${className} ${scrolls ? 'marquee' : ''}`}
      // Not a tooltip: the whole text is the point, and it is already here.
      title={scrolls ? text : undefined}
      style={slide}
    >
      <span>{text}</span>
    </div>
  )
}

/** Where a search applies. Not a filter over one list — a different list. */
const SCOPES: Array<[string, string]> = [
  ['music', 'Music'],
  ['podcasts', 'Podcasts'],
  ['audiobooks', 'Audiobooks'],
  ['apps', 'Apps'],
  ['radio', 'Radio'],
]

/** What a job is called while it runs, in the display's own voice. */
const JOB_LABEL = {
  scan: 'Scanning',
  transcode: 'Converting',
  fingerprint: 'Fingerprinting',
  podcast: 'Refreshing podcasts',
  writeback: 'Writing tags',
  sync: 'Syncing',
  acquire: 'Downloading',
  analyze: 'Analysing',
  relay: 'Relaying',
  move: 'Moving files',
  backup: 'Backing up',
  download: 'Downloading',
} satisfies Record<JobKind, string>

/** Kinds whose done/total are bytes of a file, not items of a list. */
const BYTE_KINDS = new Set<JobKind>(['download'])

export type Upload = { id: string; label: string; done: number; total: number }

export function Player({
  track,
  playing,
  audio,
  uploads,
  shuffle,
  repeat,
  volume,
  target,
  onTarget,
  search,
  scope,
  browserOpen,
  queueLength,
  queueOpen,
  artOpen,
  onToggleQueue,
  onToggleArt,
  onToggle,
  onPrev,
  onNext,
  onSeek,
  onVolume,
  onShuffle,
  onRepeat,
  onSearch,
  onScope,
  onToggleBrowser,
}: {
  track: Track | null
  playing: boolean
  /** Files on their way to the server — the app's own work, so not in `jobs`. */
  uploads: Upload[]
  /**
   * The element, for the two things only this bar draws: where the track is and
   * how long it is. Subscribed here rather than passed down as numbers, so a
   * `timeupdate` four times a second re-renders this bar and nothing else —
   * it used to re-render the entire application, tooltips included.
   */
  audio: Audio
  shuffle: boolean
  repeat: Repeat
  volume: number
  /** Where the music comes out. `local` is this tab. */
  target: PlayerState['target']
  onTarget: (target: PlayerState['target']) => void
  search: string
  /** The source the search applies to — one of the library's five. */
  scope: string
  browserOpen: boolean
  /** Everything else the server is doing. The display cycles through them. */

  queueLength: number
  queueOpen: boolean
  artOpen: boolean
  onToggleQueue: () => void
  onToggleArt: () => void
  onToggle: () => void
  onPrev: () => void
  onNext: () => void
  onSeek: (s: number) => void
  onVolume: (v: number) => void
  onShuffle: () => void
  onRepeat: () => void
  onSearch: (s: string) => void
  onScope: (id: string) => void
  onToggleBrowser: () => void
}) {
  // Fall back to the tag only until the decoder has read the file.
  // The decoder's duration beats the tag's on a VBR file whose header lies.
  useLocale()
  const { position, duration } = useAudioTime(audio)
  // Only what is still moving: a finished scan is history, and this display is
  // for what is happening now. Asked here because this is the only thing that
  // shows it — in the app's own state it re-rendered every list on every tick.
  const jobs = (useJobs().data?.items ?? []).filter(
    (j) => j.state === 'running' || j.state === 'queued' || j.state === 'paused')
  // Zero when there is no length to speak of — which is what a radio stream
  // is: the element reports `Infinity`, and a progress bar over an infinity is
  // a bar that never moves and a countdown that never means anything.
  const total = (Number.isFinite(duration) ? duration : 0) || track?.duration || 0
  const pct = total ? (position / total) * 100 : 0

  // The display holds one thing at a time and there is often more than one
  // thing: a track playing and a scan running are both "in progress". iTunes
  // solved this by making the panel cycle, and it is still the right answer —
  // a second panel would take space from a window that has none to give.
  // Silence is not a task: with nothing playing the panel goes straight to the
  // scan, and the cycle button only appears when there is somewhere to cycle to.
  const tasks: Array<{ key: string; job?: Job; upload?: Upload }> = [
    ...(track ? [{ key: 'now-playing' }] : []),
    ...jobs.map((j) => ({ key: j.id, job: j })),
    ...uploads.map((u) => ({ key: u.id, upload: u })),
  ]
  const [at, setAt] = useState(0)
  const [scopeOpen, setScopeOpen] = useState(false)
  // A job that finishes takes its slot with it; falling back to what is playing
  // beats leaving the panel on a task that no longer exists.
  useEffect(() => {
    if (at >= tasks.length) setAt(0)
  }, [at, tasks.length])
  const shown = tasks[Math.min(at, tasks.length - 1)]
  const job = shown?.job
  const upload = shown?.upload
  const done = job ? (job.progress.total ? (job.progress.done / job.progress.total) * 100 : 0) : 0

  return (
    <div className="topbar">
      <div className="transport">
        <button onClick={onPrev} title={t('Previous')}>
          <Icon name="prev" size={13} />
        </button>
        <button className="play" onClick={onToggle} title={t('Play/Pause')}>
          <Icon name={playing ? 'pause' : 'play'} size={15} />
        </button>
        <button onClick={onNext} title={t('Next')}>
          <Icon name="next" size={13} />
        </button>
        <div className="volume">
          <Icon name="volumeLow" size={10} className="spk" />
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            // AirPlay's volume is not on the interface this server speaks, so
            // the control says so instead of moving to no effect.
            // A speaker whose volume this server cannot reach — AirPlay keeps
            // it in RTSP — is told about by the picker, which knows the
            // capability; here the slider simply drives whatever is playing.
            title={target.kind === 'output' ? `${t('Volume on')} ${target.name}` : undefined}
            onChange={(e) => onVolume(Number(e.target.value))}
          />
          <Icon name="volumeHigh" size={13} className="spk" />
        </div>
        <OutputPicker target={target} onChoose={onTarget} />
      </div>

      <div className={`lcd ${job || upload ? 'job' : track ? '' : 'idle'}`}>
        {upload ? (
          <div className="lcd-main">
            <Marquee className="lcd-title" text={upload.label} />
            <div className="lcd-sub">
              {t('Uploading')} · {t('{done} of {total}', { done: fmtBytes(upload.done), total: fmtBytes(upload.total) })}
            </div>
            <div className="lcd-scrub">
              <div className="track">
                <div className="fill" style={{ width: `${upload.total ? (upload.done / upload.total) * 100 : 0}%` }} />
              </div>
            </div>
          </div>
        ) : job ? (
          <>
            <div className="lcd-main">
              {/* A job that says what it is about — an episode title — gets the
                  title line, and the verb steps down beside the numbers. */}
              {job.label ? (
                <Marquee className="lcd-title" text={job.label} />
              ) : (
                <div className="lcd-title">
                  {t(JOB_LABEL[job.kind])}
                  {job.state === 'paused' && ' — paused'}
                </div>
              )}
              <div className="lcd-sub">
                {job.label ? `${t(JOB_LABEL[job.kind])}${job.state === 'paused' ? ' — paused' : ''} · ` : ''}
                {(() => {
                  // Bytes read as sizes, items read as counts: "12.4 MB of
                  // 52.9 MB" and "3 of 345" are different sentences.
                  const show = (n: number) => (BYTE_KINDS.has(job.kind) ? fmtBytes(n) : num(n))
                  return job.progress.total
                    ? t('{done} of {total}', { done: show(job.progress.done), total: show(job.progress.total) })
                    : t('{done} so far', { done: show(job.progress.done) })
                })()}
                {job.error ? ` · ${job.error}` : ''}
              </div>
              <div className="lcd-scrub">
                <div className="track">
                  <div className="fill" style={{ width: `${done}%` }} />
                </div>
              </div>
            </div>
          </>
        ) : track ? (
          <>
            <Cover seed={albumSeed(track)} size={34} className="lcd-art" />
            <div className="lcd-main">
              <Marquee className="lcd-title" text={track.name} />
              <div className="lcd-sub">
                {track.artist} — {track.album}
              </div>
              {/* On a speaker there is no position to show. A UPnP renderer or
                  an AirPlay receiver is not asked where it got to — only a
                  satellite reports back — so a scrubber here would sit frozen
                  at 0:00 while the music plays perfectly well in the next room.
                  It says where instead, which is the true answer. */}
              {target.kind === 'output' ? (
                <div className="lcd-scrub remote">
                  <Icon name="radio" size={10} />
                  <span>{t('Playing on')} <b>{target.name}</b></span>
                </div>
              ) : (
              <div className="lcd-scrub">
                <span className="t">{fmtTime(position)}</span>
                <div
                  className={`track ${total ? '' : 'live'}`}
                  onMouseDown={(e) => {
                    if (!total) return
                    const r = e.currentTarget.getBoundingClientRect()
                    onSeek(((e.clientX - r.left) / r.width) * total)
                  }}
                >
                  <div className="fill" style={{ width: `${pct}%` }} />
                  {total > 0 && <div className="knob" style={{ left: `${pct}%` }} />}
                </div>
                {/* Nothing rather than a countdown: a station has no end, and
                    the honest answer to "how long is left" is silence. */}
                <span className="t r">{total ? `-${fmtTime(Math.max(0, total - position))}` : t('live')}</span>
              </div>
              )}
            </div>
            <button
              className={`lcd-eye ${artOpen ? 'on' : ''}`}
              title={artOpen ? 'Hide the cover' : 'Show the cover and the files behind this track'}
              onClick={onToggleArt}
            >
              <Icon name="columns" size={11} />
            </button>
          </>
        ) : (
          <span className="lcd-idle-label">iTunes</span>
        )}
        {tasks.length > 1 && (
          <button
            className="lcd-next"
            title={`${tasks.length} things in progress — click to cycle`}
            onClick={(e) => {
              e.stopPropagation()
              setAt((i) => (i + 1) % tasks.length)
            }}
          >
            <Icon name="sync" size={10} />
            <em>{tasks.length}</em>
          </button>
        )}
      </div>

      <div className="right-tools">
        <button className={shuffle ? 'on' : ''} onClick={onShuffle} title={t('Shuffle')}>
          <Icon name="shuffle" size={13} />
        </button>
        <button
          className={`repeat ${repeat !== 'off' ? 'on' : ''}`}
          onClick={onRepeat}
          title={`Repeat: ${repeat}`}
        >
          <Icon name="repeat" size={13} />
          {repeat === 'one' && <em>1</em>}
        </button>
        <button className={browserOpen ? 'on' : ''} onClick={onToggleBrowser} title={t('Column Browser')}>
          <Icon name="columns" size={13} />
        </button>
        <button
          className={queueOpen ? 'on' : ''}
          onClick={onToggleQueue}
          title={queueLength ? t('{n} in the queue', { n: queueLength }) : t('The queue')}
        >
          <Icon name="queue" size={13} />
        </button>
        <div className="search">
          <button
            className="scope"
            title={`Searching ${SCOPES.find(([id]) => id === scope)?.[1] ?? 'Music'} — click to change`}
            onClick={() => setScopeOpen((v) => !v)}
          >
            <Icon name="search" size={10} />
            <span className="tri" />
          </button>
          {scopeOpen && (
            <div className="scope-menu" onMouseLeave={() => setScopeOpen(false)}>
              {SCOPES.map(([id, label]) => (
                <button
                  key={id}
                  className={id === scope ? 'on' : ''}
                  onClick={() => {
                    onScope(id)
                    setScopeOpen(false)
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <input value={search} placeholder={t('Search')} onChange={(e) => onSearch(e.target.value)} />
          {search && (
            <button className="clear" onClick={() => onSearch('')} title="Clear">
              <Icon name="close" size={9} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
