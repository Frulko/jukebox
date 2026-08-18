import { Icon } from './Icon'
import { useRemembered, useScrollMemory } from './viewState'
import {
  APP_LIST,
  AUDIOBOOKS,
  fmtBytes,
  fmtMin,
  PODCAST_LIST,
  RADIO_GENRES,
  type Show,
} from './media'
import { getLocale } from './i18n'

const art = (hue: number) => ({ background: `linear-gradient(150deg, hsl(${hue} 52% 58%), hsl(${(hue + 40) % 360} 46% 38%))` })
const day = (ms: number) => new Date(ms).toLocaleDateString(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' })

/* ---------------- TV / Podcasts / Audiobooks: shows + episodes ---------------- */

function ShowsView({ shows, unit, source, search }: { shows: Show[]; unit: string; source: string; search: string }) {
  const [sel, setSel] = useRemembered(`${source}.show`, shows[0]?.id)
  const list = useScrollMemory<HTMLDivElement>(`${source}.shows`)
  const episodes = useScrollMemory<HTMLDivElement>(`${source}.episodes`)

  // A show stays in the list if it matches by name, or if any of its episodes
  // does — searching for an episode you half-remember should not require
  // remembering which show it was in.
  const q = search.trim().toLowerCase()
  const hits = (s: string) => s.toLowerCase().includes(q)
  const visible = q
    ? shows.filter((s) => hits(s.title) || hits(s.subtitle) || s.episodes.some((e) => hits(e.title)))
    : shows
  const show = visible.find((s) => s.id === sel) ?? visible[0]
  // Inside the chosen show, narrow to the matching episodes — unless the show
  // itself is the match, in which case it is the whole show you were after.
  const showMatches = show ? hits(show.title) || hits(show.subtitle) : false
  const eps = q && show && !showMatches ? show.episodes.filter((e) => hits(e.title)) : show?.episodes ?? []

  if (!show) {
    return (
      <div className="media split">
        <div className="list-empty">Nothing matches “{search}”</div>
      </div>
    )
  }
  return (
    <div className="media split">
      <div className="show-list" ref={list.ref} onScroll={list.onScroll}>
        {visible.map((s) => (
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
          {eps.map((e, i) => (
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

export const PodcastsView = ({ search }: { search: string }) => (
  <ShowsView shows={PODCAST_LIST} unit="episodes" source="podcasts" search={search} />
)
export const AudiobooksView = ({ search }: { search: string }) => (
  <ShowsView shows={AUDIOBOOKS} unit="chapters" source="audiobooks" search={search} />
)

/* ---------------- Apps: icon grid ---------------- */

export function AppsView({ search }: { search: string }) {
  const pane = useScrollMemory<HTMLDivElement>('apps')
  const q = search.trim().toLowerCase()
  const apps = q
    ? APP_LIST.filter((a) => a.name.toLowerCase().includes(q) || a.category.toLowerCase().includes(q))
    : APP_LIST
  return (
    <div className="media" ref={pane.ref} onScroll={pane.onScroll}>
      {q && apps.length === 0 && <div className="list-empty">Nothing matches “{search}”</div>}
      <div className="shelf apps">
        {apps.map((a) => (
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

export function RadioView({ search }: { search: string }) {
  const [open, setOpen] = useRemembered<string | null>('radio.genre', RADIO_GENRES[0].name)
  const pane = useScrollMemory<HTMLDivElement>('radio')
  // Searching opens every genre that has a hit: a station buried in a collapsed
  // genre is the same as no result at all.
  const q = search.trim().toLowerCase()
  const genres = q
    ? RADIO_GENRES.map((g) => ({ ...g, stations: g.stations.filter((s) => s.name.toLowerCase().includes(q)) }))
        .filter((g) => g.stations.length > 0 || g.name.toLowerCase().includes(q))
    : RADIO_GENRES
  return (
    <div className="media radio">
      <div className="ep-head">
        <span className="c-name">Stream</span>
        <span className="c-time">Bit Rate</span>
        <span className="c-date">Listeners</span>
      </div>
      <div className="ep-body" ref={pane.ref} onScroll={pane.onScroll}>
        {q && genres.length === 0 && <div className="list-empty">Nothing matches “{search}”</div>}
        {genres.map((g) => (
          <div key={g.name}>
            <button className="genre" onClick={() => setOpen(open === g.name ? null : g.name)}>
              <span className={`tri ${q || open === g.name ? 'open' : ''}`} />
              {g.name}
              <em className="dim">({g.stations.length} streams)</em>
            </button>
            {(q || open === g.name) &&
              g.stations.map((s, i) => (
                <div key={s.id} className={`ep ${i % 2 ? 'odd' : ''}`}>
                  <span className="c-name indent">
                    <Icon name="radio" size={10} /> {s.name}
                  </span>
                  <span className="c-time num">{s.bitrate} kbps</span>
                  <span className="c-date num">{s.listeners.toLocaleString(getLocale())}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}
