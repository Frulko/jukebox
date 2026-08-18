import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { CommandResult, Plugin } from '@jukebox/client-sdk'
import { api } from './api'
import { Icon } from './Icon'
import { useScrollMemory } from './viewState'

/** A recommender a plugin declares: a label, and the command that produces it. */
type Source = {
  pluginId: string
  pluginName: string
  id: string
  label: string
  command: string
  description?: string
  /** Installed but switched off still contributes — it says so instead of hiding. */
  runnable: boolean
}

function sourcesOf(plugins: Plugin[]): Source[] {
  return plugins.flatMap((p) => {
    const zone = p.contributes?.recommendations
    if (!Array.isArray(zone)) return []
    // SAFETY: the zone is manifest data — an array of { id?, label, command,
    // description? } strings the plugin declared; the filter right below drops
    // any entry missing the two fields a recommender cannot run without.
    return (zone as Array<Record<string, string>>)
      .filter((c) => c.label && c.command)
      .map((c) => ({
        pluginId: p.id,
        pluginName: p.name,
        id: c.id ?? `${p.id}.${c.command}`,
        label: c.label,
        command: c.command,
        description: c.description,
        runnable: p.state === 'active',
      }))
  })
}

/**
 * One suggestion, and the only question worth asking about it: do you have it?
 *
 * A recommender names either a track or an artist — the sitewide charts of most
 * services rank artists — and the two are answered differently. `name` equal to
 * `artist` is the artist case, which the shape carries without a second field
 * nobody would remember to set: "Aphex Twin by Aphex Twin" is not a song.
 *
 * Asked of the server rather than of the page: the library is thousands of
 * tracks and the page holds a few hundred, so "do I own this" is a question
 * only the server can answer. Cached, and a suggestion list is a dozen names.
 */
function Suggestion({
  item,
  onPlay,
  onOpenArtist,
}: {
  item: { name: string; artist: string; why?: string }
  onPlay: (id: string) => void
  onOpenArtist: (artist: string) => void
}) {
  const isArtist = item.name.trim().toLowerCase() === item.artist.trim().toLowerCase()
  const found = useQuery({
    queryKey: ['tracks', 'have', isArtist ? 'artist' : 'track', item.artist, item.name],
    queryFn: () =>
      isArtist
        ? api.tracks.list({ artist: item.artist, limit: 200 })
        : api.tracks.list({ q: item.name, limit: 10 }),
    staleTime: 60_000,
  })
  const items = found.data?.items ?? []
  const mine = isArtist
    ? items[0]
    : items.find(
        (t) =>
          t.name.toLowerCase() === item.name.toLowerCase() &&
          (t.artist.toLowerCase() === item.artist.toLowerCase() ||
            t.albumArtist.toLowerCase() === item.artist.toLowerCase()),
      )

  return (
    <li className={`sug ${mine ? 'have' : ''}`}>
      <Icon name={isArtist ? 'artists' : 'music'} size={10} className="dim" />
      <span className="n">{item.name}</span>
      {!isArtist && <span className="a dim">{item.artist}</span>}
      {item.why && <em className="dim why">{item.why}</em>}
      <span className="spacer" />
      {found.isPending ? (
        <span className="dim">…</span>
      ) : mine ? (
        <>
          {/* How much of them you have is the useful number for an artist:
              "one track" and "four albums" are different answers to "do you
              know this one". */}
          {isArtist && (
            <span className="dim">
              {items.length}
              {items.length === 200 ? '+' : ''} in your library
            </span>
          )}
          <button onClick={() => (isArtist ? onOpenArtist(item.artist) : onPlay(mine.id))}>
            {isArtist ? 'Open' : 'Play'}
          </button>
        </>
      ) : (
        // No "get it" button, and not an oversight: whether a track can be
        // obtained depends on what is installed, and this page's job is to say
        // what is worth hearing — not to imply a shop that may not exist.
        <span className="dim">not in your library</span>
      )}
    </li>
  )
}

