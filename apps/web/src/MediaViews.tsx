import { Icon } from './Icon'
import { useRemembered, useScrollMemory } from './viewState'
import {
  APP_LIST,
  AUDIOBOOKS,
  fmtBytes,
  fmtMin,
  PODCAST_LIST,
  RADIO_GENRES,
  STORE_CHARTS,
  STORE_FEATURED,
  type Show,
} from './media'

const art = (hue: number) => ({ background: `linear-gradient(150deg, hsl(${hue} 52% 58%), hsl(${(hue + 40) % 360} 46% 38%))` })
const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })

/* ---------------- TV / Podcasts / Audiobooks: shows + episodes ---------------- */

function ShowsView({ shows, unit, source }: { shows: Show[]; unit: string; source: string }) {
  const [sel, setSel] = useRemembered(`${source}.show`, shows[0]?.id)
  const list = useScrollMemory<HTMLDivElement>(`${source}.shows`)
  const episodes = useScrollMemory<HTMLDivElement>(`${source}.episodes`)
  const show = shows.find((s) => s.id === sel) ?? shows[0]
  return (
    <div className="media split">
      <div className="show-list" ref={list.ref} onScroll={list.onScroll}>
        {shows.map((s) => (
          <button key={s.id} className={`show ${s.id === show.id ? 'on' : ''}`} onClick={() => setSel(s.id)}>
            <div className="art" style={art(s.hue)} />
            <div className="meta">
              <span className="t">{s.title}</span>
              <span className="s">
                {s.subtitle} · {s.episodes.length} {unit}
              </span>
            </div>
            {s.episodes.some((e) => e.unplayed) && <span className="badge">{s.episodes.filter((e) => e.unplayed).length}</span>}
          </button>
        ))}
      </div>
      <div className="ep-list">
        <div className="ep-head">
          <span className="c-dot" />
          <span className="c-name">Name</span>
          <span className="c-time">Time</span>
          <span className="c-date">Release Date</span>
          <span className="c-size">Size</span>
        </div>
        <div className="ep-body" ref={episodes.ref} onScroll={episodes.onScroll}>
          {show.episodes.map((e, i) => (
            <div key={e.id} className={`ep ${i % 2 ? 'odd' : ''}`}>
              <span className="c-dot">{e.unplayed && <i />}</span>
              <span className="c-name">
                {e.season > 1 ? `${e.season}×${String(e.index).padStart(2, '0')} · ` : ''}
                {e.title}
              </span>
              <span className="c-time num">{fmtMin(e.runtime)}</span>
              <span className="c-date">{day(e.date)}</span>
              <span className="c-size num">{fmtBytes(e.size)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export const PodcastsView = () => <ShowsView shows={PODCAST_LIST} unit="episodes" source="podcasts" />
export const AudiobooksView = () => <ShowsView shows={AUDIOBOOKS} unit="chapters" source="audiobooks" />

/* ---------------- Apps: icon grid ---------------- */

export function AppsView() {
  const pane = useScrollMemory<HTMLDivElement>('apps')
  return (
    <div className="media" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="shelf apps">
        {APP_LIST.map((a) => (
          <button key={a.id} className="poster">
            <div className="art app" style={art(a.hue)}>
              <Icon name="apps" size={22} />
            </div>
            <span className="t">{a.name}</span>
            <span className="s">
              {a.category} · {fmtBytes(a.size)}
            </span>
            <span className="s dim">
              v{a.version}
              {a.universal ? ' · Universal' : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ---------------- Radio: genre → streams ---------------- */

export function RadioView() {
  const [open, setOpen] = useRemembered<string | null>('radio.genre', RADIO_GENRES[0].name)
  const pane = useScrollMemory<HTMLDivElement>('radio')
  return (
    <div className="media radio">
      <div className="ep-head">
        <span className="c-name">Stream</span>
        <span className="c-time">Bit Rate</span>
        <span className="c-date">Listeners</span>
      </div>
      <div className="ep-body" ref={pane.ref} onScroll={pane.onScroll}>
        {RADIO_GENRES.map((g) => (
          <div key={g.name}>
            <button className="genre" onClick={() => setOpen(open === g.name ? null : g.name)}>
              <span className={`tri ${open === g.name ? 'open' : ''}`} />
              {g.name}
              <em className="dim">({g.stations.length} streams)</em>
            </button>
            {open === g.name &&
              g.stations.map((s, i) => (
                <div key={s.id} className={`ep ${i % 2 ? 'odd' : ''}`}>
                  <span className="c-name indent">
                    <Icon name="radio" size={10} /> {s.name}
                  </span>
                  <span className="c-time num">{s.bitrate} kbps</span>
                  <span className="c-date num">{s.listeners.toLocaleString('en-US')}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------------- iTunes Store: fake storefront ---------------- */

export function StoreView({ purchased }: { purchased: boolean }) {
  const pane = useScrollMemory<HTMLDivElement>(purchased ? 'purchased' : 'store')
  if (purchased) {
    return (
      <div className="media store" ref={pane.ref} onScroll={pane.onScroll}>
        <h2>Purchased</h2>
        <div className="charts">
          {STORE_CHARTS.slice(0, 2).map((c) => (
            <div key={c.title} className="chart">
              <h3>{c.title.replace('Top', 'Recently Purchased')}</h3>
              <ol>
                {c.rows.slice(0, 6).map((row) => (
                  <li key={row}>
                    <span>{row}</span>
                    <Icon name="cloud" size={11} className="dim" />
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="media store" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="banners">
        {STORE_FEATURED.map((f) => (
          <button key={f.id} className="banner" style={art(f.hue)}>
            <b>{f.title}</b>
            <span>{f.subtitle}</span>
          </button>
        ))}
      </div>
      <div className="charts">
        {STORE_CHARTS.map((c) => (
          <div key={c.title} className="chart">
            <h3>{c.title}</h3>
            <ol>
              {c.rows.map((row, i) => (
                <li key={row}>
                  <em>{i + 1}</em>
                  <span>{row}</span>
                  <button className="buy">BUY</button>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Status-bar summary per source, so the bottom line is never stale. */
export function mediaSummary(id: string) {
  const total = (xs: Show[]) => xs.reduce((a, s) => a + s.episodes.length, 0)
  switch (id) {
    case 'podcasts':
      return `${PODCAST_LIST.length} podcasts, ${total(PODCAST_LIST)} episodes`
    case 'audiobooks':
      return `${AUDIOBOOKS.length} audiobooks, ${total(AUDIOBOOKS)} chapters`
    case 'apps':
      return `${APP_LIST.length} apps, ${fmtBytes(APP_LIST.reduce((a, x) => a + x.size, 0))}`
    case 'radio':
      return `${RADIO_GENRES.reduce((a, g) => a + g.stations.length, 0)} streams in ${RADIO_GENRES.length} genres`
    default:
      return ''
  }
}
