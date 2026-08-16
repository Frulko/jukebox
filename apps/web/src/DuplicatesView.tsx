import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { DuplicateGroup } from '@jukebox/client-sdk'
import { api } from './api'
import { fmtSize, fmtTime } from './data'
import { Icon } from './Icon'
import { useScrollMemory } from './viewState'
import { useViewSearch, ViewSearch } from './ViewSearch'

/**
 * The same song, twice.
 *
 * Nothing here merges on its own. Two different recordings sharing a title is
 * ordinary — a live take, a remaster, a cover — and a wrong merge loses one of
 * them, so the server proposes and the page asks.
 *
 * Merging is not deletion: the other copies' files become renditions of the one
 * kept. That is the useful outcome rather than a tidy one — an iPod that takes
 * AAC and a browser that wants the FLAC are the same song, and a library that
 * knows it can hand each of them the right file.
 */
function Group({
  group,
  onMerged,
}: {
  group: DuplicateGroup
  onMerged: (message: string) => void
}) {
  const qc = useQueryClient()
  const [keeper, setKeeper] = useState(group.keeperId)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const others = group.tracks.filter((t) => t.id !== keeper)
  const first = group.tracks[0]

  const merge = async () => {
    setBusy(true)
    setFailed(null)
    try {
      const r = await api.duplicates.merge(keeper, others.map((t) => t.id))
      qc.invalidateQueries({ queryKey: ['duplicates'] })
      qc.invalidateQueries({ queryKey: ['tracks'] })
      onMerged(`Folded ${r.merged} cop${r.merged > 1 ? 'ies' : 'y'} into one track, ${r.renditions} files kept`)
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The merge was refused')
      setBusy(false)
    }
  }

  return (
    <div className="dup-group">
      <div className="dup-head">
        <b>{first.name}</b>
        <span className="dim">
          {first.artist} — {first.album} · {fmtTime(first.duration)}
        </span>
        {/* How they were matched decides how much to trust the proposal, so it
            is on the group rather than in a legend nobody reads. */}
        <span className={`dup-why ${group.reason}`}>
          {group.reason === 'fingerprint' ? 'same audio' : 'same tags and length'}
        </span>
      </div>

      <table className="dup-table">
        <thead>
          <tr>
            <th>Keep</th><th>Format</th><th>Bit rate</th><th>Size</th><th>Rating</th><th>Plays</th><th>Files</th>
          </tr>
        </thead>
        <tbody>
          {group.tracks.map((t) => (
            <tr key={t.id} className={t.id === keeper ? 'on' : ''}>
              <td>
                <input type="radio" checked={t.id === keeper} onChange={() => setKeeper(t.id)} />
              </td>
              <td>{t.format.toUpperCase()}</td>
              <td className="num">{t.bitRate ? `${t.bitRate} kbps` : '—'}</td>
              <td className="num">{fmtSize(t.size)}</td>
              {/* Plays and a rating are the only things a merge cannot rebuild,
                  which is why the server suggests the copy that has them. */}
              <td className="num">{t.rating ? '★'.repeat(t.rating) : '—'}</td>
              <td className="num">{t.playCount || '—'}</td>
              <td className="num">{t.renditions}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="dup-foot">
        {failed && <span className="dup-failed">{failed}</span>}
        <span className="dim">
          {others.length > 1
            ? `${others.length} other copies become renditions of the one kept.`
            : 'The other copy becomes a rendition of the one kept.'}{' '}
          No file is deleted.
        </span>
        <button className="prim" disabled={busy || others.length === 0} onClick={merge}>
          {busy ? 'Merging…' : 'Merge into one track'}
        </button>
      </div>
    </div>
  )
}

export function DuplicatesView({ onNotice }: { onNotice: (message: string) => void }) {
  const pane = useScrollMemory<HTMLDivElement>('duplicates')
  const { data, isPending } = useQuery({
    queryKey: ['duplicates'],
    queryFn: () => api.duplicates.find(),
    staleTime: 60_000,
  })
  const search = useViewSearch()
  const all = data?.groups ?? []
  const groups = all.filter((g) => search.matches(g.tracks[0]?.name, g.tracks[0]?.artist, g.tracks[0]?.album))

  return (
    <div className="media duplicates" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="view-head">
        <h2>Duplicates</h2>
        <ViewSearch value={search.query} onChange={search.setQuery} placeholder="Filter by title or artist" count={groups.length} />
      </div>
      <p className="dup-lead">
        Rows that look like one song. Matched on the audio itself where a fingerprint exists, on tags and
        length otherwise — and proposed rather than applied, because two recordings sharing a title is
        ordinary and a wrong merge loses one of them.
      </p>

      {isPending && <p className="dim">Looking for the same song twice…</p>}
      {!isPending && groups.length === 0 && (
        <div className="list-empty">
          <Icon name="alert" size={12} /> Nothing looks duplicated.
        </div>
      )}

      {groups.map((g) => (
        <Group key={g.keeperId} group={g} onMerged={onNotice} />
      ))}
    </div>
  )
}