/**
 * What is worth hearing, from whatever is plugged in.
 *
 * This replaces a fabricated iTunes Store: two pages of invented charts and
 * invented "purchases", none of which could be played, bought or dismissed. The
 * honest version of a discovery page in an app that owns no catalogue is a page
 * that shows **what your own integrations say** — a scrobbler knows what you
 * play, and services built on that know what people who play it also play.
 *
 * So the host draws nothing of its own here. A plugin declares
 * `contributes.recommendations`, the host runs the command and renders what
 * comes back, and each suggestion is checked against the library so the page
 * can say "you have this" rather than sending you looking. With nothing
 * plugged in the page says exactly that, because a discovery page with no
 * source is empty — inventing charts to fill it is how the old one got here.
 */
export function DiscoverView({
  onPlay,
  onOpenArtist,
}: {
  onPlay: (id: string) => void
  /** An artist you already have is a place in the library, not a suggestion. */
  onOpenArtist: (artist: string) => void
}) {
  const pane = useScrollMemory<HTMLDivElement>('discover')
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list(), staleTime: 60_000 })
  const [results, setResults] = useState<Record<string, CommandResult | { error: string } | 'asking'>>({})

  const sources = sourcesOf(plugins.data?.items ?? [])

  const run = async (s: Source) => {
    setResults((r) => ({ ...r, [s.id]: 'asking' }))
    try {
      const out = await api.plugins.command(s.pluginId, s.command)
      setResults((r) => ({ ...r, [s.id]: out }))
    } catch (err) {
      setResults((r) => ({
        ...r,
        [s.id]: { error: err instanceof Error ? err.message : 'the plugin did not answer' },
      }))
    }
  }

  return (
    <div className="media discover" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="view-head">
        <h2>Discover</h2>
      </div>

      <p className="discover-lead">
        Nothing here is invented. This page shows what the integrations you have installed say is
        worth hearing — a scrobbler knows what you play, and the services built on that know what
        people who play it also play. Every suggestion is checked against your library, so it says
        whether you already own it.
      </p>

      {plugins.isPending && <p className="dim">Asking the server which plugins are installed…</p>}

      {!plugins.isPending && sources.length === 0 && (
        <div className="discover-empty">
          <h3>No plugin here offers recommendations yet</h3>
          <p className="dim">
            A plugin declares them in its manifest — a label and a command per recommender — and this
            page runs them. The two that ship with the server are scrobblers: they send what you
            play, they do not ask anything back. Install one that does, or enable it in{' '}
            <b>Server → Plugins</b>, and its sources appear here.
          </p>
          <p className="dim">
            Until then this page is empty on purpose. It used to be a store with invented charts and
            invented purchases, none of which could be played or bought, and an empty page that says
            why beats a full one that is not true.
          </p>
        </div>
      )}

      {sources.map((s) => {
        const state = results[s.id]
        return (
          <div key={s.id} className="discover-source">
            <div className="ds-head">
              <Icon name="star" size={11} />
              <b>{s.label}</b>
              <em className="dim">{s.pluginName}</em>
              {s.description && <span className="dim ds-what">{s.description}</span>}
              <span className="spacer" />
              <button
                disabled={!s.runnable || state === 'asking'}
                title={s.runnable ? undefined : 'This plugin is installed but switched off'}
                onClick={() => void run(s)}
              >
                {state === 'asking' ? 'Asking…' : state ? 'Again' : 'Show me'}
              </button>
            </div>

            {state && state !== 'asking' && 'error' in state && (
              <p className="pod-add-error">{state.error}</p>
            )}

            {state && state !== 'asking' && !('error' in state) && state.kind === 'suggestions' && (
              <ul className="sug-list">
                {state.items.map((item, i) => (
                  <Suggestion
                    key={`${item.artist}-${item.name}-${i}`}
                    item={item}
                    onPlay={onPlay}
                    onOpenArtist={onOpenArtist}
                  />
                ))}
                {state.items.length === 0 && <li className="dim">It had nothing to suggest.</li>}
              </ul>
            )}

            {/* A recommender is free to answer in prose — "here is what your
                year sounded like" — and the host draws text as text. */}
            {state && state !== 'asking' && !('error' in state) && state.kind === 'text' && (
              <pre className="plugin-text">{state.body}</pre>
            )}

            {state && state !== 'asking' && !('error' in state) &&
              state.kind !== 'suggestions' && state.kind !== 'text' && (
                <p className="dim">
                  {state.kind === 'done' ? state.message ?? 'Done.' : `It answered with a ${state.kind}.`}
                </p>
              )}
          </div>
        )
      })}
    </div>
  )
}
