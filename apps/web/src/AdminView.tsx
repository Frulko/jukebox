import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, type Account, type Job, type Role } from '@jukebox/client-sdk'
import { api, useJobs, useStats } from './api'
import { fmtSize } from './data'
import { Icon } from './Icon'
import { useRemembered, useScrollMemory } from './viewState'

const num = (n: number) => n.toLocaleString('en-US')

/** Days and hours, because a library is measured in days and a job in minutes. */
const duration = (seconds: number) => {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d ? `${d} day${d > 1 ? 's' : ''}, ${h} h` : h ? `${h} h ${m} min` : `${m} min`
}

const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'

function JobRow({ job, onCancel }: { job: Job; onCancel: () => void }) {
  const pct = job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : null
  return (
    <div className={`admin-job ${job.state}`}>
      <span className="k">{job.kind}</span>
      <span className="s">{job.state}</span>
      <span className="bar">
        {/* A job with no total is a job that does not know how much work it has;
            an indeterminate bar says that better than a bar stuck at zero. */}
        <i className={pct === null ? 'unknown' : ''} style={pct === null ? undefined : { width: `${pct}%` }} />
      </span>
      <span className="n">
        {job.progress.total ? `${num(job.progress.done)} / ${num(job.progress.total)}` : num(job.progress.done)}
      </span>
      {job.error && <span className="err">{job.error}</span>}
      <button onClick={onCancel} title="Cancel this job">
        <Icon name="close" size={8} />
      </button>
    </div>
  )
}

/**
 * What the server is holding and doing.
 *
 * Every number here is the server's own: the front holds one page of tracks and
 * cannot add up a library by looking at it. Counting what happens to be loaded
 * is how a dashboard ends up confidently wrong.
 */
/**
 * Accounts, which had no interface at all.
 *
 * The routes have been there since roles landed; nothing in the app could list
 * an account, let alone make one. Deliberately here rather than on the Sharing
 * page: Sharing is about *who reads what*, and answers a `403` by saying so;
 * this is the page that may actually change it.
 */
function Accounts() {
  const qc = useQueryClient()
  const accounts = useQuery<{ items: Account[] }, ApiError>({
    queryKey: ['users'],
    queryFn: () => api.users.list(),
    retry: false,
  })
  const [form, setForm] = useState({ username: '', password: '', role: 'user' as Role })
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] })

  if (accounts.error?.status === 403 || accounts.error?.status === 401) {
    return <p className="dim">Only an admin can see or change the accounts on this server.</p>
  }

  const users = accounts.data?.items ?? []
  const admins = users.filter((u) => u.role === 'admin').length

  return (
    <>
      <table className="admin-table">
        <thead>
          <tr><th>Account</th><th>Role</th><th>Subsonic</th><th>Last seen</th><th /></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>
                <select
                  value={u.role}
                  /* The server refuses to demote the last admin; the interface
                     refuses to *offer* it, which is the same answer without the
                     round trip and without an error nobody expected. */
                  disabled={u.role === 'admin' && admins === 1}
                  onChange={(e) =>
                    api.users
                      .update(u.id, { role: e.target.value as Role })
                      .then(refresh)
                      .catch((err) => setError(err instanceof Error ? err.message : 'refused'))
                  }
                >
                  {(['admin', 'user', 'guest'] as const).map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </td>
              {/* Subsonic clients need a password the server can replay, so the
                  fact that one is stored is a security-relevant thing to show
                  rather than a feature flag. */}
              <td className="dim">{u.subsonic ? 'password stored' : 'browser only'}</td>
              <td className="dim">{when(u.lastSeenAt)}</td>
              <td>
                <button
                  className={confirming === u.id ? 'danger' : ''}
                  disabled={u.role === 'admin' && admins === 1}
                  onClick={() => {
                    if (confirming !== u.id) return setConfirming(u.id)
                    api.users.remove(u.id).then(() => { setConfirming(null); refresh() }).catch(() => {})
                  }}
                  onBlur={() => setConfirming(null)}
                >
                  {confirming === u.id ? 'Really remove?' : 'Remove'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form
        className="admin-newuser"
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          api.users
            .create({ username: form.username.trim(), password: form.password, role: form.role })
            .then(() => {
              setForm({ username: '', password: '', role: 'user' })
              refresh()
            })
            .catch((err) => setError(err instanceof Error ? err.message : 'the server refused it'))
        }}
      >
        <input
          placeholder="Username"
          value={form.username}
          onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
        />
        <input
          type="password"
          placeholder="Password — at least 8 characters"
          value={form.password}
          onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
        />
        <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))}>
          {(['user', 'guest', 'admin'] as const).map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button type="submit" disabled={!form.username.trim() || form.password.length < 8}>
          Add account
        </button>
      </form>
      {error && <p className="pod-add-error">{error}</p>}
      <p className="admin-note">
        A <b>guest</b> may play and nothing else; a <b>user</b> may edit the library; an <b>admin</b> may
        change the server. What an account can <i>see</i> is narrowed per source, which is on the
        Sharing page next to the rest of who-reads-what.
      </p>
    </>
  )
}

const TABS = ['Overview', 'Jobs', 'Plugins', 'Accounts'] as const

