
import { Icon } from './Icon'

export function ViewSearch({
  value,
  onChange,
  placeholder = 'Filter this list',
  count,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** What the filter left, so an empty result is explained rather than blank. */
  count?: number
}) {
  return (
    <div className="view-search">
      <Icon name="search" size={10} />
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('')
        }}
      />
      {value && (
        <>
          {count !== undefined && <span className="dim">{count}</span>}
          <button className="clear" onClick={() => onChange('')} title="Clear (Esc)">
            <Icon name="close" size={9} />
          </button>
        </>
      )}
    </div>
  )
}
