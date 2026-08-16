import { useMemo } from 'react'
import type { Track } from '@jukebox/client-sdk'
import { useTracks } from './api'
import { Icon } from './Icon'
import { fmtSize } from './data'
import { useTrackMenu, type TrackActions } from './TrackMenu'
import { useRemembered, useScrollMemory } from './viewState'

/** Deterministic colour for a book with no cover, so one looks like itself. */
const hue = (id: string) => [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 11)
const art = (id: string) => ({
  background: `linear-gradient(150deg, hsl(${hue(id)} 46% 52%), hsl(${(hue(id) + 40) % 360} 42% 34%))`,
})

/** Hours and minutes: a chapter is not three minutes long, and 74:12 is unreadable. */
const length = (s: number) =>
  s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}min` : `${Math.round(s / 60)} min`

/**
 * Audiobooks, from the library.
 *
 * This drew six invented books with invented chapters that could not be played.
 * The library has had them all along: the scanner files an `.m4b` as
 * `kind: 'audiobook'`, which is what keeps them out of Songs, and a book is an
 * album of chapters like any other album — so this is a grouping, not a store
 * of its own.
 *
 * A chapter plays with the rest of the book behind it, because that is the only
 * queue anybody wants here: the next chapter, not a shuffle of the library.
 */
export function AudiobooksView({
  search,
  nowPlaying,
  onPlay,
  actions,
}: {
  search: string
  nowPlaying: string | null
  onPlay: (id: string, queue?: string[]) => void
  actions: TrackActions
}) {
  const { data, isPending } = useTracks({ kind: 'audiobook', limit: 500, sort: 'album' })
  const menu = useTrackMenu(actions)
  const list = useScrollMemory<HTMLDivElement>('audiobooks.list')
  const body = useScrollMemory<HTMLDivElement>('audiobooks.chapters')
  const [sel, setSel] = useRemembered<string | null>('audiobooks.book', null)

  const books = useMemo(() => {
    const by = new Map<string, { key: string; title: string; author: string; chapters: Track[] }>()
    for (const t of data?.items ?? []) {
      const key = `${t.albumArtist} — ${t.album}`
      const book = by.get(key) ?? { key, title: t.album || t.name, author: t.albumArtist || t.artist, chapters: [] }
      book.chapters.push(t)
      by.set(key, book)
    }
    for (const b of by.values()) b.chapters.sort((a, z) => a.discNumber - z.discNumber || a.trackNumber - z.trackNumber)
    return [...by.values()].sort((a, z) => a.title.localeCompare(z.title))
  }, [data])

  const q = search.trim().toLowerCase()
  const hits = (s: string) => s.toLowerCase().includes(q)
  const visible = q ? books.filter((b) => hits(b.title) || hits(b.author) || b.chapters.some((c) => hits(c.name))) : books
  const book = visible.find((b) => b.key === sel) ?? visible[0]
  // Inside the chosen book, narrow to matching chapters — unless the book
  // itself is the match, in which case the whole book is what was wanted.
  const bookMatches = book ? hits(book.title) || hits(book.author) : false
  const chapters = q && book && !bookMatches ? book.chapters.filter((c) => hits(c.name)) : book?.chapters ?? []
  const ids = chapters.map((c) => c.id)

  if (isPending) return <div className="media split"><div className="list-empty">Asking the server…</div></div>
  if (!books.length) {
    return (
      <div className="media split">
        <div className="list-empty">
          No audiobooks yet. A file the scanner reads as one — an <code>.m4b</code>, or anything you set
          to Audiobook in Get Info — appears here rather than among the songs.
        </div>
      </div>
    )
  }
  if (!book) return <div className="media split"><div className="list-empty">Nothing matches “{search}”</div></div>

  return (
    <div className="media split audiobooks">
      {menu.node}
      <div className="show-list" ref={list.ref} onScroll={list.onScroll}>
        {visible.map((b) => (
          <button key={b.key} className={`show ${b.key === book.key ? 'on' : ''}`} onClick={() => setSel(b.key)}>
            <div className="art" style={art(b.key)} />
            <div className="meta">
              <span className="t">{b.title}</span>
              <span className="s">
                {b.author || 'Unknown'} · {b.chapters.length} chapter{b.chapters.length === 1 ? '' : 's'}
              </span>
              <span className="s">{length(b.chapters.reduce((a, c) => a + c.duration, 0))}</span>
            </div>
          </button>
        ))}
      </div>

      <div className="ep-list">
        <div className="ep-head">
          <span className="c-dot" />
          <span className="c-name">Chapter</span>
          <span className="c-time">Time</span>
          <span className="c-date">Format</span>
          <span className="c-size">Size</span>
        </div>
        <div className="ep-body" ref={body.ref} onScroll={body.onScroll}>
          {!chapters.length && <div className="list-empty">Nothing matches “{search}”</div>}
          {chapters.map((c, i) => (
            <div
              key={c.id}
              className={`ep ${i % 2 ? 'odd' : ''} ${c.id === nowPlaying ? 'playing' : ''}`}
              onDoubleClick={() => onPlay(c.id, ids)}
              onContextMenu={(e) => menu.open(e, [c], ids)}
            >
              {/* The same speaker as a playing row in the library. One mark for
                  "this is the sound you are hearing", wherever the sound was
                  started from. */}
              <span className="c-dot">
                {c.id === nowPlaying ? <Icon name="volumeHigh" size={10} className="spk" /> : c.trackNumber || null}
              </span>
              <span className="c-name">{c.name}</span>
              <span className="c-time num">{length(c.duration)}</span>
              <span className="c-date">{c.format.toUpperCase()}</span>
              <span className="c-size num">{fmtSize(c.size)}</span>
            </div>
          ))}
        </div>
        <div className="book-foot">
          <button
            className="prim"
            disabled={!ids.length}
            onClick={() => onPlay(ids[0], ids)}
            title="From the first chapter"
          >
            <Icon name="play" size={10} /> Play the book
          </button>
          <span className="dim">
            {/* Hours, not `mm:ss`: a book is nine hours long and "539:00" is
                not a length anybody reads. */}
            {book.chapters.length} chapter{book.chapters.length === 1 ? '' : 's'} ·{' '}
            {length(book.chapters.reduce((a, c) => a + c.duration, 0))}
          </span>
        </div>
      </div>
    </div>
  )
}
