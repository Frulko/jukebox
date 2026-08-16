import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useQueryClient } from '@tanstack/react-query'
import type { MissingTrack, Source } from '@jukebox/client-sdk'
import { api, useMissing, useSources, useTracks } from './api'
import { fmtTime } from './data'
import { Icon } from './Icon'
import { useMenuPosition } from './useMenuPosition'
import { useScrollMemory } from './viewState'
import { useViewSearch, ViewSearch } from './ViewSearch'
import { DataTable } from './DataTable'
import type { features } from './tableFeatures'

/** What the sources route adds for a local source, and api-types does not name yet. */
type Mounted = Source & {
  mount?: { device: string; type: string; network: boolean; readOnly: boolean; point: string } | null
}

const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/'
const fileOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * Where a file went, and what to do about it.
 *
 * A missing track is not a broken row to be tidied away: it is a rating, a play
 * count and a place in three playlists, waiting for a disk. So this answers the
 * two questions actually being asked — *where was it* and *is it somewhere else
 * now* — and offers only what is real. It does not open a Finder window,
 * because a web page cannot; it hands over the path instead, which is what you
 * paste into one.
 *
 * The search is the part worth having. A file that was moved rather than lost
 * comes back into the library under its new path at the next scan, so the same
 * name and artist may well be sitting there already — under a different id, in
 * a different folder, with none of this row's history attached to it.
 */
