import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Radio, RadioHit } from '@jukebox/client-sdk'
import { api } from './api'
import { Icon } from './Icon'
import { Cover } from './Artwork'
import { useRemembered, useScrollMemory } from './viewState'
import { t, useLocale } from './i18n'

/**
 * A station's logo, or a cover made from its name.
 *
 * The server has been finding these all along — off the stream's `icy-url`, off
 * the homepage favicon, off the directory — and storing them in `imageUrl`;
 * this page simply never drew them. A logo lives on somebody else's web server,
 * so it is the one image in this app that can be a 404 by tomorrow: `onError`
 * falls through to the generated cover rather than leaving a broken frame,
 * which also covers every station the probe found nothing for.
 */
function StationArt({ station, size }: { station: Pick<Radio, 'name' | 'streamUrl' | 'imageUrl'>; size: number }) {
  const [broken, setBroken] = useState(false)
  if (station.imageUrl && !broken) {
    return (
      <img
        className="st-art"
        src={station.imageUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setBroken(true)}
      />
    )
  }
  // Seeded on the name, not the id: two libraries holding the same station draw
  // the same cover, and re-adding one does not change how it looks.
  return <Cover seed={station.name || station.streamUrl} size={size} label={size >= 96 ? station.name : undefined} />
}

/**
 * Internet radio, from the server.
 *
 * The list used to be forty invented stations in six invented genres: nothing
 * could be added, renamed or played. The server has had the whole of it —
 * stations, a discovery probe that fills in a name, a genre and a logo from the
 * stream itself, and the editing to correct what the probe got wrong.
 *
 * A station is not a track, and this page does not pretend otherwise. There is
 * no duration, no queue and no next: it plays until it is stopped. What is
 * *on* right now would come from the stream's own metadata, which the browser
 * cannot read off an `<audio>` element — that needs the server to proxy the
 * stream and parse it, and until it does, this page says nothing about it
 * rather than showing an empty title that looks broken.
 */
