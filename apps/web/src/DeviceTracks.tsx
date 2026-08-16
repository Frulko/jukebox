import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { Icon } from './Icon'
import type { Source } from '@jukebox/client-sdk'
import { fmtTime } from './data'
import type { Play } from './App'

/**
 * What is actually on the device.
 *
 * The original iTunes never showed this: it displayed your library and which
 * parts of it were synced, so anything on the iPod that had fallen out of the
 * library was invisible. Those tracks are the interesting ones — an old iPod is
 * often the last copy of music whose library is long gone.
 */
export function DeviceTracks({
  deviceId,
  deviceName,
  sources,
  nowPlaying,
  onPlay,
}: {
  deviceId: string
  deviceName: string
  sources: Source[]
  nowPlaying: string | null
  onPlay: Play
}) {
  const [orphansOnly, setOrphansOnly] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState<string | null>(null)

  const { data, isPending } = useQuery({
    queryKey: ['devices', deviceId, 'tracks', orphansOnly],
    queryFn: () => api.devices.tracks(deviceId, { limit: 300, orphansOnly }),
  })
  const stats = useQuery({ queryKey: ['devices', deviceId, 'stats'], queryFn: () => api.devices.stats(deviceId) })

  const items = data?.items ?? []
  // Only a writable source can receive imported files, so only those are offered.
  const targets = useMemo(() => sources.filter((s) => s.writable === 1), [sources])

  const toggle = (id: string) =>
    setSelected((old) => {
      const next = new Set(old)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const importable = items.filter((t) => t.libraryTrackId === null && t.sourceUrl)
  const chosen = [...selected].filter((id) => importable.some((t) => t.deviceLocalId === id))

  const runImport = async () => {
    if (!targets[0] || chosen.length === 0) return
    setImporting('running')
    try {
      await api.devices.importTracks(deviceId, chosen, targets[0].id, `Imported from ${deviceName}`)
      setSelected(new Set())
      setImporting('queued')
    } catch (err) {
      setImporting(err instanceof Error ? err.message : 'import failed')
    }
  }

  return (
    <div className="devtracks">
      <div className="devtracks-bar">
        <label className="dev-check">
          <input type="checkbox" checked={orphansOnly} onChange={(e) => setOrphansOnly(e.target.checked)} />
          <span>Only tracks missing from the library</span>
        </label>

        <span className="spacer" />

        {stats.data && (
          <span className="dim">
            {stats.data.tracks} on device · <b>{stats.data.orphans}</b> not in the library
          </span>
        )}

        {targets.length === 0 ? (
          // Saying why the button is absent beats showing one that always fails.
          <span className="dim">No writable source to import into</span>
        ) : (
          <button className="prim" disabled={chosen.length === 0 || importing === 'running'} onClick={runImport}>
            <Icon name="backup" size={11} />
            {chosen.length ? `Import ${chosen.length}` : 'Import'}
          </button>
        )}
      </div>

      {importing && importing !== 'running' && (
        <div className="devtracks-note">
          {importing === 'queued' ? 'Import queued. Progress appears in the job list.' : importing}
        </div>
      )}

      <div className="ep-head devtracks-head">
        <span />
        <span className="c-name">Name</span>
        <span className="c-artist">Artist</span>
        <span className="c-time">Time</span>
        <span className="c-state">In library</span>
      </div>

      <div className="ep-body">
        {isPending && <div className="list-empty">Reading the device…</div>}
        {!isPending && items.length === 0 && (
          <div className="list-empty">{orphansOnly ? 'Everything on this device is in the library' : 'Nothing on this device'}</div>
        )}
        {items.map((t, i) => {
          const orphan = t.libraryTrackId === null
          return (
            <div
              key={t.deviceLocalId}
              className={`ep devtracks-row ${i % 2 ? 'odd' : ''} ${orphan ? 'orphan' : ''} ${t.libraryTrackId && t.libraryTrackId === nowPlaying ? 'playing' : ''}`}
              // The server can only stream what the library holds. A row that
              // exists solely on the device has no source to play from — the
              // file is on the iPod, not here — so it says so rather than
              // failing silently on a double-click.
              title={orphan ? 'Only on the device — import it to play it' : 'Double-click to play'}
              onDoubleClick={() => {
                if (!t.libraryTrackId) return
                onPlay(
                  t.libraryTrackId,
                  items.map((x) => x.libraryTrackId).filter((id): id is string => id !== null),
                )
              }}
            >
              <span>
                {orphan && t.sourceUrl && (
                  <input
                    type="checkbox"
                    checked={selected.has(t.deviceLocalId)}
                    onChange={() => toggle(t.deviceLocalId)}
                  />
                )}
              </span>
              <span className="c-name">{t.name || t.deviceLocalId}</span>
              <span className="c-artist">{t.artist}</span>
              <span className="c-time num">{fmtTime(t.duration)}</span>
              <span className="c-state">
                {orphan ? (
                  <em className="tag-orphan">{t.sourceUrl ? 'importable' : 'not fetchable'}</em>
                ) : (
                  <Icon name="music" size={10} className="dim" />
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
