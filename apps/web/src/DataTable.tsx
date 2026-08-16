import { useLayoutEffect, useRef } from 'react'
import { useTable, type ColumnDef, type RowData } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { features } from './tableFeatures'
import { titleIfClipped } from './Tooltip'
import { useScrollMemory } from './viewState'

/**
 * The table, without the library's opinions.
 *
 * The track list grew virtualisation, sortable and resizable headers, a
 * scroll position that survives navigation and cells that reveal what they
 * clip — and every other list in the app was a hand-written `<div>` stack that
 * had none of it. The device contents were the worst of them: no sorting, no
 * virtualisation, a header that did not line up with its rows.
 *
 * So the shell lives here, generic over the row type, and each view brings its
 * own columns. What it deliberately does *not* bring is selection, drag and
 * drop or context menus: those exist in the track list because a library row is
 * something you act on, and a list of what an iPod holds is something you read.
 * A view that needs them can still add them around this.
 */
export function DataTable<T extends RowData>({
  data,
  columns,
  getRowId,
  memoryKey,
  rowHeight = 26,
  rowClass,
  empty,
  selected,
  onSelectedChange,
  onRowDoubleClick,
  onRowContextMenu,
}: {
  data: T[]
  columns: ColumnDef<typeof features, T, any>[]
  getRowId: (row: T) => string
  /** Keys the remembered scroll position; usually the view's own id. */
  memoryKey: string
  rowHeight?: number
  rowClass?: (row: T) => string
  empty?: React.ReactNode
  /**
   * Selection, when a view wants one — the same gestures as the track list,
   * because a table that looks like it and selects differently is worse than
   * one that looks different. Plain click replaces, cmd toggles, shift extends
   * from the last row clicked.
   */
  selected?: Set<string>
  onSelectedChange?: (next: Set<string>) => void
  onRowDoubleClick?: (row: T) => void
  onRowContextMenu?: (row: T, e: React.MouseEvent) => void
}) {
  const { ref: bodyRef, onScroll: rememberScroll } = useScrollMemory<HTMLDivElement>(`table:${memoryKey}`)
  const headRef = useRef<HTMLDivElement>(null)
  /** Where a shift-range starts. The last row clicked without shift. */
  const anchor = useRef<string | null>(null)

  const table = useTable<typeof features, T>({
    features,
    columns,
    data,
    getRowId: (row) => getRowId(row),
    columnResizeMode: 'onChange',
  })
  const rows = table.getRowModel().rows

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  })

  // Same reason as the track list: TanStack Virtual caches its measurements, so
  // a row height that changes has to be re-measured or the rows keep the old
  // pitch and their backgrounds spill onto each other.
  useLayoutEffect(() => { virtualizer.measure() }, [rowHeight, virtualizer])

  const onScroll = () => {
    rememberScroll()
    const el = bodyRef.current
    if (el && headRef.current) headRef.current.scrollLeft = el.scrollLeft
  }

  return (
    <div className="tracklist data-table">
      <div className="thead" ref={headRef}>
        {table.getFlatHeaders().map((header) => {
          const sorted = header.column.getIsSorted()
          return (
            <div
              key={header.id}
              className={`th ${sorted ? 'sorted' : ''}`}
              style={{ width: header.column.getSize() }}
              onClick={header.column.getToggleSortingHandler()}
            >
              <span className="th-label">
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

      <div className="tbody" ref={bodyRef} onScroll={onScroll} style={{ ['--row-h' as string]: `${rowHeight}px` }}>
        <div className="tbody-sizer" style={{ height: virtualizer.getTotalSize(), width: table.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]
            return (
              <div
                key={row.id}
                data-rowid={row.id}
                style={{ transform: `translateY(${v.start}px)` }}
                className={`tr ${v.index % 2 ? 'odd' : ''} ${selected?.has(row.id) ? 'sel' : ''} ${rowClass?.(row.original) ?? ''}`}
                onMouseDown={(e) => {
                  if (e.button !== 0 || !onSelectedChange) return
                  const ids = rows.map((r) => r.id)
                  if (e.shiftKey && anchor.current) {
                    const a = ids.indexOf(anchor.current)
                    const b = ids.indexOf(row.id)
                    if (a > -1 && b > -1) {
                      return onSelectedChange(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)))
                    }
                  }
                  anchor.current = row.id
                  if (e.metaKey || e.ctrlKey) {
                    const next = new Set(selected ?? [])
                    next.has(row.id) ? next.delete(row.id) : next.add(row.id)
                    return onSelectedChange(next)
                  }
                  onSelectedChange(new Set([row.id]))
                }}
                onDoubleClick={() => onRowDoubleClick?.(row.original)}
                onContextMenu={(e) => onRowContextMenu?.(row.original, e)}
              >
                {row.getVisibleCells().map((cell) => (
                  <div
                    key={cell.id}
                    className={`td ${cell.column.id}`}
                    style={{ width: cell.column.getSize() }}
                    onMouseEnter={titleIfClipped}
                  >
                    <table.FlexRender cell={cell} />
                  </div>
                ))}
              </div>
            )
          })}
        </div>
        {rows.length === 0 && <div className="list-empty">{empty ?? 'Nothing here.'}</div>}
      </div>
    </div>
  )
}
