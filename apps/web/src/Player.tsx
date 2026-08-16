import { useEffect, useState } from 'react'
import type { Job } from '@jukebox/client-sdk'
import { fmtTime, type Track } from './data'
import { Icon } from './Icon'
import { albumSeed, Cover } from './Artwork'

export type Repeat = 'off' | 'all' | 'one'

/** What a job is called while it runs, in the display's own voice. */
const JOB_LABEL: Record<string, string> = {
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
}

export function Player({
  track,
  playing,
  position,
  duration,
  shuffle,
  repeat,
  volume,
  search,
  browserOpen,
  jobs,
  onToggle,
  onPrev,
  onNext,
  onSeek,
  onVolume,
  onShuffle,
  onRepeat,
  onSearch,
  onToggleBrowser,
}: {
  track: Track | null
  playing: boolean
  position: number
  /** The decoder's duration, which beats the tag's on a VBR file whose header lies. */
  duration: number
  shuffle: boolean
  repeat: Repeat
  volume: number
  search: string
  browserOpen: boolean
  /** Everything else the server is doing. The display cycles through them. */
  jobs: Job[]
  onToggle: () => void
  onPrev: () => void
  onNext: () => void
  onSeek: (s: number) => void
  onVolume: (v: number) => void
  onShuffle: () => void
  onRepeat: () => void
  onSearch: (s: string) => void
  onToggleBrowser: () => void
}) {
  // Fall back to the tag only until the decoder has read the file.
  const total = duration || track?.duration || 0
  const pct = total ? (position / total) * 100 : 0

  // The display holds one thing at a time and there is often more than one
  // thing: a track playing and a scan running are both "in progress". iTunes
  // solved this by making the panel cycle, and it is still the right answer —
  // a second panel would take space from a window that has none to give.
  // Silence is not a task: with nothing playing the panel goes straight to the
  // scan, and the cycle button only appears when there is somewhere to cycle to.
  const tasks: Array<{ key: string; job?: Job }> = [
    ...(track ? [{ key: 'now-playing' }] : []),
    ...jobs.map((j) => ({ key: j.id, job: j })),
  ]
  const [at, setAt] = useState(0)
  // A job that finishes takes its slot with it; falling back to what is playing
  // beats leaving the panel on a task that no longer exists.
  useEffect(() => {
    if (at >= tasks.length) setAt(0)
  }, [at, tasks.length])
  const shown = tasks[Math.min(at, tasks.length - 1)]
  const job = shown?.job
  const done = job ? (job.progress.total ? (job.progress.done / job.progress.total) * 100 : 0) : 0

  return (
    <div className="topbar">
      <div className="transport">
        <button onClick={onPrev} title="Previous">
          <Icon name="prev" size={13} />
        </button>
        <button className="play" onClick={onToggle} title="Play/Pause">
          <Icon name={playing ? 'pause' : 'play'} size={15} />
        </button>
        <button onClick={onNext} title="Next">
          <Icon name="next" size={13} />
        </button>
        <div className="volume">
          <Icon name="volumeLow" size={10} className="spk" />
          <input type="range" min={0} max={100} value={volume} onChange={(e) => onVolume(Number(e.target.value))} />
          <Icon name="volumeHigh" size={13} className="spk" />
        </div>
      </div>

      <div className={`lcd ${job ? 'job' : track ? '' : 'idle'}`}>
        {job ? (
          <>
            <div className="lcd-main">
              <div className="lcd-title">
                {JOB_LABEL[job.kind] ?? job.kind}
                {job.state === 'paused' && ' — paused'}
              </div>
              <div className="lcd-sub">
                {job.progress.total
                  ? `${job.progress.done.toLocaleString('en-US')} of ${job.progress.total.toLocaleString('en-US')}`
                  : `${job.progress.done.toLocaleString('en-US')} so far`}
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
              <div className="lcd-title">{track.name}</div>
              <div className="lcd-sub">
                {track.artist} — {track.album}
              </div>
              <div className="lcd-scrub">
                <span className="t">{fmtTime(position)}</span>
                <div
                  className="track"
                  onMouseDown={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    onSeek(((e.clientX - r.left) / r.width) * total)
                  }}
                >
                  <div className="fill" style={{ width: `${pct}%` }} />
                  <div className="knob" style={{ left: `${pct}%` }} />
                </div>
                <span className="t r">-{fmtTime(Math.max(0, total - position))}</span>
              </div>
            </div>
            <button className="lcd-eye" title="Cover art">
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
        <button className={shuffle ? 'on' : ''} onClick={onShuffle} title="Shuffle">
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
        <button className={browserOpen ? 'on' : ''} onClick={onToggleBrowser} title="Column Browser">
          <Icon name="columns" size={13} />
        </button>
        <div className="search">
          <Icon name="search" size={10} />
          <input value={search} placeholder="Search" onChange={(e) => onSearch(e.target.value)} />
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