export function RadioView({
  search,
  nowPlaying,
  onPlayStream,
  onNotice,
}: {
  search: string
  /** The id of whatever is playing, `radio:<id>` while a station is on. */
  nowPlaying: string | null
  onPlayStream: (station: Radio) => void
  onNotice: (message: string) => void
}) {
  useLocale()
  const qc = useQueryClient()
  const pane = useScrollMemory<HTMLDivElement>('radio')
  const { data, isPending } = useQuery({ queryKey: ['radios'], queryFn: () => api.radios.list(), staleTime: 60_000 })
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What the directory proposed, and for what question — the heading has to say
  // what was searched, or a stale panel reads as an answer to the new input.
  const [proposals, setProposals] = useState<{ q: string; items: RadioHit[] } | null>(null)
  const [searching, setSearching] = useState(false)
  const [addingHit, setAddingHit] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  // Two views because a station is two things at once. Browsing is visual —
  // logos are how anyone recognises a station — while renaming, re-probing and
  // removing are a list of rows with controls. One layout doing both makes the
  // covers small enough to be pointless or the buttons too far apart to use.
  const [layout, setLayout] = useRemembered<'grid' | 'list'>('radio.layout', 'grid')

  const stations = data?.items ?? []
  const q = search.trim().toLowerCase()
  const hits = (s: string) => (s ?? '').toLowerCase().includes(q)
  const shown = q ? stations.filter((s) => hits(s.name) || hits(s.genre) || hits(s.country)) : stations

  const genres = useMemo(() => {
    const by = new Map<string, Radio[]>()
    for (const s of shown) {
      const key = s.genre || 'Unfiled'
      by.set(key, [...(by.get(key) ?? []), s])
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [shown])

  const refresh = () => qc.invalidateQueries({ queryKey: ['radios'] })

  const add = async () => {
    const streamUrl = url.trim()
    if (!streamUrl || adding) return
    setAdding(true)
    setError(null)
    try {
      // Discovery on by default: pasting a URL and being handed a name, a genre
      // and a logo is the difference between adding a station and typing one in.
      const made = await api.radios.create({ streamUrl })
      setUrl('')
      refresh()
      onNotice(
        made.probeError
          // Added anyway: a station that would not answer *now* is often one
          // that answers this evening, and refusing to save it loses the URL.
          ? `Added, but the stream did not answer: ${made.probeError}`
          : `Added ${made.name}${made.codec ? ` · ${made.codec.toUpperCase()}` : ''}`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the server refused that URL')
    } finally {
      setAdding(false)
    }
  }

  const patch = (id: string, p: Partial<Radio>) => api.radios.update(id, p).then(refresh)

  /**
   * One field, two questions. A URL is a stream to add; anything else is a name
   * to look up in the community directory (Radio-Browser) — which is where the
   * logo, the canonical stream and the right bitrate live when the stream's own
   * headers say nothing. Typing "fip" beats hunting down an icecast URL.
   */
  const isUrl = /^https?:\/\//i.test(url.trim())

  const searchStations = async () => {
    const q = url.trim()
    if (!q || searching) return
    setSearching(true)
    setError(null)
    try {
      const r = await api.radios.search(q)
      setProposals({ q, items: r.items })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the directory did not answer')
    } finally {
      setSearching(false)
    }
  }

  const owned = new Set(stations.map((s) => s.streamUrl))

  const addHit = async (h: RadioHit) => {
    if (addingHit) return
    setAddingHit(h.streamUrl)
    try {
      // The directory already answered everything a probe would ask, with a
      // better source for the logo — `discover: false` makes the add instant.
      const { votes: _ranked, ...station } = h
      const made = await api.radios.create({ ...station, discover: false })
      refresh()
      onNotice(`Added ${made.name}${made.codec ? ` · ${made.codec.toUpperCase()}` : ''}`)
    } catch (err) {
      onNotice(err instanceof Error ? err.message : `Could not add ${h.name}`)
    } finally {
      setAddingHit(null)
    }
  }

  return (
    <div className="media radio stations" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="view-head">
        <h2>Radio</h2>
        <div className="seg">
          <button className={layout === 'grid' ? 'on' : ''} title={t('Covers')} onClick={() => setLayout('grid')}>
            <Icon name="albums" size={10} />
          </button>
          <button className={layout === 'list' ? 'on' : ''} title={t('List')} onClick={() => setLayout('list')}>
            <Icon name="columns" size={10} />
          </button>
        </div>
        <form
          className="radio-add"
          onSubmit={(e) => {
            e.preventDefault()
            void (isUrl ? add() : searchStations())
          }}
        >
          <input
            value={url}
            placeholder="A station name to search, or a stream URL to add"
            onChange={(e) => (setUrl(e.target.value), setError(null))}
          />
          <button type="submit" disabled={!url.trim() || adding || searching}>
            {adding ? 'Listening…' : searching ? 'Asking…' : isUrl ? 'Add station' : 'Search'}
          </button>
        </form>
      </div>
      {error && <div className="pod-add-error">{error}</div>}

      {proposals && (
        <div className="radio-genre">
          <h3>
            Proposed for “{proposals.q}”
            <em className="dim">
              {proposals.items.length
                ? `best-voted first, from the community directory`
                : 'the community directory knows no station by that name'}
            </em>
            <span className="spacer" />
            <button onClick={() => setProposals(null)}>Dismiss</button>
          </h3>
          {proposals.items.map((h) => {
            const had = owned.has(h.streamUrl)
            return (
              <div key={h.streamUrl} className="station">
                <StationArt station={h} size={18} />
                <span className="st-name">{h.name}</span>
                <span className="dim st-what">
                  {[
                    h.country,
                    h.codec ? h.codec.toUpperCase() : null,
                    h.bitrate ? `${h.bitrate} kbps` : null,
                    h.votes ? `${h.votes.toLocaleString()} votes` : null,
                  ].filter(Boolean).join(' · ')}
                </span>
                <span className="spacer" />
                {h.homepageUrl && (
                  <a className="st-home" href={h.homepageUrl} target="_blank" rel="noreferrer" title={h.homepageUrl}>
                    Site
                  </a>
                )}
                <button disabled={had || addingHit === h.streamUrl} onClick={() => void addHit(h)}>
                  {had ? 'In your stations' : addingHit === h.streamUrl ? 'Adding…' : 'Add'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {isPending && <p className="dim">Asking the server…</p>}
      {!isPending && stations.length === 0 && !proposals && (
        <p className="dim">
          No stations yet. Type a name above to search the community directory, or paste a stream
          URL — the server listens to it once and fills in the name, the genre and the logo, which
          you can then correct.
        </p>
      )}
      {!isPending && stations.length > 0 && shown.length === 0 && (
        <div className="list-empty">Nothing matches “{search}”</div>
      )}

      {genres.map(([genre, list]) => (
        <div key={genre} className="radio-genre">
          <h3>
            {genre}
            <em className="dim">
              {list.length} station{list.length === 1 ? '' : 's'}
            </em>
          </h3>

          {layout === 'grid' && (
            <div className="grid stations-grid">
              {list.map((s) => {
                const playing = nowPlaying === `radio:${s.id}`
                return (
                  <div key={s.id} className={`tile ${playing ? 'on' : ''}`}>
                    <button className="tile-art" onClick={() => onPlayStream(s)} title={s.streamUrl}>
                      <StationArt station={s} size={148} />
                      <span className="hover-play">
                        <Icon name={playing ? 'volumeHigh' : 'play'} size={13} />
                      </span>
                    </button>
                    <button
                      className={`tile-fav ${s.favorite ? 'on' : ''}`}
                      title={s.favorite ? 'A favourite' : 'Mark as a favourite'}
                      onClick={() => void patch(s.id, { favorite: s.favorite ? 0 : 1 })}
                    >
                      <Icon name="star" size={11} />
                    </button>
                    <span className="tile-t">{s.name}</span>
                    {/* The same line the list shows, and just as empty when the
                        stream said nothing — a tile that invents a bitrate to
                        look complete is worse than one that admits the gap. */}
                    <span className="tile-s">
                      {[s.country, s.codec?.toUpperCase(), s.bitrate ? `${s.bitrate} kbps` : null]
                        .filter(Boolean)
                        .join(' · ') || 'nothing known yet'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {layout === 'list' && list.map((s) => {
            const playing = nowPlaying === `radio:${s.id}`
            return (
              <div key={s.id} className={`station ${playing ? 'playing' : ''}`}>
                {/* The logo here too, at row height: recognising a station by
                    its mark is the point, and it should not depend on which
                    view you happen to be in. */}
                <StationArt station={s} size={18} />
                <button
                  className="st-play"
                  title={playing ? 'Playing' : 'Play this station'}
                  onClick={() => onPlayStream(s)}
                >
                  <Icon name={playing ? 'volumeHigh' : 'play'} size={11} />
                </button>

                {editing === s.id ? (
                  <input
                    className="st-rename"
                    autoFocus
                    defaultValue={s.name}
                    onBlur={(e) => {
                      const name = e.target.value.trim()
                      if (name && name !== s.name) void patch(s.id, { name })
                      setEditing(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  // Double-click to rename, as a playlist in the sidebar does.
                  <span className="st-name" onDoubleClick={() => setEditing(s.id)}>
                    {s.name}
                  </span>
                )}

                <span className="dim st-what">
                  {[s.country, s.codec?.toUpperCase(), s.bitrate ? `${s.bitrate} kbps` : null]
                    .filter(Boolean)
                    .join(' · ') || 'nothing known about the stream yet'}
                </span>

                <span className="spacer" />

                <button
                  className={`st-fav ${s.favorite ? 'on' : ''}`}
                  title={s.favorite ? 'A favourite' : 'Mark as a favourite'}
                  onClick={() => void patch(s.id, { favorite: s.favorite ? 0 : 1 })}
                >
                  <Icon name="star" size={11} />
                </button>
                {s.homepageUrl && (
                  <a className="st-home" href={s.homepageUrl} target="_blank" rel="noreferrer" title={s.homepageUrl}>
                    Site
                  </a>
                )}
                <button
                  title="Ask the stream again for what it is — fills blanks, never overwrites a rename"
                  onClick={() =>
                    api.radios
                      .discover(s.id)
                      .then((r) => {
                        refresh()
                        onNotice(r.probeError ? `${s.name}: ${r.probeError}` : `${r.name} answered`)
                      })
                      .catch(() => onNotice(`${s.name} did not answer`))
                  }
                >
                  Re-probe
                </button>
                {/* Two clicks rather than a browser dialog, and the second says
                    what is actually lost: the URL, not any audio. */}
                <button
                  className={confirming === s.id ? 'danger' : ''}
                  onClick={() => {
                    if (confirming !== s.id) return setConfirming(s.id)
                    api.radios.remove(s.id).then(() => {
                      setConfirming(null)
                      refresh()
                      onNotice(`Removed ${s.name}`)
                    })
                  }}
                  onBlur={() => setConfirming(null)}
                >
                  {confirming === s.id ? 'Really remove?' : 'Remove'}
                </button>
              </div>
            )
          })}
        </div>
      ))}

      {stations.length > 0 && (
        <p className="radio-note">
          A station plays until you stop it: no length, no queue, no next. What is <b>on</b> right now
          travels inside the stream as metadata, and a browser cannot read that off an audio element —
          the server would have to proxy the stream and parse it. Until it does, this page says nothing
          about it rather than showing an empty title that looks broken.
        </p>
      )}
    </div>
  )
}
