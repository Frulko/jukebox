import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Job } from '@jukebox/client-sdk'
import { api, useJobs, useSources, useStats } from './api'
import { fmtSize } from './data'
import { Icon } from './Icon'
import { useScrollMemory } from './viewState'

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
export function AdminView() {
  const qc = useQueryClient()
  const pane = useScrollMemory<HTMLDivElement>('admin')
  const stats = useStats()
  const jobs = useJobs().data?.items ?? []
  const sources = useSources().data?.items ?? []
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list(), staleTime: 30_000 })

  const s = stats.data
  const running = jobs.filter((j) => j.state === 'running' || j.state === 'queued' || j.state === 'paused')

  return (
    <div className="media admin" ref={pane.ref} onScroll={pane.onScroll}>
      <h2>Server</h2>

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

      <section>
        <h3>
          Sources <em>{num(sources.length)}</em>
        </h3>
        <table className="admin-table">
          <thead>
            <tr><th>Name</th><th>Kind</th><th>Root</th><th>Last scan</th><th /></tr>
          </thead>
          <tbody>
            {sources.map((src) => (
              <tr key={src.id}>
                <td>{src.name}</td>
                <td className="dim">{src.kind}</td>
                <td className="dim path">{src.root}</td>
                <td className="dim">{when(src.lastScanAt)}</td>
                <td>
                  <button
                    onClick={() =>
                      api.sources.scan(src.id).then(() => qc.invalidateQueries({ queryKey: ['jobs'] })).catch(() => {})
                    }
                  >
                    Rescan
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

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
    </div>
  )
}
