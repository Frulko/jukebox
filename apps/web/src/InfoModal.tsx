import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fmtDate, fmtSize, fmtTime, type Track } from './data'
import { Icon } from './Icon'
import { albumSeed, Cover } from './Artwork'
import { useSources } from './api'
import { explainTab, runPluginTab, type PluginTab } from './pluginMenu'

/**
 * A tab a plugin asked for, drawn by the host.
 *
 * The command runs when the tab is opened rather than when the window is —
 * a plugin that reaches a third party should cost nothing to whoever only
 * wanted to fix a track number. React Query then keeps the answer, so coming
 * back to the tab is instant and does not ask twice.
 */
function PluginTabBody({ tab, track }: { tab: PluginTab; track: Track }) {
  const { data, error, isPending } = useQuery({
    queryKey: ['plugin-tab', tab.pluginId, tab.command, track.id],
    queryFn: () => runPluginTab(tab, track.id),
    retry: false,
    staleTime: 5 * 60_000,
  })

  if (isPending) return <p className="dim">Asking {tab.pluginName}…</p>
  if (error) return <p className="dim">{explainTab(error, tab)}</p>

  switch (data.kind) {
    case 'text':
      return (
        <>
          {data.title && <h4 className="plugin-title">{data.title}</h4>}
          {/* Text, not markup: the newlines are the plugin's, the styling is
              ours, and nothing it returns can become an element. */}
          <pre className="plugin-text">{data.body}</pre>
          <p className="dim plugin-from">from {tab.pluginName}</p>
        </>
      )
    case 'done':
      return <p className="dim">{data.message ?? 'Nothing to show.'}</p>
    default:
      // The other kinds start something — a job, a playlist, a selection — and
      // a tab is a place to read, not a place to set things off.
      return <p className="dim">{tab.pluginName} answered with something a tab cannot show.</p>
  }
}

type Field = {
  key: keyof Track
  label: string
  type: 'text' | 'number' | 'check' | 'textarea' | 'select' | 'stars'
  tab: 'details' | 'options' | 'artwork'
  options?: string[]
  half?: boolean
  suffix?: string
}

const FIELDS: Field[] = [
  { key: 'name', label: 'Name', type: 'text', tab: 'details' },
  { key: 'artist', label: 'Artist', type: 'text', tab: 'details' },
  { key: 'albumArtist', label: 'Album Artist', type: 'text', tab: 'details' },
  { key: 'album', label: 'Album', type: 'text', tab: 'details' },
  { key: 'grouping', label: 'Grouping', type: 'text', tab: 'details' },
  { key: 'composer', label: 'Composer', type: 'text', tab: 'details' },
  { key: 'comments', label: 'Comments', type: 'textarea', tab: 'details' },
  { key: 'genre', label: 'Genre', type: 'text', tab: 'details', half: true },
  { key: 'year', label: 'Year', type: 'number', tab: 'details', half: true },
  { key: 'trackNumber', label: 'Track Number', type: 'number', tab: 'details', half: true },
  { key: 'discNumber', label: 'Disc Number', type: 'number', tab: 'details', half: true },
  { key: 'bpm', label: 'BPM', type: 'number', tab: 'details', half: true },
  { key: 'compilation', label: 'Part of a compilation', type: 'check', tab: 'details' },
  { key: 'rating', label: 'Rating', type: 'stars', tab: 'options' },
  { key: 'loved', label: 'Loved', type: 'check', tab: 'options' },
  { key: 'enabled', label: 'Enabled (plays in this list)', type: 'check', tab: 'options' },
  { key: 'kind', label: 'Kind', type: 'text', tab: 'options', half: true },
]

const MIXED = Symbol('mixed')

/** Common value across the selection, or MIXED. */
function shared(tracks: Track[], key: keyof Track) {
  const first = tracks[0][key]
  return tracks.every((t) => t[key] === first) ? first : MIXED
}

