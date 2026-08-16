import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { api } from './api'
import { Icon } from './Icon'
import type { DeviceTrack, Source } from '@jukebox/client-sdk'
import { fmtSize, fmtTime } from './data'
import type { Play } from './App'
import { DataTable } from './DataTable'
import { FilterBar, type FilterChip } from './FilterBar'
import type { features } from './tableFeatures'

const h = createColumnHelper<typeof features, DeviceTrack>()

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

  // The same chips over a list the page holds entirely — which is what makes
  // filtering it here honest, where doing so in the library would not be.
  const chips: FilterChip[] = [
    {
      id: 'orphans',
      label: 'Shows',
      value: orphansOnly ? 'orphans' : null,
      options: [{ value: 'orphans', label: 'Only what the library has lost' }],
      onChange: (v) => setOrphansOnly(v === 'orphans'),
    },
  ]

  const columns = useMemo(
    () => [
      h.display({
        id: 'pick',
        header: '',
        size: 26,
        enableResizing: false,
        // Only an orphan the satellite can serve is importable; the rest have
        // nothing to tick, so they get no box rather than a disabled one.
        cell: ({ row }) =>
          row.original.libraryTrackId === null && row.original.sourceUrl ? (
            <input
              type="checkbox"
              checked={selected.has(row.original.deviceLocalId)}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={() => toggle(row.original.deviceLocalId)}
            />
          ) : null,
      }),
      h.accessor('name', {
        header: 'Name',
        size: 240,
        cell: (c) => c.getValue() || c.row.original.deviceLocalId,
      }),
      h.accessor('artist', { header: 'Artist', size: 170 }),
      h.accessor('album', { header: 'Album', size: 170 }),
      h.accessor('duration', {
        header: 'Time',
        size: 58,
        cell: (c) => <span className="num">{fmtTime(c.getValue())}</span>,
      }),
      h.accessor('format', { header: 'Format', size: 62, cell: (c) => c.getValue().toUpperCase() }),
      h.accessor('size', { header: 'Size', size: 72, cell: (c) => <span className="num">{fmtSize(c.getValue())}</span> }),
      h.accessor('libraryTrackId', {
        id: 'state',
        header: 'In library',
        size: 110,
        cell: (c) =>
          c.getValue() ? (
            <Icon name="music" size={10} className="dim" />
          ) : (
            <em className="tag-orphan">{c.row.original.sourceUrl ? 'importable' : 'not fetchable'}</em>
          ),
      }),
    ],
    [selected],
  )

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
        <FilterBar chips={chips} />

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

      <DataTable
        data={items}
        columns={columns}
        getRowId={(t) => t.deviceLocalId}
        memoryKey={`device:${deviceId}`}
        rowHeight={24}
        empty={
          isPending
            ? 'Reading the device…'
            : orphansOnly
              ? 'Everything on this device is in the library'
              : 'Nothing on this device'
        }
        rowClass={(t) =>
          `${t.libraryTrackId === null ? 'orphan' : ''} ${t.libraryTrackId && t.libraryTrackId === nowPlaying ? 'playing' : ''}`
        }
        // The server can only stream what the library holds. A row that exists
        // solely on the device has nothing to play from — the file is on the
        // iPod — so the double-click does nothing rather than failing later.
        onRowDoubleClick={(t) => {
          if (!t.libraryTrackId) return
          onPlay(
            t.libraryTrackId,
            items.map((x) => x.libraryTrackId).filter((id): id is string => id !== null),
          )
        }}
      />
    </div>
  )
}
