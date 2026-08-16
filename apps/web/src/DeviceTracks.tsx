import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createColumnHelper } from '@tanstack/react-table'
import { api } from './api'
import { Icon } from './Icon'
import type { DeviceTrack, Source } from '@jukebox/client-sdk'
import { fmtSize, fmtTime } from './data'
import type { Play } from './App'
import { DataTable } from './DataTable'
import { useMenuPosition } from './useMenuPosition'
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
  onReveal,
}: {
  deviceId: string
  deviceName: string
  sources: Source[]
  nowPlaying: string | null
  onPlay: Play
  onReveal: (trackId: string) => void
}) {
  const [orphansOnly, setOrphansOnly] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState<string | null>(null)
  /** The row being pointed at, which is what a right-click acts on. */
  const [current, setCurrent] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; track: DeviceTrack } | null>(null)
  const menuPosition = useMenuPosition(menu)

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
        // Headed, because an empty column with a box on four rows out of forty
        // reads as something failing to render rather than as a choice.
        header: 'Import',
        size: 46,
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
        header: 'Where else',
        size: 132,
        // Words, not a glyph. The difference between "you have this" and "this
        // iPod is the last copy" is the reason to open this page at all, and a
        // small dim note was making the interesting half the quiet one.
        cell: (c) =>
          c.getValue() ? (
            <span className="dim">In your library</span>
          ) : c.row.original.sourceUrl ? (
            <em className="tag-orphan" title="Only on this device — the satellite can serve the file, so it can be imported">
              Only here
            </em>
          ) : (
            <em className="tag-orphan off" title="Only on this device, and nothing can fetch the file from it">
              Only here · no source
            </em>
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
      // The band says the job started; the job list says how it is going. A
      // line that stays for ever ends up describing an import from last Tuesday.
      setTimeout(() => setImporting((v) => (v === 'queued' ? null : v)), 6000)
    } catch (err) {
      // A failure keeps its place until something else happens: it is the one
      // of the two that nobody else will mention.
      setImporting(err instanceof Error ? err.message : 'import failed')
    }
  }

  const menuFor = (t: DeviceTrack) => {
    const inLibrary = !!t.libraryTrackId
    return (
      <div
        className="ctx"
        ref={menuPosition.setFloating}
        style={menuPosition.floatingStyles}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          disabled={!inLibrary}
          // The server streams what the library holds; the file for an orphan
          // is on the iPod, so there is nothing to play from here.
          title={inLibrary ? undefined : 'Only on the device — import it to play it'}
          onClick={() => {
            if (t.libraryTrackId) {
              onPlay(t.libraryTrackId, items.map((x) => x.libraryTrackId).filter((id): id is string => !!id))
            }
            setMenu(null)
          }}
        >
          Play
        </button>
        <button
          disabled={!inLibrary}
          onClick={() => (t.libraryTrackId && onReveal(t.libraryTrackId), setMenu(null))}
        >
          Show in library
        </button>
        <hr />
        <button
          disabled={inLibrary || !t.sourceUrl || targets.length === 0}
          title={targets.length === 0 ? 'No writable source to import into' : undefined}
          onClick={() => {
            setSelected((old) => new Set(old).add(t.deviceLocalId))
            setMenu(null)
          }}
        >
          Tick for import
        </button>
      </div>
    )
  }

  return (
    <div className="devtracks" onMouseDown={() => setMenu(null)}>
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
        selectedId={current}
        onRowClick={(t) => setCurrent(t.deviceLocalId)}
        onRowContextMenu={(t, e) => {
          e.preventDefault()
          setCurrent(t.deviceLocalId)
          setMenu({ x: e.clientX, y: e.clientY, track: t })
        }}
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

      {menu && menuFor(menu.track)}
    </div>
  )
}