function WhereDidItGo({
  track,
  source,
  onClose,
  onRescan,
}: {
  track: MissingTrack
  source: Mounted | undefined
  onClose: () => void
  onRescan: () => void
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const elsewhere = useTracks({ q: track.name, limit: 5 }, true)
  // Name *and* artist. A library holds a dozen tracks called "Intro", and
  // offering them as "it may have moved here" is a worse answer than none.
  const others = (elsewhere.data?.items ?? []).filter(
    (t) => t.name === track.name && t.artist === track.artist)

  const copy = (what: string, value: string) => {
    const done = navigator.clipboard?.writeText(value)
    // No clipboard at all (an insecure origin) reads the same as one that
    // refused: either way the button did nothing, and a button that did nothing
    // in silence is the thing to avoid. The path stays on screen to select.
    if (!done) return setCopied('The browser would not let us copy — select it above')
    void done.then(
      () => setCopied(`${what} copied`),
      () => setCopied('The browser would not let us copy — select it above'),
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal where-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-titlebar">
          <button className="close" onClick={onClose} />
          <span>{track.name} — where did it go?</span>
        </div>

        <div className="modal-body">
          <h4>It was here</h4>
          <dl className="file-info">
            <div>
              <dt>Source</dt>
              <dd>
                {source ? source.name : track.sourceName || track.sourceId}
                {source?.mount ? (
                  <span className="dim">
                    {' '}· on {source.mount.device} ({source.mount.type}
                    {source.mount.network ? ', network' : ''})
                  </span>
                ) : source && 'mount' in source ? (
                  // `mount: null` is the server saying it looked and the path is
                  // on no filesystem this machine currently has — the disk is
                  // out, which is usually the whole answer. An *absent* key is a
                  // server that did not look, and claiming "not mounted" for it
                  // would be inventing the most alarming reading of silence.
                  <span className="gone"> · not mounted</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Folder</dt>
              <dd className="path" title={folderOf(track.path)}>{folderOf(track.path)}</dd>
            </div>
            <div>
              <dt>File</dt>
              <dd className="path" title={fileOf(track.path)}>{fileOf(track.path)}</dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>{when(track.deletedAt)}</dd>
            </div>
          </dl>

          {/* Why the row is worth keeping rather than tidying away. */}
          <h4 className="file-where">What it carries</h4>
          <dl className="file-info">
            <div>
              <dt>Rating</dt>
              <dd>{track.rating ? '★'.repeat(track.rating) : <span className="dim">none</span>}</dd>
            </div>
            <div>
              <dt>Plays</dt>
              <dd>{track.playCount || <span className="dim">none</span>}</dd>
            </div>
          </dl>

          <h4 className="file-where">Elsewhere in your library</h4>
          {elsewhere.isPending && <p className="dim">Looking…</p>}
          {!elsewhere.isPending && others.length === 0 && (
            <p className="dim">Nothing else in the library has that name — it has not simply moved.</p>
          )}
          {others.map((t) => (
            <div key={t.id} className="where-found">
              <Icon name="music" size={10} />
              <span className="n">{t.artist || t.albumArtist}</span>
              <span className="path" title={t.path}>{t.path}</span>
            </div>
          ))}
        </div>

        <div className="modal-foot">
          <span className="dim">{copied ?? ''}</span>
          <button onClick={() => copy('Folder', folderOf(track.path))}>Copy folder</button>
          <button onClick={() => copy('Path', track.path)}>Copy path</button>
          <button className="default" onClick={onRescan}>Rescan this source</button>
        </div>
      </div>
    </div>
  )
}

const h = createColumnHelper<typeof features, MissingTrack>()

/**
 * The same table the rest of the app uses, so a hundred missing files sort,
 * resize and scroll like everything else rather than being a list of divs that
 * happens to look similar.
 */
const columns = [
  h.accessor('name', { header: 'Name', size: 230 }),
  h.accessor('artist', {
    header: 'Artist',
    size: 200,
    cell: (c) => (
      <>
        {c.getValue()}
        {c.row.original.album ? <em className="dim"> — {c.row.original.album}</em> : null}
      </>
    ),
  }),
  h.accessor('duration', { header: 'Time', size: 58, cell: (c) => <span className="num">{fmtTime(c.getValue())}</span> }),
  h.accessor('deletedAt', { header: 'Last seen', size: 110, cell: (c) => when(c.getValue()) }),
  // The path is the actionable column — it names the drive to plug back in — so
  // it gets the room, and the ellipsis falls at the front where the prefix repeats.
  h.accessor('path', { header: 'Where it was', size: 320, cell: (c) => <span className="c-path">{c.getValue()}</span> }),
]

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
  /** Pointed at, right-clicked, and opened: three states of the same row. */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; track: MissingTrack } | null>(null)
  const [asking, setAsking] = useState<MissingTrack | null>(null)
  const menuPosition = useMenuPosition(menu)

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

  const sourceOf = (t: MissingTrack) => (sources as Mounted[]).find((x) => x.id === t.sourceId)

  return (
    <div className="media missing" ref={pane.ref} onScroll={pane.onScroll} onMouseDown={() => setMenu(null)}>
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

            <DataTable
              data={list}
              columns={columns}
              getRowId={(t) => t.id}
              memoryKey={`missing:${sourceId}`}
              rowHeight={22}
              empty="Nothing matches."
              selected={selected}
              onSelectedChange={setSelected}
              // Double-click plays a track everywhere else in the app; here
              // there is nothing to play, and the question the row raises is
              // "where did it go" — so that is what it opens.
              onRowDoubleClick={(t) => setAsking(t)}
              onRowContextMenu={(t, e) => {
                e.preventDefault()
                if (!selected.has(t.id)) setSelected(new Set([t.id]))
                setMenu({ x: e.clientX, y: e.clientY, track: t })
              }}
            />
          </div>
        )
      })}

      {menu && (
        <div
          className="ctx"
          ref={menuPosition.setFloating}
          style={menuPosition.floatingStyles}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button onClick={() => (setAsking(menu.track), setMenu(null))}>Where did it go…</button>
          <hr />
          <button onClick={() => (void navigator.clipboard?.writeText(menu.track.path), setMenu(null))}>
            Copy path
          </button>
          <button onClick={() => (void navigator.clipboard?.writeText(folderOf(menu.track.path)), setMenu(null))}>
            Copy folder
          </button>
          <hr />
          <button onClick={() => (rescan(menu.track.sourceId), setMenu(null))}>
            Rescan {sourceOf(menu.track)?.name ?? menu.track.sourceName ?? 'this source'}
          </button>
        </div>
      )}

      {asking && (
        <WhereDidItGo
          track={asking}
          source={sourceOf(asking)}
          onClose={() => setAsking(null)}
          onRescan={() => (rescan(asking.sourceId), setAsking(null))}
        />
      )}
    </div>
  )
}
