import { fmtTime, type Track } from './data'
import { Icon } from './Icon'
import { albumSeed, Cover } from './Artwork'

export type Repeat = 'off' | 'all' | 'one'

export function Player({
  track,
  playing,
  position,
  shuffle,
  repeat,
  volume,
  search,
  browserOpen,
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
  shuffle: boolean
  repeat: Repeat
  volume: number
  search: string
  browserOpen: boolean
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
  const pct = track ? (position / track.duration) * 100 : 0

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

      <div className={`lcd ${track ? '' : 'idle'}`}>
        {track ? (
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
                    onSeek(((e.clientX - r.left) / r.width) * track.duration)
                  }}
                >
                  <div className="fill" style={{ width: `${pct}%` }} />
                  <div className="knob" style={{ left: `${pct}%` }} />
                </div>
                <span className="t r">-{fmtTime(Math.max(0, track.duration - position))}</span>
              </div>
            </div>
            <button className="lcd-eye" title="Cover art">
              <Icon name="columns" size={11} />
            </button>
          </>
        ) : (
          <span className="lcd-idle-label">iTunes</span>
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
