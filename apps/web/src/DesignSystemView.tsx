import { useState } from 'react'
import { useSources } from './api'
import { Icon } from './Icon'
import { ICON_NAMES } from './iconPaths'
import { FolderBrowser, FolderRow } from './FolderBrowser'
import { ViewSearch } from './ViewSearch'
import { useScrollMemory } from './viewState'

/**
 * The kit, laid out to be looked at.
 *
 * Every control below is the real component with its real classes — nothing is
 * redrawn for the page — so this cannot drift from the app: a rule that breaks
 * a button breaks it here first, in every state at once. Theming is shown the
 * only honest way there is: the theme picker in the status bar reskins this
 * page live, because components read tokens and nothing else.
 */

/** The tokens, grouped the way the CSS declares them. Names are the contract. */
const TOKEN_GROUPS: Array<[string, string[]]> = [
  ['Chrome', ['--chrome', '--chrome-line', '--chrome-text', '--status', '--lcd', '--lcd-line', '--track-bg']],
  ['Buttons', ['--btn', '--btn-line', '--btn-text', '--btn-on', '--btn-on-line', '--btn-on-text']],
  ['Sidebar', ['--sidebar', '--sidebar-line', '--sidebar-text', '--sidebar-section', '--sidebar-sel', '--sidebar-sel-text']],
  ['Content', ['--content', '--text', '--dim', '--line', '--line-soft', '--panel', '--stripe']],
  ['Table', ['--head', '--head-line', '--head-text', '--head-sorted', '--sel', '--sel-text', '--sel-blur']],
  ['Fields & accent', ['--field', '--field-line', '--accent', '--focus', '--menu', '--menu-text', '--menu-line', '--star', '--star-off']],
]

const METRICS = ['--font', '--font-mono', '--fs', '--row-h', '--row-radius', '--radius', '--page-x', '--page-top', '--page-bottom']

function Swatch({ name }: { name: string }) {
  // Computed at render: the theme attribute is already on the root when the
  // repaint that follows a theme switch reaches this page.
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return (
    <div className="token" title={value}>
      <i style={{ background: `var(${name})` }} />
      <div>
        <b>{name}</b>
        <em>{value || '—'}</em>
      </div>
    </div>
  )
}

