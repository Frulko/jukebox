import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Episode, Podcast, Track } from '@jukebox/client-sdk'
import { api, usePodcasts, useTracks } from './api'
import { AddPodcast } from './AddPodcast'
import { Icon } from './Icon'
import { fmtBytes } from './media'
import { hostOf } from './podcasts'
import { useRemembered, useScrollMemory } from './viewState'
import { getLocale } from './i18n'

const NO_TRACKS: Track[] = []

/**
 * An episode's length, in seconds — which is what the server stores, and what
 * the fabricated list this replaced did not: it held minutes, so the first real
 * feed rendered a forty-minute episode as forty hours.
 */
const runtime = (s: number) =>
  s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}min` : `${Math.round(s / 60)} min`

const day = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : ''

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
  onPlay,
  onNotice,
}: {
  search: string
  nowPlaying: string | null
  onPlayEpisode: (episode: Episode, show: Podcast, downloaded: string[]) => void
  /** For episodes that are simply files: they are library tracks and play like any. */
  onPlay: (id: string, queue?: string[]) => void
  onNotice: (message: string) => void
}) {
  const qc = useQueryClient()
  const shows = usePodcasts()
  const [addOpen, setAddOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Episodes the library holds as files: what the folder half of "Add a
  // podcast" produces, and what a feed's downloads are too.
  // The fallback is a module constant: a fresh `[]` on every render while the
  // query loads would re-run the grouping memo below for nothing.
  const onDisk = useTracks({ kind: 'podcast', limit: 500, sort: 'album' }).data?.items ?? NO_TRACKS
  const diskShows = useMemo(() => {
    const by = new Map<string, { key: string; title: string; tracks: typeof onDisk }>()
    for (const t of onDisk) {
      // Grouped by folder, not by album: this section is about *where the files
      // are*, and two shows can carry the same album tag while a folder is one
      // place. It is also what distinguishes these rows from the feed above
      // when a feed's downloads land here too.
      const key = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : 'Loose files'
      const show = by.get(key) ?? { key, title: key.split('/').pop() || key, tracks: [] }
      show.tracks.push(t)
      by.set(key, show)
    }
    return [...by.values()].sort((a, b) => a.title.localeCompare(b.title))
  }, [onDisk])

  const refreshShows = () => {
    qc.invalidateQueries({ queryKey: ['podcasts'] })
    qc.invalidateQueries({ queryKey: ['tracks'] })
  }
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
  // Feeds *or* files: a folder just filed as a podcast is a podcast, and the
  // page saying "No podcasts yet" over it while the status bar says "1 episode
  // filed" was the page and the app disagreeing about the same fact.
  if (!items.length && !diskShows.length) {
    return (
      <div className="media split">
        <div className="pod-empty">
          <p>
            No podcasts yet. Subscribe to a feed, or point at a folder of episodes you already have.
          </p>
          <div className="pod-add">
            <button className="prim" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={9} /> Add a podcast
            </button>
          </div>
          {addOpen && (
            <AddPodcast onClose={() => setAddOpen(false)} onNotice={onNotice} onAdded={refreshShows} />
          )}
        </div>
      </div>
    )
  }
  if (!show && !diskShows.length) {
    return <div className="media split"><div className="list-empty">Nothing matches “{search}”</div></div>
  }

  // With no feed to open — none subscribed, or the search hid them all — the
  // right pane falls back to the first folder of files rather than a blank.
  const disk = sel?.startsWith('disk:')
    ? diskShows.find((d) => `disk:${d.key}` === sel)
    : show ? undefined : diskShows[0]

  return (
    <div className="media split podcasts">
      <div className="show-col">
        {/* A button rather than a URL field: there are two ways a podcast gets
            into a library — a feed you subscribe to and a folder you already
            have — and a box labelled "Feed URL" makes the second invisible. */}
        <div className="pod-add">
          <button className="prim" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={9} /> Add a podcast
          </button>
        </div>
      <div className="show-list" ref={list.ref} onScroll={list.onScroll}>
        {visible.map((s) => (
          <button key={s.id} className={`show ${s.id === show?.id ? 'on' : ''}`} onClick={() => setSel(s.id)}>
            {s.imageUrl ? (
              <img className="art" src={s.imageUrl} alt="" />
            ) : (
              <div className="art" style={art(s.id)} />
            )}
            <div className="meta">
              {/* A feed subscribed a second ago has no title yet, and one that
                  never answers never will: the URL is what the person typed and
                  the only name that is certainly true. */}
              <span className="t">{s.title || hostOf(s.feedUrl)}</span>
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

        {/* Files, not subscriptions. A feed's downloaded episodes are here too,
            because they *are* episodes on disk — the feed's own row says "In
            your library" about the same file, which is one fact from two
            directions rather than a duplicate. */}
        {diskShows.length > 0 && (
          <>
            <div className="pod-section">Episodes on disk</div>
            {diskShows.map((d) => (
              <button
                key={d.key}
                className={`show ${sel === `disk:${d.key}` ? 'on' : ''}`}
                onClick={() => setSel(`disk:${d.key}`)}
              >
                <div className="art" style={art(d.key)} />
                <div className="meta">
                  <span className="t">{d.title}</span>
                  <span className="s" title={d.key}>
                    {d.tracks.length} episode{d.tracks.length === 1 ? '' : 's'} · {d.key}
                  </span>
                </div>
              </button>
            ))}
          </>
        )}
      </div>
      </div>

      {disk ? (
        <div className="ep-list">
          <div className="show-head">
            <div className="sh-meta">
              <b>{disk.title}</b>
              <span className="dim">
                {disk.tracks.length} episode{disk.tracks.length === 1 ? '' : 's'} on disk · no feed to
                check, so nothing new appears by itself
              </span>
            </div>
            <div className="sh-actions">
              <button
                onClick={() => {
                  // Back among the songs. The same one call that filed them,
                  // which is why filing needed no confirmation.
                  void api.tracks
                    .patch(disk.tracks.map((t) => t.id), { kind: 'music' })
                    .then(() => {
                      refreshShows()
                      setSel(null)
                      onNotice(`${disk.title} is back among the songs`)
                    })
                }}
              >
                Not a podcast
              </button>
            </div>
          </div>
          <div className="ep-head">
            <span className="c-dot" />
            <span className="c-name">Name</span>
            <span className="c-time">Time</span>
            <span className="c-date">Added</span>
            <span className="c-where">Where</span>
            <span className="c-size">Size</span>
          </div>
          <div className="ep-body" ref={body.ref} onScroll={body.onScroll}>
            {disk.tracks.map((t, i) => (
              <div
                key={t.id}
                className={`ep ${i % 2 ? 'odd' : ''} ${t.id === nowPlaying ? 'playing' : ''}`}
                onDoubleClick={() => onPlay(t.id, disk.tracks.map((x) => x.id))}
              >
                <span className="c-dot">
                  {t.id === nowPlaying ? <Icon name="volumeHigh" size={10} className="spk" /> : null}
                </span>
                <span className="c-name">
                  <Icon name="music" size={9} className="ep-have" />
                  {t.name}
                </span>
                <span className="c-time num">{t.duration ? runtime(t.duration) : '—'}</span>
                <span className="c-date">{day(t.dateAdded)}</span>
                <span className="c-where dim">In your library</span>
                <span className="c-size num">{t.size ? fmtBytes(t.size) : '—'}</span>
              </div>
            ))}
          </div>
        </div>
      ) : show ? (
      <div className="ep-list">
        {/* Where this show comes from, and what to do about it. The feed URL is
            shown rather than hidden behind a settings dialog: it is the whole
            identity of a podcast, and the thing you paste somewhere else. */}
        <div className="show-head">
          <div className="sh-meta">
            <b>{show.title || hostOf(show.feedUrl)}</b>
            <a className="sh-feed" href={show.feedUrl} target="_blank" rel="noreferrer" title={show.feedUrl}>
              <Icon name="cloud" size={9} /> {show.feedUrl}
            </a>
            <span className="dim">
              {show.downloadedCount} of {show.episodeCount} downloaded
              {show.lastFetchAt ? ` · checked ${day(show.lastFetchAt)}` : ' · never checked'}
              {show.cron ? '' : ' · manual refresh only'}
            </span>
          </div>
          <div className="sh-actions">
            <label className="sh-toggle" title="New episodes are fetched into the library as they appear">
              <input
                type="checkbox"
                checked={!!show.autoDownload}
                onChange={(e) =>
                  api.podcasts.update(show.id, { autoDownload: e.target.checked }).then(refreshShows)
                }
              />
              <span>Download new episodes</span>
            </label>
            <button
              onClick={() =>
                api.podcasts
                  .refresh(show.id)
                  .then(() => onNotice(`Refreshing ${show.title}…`))
                  .catch(() => onNotice(`${show.title} could not be refreshed`))
              }
            >
              <Icon name="sync" size={10} /> Refresh
            </button>
            {/* Two clicks rather than a `confirm()`: the browser's dialog
                blocks the page, looks nothing like the app, and says the wrong
                thing. The second click also carries the answer to the question
                people actually have — what happens to what they downloaded. */}
            <button
              className={confirming ? 'danger' : ''}
              title={confirming ? 'Downloaded episodes stay in your library' : undefined}
              onClick={() => {
                if (!confirming) return setConfirming(true)
                api.podcasts.unsubscribe(show.id).then(() => {
                  setConfirming(false)
                  setSel(null)
                  refreshShows()
                  onNotice(`Unsubscribed from ${show.title} — downloaded episodes stay in your library`)
                })
              }}
              onBlur={() => setConfirming(false)}
            >
              {confirming ? 'Really unsubscribe?' : 'Unsubscribe'}
            </button>
          </div>
        </div>
        <div className="ep-head">
          <span className="c-dot" />
          <span className="c-name">Name</span>
          <span className="c-time">Time</span>
          <span className="c-date">Release Date</span>
          <span className="c-where">Where</span>
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
              {/* Three states, one column, in order of what is happening now:
                  the speaker if this is the sound you are hearing — the same
                  mark as a playing row in the library — otherwise a dot if it
                  has not been listened to, otherwise nothing. */}
              <span className="c-dot">
                {e.trackId && e.trackId === nowPlaying ? (
                  <Icon name="volumeHigh" size={10} className="spk" />
                ) : !e.played ? (
                  <i />
                ) : null}
              </span>
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
              {/* The distinction in words, not only in a glyph: one of these is
                  a file you have, the other is somebody else's server. */}
              <span className={`c-where ${e.trackId ? '' : 'dim'}`}>
                {e.trackId ? 'In your library' : e.enclosureUrl ? hostOf(e.enclosureUrl) : 'nowhere'}
              </span>
              <span className="c-size num">{e.enclosureLength ? fmtBytes(e.enclosureLength) : '—'}</span>
            </div>
          ))}
        </div>
      </div>
      ) : null}

      {addOpen && (
        <AddPodcast onClose={() => setAddOpen(false)} onNotice={onNotice} onAdded={refreshShows} />
      )}
    </div>
  )
}
