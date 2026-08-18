import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Source, SourceFavorite } from '@jukebox/client-sdk'
import { api, useSources, useTrackCount } from './api'
import { Icon } from './Icon'
import { useScrollMemory } from './viewState'
import { AddSource } from './AddSource'
import { SourceFavorites, favoriteKindLabel } from './SourceFavorites'
import { canWrite, fieldsOf, kindIcon, kindLabel } from './sourceKinds'
import { getLocale } from './i18n'

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
function SourceCard({
  source,
  onScan,
  onChanged,
  onNotice,
}: {
  source: Source
  onScan: (full: boolean) => void
  onChanged: () => void
  onNotice: (message: string) => void
}) {
  const [probe, setProbe] = useState<'asking' | { ok: boolean; text: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<{
    name: string; writable: boolean; config: Record<string, string>; favorites: SourceFavorite[]
  }>({
    name: source.name, writable: !!source.writable, config: {}, favorites: source.favorites ?? [],
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const tracks = useTrackCount({ sourceId: source.id, limit: 1 })

  // Everything except `root`, which the server refuses to change: a track's
  // path is stored relative to it, so editing it would point the whole library
  // somewhere else without a file moving.
  const fields = fieldsOf(source.kind).filter((f) => f.config)
  const secrets = new Set(source.secrets ?? [])

  const open = () => {
    setDraft({ name: source.name, writable: !!source.writable, config: {}, favorites: source.favorites ?? [] })
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const patch = await api.sources.update(source.id, {
        name: draft.name.trim() || source.name,
        writable: draft.writable,
        // Only what was typed. A field left blank keeps whatever the server
        // holds — which is the only way to edit a port next to a token the
        // page was never shown.
        config: Object.fromEntries(Object.entries(draft.config).filter(([, v]) => v !== '')),
        // Unlike config, replaced whole: the list on screen is the truth, and
        // an emptied one has to be sayable.
        favorites: draft.favorites,
      })
      onChanged()
      setEditing(false)
      onNotice(`Saved ${patch.name}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the server refused it')
    } finally {
      setBusy(false)
    }
  }

  const forget = async () => {
    if (!confirming) return setConfirming(true)
    setBusy(true)
    setError(null)
    try {
      await api.sources.remove(source.id)
      onChanged()
      onNotice(`Forgot ${source.name}`)
    } catch (err) {
      // Almost always the refusal, and it is the useful sentence: how many
      // tracks would go with it.
      setError(err instanceof Error ? err.message : 'the server refused it')
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

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
        <Icon name={kindIcon(source.kind)} size={14} />
        <b>{source.name}</b>
        <em className="dim">{kindLabel(source.kind)}</em>
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
          {/* Empty for a non-admin, who is told sources exist but not where the
              machine keeps them. */}
          <dd className="path" title={source.root}>
            {source.root || <span className="dim">not shown</span>}
          </dd>
        </div>
        <div>
          <dt>Tracks</dt>
          <dd>{(tracks.data?.count ?? 0).toLocaleString(getLocale())}</dd>
        </div>
        <div>
          <dt>Last scan</dt>
          <dd>{when(source.lastScanAt)}</dd>
        </div>
        {/* What the source needs beyond its root. Shown because a wrong port
            or a stale library id is exactly what a "test" failure means, and
            hiding it left nowhere to look. A credential is named and never
            printed: the server withholds the value and says the key is set. */}
        {fields.map((f) => {
          const value = (source.config ?? {})[f.config!]
          const isSecret = secrets.has(f.config!)
          if (value === undefined && !isSecret) return null
          return (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd className={isSecret ? 'dim' : 'path'}>
                {isSecret ? 'set — not shown' : String(value)}
              </dd>
            </div>
          )
        })}
        {/* The starred folders, visible without opening the editor: where the
            music is, and what each folder files its contents as. */}
        {(source.favorites?.length ?? 0) > 0 && (
          <div>
            <dt>Favorites</dt>
            <dd className="sf-chips">
              {source.favorites!.map((f) => (
                <span key={f.path} className="sf-chip" title={f.path}>
                  <Icon name="star" size={9} />
                  {f.path}
                  {f.kind && <em> → {favoriteKindLabel(f.kind)}</em>}
                </span>
              ))}
            </dd>
          </div>
        )}
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

      {editing && (
        <div className="sc-edit">
          <label className="as-row">
            <span>Name</span>
            <input
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </label>

          {fields.map((f) => (
            <label key={f.key} className="as-row">
              <span>{f.label}</span>
              <span className="as-input">
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={draft.config[f.config!] ?? ''}
                  // A secret is not filled in, because the page was never told
                  // it. Blank means "keep it", which is the only honest default
                  // for a field whose current value nobody here can read.
                  placeholder={
                    f.secret
                      ? secrets.has(f.config!) ? 'set — leave blank to keep' : f.placeholder
                      : String((source.config ?? {})[f.config!] ?? f.placeholder)
                  }
                  onChange={(e) => setDraft((d) => ({ ...d, config: { ...d.config, [f.config!]: e.target.value } }))}
                />
              </span>
            </label>
          ))}

          {canWrite(source.kind) ? (
            <label className="as-check">
              <input
                type="checkbox"
                checked={draft.writable}
                onChange={(e) => setDraft((d) => ({ ...d, writable: e.target.checked }))}
              />
              <span>
                <b>Writable</b> — the server may put files here and write tags back into them.
              </span>
            </label>
          ) : null}

          <div className="sf-block">
            <span className="sf-title">Favorite folders</span>
            <SourceFavorites
              sourceId={source.id}
              value={draft.favorites}
              onChange={(favorites) => setDraft((d) => ({ ...d, favorites }))}
            />
          </div>

          {/* The one thing that cannot be edited, said where someone would go
              looking for it rather than left as a missing field. */}
          <p className="dim as-note">
            The root stays <code>{source.root}</code>. Every track’s path is stored relative to it, so
            changing it would point the whole library somewhere else without a file moving — add a
            source and rescan instead.
          </p>
        </div>
      )}

      <div className="sc-actions">
        {editing ? (
          <>
            <button className="prim" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <button onClick={open}>Edit</button>
        )}
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
        <span className="spacer" />
        {/* Two clicks, and the second one is answered by the server rather than
            by a dialog: it refuses while the source still holds tracks and says
            how many would go with it. */}
        <button
          className={confirming ? 'danger' : ''}
          disabled={busy}
          onClick={() => void forget()}
          onBlur={() => setConfirming(false)}
        >
          {confirming ? 'Really forget?' : 'Forget'}
        </button>
        {probe && probe !== 'asking' && (
          <span className={`sc-probe ${probe.ok ? 'ok' : 'bad'}`}>
            <Icon name={probe.ok ? 'music' : 'alert'} size={10} />
            {probe.text}
          </span>
        )}
      </div>
      {error && <p className="sc-probe bad sc-error">{error}</p>}
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
  const sources = useSources().data?.items ?? []
  const [adding, setAdding] = useState(false)

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

  return (
    <div className="media sources" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="view-head">
        <h2>Sources</h2>
        <span className="spacer" />
        <button className="prim" onClick={() => setAdding(true)}>
          Add a source
        </button>
      </div>

      {adding && (
        <AddSource
          onClose={() => setAdding(false)}
          onNotice={onNotice}
          onAdded={() => qc.invalidateQueries({ queryKey: ['sources'] })}
        />
      )}

      {sources.length === 0 && !adding && (
        <p className="dim">No sources yet. Add a folder and scan it, and its music becomes the library.</p>
      )}

      {sources.map((s) => (
        <SourceCard
          key={s.id}
          source={s}
          onScan={(full) => scan(s.id, full)}
          onChanged={() => qc.invalidateQueries({ queryKey: ['sources'] })}
          onNotice={onNotice}
        />
      ))}

      <p className="sources-note">
        <b>Forgetting a source is refused while it still holds tracks</b>, and the refusal says how
        many. The tracks of a source carry ratings, play counts, tags and places in playlists — and
        a missing track carries them while its disk is unplugged — so “forget where this came from”
        and “delete this music” stay two different requests rather than one destructive reading of
        an ambiguous one. The <b>root</b> cannot be edited either: every path is stored relative to
        it. Everything else — the name, the write capability, a rotated token — is editable here,
        and a credential is never printed back: the server says a key is set without saying what it is.
      </p>
    </div>
  )
}
