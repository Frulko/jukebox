import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTable } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Icon } from './Icon'
import { albumSeed, Cover } from './Artwork'
import { features } from './tableFeatures'
import { COLUMN_LABELS, DEFAULT_VISIBLE, makeColumns, NUMERIC } from './columns'
import type { Playlist, Track } from './data'
import type { View } from './App'
import { isUnavailable } from './trackBadges'
import type { PluginEntry } from './pluginMenu'
import { useMenuPosition } from './useMenuPosition'
import { usePersisted, useScrollMemory } from './viewState'

// ponytail: column layout is global, not per-playlist like real iTunes.
const ALL_IDS = Object.keys(COLUMN_LABELS)
const defaultVisibility = Object.fromEntries(ALL_IDS.map((id) => [id, DEFAULT_VISIBLE.has(id)]))


type Props = {
  tracks: Track[]
  view: View
  /** Identity of the current source; keys the scroll memory. */
  viewKey: string
  /** Comes from the active theme, which sets --row-h. */
  rowHeight: number
  /** iTunes 12 onward put a cover thumbnail in the Name column. */
  showArtwork: boolean
  /** Connected devices — the presence column labels its dots with them. */
  devices: { id: string; name: string }[]
  /** Sources the server reports. A track from anywhere else cannot be played. */
  sourceIds: string[]
  /** The format being filtered on, or null for all of them. */
  format: string | null
  /** What the library actually holds, with counts. Never a hardcoded list. */
  formats: { value: string; count: number }[]
  onFormat: (format: string | null) => void
  playlists: Playlist[]
  nowPlaying: string | null
  /** The second argument is the queue this play starts from, in the order shown. */
  onPlay: (id: string, queue?: string[]) => void
  /** Appends to what is already playing rather than replacing it. */
  onEnqueue: (ids: string[]) => void
  /** Inserts right after the track playing, rather than at the end. */
  onPlayNext: (ids: string[]) => void
  /** Opens the conversion dialog for these tracks. */
  onConvert: (ids: string[]) => void
  /** Entries plugins asked to add, and how to run one. */
  pluginEntries: PluginEntry[]
  onPluginCommand: (entry: PluginEntry, ids: string[]) => void
  /** A selection handed in from outside — a plugin command that found tracks. */
  selectIds: string[] | null
  onUpdate: (ids: string[], patch: Partial<Track>) => void
  onDelete: (ids: string[]) => void
  onAddToPlaylist: (playlistId: string, ids: string[]) => void
  onAddToDevice: (deviceId: string, ids: string[]) => void
  onReorder: (playlistId: string, ids: string[], toIndex: number) => void
  onGetInfo: (ids: string[]) => void
  onNewPlaylistFrom: (ids: string[]) => void
}