export function InfoModal({
  tracks,
  onClose,
  onApply,
  pluginTabs = [],
}: {
  tracks: Track[]
  onClose: () => void
  onApply: (patch: Partial<Track>) => void
  /** Tabs plugins asked to add. About one track, so none when several. */
  pluginTabs?: PluginTab[]
}) {
  const multi = tracks.length > 1
  const [tab, setTab] = useState<string>('details')
  // Named, not just an id: "Demo library" answers "where is this?", `src-3` does not.
  const sources = useSources().data?.items ?? []
  const source = sources.find((x) => x.id === tracks[0]?.sourceId)
  const [patch, setPatch] = useState<Partial<Track>>({})
  const [on, setOn] = useState<Set<string>>(new Set())

  const base = useMemo(
    () => Object.fromEntries(FIELDS.map((f) => [f.key, shared(tracks, f.key)])) as Record<string, unknown>,
    [tracks],
  )

  const setField = (f: Field, value: unknown) => {
    setPatch((old) => ({ ...old, [f.key]: value }))
    if (multi) setOn((old) => new Set(old).add(f.key as string))
  }

  const valueOf = (f: Field) => {
    if (f.key in patch) return patch[f.key]
    const b = base[f.key as string]
    return b === MIXED ? (f.type === 'check' ? false : '') : b
  }

  const apply = () => {
    const out: Partial<Track> = {}
    for (const f of FIELDS) {
      if (multi && !on.has(f.key as string)) continue
      if (!(f.key in patch)) continue
      ;(out as Record<string, unknown>)[f.key] = patch[f.key]
    }
    if (Object.keys(out).length) onApply(out)
    onClose()
  }

  const own = multi ? ['details', 'options', 'artwork'] : ['details', 'options', 'artwork', 'file']
  // A plugin tab is about one track: "the lyrics of these nine songs" is not a
  // question, so the window keeps its own tabs when several are selected.
  const mine = multi ? [] : pluginTabs
  const open = mine.find((x) => x.id === tab)
  const visible = FIELDS.filter((f) => f.tab === tab)
  const t = tracks[0]

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${multi ? 'multi' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-titlebar">
          <button className="close" onClick={onClose} />
          <span>{multi ? 'Multiple Item Information' : `${t.name} — Item Information`}</span>
        </div>

        <div className="modal-head">
          <Cover seed={albumSeed(t)} size={58} className="art" />
          <div className="head-meta">
            {multi ? (
              <>
                <b>{tracks.length} songs selected</b>
                <span>Edits apply to every checked field.</span>
                <span className="dim">{[...new Set(tracks.map((x) => x.artist))].slice(0, 3).join(', ')}…</span>
              </>
            ) : (
              <>
                <b>{t.name}</b>
                <span>{t.artist}</span>
                <span className="dim">{t.album}</span>
              </>
            )}
          </div>
        </div>

        <div className="tabs">
          {own.map((id) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {id[0].toUpperCase() + id.slice(1)}
            </button>
          ))}
          {mine.map((x) => (
            <button
              key={x.id}
              className={tab === x.id ? 'on' : ''}
              // Which plugin put it there, without making the tab itself longer.
              title={`${x.pluginName} · ${x.command}`}
              onClick={() => setTab(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {open ? (
            <PluginTabBody tab={open} track={t} />
          ) : tab === 'file' ? (
            <>
              <dl className="file-info">
                {[
                  ['Kind', t.format],
                  ['Size', fmtSize(t.size)],
                  ['Bit Rate', `${t.bitRate} kbps`],
                  ['Sample Rate', `${(t.sampleRate / 1000).toFixed(3)} kHz`],
                  ['Duration', fmtTime(t.duration)],
                  ['Date Added', fmtDate(t.dateAdded)],
                  ['Last Played', fmtDate(t.lastPlayed) || 'Never'],
                  ['Plays', String(t.playCount)],
                  ['Skips', String(t.skipCount)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>

              {/* Where this came from. The rest of the tab describes the audio;
                  this says which disk to plug in when it stops playing, which
                  is the question the tab gets opened for half the time. */}
              <h4 className="file-where">Where it came from</h4>
              <dl className="file-info">
                <div>
                  <dt>Source</dt>
                  <dd>
                    {source ? (
                      <>
                        {source.name} <span className="dim">({source.kind})</span>
                      </>
                    ) : (
                      // A track whose source the server no longer lists: the
                      // drive was removed, or the source was deleted from under it.
                      <span className="dim">{t.sourceId} — not connected</span>
                    )}
                  </dd>
                </div>
                {source && (
                  <div>
                    <dt>Root</dt>
                    <dd className="path">{source.root}</dd>
                  </div>
                )}
                <div>
                  <dt>Path</dt>
                  <dd className="path" title={t.path}>{t.path}</dd>
                </div>
                {t.renditions.length > 1 && (
                  <div>
                    <dt>Other files</dt>
                    <dd>
                      {t.renditions
                        .filter((r) => !r.preferred)
                        .map((r) => `${r.format.toUpperCase()} · ${fmtSize(r.size)}`)
                        .join(', ')}
                    </dd>
                  </div>
                )}
              </dl>
            </>
          ) : (
            <div className="fields">
              {visible.map((f) => {
                const mixed = base[f.key as string] === MIXED && !(f.key in patch)
                const enabled = !multi || on.has(f.key as string)
                return (
                  <label
                    key={f.key as string}
                    className={`field ${f.half ? 'half' : ''} ${f.type === 'check' ? 'bool' : ''} ${f.type === 'textarea' ? 'tall' : ''} ${enabled ? '' : 'off'}`}
                  >
                    {multi && (
                      <input
                        type="checkbox"
                        className="apply-box"
                        checked={on.has(f.key as string)}
                        onChange={(e) =>
                          setOn((old) => {
                            const n = new Set(old)
                            if (e.target.checked) n.add(f.key as string)
                            else n.delete(f.key as string)
                            return n
                          })
                        }
                      />
                    )}
                    <span className="lbl">{f.label}</span>
                    {f.type === 'check' ? (
                      <input
                        type="checkbox"
                        disabled={multi && !enabled}
                        checked={Boolean(valueOf(f))}
                        onChange={(e) => setField(f, e.target.checked)}
                      />
                    ) : f.type === 'textarea' ? (
                      <textarea
                        disabled={multi && !enabled}
                        placeholder={mixed ? 'Mixed' : ''}
                        value={String(valueOf(f) ?? '')}
                        onChange={(e) => setField(f, e.target.value)}
                      />
                    ) : f.type === 'stars' ? (
                      <span className="stars big">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <i
                            key={n}
                            className={n <= Number(valueOf(f) || 0) ? 'on' : 'off'}
                            onClick={() => setField(f, n === 1 && Number(valueOf(f)) === 1 ? 0 : n)}
                          >
                            <Icon name="star" size={14} />
                          </i>
                        ))}
                      </span>
                    ) : (
                      <span className="input-wrap">
                        <input
                          type={f.type === 'number' ? 'number' : 'text'}
                          disabled={multi && !enabled}
                          placeholder={mixed ? 'Mixed' : ''}
                          value={String(valueOf(f) ?? '')}
                          onChange={(e) =>
                            setField(f, f.type === 'number' ? Number(e.target.value) : e.target.value)
                          }
                        />
                        {f.suffix && <em>{f.suffix}</em>}
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
          )}
        </div>

        <div className="modal-foot">
          {multi && <span className="dim">{on.size} field{on.size === 1 ? '' : 's'} will be applied</span>}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="default" onClick={apply}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