export function AdminView() {
  const qc = useQueryClient()
  const pane = useScrollMemory<HTMLDivElement>('admin')
  const stats = useStats()
  const jobs = useJobs().data?.items ?? []
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list(), staleTime: 30_000 })
  // Everything the queue has done lately, not only what is moving: a scan that
  // failed at four in the morning is the thing you open this page to find, and
  // it was invisible when the page only listed what was running.
  const history = useQuery({
    queryKey: ['jobs', 'history'],
    queryFn: () => api.jobs.list({ limit: 40 }),
    staleTime: 10_000,
  })
  const [tab, setTab] = useRemembered<(typeof TABS)[number]>('admin.tab', 'Overview')

  const s = stats.data
  const running = jobs.filter((j) => j.state === 'running' || j.state === 'queued' || j.state === 'paused')

  return (
    <div className="media admin" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="view-head">
        <h2>Server</h2>
      </div>

      {/* Tabs rather than one column: this page is going to keep growing —
          accounts, jobs, plugins, whatever the server learns next — and a page
          that grows downwards buries whatever was added first. */}
      <div className="tabs admin-tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t}
            {t === 'Jobs' && running.length > 0 && <em className="tab-badge">{running.length}</em>}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (<>
      <section className="admin-cards">
        <div className="admin-card">
          <b>{s ? num(s.tracks) : '—'}</b>
          <span>tracks</span>
          <em>{s ? `${num(s.albums)} albums · ${num(s.artists)} artists` : ''}</em>
        </div>
        <div className="admin-card">
          <b>{s ? fmtSize(s.bytes) : '—'}</b>
          <span>on disk</span>
          <em>{s ? duration(s.seconds) : ''}</em>
        </div>
        <div className="admin-card">
          <b>{s ? num(s.playlists) : '—'}</b>
          <span>playlists</span>
          <em>{s ? `${num(s.podcasts)} podcasts · ${num(s.radios)} radios` : ''}</em>
        </div>
        <div className={`admin-card ${s?.missing ? 'warn' : ''}`}>
          <b>{s ? num(s.missing) : '—'}</b>
          <span>missing files</span>
          <em>{s?.missing ? 'their sources may be unplugged' : 'every file is where it should be'}</em>
        </div>
      </section>

      <section>
        <h3>
          In progress <em>{running.length ? `${running.length} running` : 'nothing running'}</em>
        </h3>
        {running.length === 0 ? (
          <p className="dim">The queue is empty. Scans, conversions and syncs appear here while they run.</p>
        ) : (
          <div className="admin-jobs">
            {running.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                onCancel={() => api.jobs.cancel(j.id).then(() => qc.invalidateQueries({ queryKey: ['jobs'] })).catch(() => {})}
              />
            ))}
          </div>
        )}
      </section>

      </>)}

      {tab === 'Jobs' && (
      <section>
        <h3>
          Lately <em>{history.data ? `${history.data.items.length} in the queue's memory` : ''}</em>
        </h3>
        {history.data?.items.length === 0 && <p className="dim">The queue has done nothing yet.</p>}
        <table className="admin-table">
          <thead>
            <tr><th>Kind</th><th>State</th><th>Progress</th><th>Started</th><th /></tr>
          </thead>
          <tbody>
            {history.data?.items.map((j) => (
              <tr key={j.id} className={j.state}>
                <td>{j.kind}</td>
                <td className={`j-state ${j.state}`}>{j.state}</td>
                <td className="dim">
                  {j.progress.total ? `${num(j.progress.done)} / ${num(j.progress.total)}` : num(j.progress.done)}
                  {j.error && <span className="j-error"> · {j.error}</span>}
                </td>
                <td className="dim">{when(j.startedAt ?? j.createdAt)}</td>
                <td>
                  {/* Only what a job in that state can actually do. A finished
                      job with a live "Cancel" is a button that answers 409. */}
                  {j.state === 'running' && (
                    <button onClick={() => api.jobs.pause(j.id).then(() => qc.invalidateQueries({ queryKey: ['jobs'] })).catch(() => {})}>
                      Pause
                    </button>
                  )}
                  {j.state === 'paused' && (
                    <button onClick={() => api.jobs.resume(j.id).then(() => qc.invalidateQueries({ queryKey: ['jobs'] })).catch(() => {})}>
                      Resume
                    </button>
                  )}
                  {(j.state === 'running' || j.state === 'queued' || j.state === 'paused') && (
                    <button onClick={() => api.jobs.cancel(j.id).then(() => qc.invalidateQueries({ queryKey: ['jobs'] })).catch(() => {})}>
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      )}

      {tab === 'Accounts' && (
      <section>
        <h3>Accounts</h3>
        <Accounts />
      </section>
      )}

      {tab === 'Plugins' && (
      <section>
        <h3>
          Plugins <em>{plugins.data ? `host API ${plugins.data.hostApi}` : ''}</em>
        </h3>
        {plugins.data?.items.length === 0 && <p className="dim">None installed.</p>}
        <div className="admin-plugins">
          {plugins.data?.items.map((pl) => (
            <div key={pl.id} className={`admin-plugin ${pl.state}`}>
              <div className="p-head">
                <b>{pl.name}</b>
                <span className="dim">{pl.version}</span>
                <span className={`p-state ${pl.state}`}>{pl.state}</span>
                <button
                  onClick={() =>
                    api.plugins
                      .setEnabled(pl.id, !pl.enabled)
                      .then(() => qc.invalidateQueries({ queryKey: ['plugins'] }))
                      .catch(() => {})
                  }
                >
                  {pl.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
              <p className="dim">{pl.description}</p>
              {pl.error && <p className="p-error">{pl.error}</p>}
              {pl.permissions.length > 0 && (
                <p className="p-perms">
                  {pl.permissions.map((perm) => (
                    <em key={perm}>{perm}</em>
                  ))}
                </p>
              )}
            </div>
          ))}
        </div>
        {/* Said here rather than in a tooltip: it is the kind of thing a reader
            has to know before installing, not after wondering. */}
        <p className="admin-note">
          Permissions above are <b>declared, not enforced</b>. Plugins run in the server's own process
          with its rights — install what you would run yourself.
        </p>
      </section>
      )}
    </div>
  )
}
