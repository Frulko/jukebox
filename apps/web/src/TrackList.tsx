import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTable } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Icon } from './Icon'
import { albumSeed, Cover } from './Artwork'
import { features } from './tableFeatures'
import { COLUMN_LABELS, DEFAULT_VISIBLE, makeColumns, NUMERIC } from './columns'
import type { Playlist, Track } from './data'
import type { View } from './App'

// ponytail: column layout is global, not per-playlist like real iTunes.
//
// `merge` reconciles what was stored with today's defaults. Without it, adding a
// column leaves every existing user without it forever: their saved order and
// visibility map predate it, and nothing ever puts it back.
function usePersisted<T>(key: string, initial: T, merge?: (stored: T, fresh: T) => T) {
  const [v, setV] = useState<T>(() => {
    const raw = localStorage.getItem(key)
    if (!raw) return initial
    try {
      const stored = JSON.parse(raw) as T
      return merge ? merge(stored, initial) : stored
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: T | ((old: T) => T)) =>
      setV((old) => {
        const val = typeof next === 'function' ? (next as (o: T) => T)(old) : next
        localStorage.setItem(key, JSON.stringify(val))
        return val
      }),
    [key],
  )
  return [v, set] as const
}

const ALL_IDS = Object.keys(COLUMN_LABELS)
const defaultVisibility = Object.fromEntries(ALL_IDS.map((id) => [id, DEFAULT_VISIBLE.has(id)]))

// Where each source was left scrolled. Module-level so it survives the remount
// that switching views triggers; deliberately not persisted across reloads.
const scrollMemory = new Map<string, { top: number; left: number }>()


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
  playlists: Playlist[]
  nowPlaying: string | null
  onPlay: (id: string) => void
  onUpdate: (ids: string[], patch: Partial<Track>) => void
  onDelete: (ids: string[]) => void
  onAddToPlaylist: (playlistId: string, ids: string[]) => void
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
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'row' | 'header' } | null>(null)
  const [dropRow, setDropRow] = useState<number | null>(null)
  const [dragCol, setDragCol] = useState<string | null>(null)
  const anchor = useRef<string | null>(null)
  const pendingCollapse = useRef<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)

  const actions = useMemo(
    () => ({
      toggleChecked: (id: string) =>
        p.onUpdate([id], { enabled: !p.tracks.find((t) => t.id === id)?.enabled }),
      rate: (id: string, rating: number) => p.onUpdate([id], { rating }),
      devices: p.devices,
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

  const rows = table.getRowModel().rows
  const selectedIds = table.getSelectedRowIds()
  const manualOrder = p.view.kind === 'playlist' && !p.view.smart && table.state.sorting.length === 0

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => p.rowHeight,
    overscan: 12,
  })

  // Restore where this source was last left, before paint so there is no jump.
  useLayoutEffect(() => {
    const at = scrollMemory.get(p.viewKey)
    if (at && bodyRef.current) {
      bodyRef.current.scrollTop = at.top
      bodyRef.current.scrollLeft = at.left
      if (headRef.current) headRef.current.scrollLeft = at.left
    }
  }, [p.viewKey])

  const onScroll = () => {
    const el = bodyRef.current
    if (!el) return
    scrollMemory.set(p.viewKey, { top: el.scrollTop, left: el.scrollLeft })
    if (headRef.current) headRef.current.scrollLeft = el.scrollLeft // header follows horizontally
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
      p.onPlay(selectedIds[0])
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
  const openMenu = (e: React.MouseEvent, kind: 'row' | 'header') => {
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
                className={`tr ${sel ? 'sel' : ''} ${v.index % 2 ? 'odd' : ''} ${row.id === p.nowPlaying ? 'playing' : ''} ${row.original.enabled ? '' : 'unchecked'} ${dropRow === v.index ? 'drop-above' : ''} ${dropRow === rows.length && v.index === rows.length - 1 ? 'drop-below' : ''}`}
                draggable
                onDragStart={(e) => dragTracks(e, row.id)}
                onMouseDown={(e) => clickRow(e, row.id)}
                onMouseUp={() => releaseRow(row.id)}
                onContextMenu={(e) => {
                  if (!sel) table.setRowSelection({ [row.id]: true })
                  openMenu(e, 'row')
                }}
                onDoubleClick={() => p.onPlay(row.id)}
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
        <div className="ctx" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {menu.kind === 'header' ? (
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
              <button onClick={() => (p.onPlay(selectedIds[0]), setMenu(null))}>Play</button>
              <button onClick={() => (p.onGetInfo(selectedIds), setMenu(null))}>
                {selectedIds.length > 1 ? `Get Info (${selectedIds.length} items)` : 'Get Info'}
              </button>
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
