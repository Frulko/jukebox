import { useQuery } from '@tanstack/react-query'
import type { Episode, Podcast, Track } from '@jukebox/client-sdk'
import { api } from './api'
import { Icon } from './Icon'
import { fmtBytes } from './media'
import { useRemembered, useScrollMemory } from './viewState'

/** The publisher's host, for a line that says where the sound comes from. */
export const hostOf = (url: string) => {
  try { return new URL(url).hostname } catch { return 'the publisher' }
}

/**
 * An episode dressed as a track, for the parts of the interface that only know
 * how to show a track — the LCD, the cover, the marquee.
 *
 * The id is prefixed `ep:` deliberately: it is not a library id, and anything
 * tempted to send it to the server has to notice.
 */
export function episodeAsTrack(e: Episode, show: Podcast): Track {
  return {
    id: `ep:${e.id}`,
    sourceId: '',
    path: e.enclosureUrl ?? '',
    kind: 'podcast',
    name: e.title,
    artist: show.author || show.title,
    albumArtist: show.author || show.title,
    album: show.title,
    genre: 'Podcast',
    composer: '',
    year: e.pubDate ? new Date(e.pubDate).getFullYear() : 0,
    trackNumber: e.episodeNumber ?? 0,
    trackCount: 0,
    discNumber: e.season ?? 1,
    duration: e.duration,
    bitRate: 0,
    sampleRate: 0,
    format: (e.enclosureType || '').split('/')[1] ?? '',
    size: e.enclosureLength,
    rating: 0,
    loved: false,
    enabled: true,
    comments: '',
    grouping: '',
    bpm: 0,
    compilation: false,
    playCount: 0,
    skipCount: 0,
    dateAdded: e.pubDate ?? 0,
    lastPlayed: null,
    artwork: e.imageUrl ?? show.imageUrl,
    devices: [],
    tags: [],
    renditions: [],
    rev: 0,
  }
}

/**
 * An episode's length, in seconds — which is what the server stores, and what
 * the fabricated list this replaced did not: it held minutes, so the first real
 * feed rendered a forty-minute episode as forty hours.
 */
const runtime = (s: number) =>
  s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}min` : `${Math.round(s / 60)} min`

const day = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : ''

/** Deterministic colour for a feed with no artwork, so a show looks like itself. */
const hue = (id: string) => [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)
const art = (id: string) => ({
  background: `linear-gradient(150deg, hsl(${hue(id)} 52% 58%), hsl(${(hue(id) + 40) % 360} 46% 38%))`,
})

/**
 * Podcasts, from the server.
 *
 * This view used to draw a fabricated list: eight invented shows with invented
 * episodes, which looked right and could not be played, subscribed to or
 * refreshed. The server has had feeds, episodes, download state and a refresh
 * job all along.
 *
 * The distinction the rows exist to make is **downloaded or not**. A downloaded
 * episode is a track in the library: it plays like any other, it queues, and
 * what comes next is the rest of the show. An episode that is only in the feed
 * has nothing here but a URL at the publisher — it can still be played, and the
 * status line says where the sound is coming from, because "in your library"
 * and "streaming from someone else's server" are not the same thing to anyone
 * who has ever been on a train.
 */
export function PodcastsView({
  search,
  nowPlaying,
  onPlayEpisode,
}: {
  search: string
  nowPlaying: string | null
  onPlayEpisode: (episode: Episode, show: Podcast, downloaded: string[]) => void
}) {
  const shows = useQuery({ queryKey: ['podcasts'], queryFn: () => api.podcasts.list(), staleTime: 60_000 })
  const items = shows.data?.items ?? []

  const [sel, setSel] = useRemembered<string | null>('podcasts.show', null)
  const list = useScrollMemory<HTMLDivElement>('podcasts.shows')
  const body = useScrollMemory<HTMLDivElement>('podcasts.episodes')

  const q = search.trim().toLowerCase()
  const hits = (s: string) => s.toLowerCase().includes(q)
  const visible = q ? items.filter((s) => hits(s.title) || hits(s.author)) : items
  const show = visible.find((s) => s.id === sel) ?? visible[0]

  const episodes = useQuery({
    queryKey: ['podcasts', show?.id, 'episodes'],
    queryFn: () => api.podcasts.episodes(show!.id, { limit: 200 }),
    enabled: !!show,
    staleTime: 30_000,
  })
  const eps = (episodes.data?.items ?? []).filter((e) => !q || hits(show?.title ?? '') || hits(e.title))
  // What the show can queue: an undownloaded episode has no track to queue.
  const downloaded = eps.map((e) => e.trackId).filter((id): id is string => !!id)

  if (shows.isPending) return <div className="media split"><div className="list-empty">Asking the server…</div></div>
  if (!items.length) {
    return (
      <div className="media split">
        <div className="list-empty">
          No podcasts yet. Subscribe to a feed and its episodes appear here.
        </div>
      </div>
    )
  }
  if (!show) {
    return <div className="media split"><div className="list-empty">Nothing matches “{search}”</div></div>
  }

  return (
    <div className="media split">
      <div className="show-list" ref={list.ref} onScroll={list.onScroll}>
        {visible.map((s) => (
          <button key={s.id} className={`show ${s.id === show.id ? 'on' : ''}`} onClick={() => setSel(s.id)}>
            {s.imageUrl ? (
              <img className="art" src={s.imageUrl} alt="" />
            ) : (
              <div className="art" style={art(s.id)} />
            )}
            <div className="meta">
              <span className="t">{s.title}</span>
              <span className="s">
                {s.author || 'Unknown'} · {s.episodeCount} episode{s.episodeCount === 1 ? '' : 's'}
              </span>
              {/* A feed that has been failing for weeks is the one thing a list
                  of podcasts must not keep to itself. */}
              {s.lastError && (
                <span className="s err" title={s.lastError}>
                  <Icon name="alert" size={9} /> {s.lastError}
                </span>
              )}
            </div>
            {s.downloadedCount > 0 && <span className="badge">{s.downloadedCount}</span>}
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
        <div className="ep-body" ref={body.ref} onScroll={body.onScroll}>
          {episodes.isPending && <div className="list-empty">Asking the server…</div>}
          {!episodes.isPending && !eps.length && (
            <div className="list-empty">
              {q ? `Nothing matches “${search}”` : 'This feed has no episodes yet — refresh it.'}
            </div>
          )}
          {eps.map((e, i) => (
            <div
              key={e.id}
              className={`ep ${i % 2 ? 'odd' : ''} ${e.trackId && e.trackId === nowPlaying ? 'playing' : ''}`}
              onDoubleClick={() => onPlayEpisode(e, show, downloaded)}
              title={e.trackId ? 'In your library' : 'Not downloaded — plays from the publisher'}
            >
              {/* Unplayed is a dot, downloaded is the disc: two facts, two
                  marks, because an episode can be either without the other. */}
              <span className="c-dot">{!e.played && <i />}</span>
              <span className="c-name">
                {e.trackId ? (
                  <Icon name="music" size={9} className="ep-have" />
                ) : (
                  <Icon name="cloud" size={9} className="ep-remote dim" />
                )}
                {e.season && e.season > 1 ? `${e.season}×${String(e.episodeNumber ?? 0).padStart(2, '0')} · ` : ''}
                {e.title}
              </span>
              <span className="c-time num">{e.duration ? runtime(e.duration) : '—'}</span>
              <span className="c-date">{day(e.pubDate)}</span>
              <span className="c-size num">{e.enclosureLength ? fmtBytes(e.enclosureLength) : '—'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
