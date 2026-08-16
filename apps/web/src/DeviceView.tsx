import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SyncPlan } from '@jukebox/client-sdk'
import { CAPACITY_SEGMENTS, DEVICE_ICON, type Device } from './devices'
import { api, useSources } from './api'
import { DeviceTracks } from './DeviceTracks'
import { Icon } from './Icon'
import type { Playlist } from './data'
import type { Play } from './App'

const GB = 1024 ** 3
const MB = 1024 ** 2
// KB matters here as well as GB: the sync plan reports its own sizes, and a
// handful of tracks reading "0 MB" looks like a broken plan rather than a small one.
const gb = (b: number) =>
  b >= GB ? `${(b / GB).toFixed(2)} GB`
  : b >= MB ? `${(b / MB).toFixed(0)} MB`
  : `${Math.max(1, Math.round(b / 1024))} KB`
const when = (ms: number | null) =>
  ms
    ? new Date(ms).toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Never'

export function DeviceView({
  device,
  playlists,
  onDevices,
  onEject,
  nowPlaying,
  onPlay,
}: {
  device: Device
  playlists: Playlist[]
  onDevices: () => void
  onEject: () => void
  nowPlaying: string | null
  onPlay: Play
}) {
  const [job, setJob] = useState<{ kind: 'sync' | 'backup'; progress: number } | null>(null)
  const [tab, setTab] = useState<'settings' | 'contents'>('settings')
  const [plan, setPlan] = useState<SyncPlan | 'loading' | null>(null)
  const [renaming, setRenaming] = useState(false)
  const sources = useSources().data?.items ?? []
  const stats = useQuery({ queryKey: ['devices', device.id, 'stats'], queryFn: () => api.devices.stats(device.id) })

  // The declared breakdown is what the device reported; what it actually holds
  // is what we indexed. Preferring the latter keeps the bar honest between two
  // satellite reports.
  const declared = Object.values(device.used).reduce((a, b) => a + b, 0)
  const used = stats.data?.bytes ?? declared
  const free = Math.max(0, device.capacity - used)

  const patch = (p: Partial<Device>) => api.devices.update(device.id, p as never).then(onDevices)

  /**
   * Syncing creates a job on the server; its progress arrives over the event
   * stream. The real work will belong to the satellite — the contract will not
   * change when it lands.
   */
  const start = (kind: 'sync' | 'backup') => {
    if (job) return
    setJob({ kind, progress: 0 })
    const call = kind === 'sync' ? api.devices.sync(device.id) : api.devices.backup(device.id)
    call
      .then(() => { setPlan(null); onDevices() })
      .catch(() => {})
      .finally(() => setJob(null))
  }

  /**
   * Sync asks before it acts.
   *
   * A full iPod over USB on a Pi is hours of transfer, and the one thing worth
   * knowing beforehand is what it will do — including that it does not fit. So
   * the button loads the plan first and only the second click starts anything.
   */
  const review = () => {
    setPlan('loading')
    api.devices.syncPlan(device.id).then(setPlan).catch(() => setPlan(null))
  }

  return (
    <div className="device">
      <div className="dev-head">
        <Icon name={DEVICE_ICON[device.kind]} size={54} className="dev-glyph" />
        <div className="dev-id">
          {/* Double-click to rename, exactly like a playlist in the sidebar. */}
          {renaming ? (
            <input
              className="dev-rename"
              autoFocus
              defaultValue={device.name}
              onBlur={(e) => {
                const name = e.target.value.trim()
                if (name && name !== device.name) patch({ name })
                setRenaming(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <h2 onDoubleClick={() => setRenaming(true)} title="Double-click to rename">{device.name}</h2>
          )}
          <dl>
            <div>
              <dt>Capacity</dt>
              <dd>{gb(device.capacity)}</dd>
            </div>
            <div>
              <dt>Software Version</dt>
              <dd>{device.firmware}</dd>
            </div>
            <div>
              <dt>Serial Number</dt>
              <dd>{device.serial}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{device.model}</dd>
            </div>
          </dl>
        </div>
        <div className="dev-battery">
          <div className="batt" title={`${device.battery ?? 0}%`}>
            <span style={{ width: `${device.battery ?? 0}%`, background: (device.battery ?? 0) < 25 ? '#d0473c' : '#6fae55' }} />
          </div>
          <span className="dim">
            {device.battery ?? '—'}% {device.charging ? '· Charging' : ''}
          </span>
        </div>
      </div>

      <div className="tabs dev-tabs">
        {(['settings', 'contents'] as const).map((id) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {id === 'settings' ? 'Settings' : 'On this device'}
          </button>
        ))}
      </div>

      {tab === 'contents' && (
        <DeviceTracks deviceId={device.id} deviceName={device.name} sources={sources} nowPlaying={nowPlaying} onPlay={onPlay} />
      )}

      {tab === 'settings' && <>
      <div className="dev-panel">
        <h3>Options</h3>
        <label className="dev-check">
          <input type="checkbox" checked={!!device.autoSync} onChange={(e) => patch({ autoSync: (e.target.checked ? 1 : 0) as 0 | 1 })} />
          <span>Automatically sync when this device is connected</span>
        </label>
        <label className="dev-check">
          <input
            type="checkbox"
            checked={device.syncMode === 'all'}
            onChange={(e) => patch({ syncMode: e.target.checked ? 'all' : 'playlists' })}
          />
          <span>Sync entire music library</span>
        </label>

        {device.syncMode === 'playlists' && (
          <div className="dev-playlists">
            <div className="dev-pl-head">Selected playlists</div>
            <ul>
              {playlists.map((pl) => {
                const on = device.syncPlaylistIds.includes(pl.id)
                return (
                  <li key={pl.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          patch({
                            syncPlaylistIds: on
                              ? device.syncPlaylistIds.filter((x) => x !== pl.id)
                              : [...device.syncPlaylistIds, pl.id],
                          })
                        }
                      />
                      <Icon name={pl.smart ? 'gear' : 'music'} size={11} />
                      <span>{pl.name}</span>
                      <em className="dim">{pl.smart ? 'smart' : `${pl.trackCount} songs`}</em>
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>

      <div className="dev-panel">
        <h3>Sync &amp; Backup</h3>
        <div className="dev-rows">
          <div>
            <span className="dim">Last sync</span>
            <b>{when(device.lastSync)}</b>
          </div>
          <div>
            <span className="dim">Last backup</span>
            <b>{when(device.lastBackup)}</b>
          </div>
          {stats.data && (
            <div>
              <span className="dim">On this device</span>
              <b>
                {stats.data.tracks} tracks
                {stats.data.orphans > 0 && <> · {stats.data.orphans} not in the library</>}
              </b>
            </div>
          )}
        </div>

        {plan === 'loading' && <div className="dev-plan dim">Working out what the sync would do…</div>}
        {plan && plan !== 'loading' && (
          <div className={`dev-plan ${plan.shortBy ? 'short' : ''}`}>
            <div className="plan-rows">
              <span><b>{plan.add.length}</b> to add{plan.bytesAdded > 0 && <em> · {gb(plan.bytesAdded)}</em>}</span>
              <span><b>{plan.remove.length}</b> to remove{plan.bytesFreed > 0 && <em> · frees {gb(plan.bytesFreed)}</em>}</span>
              <span><b>{plan.keep}</b> untouched</span>
            </div>
            {plan.shortBy ? (
              // Better said now than three hours into a transfer that cannot finish.
              <p className="plan-warn">
                {gb(plan.shortBy)} short. Remove something, or narrow the playlists this device syncs.
              </p>
            ) : (
              plan.add.length + plan.remove.length === 0 && <p className="dim">Already in sync — nothing to do.</p>
            )}
            {plan.add.some((a) => a.transcode) && (
              <p className="dim">
                {plan.add.filter((a) => a.transcode).length} need converting to a format this device plays.
              </p>
            )}
          </div>
        )}
        {job && (
          <div className="dev-progress">
            <span>{job.kind === 'sync' ? 'Syncing…' : 'Backing up…'}</span>
            <div className="bar">
              <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
            <span className="num">{Math.round(job.progress * 100)}%</span>
          </div>
        )}
      </div>

      </>}

      <div className="dev-foot">
        <div className="capacity">
          <div className="cap-bar">
            {CAPACITY_SEGMENTS.map(([key, , color]) => {
              const v = device.used[key]
              return v > 0 ? (
                <div key={key} style={{ width: `${(v / device.capacity) * 100}%`, background: color }} title={gb(v)} />
              ) : null
            })}
          </div>
          <div className="cap-legend">
            {CAPACITY_SEGMENTS.filter(([key]) => device.used[key] > 0).map(([key, label, color]) => (
              <span key={key}>
                <i style={{ background: color }} />
                {label} <b>{gb(device.used[key])}</b>
              </span>
            ))}
            <span>
              <i style={{ background: '#dfe3e8' }} />
              Free <b>{gb(free)}</b>
            </span>
          </div>
        </div>
        <div className="dev-actions">
          <button onClick={() => api.devices.eject(device.id).then(() => (onDevices(), onEject()))} disabled={!!job}>
            <Icon name="eject" size={11} /> Eject
          </button>
          <button onClick={() => start('backup')} disabled={!!job}>
            <Icon name="backup" size={11} /> Back Up
          </button>
          {plan && plan !== 'loading' ? (
            <>
              <button onClick={() => setPlan(null)}>Cancel</button>
              <button
                className="default"
                onClick={() => start('sync')}
                disabled={!!job || !!plan.shortBy || plan.add.length + plan.remove.length === 0}
              >
                <Icon name="sync" size={11} /> Start Sync
              </button>
            </>
          ) : (
            <button className="default" onClick={review} disabled={!!job || plan === 'loading'}>
              <Icon name="sync" size={11} /> Sync…
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
