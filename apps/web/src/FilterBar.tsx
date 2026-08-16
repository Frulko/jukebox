import { useState } from 'react'
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react'
import { Icon } from './Icon'

export type FilterOption = { value: string; label: string; count?: number }

export type FilterChip = {
  id: string
  /** What the chip is called when nothing is chosen — "Format", "Rating". */
  label: string
  value: string | null
  options: FilterOption[]
  onChange: (value: string | null) => void
  /** Shown in place of the options when there are none to offer. */
  emptyHint?: string
}

/**
 * Filters as chips over a listing.
 *
 * Composable on purpose: the bar knows nothing about what a chip means. The
 * library's chips become query parameters, because filtering the page the front
 * happens to hold would answer "nine tracks rated five" for a library with four
 * hundred. A local list's chips filter the array in place, which is honest there
 * because the array is the whole list.
 *
 * That distinction is the reason this is a component and not a hook: the same
 * control has to sit above two very different mechanisms without implying they
 * are the same, and the only way to keep it honest is to let each view answer
 * for its own chips.
 */
function Chip({ chip }: { chip: FilterChip }) {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    middleware: [offset(4), flip(), shift({ padding: 6 })],
    whileElementsMounted: autoUpdate,
  })

  const chosen = chip.options.find((o) => o.value === chip.value)

  return (
    <>
      <button
        ref={refs.setReference}
        className={`chip ${chip.value ? 'on' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        {chip.label}
        {chosen && <b>{chosen.label}</b>}
        <span className="tri" />
      </button>

      {open && (
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className="ctx chip-menu"
          onMouseLeave={() => setOpen(false)}
        >
          <button
            className={chip.value ? '' : 'on'}
            onClick={() => {
              chip.onChange(null)
              setOpen(false)
            }}
          >
            Any {chip.label.toLowerCase()}
          </button>
          {chip.options.length === 0 && <div className="ctx-empty">{chip.emptyHint ?? 'Nothing to filter by'}</div>}
          {chip.options.map((o) => (
            <button
              key={o.value}
              className={chip.value === o.value ? 'on' : ''}
              onClick={() => {
                chip.onChange(o.value)
                setOpen(false)
              }}
            >
              {o.label}
              {o.count !== undefined && <em className="dim">{o.count.toLocaleString('en-US')}</em>}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

export function FilterBar({ chips, onClear }: { chips: FilterChip[]; onClear?: () => void }) {
  const active = chips.filter((c) => c.value)
  return (
    <div className="filter-bar">
      <Icon name="columns" size={10} className="dim" />
      {chips.map((chip) => (
        <Chip key={chip.id} chip={chip} />
      ))}
      {/* One way out of everything at once: a listing narrowed by three chips
          and showing nothing is otherwise three clicks from making sense. */}
      {active.length > 1 && onClear && (
        <button className="chip clear" onClick={onClear}>
          Clear {active.length} filters
        </button>
      )}
    </div>
  )
}
