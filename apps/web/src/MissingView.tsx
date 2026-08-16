import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { MissingTrack } from '@jukebox/client-sdk'
import { api, useMissing, useSources } from './api'
import { fmtTime } from './data'
import { Icon } from './Icon'
import { useScrollMemory } from './viewState'
import { useViewSearch, ViewSearch } from './ViewSearch'

const when = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * The tracks whose files the scanner can no longer find.
 *
 * "Missing" means *not seen by the last complete scan*, so an unplugged drive
 * shows its whole contents here — which is correct rather than alarming, and the
 * page says so instead of leaving the reader to guess. Nothing was deleted: the
 * rows still hold the ratings and play counts, and the playlists still point at
 * them. Plug the disk back, rescan, and they come back with their history.
 *
 * Grouped by source, because that is the unit of the answer: files do not go
 * missing one at a time, a volume does.
 */
export function MissingView() {
  const qc = useQueryClient()
  const pane = useScrollMemory<HTMLDivElement>('missing')
  const { data, isPending } = useMissing()
  const sources = useSources().data?.items ?? []
  const [scanning, setScanning] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const search = useViewSearch()
  const all = data?.items ?? []
  const items = all.filter((t) => search.matches(t.name, t.artist, t.album, t.path))
  const groups = useMemo(() => {
    const by = new Map<string, MissingTrack[]>()
    for (const t of items) by.set(t.sourceId, [...(by.get(t.sourceId) ?? []), t])
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [items])

  const rescan = async (sourceId: string) => {
    setScanning(sourceId)
    setFailed(null)
    try {
      await api.sources.scan(sourceId)
      // The job does the work; the list refreshes when it reports back.
      qc.invalidateQueries({ queryKey: ['jobs'] })
    } catch (err) {
      // A source on an unplugged disk refuses the scan, which is the most likely
      // reason to be on this page at all. Saying so beats a button that flickers.
      setFailed(err instanceof Error ? err.message : 'The source did not answer')
    } finally {
      setScanning(null)
    }
  }

  if (isPending) return <div className="media"><div className="list-empty">Looking for what is gone…</div></div>

  if (items.length === 0) {
    return (
      <div className="media">
        <div className="list-empty">Every file in the library is where it should be.</div>
      </div>
    )
  }

  return (
    <div className="media missing" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="view-head">
        <ViewSearch
          value={search.query}
          onChange={search.setQuery}
          placeholder="Filter by name, artist or path"
          count={items.length}
        />
      </div>

      <p className="missing-lead">
        {all.length.toLocaleString('en-US')} track{all.length > 1 ? 's' : ''} the last scan could not find.
        Nothing has been deleted — ratings, play counts and playlist places are kept. If a disk was unplugged,
        plug it back and rescan: they return as they were.
      </p>

      {groups.map(([sourceId, list]) => {
        const source = sources.find((s) => s.id === sourceId)
        return (
          <div key={sourceId} className="missing-group">
            <div className="missing-head">
              <h3>
                <Icon name="alert" size={12} />
                {list[0].sourceName || source?.name || sourceId}
                <em>
                  {list.length} missing
                  {source ? ` · ${source.root}` : ''}
                </em>
              </h3>
              {failed && <span className="missing-error">{failed}</span>}
              <button className="prim" disabled={scanning === sourceId} onClick={() => rescan(sourceId)}>
                {scanning === sourceId ? 'Rescanning…' : 'Rescan this source'}
              </button>
            </div>

            <div className="ep-head">
              <span className="c-name">Name</span>
              <span className="c-artist">Artist</span>
              <span className="c-time">Time</span>
              <span className="c-date">Last seen</span>
              <span className="c-path">Where it was</span>
            </div>
            <div className="ep-body">
              {list.map((t, i) => (
                <div key={t.id} className={`ep missing-row ${i % 2 ? 'odd' : ''}`}>
                  <span className="c-name">{t.name}</span>
                  <span className="c-artist">
                    {t.artist}
                    {t.album ? <em className="dim"> — {t.album}</em> : null}
                  </span>
                  <span className="c-time num">{fmtTime(t.duration)}</span>
                  <span className="c-date">{when(t.deletedAt)}</span>
                  {/* The path is the actionable part: it says which drive to plug in. */}
                  <span className="c-path" title={t.path}>{t.path}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