export function DesignSystemView() {
  const pane = useScrollMemory<HTMLDivElement>('design')
  const sources = useSources().data?.items ?? []
  const [src, setSrc] = useState<string | null>(null)
  const [fold, setFold] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [chip, setChip] = useState(false)

  return (
    <div className="media design" ref={pane.ref} onScroll={pane.onScroll}>
      <h2>Design system</h2>
      <p className="dim">
        Every component of the app, in every state, drawn with its real classes. Components read the
        tokens below and nothing else — pick another skin in the status bar and this whole page
        re-dresses without one component changing.
      </p>

      <section>
        <h3>Colour tokens</h3>
        <p className="spec">
          A theme is one block that redefines tokens — never layout. The value shown is what the
          current theme resolves it to.
        </p>
        {TOKEN_GROUPS.map(([group, names]) => (
          <div key={group}>
            <h4>{group}</h4>
            <div className="token-grid">
              {names.map((n) => (
                <Swatch key={n} name={n} />
              ))}
            </div>
          </div>
        ))}
      </section>

      <section>
        <h3>Type & metrics</h3>
        <p className="type-sample" style={{ fontFamily: 'var(--font)' }}>
          The reading face — <b>bold</b>, <span className="dim">dim</span>, and{' '}
          <code>--font-mono for paths and anything typed back</code>.
        </p>
        <div className="token-grid">
          {METRICS.map((n) => (
            <div key={n} className="token">
              <div>
                <b>{n}</b>
                <em>{getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '—'}</em>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3>Buttons</h3>
        <p className="spec">
          Every <code>&lt;button&gt;</code> is skinned by default — a button nobody wrote a rule for
          is a plain kit button, never the browser's. <code>.prim</code> / <code>.default</code>{' '}
          carry the accent, <code>.danger</code> is for what cannot be undone, disabled is opacity.
        </p>
        <div className="row">
          <button>Button</button>
          <button className="prim">
            <Icon name="plus" size={9} /> Primary
          </button>
          <button className="default">Default</button>
          <button className="danger">Danger</button>
          <button disabled>Disabled</button>
          <button>
            <Icon name="sync" size={10} /> With an icon
          </button>
        </div>
        <h4>Small & segmented</h4>
        <div className="row">
          <button className="sb-btn" title="Status bar button">
            <Icon name="plus" size={9} />
          </button>
          <button className="sb-btn on" title="Status bar button, on">
            <Icon name="shuffle" size={10} />
          </button>
          <span className="seg">
            <button className="on">
              <Icon name="folder" size={10} />
            </button>
            <button>
              <Icon name="queue" size={10} />
            </button>
          </span>
          <button className="buy">BUY</button>
        </div>
        <h4>Tabs & modes</h4>
        <div className="row">
          <span className="tabs" style={{ padding: 0, background: 'none', border: 0 }}>
            <button className="on">Open tab</button>
            <button>Other tab</button>
          </span>
          <span className="modebar" style={{ padding: 0, border: 0 }}>
            <button className="on">Songs</button>
            <button>Albums</button>
            <button>Artists</button>
          </span>
        </div>
        <h4>Filter chips</h4>
        <div className="row">
          <button className={`chip ${chip ? 'on' : ''}`} onClick={() => setChip((v) => !v)}>
            Format{chip && <b>FLAC</b>}
            <i className="tri" />
          </button>
          <button className="chip on">
            Rating<b>★★★★ and up</b>
          </button>
          <button className="chip clear">Clear</button>
        </div>
      </section>

      <section>
        <h3>Fields</h3>
        <p className="spec">
          Hand-drawn controls: the OS checkbox, radio and select belong to no theme. The
          half-ticked box is a real state — a list of hundreds is usually half-ticked.
        </p>
        <div className="row">
          <input type="text" placeholder="Text field" />
          <input type="number" defaultValue={2008} style={{ width: 60 }} />
          <select defaultValue="b">
            <option value="a">Select</option>
            <option value="b">Another choice</option>
          </select>
          <input type="range" min={0} max={100} defaultValue={40} />
        </div>
        <div className="row">
          <label>
            <input type="checkbox" /> Off
          </label>
          <label>
            <input type="checkbox" defaultChecked /> On
          </label>
          <label>
            <input
              type="checkbox"
              ref={(el) => {
                if (el) el.indeterminate = true
              }}
            />{' '}
            Half of them
          </label>
          <label>
            <input type="checkbox" disabled defaultChecked /> Disabled
          </label>
          <label>
            <input type="radio" name="ds-radio" /> Radio
          </label>
          <label>
            <input type="radio" name="ds-radio" defaultChecked /> Chosen
          </label>
        </div>
        <div className="row">
          <ViewSearch value={filter} onChange={setFilter} placeholder="Filter this list" count={12} />
          <textarea defaultValue="A textarea, resizable vertically." />
        </div>
      </section>

      <section>
        <h3>Indicators</h3>
        <p className="spec">
          Only <code>warn</code> may pull the eye — if everything is coloured, the row that needs
          attention is the one you miss. Stars carry the rating, presence says which device holds a
          copy, pills say what state a thing is in.
        </p>
        <div className="row">
          <span className="badges">
            <i className="badge info">
              <Icon name="cloud" size={9} />
            </i>
            <i className="badge ok">
              <Icon name="music" size={9} />
            </i>
            <i className="badge warn">
              <Icon name="alert" size={9} />
            </i>
          </span>
          <span className="stars">
            {[1, 2, 3, 4, 5].map((n) => (
              <i key={n} className={n <= 3 ? 'on' : 'off'}>
                <Icon name="star" size={10} />
              </i>
            ))}
          </span>
          <span className="presence">
            <i>iP</i>
            <i>N</i>
          </span>
          <em className="p-state active">active</em>
          <em className="p-state failed">failed</em>
          <em className="p-state disabled">disabled</em>
          <span className="sc-flag on">read &amp; write</span>
          <span className="sc-flag">read only</span>
        </div>
      </section>

      <section>
        <h3>Folder browser</h3>
        <p className="spec">
          One way to point at a folder wherever the question comes up — filing episodes already on
          disk, hunting for where a missing file went. A tree to walk down, a flat list to scan,
          and a filter; the flat rows are <code>FolderRow</code>, which also stands alone in any
          list that names a folder.
        </p>
        <div className="fb-demo">
          {sources.length ? (
            <FolderBrowser
              sourceId={src ?? sources[0].id}
              onSource={setSrc}
              folder={fold}
              onFolder={setFold}
            />
          ) : (
            <p className="dim">No source to browse — add one under Sources.</p>
          )}
        </div>
        <h4>FolderRow on its own</h4>
        <div className="fb-demo">
          <FolderRow path="Air/Moon Safari/" count={12} />
          <FolderRow path="A Tribe Called Quest/The Low End Theory/" count={11} on />
          <FolderRow path="Loose files" />
        </div>
      </section>

      <section>
        <h3>Icons</h3>
        <p className="spec">
          One monochrome set, drawn on a 16-square grid, inheriting <code>currentColor</code>. A
          theme may redraw glyphs it needs heavier — Studio does — and everything it does not name
          falls back to these.
        </p>
        <div className="icon-grid">
          {ICON_NAMES.map((n) => (
            <div key={n} className="icon-cell" title={n}>
              <Icon name={n} size={12} />
              <span>{n}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
