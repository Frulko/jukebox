import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useQueryClient } from '@tanstack/react-query'
import type { MissingTrack, Source } from '@jukebox/client-sdk'
import { api, useMissing, useSources, useTracks } from './api'
import { fmtTime } from './data'
import { Icon } from './Icon'
import { useMenuPosition } from './useMenuPosition'
import { useScrollMemory } from './viewState'
import { ViewSearch } from './ViewSearch'
import { useViewSearch } from './viewState'
import { DataTable } from './DataTable'
import { FolderBrowser } from './FolderBrowser'
import type { features } from './tableFeatures'
import { getLocale } from './i18n'

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
 * The search is the part worth having, and it now goes further than "is the
 * same name and artist already in the library". It searches **the sources**,
 * with whatever words you give it, because the case this exists for is a file
 * that came back under a different name: a re-rip, a different transfer, an
 * album re-tagged by somebody else's tool. Choosing one of them is a
 * substitution — the history crosses over to the file that survived, and the
 * row stops being a question.
 */
function WhereDidItGo({
  track,
  source,
  siblings,
  onClose,
  onRescan,
  onSubstituted,
}: {
  track: MissingTrack
  source: Source | undefined
  /** The other tracks of the same album that are also missing. */
  siblings: MissingTrack[]
  onClose: () => void
  onRescan: () => void
  onSubstituted: (message: string, foundSourceId: string) => void
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const elsewhere = useTracks({ q: track.name, limit: 5 }, true)
  // Name *and* artist. A library holds a dozen tracks called "Intro", and
  // offering them as "it may have moved here" is a worse answer than none.
  const others = (elsewhere.data?.items ?? []).filter(
    (t) => t.name === track.name && t.artist === track.artist)

  // The open search. Asked of the server, across every source — the page in
  // hand holds a few hundred tracks and the answer is about all of them.
  const typed = query.trim()
  const hunt = useTracks({ q: typed, limit: 30 }, typed.length > 1)
  const candidates = (hunt.data?.items ?? []).filter((t) => t.id !== track.id)

  // Browsing, for when no words find it: a re-rip keeps its folder shape long
  // after it lost its tags, so walking source → folder is how a person actually
  // remembers where music lives. Opens on the source that lost the file — if
  // the disk is back, the folder is right there.
  const sources = useSources().data?.items ?? []
  const [browseSource, setBrowseSource] = useState<string | null>(null)
  const [browseFolder, setBrowseFolder] = useState<string | null>(null)
  const browsing =
    browseSource ??
    (sources.some((s) => s.id === track.sourceId) ? track.sourceId : sources[0]?.id) ??
    null
  const inFolder = useTracks(
    { sourceId: browsing ?? undefined, folder: browseFolder ?? undefined, limit: 100 },
    !!browsing && !!browseFolder,
  )
  const folderTracks = (inFolder.data?.items ?? []).filter((t) => t.id !== track.id)

  const substitute = async (keeperId: string, keeperPath: string, keeperSourceId: string) => {
    if (busy) return
    setBusy(true)
    try {
      // Only this row. Doing the album in one call would be a bigger promise
      // than the evidence supports: the reader has looked at *this* file and
      // said "that one is the same song", which is a judgement about one track.
      const r = await api.tracks.substitute(keeperId, [track.id])
      onSubstituted(
        r.merged
          ? `${track.name} now points at ${keeperPath} — its rating and plays came across`
          : `${track.name} was already answered`,
        keeperSourceId,
      )
    } catch (err) {
      setCopied(err instanceof Error ? err.message : 'the server refused it')
    } finally {
      setBusy(false)
    }
  }

  /** A candidate file, wherever it was found: search hit or folder listing. */
  const foundRow = (t: { id: string; name: string; artist: string; path: string; sourceId: string }) => (
    <div key={t.id} className="where-found">
      <Icon name="music" size={10} />
      <span className="n">
        {t.name}
        <em className="dim"> — {t.artist}</em>
      </span>
      <span className="path" title={t.path}>{t.path}</span>
      <button disabled={busy} onClick={() => void substitute(t.id, t.path, t.sourceId)}>
        Use this
      </button>
    </div>
  )

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
              <button disabled={busy} onClick={() => void substitute(t.id, t.path, t.sourceId)}>
                Use this
              </button>
            </div>
          ))}

          {/* The open search: the same name is the easy case, and the reason
              this box exists is the hard one — a re-rip, a different transfer,
              an album somebody else's tool re-tagged. Asked of the server so
              it covers every source, not the few hundred rows on this page. */}
          <h4 className="file-where">Look through your sources</h4>
          <input
            className="where-search"
            value={query}
            placeholder={`Search every source — try “${track.artist}”`}
            onChange={(e) => (setQuery(e.target.value), setCopied(null))}
          />
          {typed.length > 1 && hunt.isPending && <p className="dim">Asking the server…</p>}
          {typed.length > 1 && !hunt.isPending && candidates.length === 0 && (
            <p className="dim">Nothing in any source matches that.</p>
          )}
          {candidates.map(foundRow)}

          {/* Words are the fast way and the folders are the sure one: a re-rip
              that lost its tags matches no search, but it still lives where
              that album's files live. Same "Use this" either way. */}
          <h4 className="file-where">Or browse by folder</h4>
          <FolderBrowser
            sourceId={browsing}
            onSource={setBrowseSource}
            folder={browseFolder}
            onFolder={setBrowseFolder}
          />
          {browseFolder && inFolder.isPending && <p className="dim">Asking the server…</p>}
          {browseFolder && !inFolder.isPending && folderTracks.length === 0 && (
            <p className="dim">No playable track under that folder.</p>
          )}
          {folderTracks.map(foundRow)}
          {folderTracks.length >= 100 && (
            <p className="dim">Only the first 100 are shown — open a subfolder to narrow it.</p>
          )}

          {/* Files do not go missing one at a time. If the rest of the album is
              gone too, the copy you just found is almost certainly sitting next
              to its neighbours — so the useful next move is a scan of the
              source it was found in, said here rather than left to be guessed. */}
          {siblings.length > 0 && (
            <p className="where-album">
              <Icon name="alert" size={10} />
              {siblings.length} more from <b>{track.album || 'this album'}</b>{' '}
              {siblings.length === 1 ? 'is' : 'are'} missing too. Point this one at a file you found and
              the next scan of that source will look for the others in the same place.
            </p>
          )}
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
  new Date(ms).toLocaleDateString(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' })

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
  const [notice, setNotice] = useState<string | null>(null)
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

  const sourceOf = (t: MissingTrack) => sources.find((x) => x.id === t.sourceId)

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

      {notice && <p className="missing-notice">{notice}</p>}

      <p className="missing-lead">
        {all.length.toLocaleString(getLocale())} track{all.length > 1 ? 's' : ''} the last scan could not find.
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
                  {source?.root ? ` · ${source.root}` : ''}
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
          // Same album, still missing, not this row. This is what turns one
          // repair into the question worth asking next.
          siblings={all.filter(
            (t) => t.id !== asking.id && !!t.album && t.album === asking.album && t.artist === asking.artist)}
          onClose={() => setAsking(null)}
          onRescan={() => (rescan(asking.sourceId), setAsking(null))}
          onSubstituted={(message, foundSourceId) => {
            setAsking(null)
            setNotice(message)
            qc.invalidateQueries({ queryKey: ['tracks'] })
            // The rest of the album is probably beside the file just chosen, so
            // the scan that would find them is the one for *that* source — not
            // the one the missing row came from, which is the disk that lost it.
            const rest = all.filter(
              (t) => t.id !== asking.id && !!t.album && t.album === asking.album && t.artist === asking.artist)
            if (rest.length) void rescan(foundSourceId)
          }}
        />
      )}
    </div>
  )
}
