import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Playlist } from './data'
import { api, useSources } from './api'
import { Icon } from './Icon'
import { PlaylistCover } from './Artwork'
import { usePersisted, useScrollMemory } from './viewState'

/**
 * Which playlists were opened, most recent first.
 *
 * The server does not record this and should not have to: "what was I listening
 * to" is a question about this browser, not about the library. Kept as ids so a
 * renamed or deleted playlist resolves to what it is now, or to nothing.
 */
export function useRecentPlaylists() {
  const [recent, setRecent] = usePersisted<string[]>('jukebox.recent.playlists', [])
  // Stable, because navigation is built on top of it: an identity that changed
  // every render would make every consumer of `setView` re-render with it.
  const remember = useCallback(
    (id: string) => setRecent((old) => [id, ...old.filter((x) => x !== id)].slice(0, 12)),
    [setRecent],
  )
  return [recent, remember] as const
}

const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })

/**
 * The page the app opens on.
 *
 * It holds nothing of its own: recently played comes from this browser, the
 * suggestions come from whatever plugin claims the zone, and the podcast strip
 * comes from the feeds. A home page that generates its own content is a home
 * page that has to be maintained separately from everything it duplicates.
 */
export function HomeView({
  playlists,
  recent,
  onOpenPlaylist,
  onGo,
}: {
  playlists: Playlist[]
  recent: string[]
  onOpenPlaylist: (id: string, smart: string | null) => void
  onGo: (id: string) => void
}) {
  const pane = useScrollMemory<HTMLDivElement>('home')
  const podcasts = useQuery({ queryKey: ['podcasts'], queryFn: () => api.podcasts.list(), staleTime: 60_000 })
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list(), staleTime: 60_000 })
  const sources = useSources().data?.items ?? []

  const played = recent
    .map((id) => playlists.find((pl) => pl.id === id))
    .filter((pl): pl is Playlist => Boolean(pl))

  /**
   * The plugin zone.
   *
   * A plugin declares `contributes["home.section"]` and the host renders it as
   * data — title and rows, never markup. Nothing ships one yet, so the zone
   * says what it is for instead of pretending to be empty by accident.
   */
  const contributed = (plugins.data?.items ?? [])
    .filter((pl) => pl.state === 'active' && pl.contributes && 'home.section' in pl.contributes)
    .map((pl) => ({ plugin: pl.name, section: pl.contributes['home.section'] as { title?: string } }))

  return (
    <div className="media home" ref={pane.ref} onScroll={pane.onScroll}>
      <section>
        <h3>
          Recently played <em>from this browser</em>
        </h3>
        {played.length === 0 ? (
          <p className="dim">Nothing yet. Playlists you open turn up here.</p>
        ) : (
          <div className="home-strip">
            {played.map((pl) => (
              <button key={pl.id} className="home-card" onClick={() => onOpenPlaylist(pl.id, pl.smart)}>
                <PlaylistCover seed={`${pl.id} ${pl.name}`} size={120} label={pl.name} />
                <span className="t">{pl.name}</span>
                <span className="s">{pl.trackCount.toLocaleString('en-US')} tracks</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3>
          Suggested for you <em>plugin zone</em>
        </h3>
        {contributed.length === 0 ? (
          <div className="home-zone-empty">
            <Icon name="gear" size={12} />
            <p>
              This strip belongs to plugins. One that declares <code>home.section</code> — a recommender
              reading ListenBrainz or AudioMuse — fills it with playlists it built. The host renders what it
              declares as data, so no plugin code runs in this page.
            </p>
          </div>
        ) : (
          <div className="home-strip">
            {contributed.map((c) => (
              <div key={c.plugin} className="home-card">
                <span className="t">{c.section.title ?? c.plugin}</span>
                <span className="s">{c.plugin}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3>
          Podcasts <em>{podcasts.data?.items.length ? `${podcasts.data.items.length} subscribed` : ''}</em>
        </h3>
        {!podcasts.data?.items.length ? (
          <p className="dim">No feeds yet. Subscribe to one and its newest episodes appear here.</p>
        ) : (
          <div className="home-strip">
            {podcasts.data.items.map((p) => (
              <button key={p.id} className="home-card" onClick={() => onGo('podcasts')}>
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt="" className="home-art" />
                ) : (
                  <span className="home-art empty" />
                )}
                <span className="t">{p.title}</span>
                <span className={`s ${p.lastError ? 'bad' : ''}`}>
                  {/* The useful fact about a feed is when it last brought
                      something in — and, before that, whether it failed. A feed
                      dead for a month should say so on the page you open on. */}
                  {p.lastError
                    ? p.lastError
                    : p.lastFetchAt
                      ? `updated ${day(p.lastFetchAt)} · ${p.downloadedCount}/${p.episodeCount} downloaded`
                      : 'never fetched'}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {sources.length === 0 && (
        <div className="home-nudge">
          No source yet — the library is empty until one is added and scanned.
        </div>
      )}
    </div>
  )
}
