import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Source } from '@jukebox/client-sdk'
import { api, useSources, useTrackCount } from './api'
import { Icon } from './Icon'
import { useScrollMemory } from './viewState'
import { getLocale } from './i18n'

/** The mount the sources route adds for a local source; api-types does not name it yet. */
type Mounted = Source & {
  mount?: { device: string; type: string; network: boolean; readOnly: boolean; point: string } | null
}

/** What each kind is, in one line, and what it needs beyond a name and a root. */
const KINDS: Record<string, { label: string; needs: string }> = {
  local: { label: 'Folder on this machine', needs: 'A path the server can read.' },
  rclone: { label: 'rclone remote', needs: 'A daemon URL and a remote name, in the source’s config.' },
  plex: { label: 'Plex library', needs: 'A server URL and a token, in the source’s config.' },
  emby: { label: 'Emby library', needs: 'A server URL and an API key, in the source’s config.' },
  jellyfin: { label: 'Jellyfin library', needs: 'A server URL and an API key, in the source’s config.' },
}

const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(getLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'

/**
 * One source, with the two things that are actually asked about it: how much of
 * the library it holds, and whether it is answering right now.
 *
 * The count comes from the server rather than from the page — the front holds
 * one page of tracks, and "how many are on this disk" is a question about all
 * of them. The reachability is asked on demand rather than polled: a network
 * share that is down takes seconds to say so, and doing that to five sources on
 * every render would make opening this page feel like the outage.
 */
function SourceCard({ source, onScan }: { source: Mounted; onScan: (full: boolean) => void }) {
  const [probe, setProbe] = useState<'asking' | { ok: boolean; text: string } | null>(null)
  const tracks = useTrackCount({ sourceId: source.id, limit: 1 })
  const kind = KINDS[source.kind] ?? { label: source.kind, needs: '' }

  const test = async () => {
    setProbe('asking')
    try {
      const r = await api.sources.test(source.id)
      setProbe(r.ok
        ? { ok: true, text: `Answering — ${r.name}${r.version ? ` ${r.version}` : ''}` }
        : { ok: false, text: r.reason })
    } catch (err) {
      // The route answers 200 either way, so reaching here means the *server*
      // failed, which is a different thing from the source being down.
      setProbe({ ok: false, text: err instanceof Error ? err.message : 'the server did not answer' })
    }
  }

  return (
    <div className="source-card">
      <div className="sc-head">
        <Icon name={source.kind === 'local' ? 'music' : 'cloud'} size={14} />
        <b>{source.name}</b>
        <em className="dim">{kind.label}</em>
        <span className="spacer" />
        {/* Write capability is denied by default and is the difference between
            a library the server reads and one it may rewrite, so it is stated
            rather than left to be inferred from a greyed button elsewhere. */}
        <span className={`sc-flag ${source.writable ? 'on' : ''}`}>
          {source.writable ? 'Writable' : 'Read-only'}
        </span>
      </div>

      <dl className="sc-facts">
        <div>
          <dt>Root</dt>
          <dd className="path" title={source.root}>{source.root}</dd>
        </div>
        <div>
          <dt>Tracks</dt>
          <dd>{(tracks.data?.count ?? 0).toLocaleString(getLocale())}</dd>
        </div>
        <div>
          <dt>Last scan</dt>
          <dd>{when(source.lastScanAt)}</dd>
        </div>
        {source.kind === 'local' && (
          <div>
            <dt>Filesystem</dt>
            <dd>
              {source.mount ? (
                <>
                  {source.mount.device} <span className="dim">({source.mount.type}
                  {source.mount.network ? ', network' : ''}
                  {source.mount.readOnly ? ', read-only' : ''})</span>
                </>
              ) : 'mount' in source ? (
                // The server looked and found no filesystem holding this path.
                <span className="sc-gone">not mounted — the disk is not here</span>
              ) : (
                <span className="dim">not reported</span>
              )}
            </dd>
          </div>
        )}
      </dl>

      <div className="sc-actions">
        <button onClick={test} disabled={probe === 'asking'}>
          {probe === 'asking' ? 'Asking…' : 'Test'}
        </button>
        <button onClick={() => onScan(false)}>Scan</button>
        {/* Named for what it costs: it re-reads every file rather than trusting
            mtime and size, which is what to run after the server changes how it
            derives a field — and a bad thing to start by accident on 40 000. */}
        <button onClick={() => onScan(true)} title="Re-reads every file instead of trusting mtime and size">
          Full rescan
        </button>
        {probe && probe !== 'asking' && (
          <span className={`sc-probe ${probe.ok ? 'ok' : 'bad'}`}>
            <Icon name={probe.ok ? 'music' : 'alert'} size={10} />
            {probe.text}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Where the library comes from.
 *
 * The admin page counts sources; this one is about each of them — what kind it
 * is, where it points, whether it answers, and what it is allowed to do. The
 * spec has five kinds and the server implements all five; what it does not yet
 * have is a way to *change* one, and saying so is better than leaving someone
 * hunting for a button.
 */
export function SourcesView({ onNotice }: { onNotice: (message: string) => void }) {
  const qc = useQueryClient()
  const pane = useScrollMemory<HTMLDivElement>('sources')
  const sources = (useSources().data?.items ?? []) as Mounted[]
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', root: '' })
  const [error, setError] = useState<string | null>(null)

  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api.jobs.list({ limit: 20 }), enabled: false })

  const scan = async (id: string, full: boolean) => {
    try {
      await api.sources.scan(id, full)
      qc.invalidateQueries({ queryKey: ['jobs'] })
      onNotice(full ? 'Full rescan started — watch it in the display' : 'Scan started — watch it in the display')
    } catch (err) {
      // The usual reason is the one this page exists to show: the disk is out.
      onNotice(err instanceof Error ? err.message : 'The source did not answer')
    }
    void jobs
  }

  const add = async () => {
    if (!form.name.trim() || !form.root.trim()) return
    setError(null)
    try {
      await api.sources.create({ name: form.name.trim(), root: form.root.trim(), kind: 'local' })
      qc.invalidateQueries({ queryKey: ['sources'] })
      setForm({ name: '', root: '' })
      setAdding(false)
      onNotice(`Added ${form.name.trim()} — scan it to bring its music in`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the server refused it')
    }
  }

  return (
    <div className="media sources" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="view-head">
        <h2>Sources</h2>
        <span className="spacer" />
        <button className="prim" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add a folder'}
        </button>
      </div>

      {adding && (
        <form
          className="source-add"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <input
            placeholder="Name — “Vinyl rips”"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <input
            placeholder="/path/the/server/can/read"
            value={form.root}
            onChange={(e) => setForm((f) => ({ ...f, root: e.target.value }))}
          />
          <button type="submit" disabled={!form.name.trim() || !form.root.trim()}>Add</button>
          {error && <span className="sc-probe bad">{error}</span>}
          {/* A path on *the server's* machine, which is not this one when the
              server is a Pi in a cupboard — the single most common way to add a
              source that scans nothing. */}
          <p className="dim">
            The path is read on the machine running the server, not on this one. Nothing is written
            there: a source is read-only until it is made writable, and only a writable source can
            receive an import or a tag written back to a file.
          </p>
        </form>
      )}

      {sources.length === 0 && !adding && (
        <p className="dim">No sources yet. Add a folder and scan it, and its music becomes the library.</p>
      )}

      {sources.map((s) => (
        <SourceCard key={s.id} source={s} onScan={(full) => scan(s.id, full)} />
      ))}

      <p className="sources-note">
        <b>Renaming or removing a source is not offered.</b> The API has no route for either, and that
        is deliberate rather than missing: the tracks of a source carry ratings, play counts, tags and
        places in playlists, so “forget where this came from” and “delete this music” are two different
        requests and the server should not quietly pick one. Remote kinds — rclone, Plex, Emby,
        Jellyfin — can be created through the API with their own config; this page adds folders, which
        is what a first library is.
      </p>
    </div>
  )
}