export function TrackList(p: Props) {
  const [columnVisibility, setColumnVisibility] = usePersisted(
    'jukebox.cols',
    defaultVisibility,
    // A column added since the layout was saved keeps its default visibility.
    (stored, fresh) => ({ ...fresh, ...stored }),
  )
  const [columnOrder, setColumnOrder] = usePersisted<string[]>(
    'jukebox.order',
    ALL_IDS,
    // Keep the user's order, append anything new at the end, drop what is gone.
    (stored, fresh) => [...stored.filter((id) => fresh.includes(id)), ...fresh.filter((id) => !stored.includes(id))],
  )
  const [columnSizing, setColumnSizing] = usePersisted<Record<string, number>>('jukebox.sizes', {})
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'row' | 'header' | 'format' } | null>(null)
  const menuPosition = useMenuPosition(menu)
  const [dropRow, setDropRow] = useState<number | null>(null)
  const [dragCol, setDragCol] = useState<string | null>(null)
  const anchor = useRef<string | null>(null)
  const pendingCollapse = useRef<string | null>(null)
  // Same memory as every other view — see viewState.ts. The header's horizontal
  // position is not stored: it is derived from the body's on every scroll.
  const { ref: bodyRef, onScroll: rememberScroll } = useScrollMemory<HTMLDivElement>(p.viewKey)
  const headRef = useRef<HTMLDivElement>(null)

  const actions = useMemo(
    () => ({
      toggleChecked: (id: string) =>
        p.onUpdate([id], { enabled: !p.tracks.find((t) => t.id === id)?.enabled }),
      rate: (id: string, rating: number) => p.onUpdate([id], { rating }),
      devices: p.devices,
      badgeContext: { sourceIds: p.sourceIds, deviceIds: p.devices.map((d) => d.id) },
    }),
    [p],
  )
  const columns = useMemo(() => makeColumns(actions), [actions])

  // The presence column is pointless with no device connected, and iTunes never
  // showed a column that could not have content.
  const visibility = useMemo(
    () => (p.devices.length ? columnVisibility : { ...columnVisibility, devices: false }),
    [columnVisibility, p.devices.length],
  )

  const table = useTable({
    features,
    columns,
    data: p.tracks,
    getRowId: (t) => t.id,
    columnResizeMode: 'onChange',
    enableSortingRemoval: false,
    state: { columnVisibility: visibility, columnOrder, columnSizing },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
  })

  const badgeContext = useMemo(
    () => ({ sourceIds: p.sourceIds, deviceIds: p.devices.map((d) => d.id) }),
    [p.sourceIds, p.devices],
  )
  const unreachable = (t: Track) => isUnavailable(t, badgeContext)

  const rows = table.getRowModel().rows
  const selectedIds = table.getSelectedRowIds()
  const manualOrder = p.view.kind === 'playlist' && !p.view.smart && table.state.sorting.length === 0

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => p.rowHeight,
    overscan: 12,
  })

  // The list is no longer remounted per view, so what the remount used to reset
  // has to be reset here: a selection belongs to the list you made it in.
  useLayoutEffect(() => {
    table.resetRowSelection()
    anchor.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.viewKey])

  // A plugin answered with tracks: show them as a selection rather than as a
  // playlist nobody asked to keep.
  useLayoutEffect(() => {
    if (!p.selectIds?.length) return
    const chosen: Record<string, true> = {}
    for (const id of p.selectIds) chosen[id] = true
    table.setRowSelection(chosen)
    // And take the list there: twelve selected rows below the fold are twelve
    // rows nobody knows were found.
    const first = table.getRowModel().rows.findIndex((r) => chosen[r.id])
    if (first >= 0) virtualizer.scrollToIndex(first, { align: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.selectIds])

  // The row height is the theme's. TanStack Virtual keeps its measurements in a
  // cache that a new `estimateSize` does not invalidate: switching theme changed
  // the CSS height of every row while they stayed on the old pitch, so a 30 px
  // row sat in a 21 px slot and its hover and selection band spilled over the
  // rows above and below. Re-measuring is the documented way out.
  useLayoutEffect(() => { virtualizer.measure() }, [p.rowHeight, virtualizer])

  // The restore happens in the hook, before paint; the header has to be brought
  // along with it, which it cannot know about.
  useLayoutEffect(() => {
    if (headRef.current && bodyRef.current) headRef.current.scrollLeft = bodyRef.current.scrollLeft
  }, [p.viewKey, bodyRef])

  const onScroll = () => {
    rememberScroll()
    const el = bodyRef.current
    if (el && headRef.current) headRef.current.scrollLeft = el.scrollLeft // header follows horizontally
  }

  /* ---- selection: plain click replaces, cmd toggles, shift extends ---- */
  const clickRow = (e: React.MouseEvent, id: string) => {
    const isSelected = table.getRow(id)?.getIsSelected()
    if (e.button === 2) {
      if (!isSelected) {
        table.setRowSelection({ [id]: true })
        anchor.current = id
      }
      return // right-click never collapses an existing multi-selection
    }
    if (e.shiftKey && anchor.current) {
      const a = rows.findIndex((r) => r.id === anchor.current)
      const b = rows.findIndex((r) => r.id === id)
      if (a > -1 && b > -1) {
        const next: Record<string, true> = {}
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next[rows[i].id] = true
        table.setRowSelection(next)
        return
      }
    }
    if (e.metaKey || e.ctrlKey) {
      table.setRowSelection((old) => {
        const next = { ...old }
        if (next[id]) delete next[id]
        else next[id] = true
        return next
      })
      anchor.current = id
      return
    }
    // Pressing an already-selected row must NOT collapse the selection here:
    // mousedown fires before dragstart, so collapsing would drop the other rows
    // from the drag payload. Defer it to mouseup, which only lands if no drag ran.
    if (isSelected && selectedIds.length > 1) {
      pendingCollapse.current = id
      return
    }
    table.setRowSelection({ [id]: true })
    anchor.current = id
  }

  const releaseRow = (id: string) => {
    if (pendingCollapse.current === id) {
      table.setRowSelection({ [id]: true })
      anchor.current = id
    }
    pendingCollapse.current = null
  }

  const move = (delta: number, extend: boolean) => {
    const cur = rows.findIndex((r) => r.id === (anchor.current ?? selectedIds[0]))
    const next = Math.max(0, Math.min(rows.length - 1, (cur < 0 ? -1 : cur) + delta))
    const row = rows[next]
    if (!row) return
    if (extend && anchor.current) {
      const a = rows.findIndex((r) => r.id === anchor.current)
      const sel: Record<string, true> = {}
      for (let i = Math.min(a, next); i <= Math.max(a, next); i++) sel[rows[i].id] = true
      table.setRowSelection(sel)
    } else {
      table.setRowSelection({ [row.id]: true })
      anchor.current = row.id
    }
    virtualizer.scrollToIndex(next, { align: 'auto' }) // the row may not be mounted
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
    } else if (e.key === 'Enter' && selectedIds[0]) {
      p.onPlay(selectedIds[0], rows.map((r) => r.id))
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault()
      table.setRowSelection(Object.fromEntries(rows.map((r) => [r.id, true])))
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'i' && selectedIds.length) {
      e.preventDefault()
      p.onGetInfo(selectedIds)
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && selectedIds.length) {
      e.preventDefault()
      p.onDelete(selectedIds)
    }
  }

  /* ---- drag & drop ---- */
  const dragTracks = (e: React.DragEvent, id: string) => {
    pendingCollapse.current = null // a drag started: keep the whole selection
    const ids = table.getRow(id)?.getIsSelected() ? selectedIds : [id]
    if (!table.getRow(id)?.getIsSelected()) table.setRowSelection({ [id]: true })
    e.dataTransfer.setData('application/x-tracks', JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'copyMove'
    const ghost = document.createElement('div')
    ghost.className = 'drag-ghost'
    ghost.textContent = ids.length > 1 ? `${ids.length} songs` : (p.tracks.find((t) => t.id === id)?.name ?? '')
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 12, 12)
    setTimeout(() => ghost.remove(), 0)
  }

  const bodyDragOver = (e: React.DragEvent) => {
    if (!manualOrder || !e.dataTransfer.types.includes('application/x-tracks')) return
    e.preventDefault()
    const tr = (e.target as HTMLElement).closest('[data-rowidx]') as HTMLElement | null
    if (!tr) return
    const rect = tr.getBoundingClientRect()
    const idx = Number(tr.dataset.rowidx) + (e.clientY > rect.top + rect.height / 2 ? 1 : 0)
    setDropRow(idx)
  }

  const bodyDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-tracks')
    if (!manualOrder || !raw || dropRow == null) return
    e.preventDefault()
    p.onReorder((p.view as { id: string }).id, JSON.parse(raw), dropRow)
    setDropRow(null)
  }

  /* ---- context menu ---- */
  const openMenu = (e: React.MouseEvent, kind: 'row' | 'header' | 'format') => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, kind })
  }

  const headers = table.getHeaderGroups()[0].headers

  return (
    <div className="tracklist" tabIndex={0} onKeyDown={onKeyDown} onMouseDown={() => setMenu(null)}>
      <div className="thead" ref={headRef} onContextMenu={(e) => openMenu(e, 'header')}>
        {headers.map((header) => {
          const sorted = header.column.getIsSorted()
          return (
            <div
              key={header.id}
              className={`th ${sorted ? 'sorted' : ''} ${NUMERIC.has(header.column.id) ? 'r' : ''} ${dragCol === header.column.id ? 'dragging' : ''}`}
              style={{ width: header.getSize() }}
              onClick={header.column.getToggleSortingHandler()}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('text/x-col')) e.preventDefault()
              }}
              onDrop={(e) => {
                const from = e.dataTransfer.getData('text/x-col')
                if (!from) return
                e.preventDefault()
                setColumnOrder((old) => {
                  const next = old.filter((id) => id !== from)
                  next.splice(next.indexOf(header.column.id), 0, from)
                  return next
                })
                setDragCol(null)
              }}
            >
              <span
                className="th-label"
                draggable={header.column.id !== 'checked'}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/x-col', header.column.id)
                  setDragCol(header.column.id)
                }}
                onDragEnd={() => setDragCol(null)}
              >
                <table.FlexRender header={header} />
              </span>
              {header.column.id === 'format' && (
                <button
                  className={`th-filter ${p.format ? 'on' : ''}`}
                  title={p.format ? `Showing ${p.format.toUpperCase()} only` : 'Filter by format'}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    openMenu(e, 'format')
                  }}
                >
                  ▾
                </button>
              )}
              {sorted && <b className={`sort-arrow ${sorted}`} />}
              {header.column.getCanResize() && (
                <span
                  className="resizer"
                  onMouseDown={header.getResizeHandler()}
                  onTouchStart={header.getResizeHandler()}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
            </div>
          )
        })}
        <div className="th filler" />
      </div>

      <div
        className="tbody"
        ref={bodyRef}
        onScroll={onScroll}
        onDragOver={bodyDragOver}
        onDrop={bodyDrop}
        onDragLeave={() => setDropRow(null)}
      >
        <div className="tbody-sizer" style={{ height: virtualizer.getTotalSize(), width: table.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]
            const sel = row.getIsSelected()
            return (
              <div
                key={row.id}
                data-rowid={row.id}
                data-rowidx={v.index}
                style={{ transform: `translateY(${v.start}px)` }}
                className={`tr ${sel ? 'sel' : ''} ${v.index % 2 ? 'odd' : ''} ${row.id === p.nowPlaying ? 'playing' : ''} ${row.original.enabled ? 'checked' : 'unchecked'} ${unreachable(row.original) ? 'unavailable' : ''} ${dropRow === v.index ? 'drop-above' : ''} ${dropRow === rows.length && v.index === rows.length - 1 ? 'drop-below' : ''}`}
                draggable
                onDragStart={(e) => dragTracks(e, row.id)}
                onMouseDown={(e) => clickRow(e, row.id)}
                onMouseUp={() => releaseRow(row.id)}
                onContextMenu={(e) => {
                  if (!sel) table.setRowSelection({ [row.id]: true })
                  openMenu(e, 'row')
                }}
                // A track whose source is gone has nothing to stream. Refusing
                // here beats a player that starts and immediately errors.
                onDoubleClick={() => !unreachable(row.original) && p.onPlay(row.id, rows.map((r) => r.id))}
              >
                {row.getVisibleCells().map((cell) => (
                  <div
                    key={cell.id}
                    className={`td ${NUMERIC.has(cell.column.id) ? 'r' : ''} ${cell.column.id}`}
                    style={{ width: cell.column.getSize() }}
                  >
                    {cell.column.id === 'name' && p.showArtwork && (
                      <Cover seed={albumSeed(row.original)} size={p.rowHeight - 5} className="thumb" />
                    )}
                    {cell.column.id === 'name' && row.id === p.nowPlaying && (
                      <Icon name="volumeHigh" size={10} className="speaker" />
                    )}
                    <table.FlexRender cell={cell} />
                  </div>
                ))}
              </div>
            )
          })}
        </div>
        {!rows.length && <div className="list-empty">No songs</div>}
      </div>

      {menu && (
        <div
          className="ctx"
          ref={menuPosition.setFloating}
          style={menuPosition.floatingStyles}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menu.kind === 'format' ? (
            <>
              <div className="ctx-title">Format</div>
              <button
                className={p.format ? '' : 'on'}
                onClick={() => (p.onFormat(null), setMenu(null))}
              >
                All formats
              </button>
              {p.formats.length === 0 && <div className="ctx-empty">Nothing scanned yet</div>}
              {p.formats.map((f) => (
                <button
                  key={f.value}
                  className={p.format === f.value ? 'on' : ''}
                  onClick={() => (p.onFormat(f.value), setMenu(null))}
                >
                  {f.value.toUpperCase()}
                  <em className="dim">{f.count.toLocaleString('en-US')}</em>
                </button>
              ))}
            </>
          ) : menu.kind === 'header' ? (
            <>
              <div className="ctx-title">View Options</div>
              {columnOrder
                .filter((id) => id !== 'checked')
                .map((id) => {
                  const col = table.getColumn(id)
                  if (!col) return null
                  return (
                    <button
                      key={id}
                      onClick={() => col.toggleVisibility()}
                      className={col.getIsVisible() ? 'on' : ''}
                    >
                      {col.getIsVisible() ? '✓' : ' '}&nbsp;&nbsp;{COLUMN_LABELS[id]}
                    </button>
                  )
                })}
            </>
          ) : (
            <>
              <button onClick={() => (p.onPlay(selectedIds[0], rows.map((r) => r.id)), setMenu(null))}>Play</button>
              <button onClick={() => (p.onPlayNext(selectedIds), setMenu(null))}>
                Play Next
              </button>
              <button onClick={() => (p.onEnqueue(selectedIds), setMenu(null))}>
                {selectedIds.length > 1 ? `Add ${selectedIds.length} to Queue` : 'Add to Queue'}
              </button>
              <button onClick={() => (p.onGetInfo(selectedIds), setMenu(null))}>
                {selectedIds.length > 1 ? `Get Info (${selectedIds.length} items)` : 'Get Info'}
              </button>
              <button onClick={() => (p.onConvert(selectedIds), setMenu(null))}>
                {selectedIds.length > 1 ? `Convert ${selectedIds.length} Tracks…` : 'Convert…'}
              </button>
              {p.pluginEntries.length > 0 && <hr />}
              {p.pluginEntries.map((entry) => (
                <button
                  key={entry.id}
                  disabled={!entry.runnable}
                  title={
                    entry.runnable
                      ? `${entry.pluginName} · ${entry.command}`
                      : `${entry.pluginName} is switched off`
                  }
                  onClick={() => (p.onPluginCommand(entry, selectedIds), setMenu(null))}
                >
                  {entry.label}
                  <em className="ctx-from">{entry.pluginName}</em>
                </button>
              ))}
              <hr />
              <div className="ctx-sub">
                Rating
                <div className="ctx-flyout">
                  {[0, 1, 2, 3, 4, 5].map((n) => (
                    <button key={n} onClick={() => (p.onUpdate(selectedIds, { rating: n }), setMenu(null))}>
                      {n ? '★'.repeat(n) : 'None'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ctx-sub">
                Add to Playlist
                <div className="ctx-flyout">
                  <button onClick={() => (p.onNewPlaylistFrom(selectedIds), setMenu(null))}>New Playlist…</button>
                  <hr />
                  {p.playlists
                    .filter((pl) => !pl.smart)
                    .map((pl) => (
                      <button key={pl.id} onClick={() => (p.onAddToPlaylist(pl.id, selectedIds), setMenu(null))}>
                        {pl.name}
                      </button>
                    ))}
                </div>
              </div>
              {/* Absent with nothing connected -- iTunes never showed a menu
                  entry that could not do anything. */}
              {p.devices.length > 0 && (
                <div className="ctx-sub">
                  Add to Device
                  <div className="ctx-flyout">
                    {p.devices.map((d) => (
                      <button key={d.id} onClick={() => (p.onAddToDevice(d.id, selectedIds), setMenu(null))}>
                        {d.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <hr />
              <button onClick={() => (p.onUpdate(selectedIds, { enabled: true }), setMenu(null))}>Check Selection</button>
              <button onClick={() => (p.onUpdate(selectedIds, { enabled: false }), setMenu(null))}>Uncheck Selection</button>
              <button onClick={() => (p.onUpdate(selectedIds, { playCount: 0, lastPlayed: null }), setMenu(null))}>Reset Plays</button>
              <hr />
              <button onClick={() => (p.onDelete(selectedIds), setMenu(null))}>
                {p.view.kind === 'playlist' ? 'Remove from Playlist' : 'Delete from Library'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
