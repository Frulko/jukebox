import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Radio } from '@jukebox/client-sdk'
import { api } from './api'
import { Icon } from './Icon'
import { useScrollMemory } from './viewState'

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
  const qc = useQueryClient()
  const pane = useScrollMemory<HTMLDivElement>('radio')
  const { data, isPending } = useQuery({ queryKey: ['radios'], queryFn: () => api.radios.list(), staleTime: 60_000 })
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

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

  return (
    <div className="media radio stations" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="view-head">
        <h2>Radio</h2>
        <form
          className="radio-add"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <input
            value={url}
            placeholder="Stream URL — the server works out the rest"
            onChange={(e) => (setUrl(e.target.value), setError(null))}
          />
          <button type="submit" disabled={!url.trim() || adding}>
            {adding ? 'Listening…' : 'Add station'}
          </button>
        </form>
      </div>
      {error && <div className="pod-add-error">{error}</div>}

      {isPending && <p className="dim">Asking the server…</p>}
      {!isPending && stations.length === 0 && (
        <p className="dim">
          No stations yet. Paste a stream URL above — the server listens to it once and fills in the
          name, the genre and the logo, which you can then correct.
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
          {list.map((s) => {
            const playing = nowPlaying === `radio:${s.id}`
            return (
              <div key={s.id} className={`station ${playing ? 'playing' : ''}`}>
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
                  onClick={() => void patch(s.id, { favorite: (s.favorite ? 0 : 1) as 0 | 1 })}
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
