import { useState } from 'react'
import { CAPACITY_SEGMENTS, DEVICE_ICON, type Device } from './devices'
import { api } from './api'
import { Icon } from './Icon'
import type { Playlist } from './data'

const GB = 1024 ** 3
const gb = (b: number) => (b >= GB ? `${(b / GB).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`)
const when = (ms: number | null) =>
  ms
    ? new Date(ms).toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Never'

export function DeviceView({
  device,
  playlists,
  onDevices,
}: {
  device: Device
  playlists: Playlist[]
  onDevices: () => void
}) {
  const [job, setJob] = useState<{ kind: 'sync' | 'backup'; progress: number } | null>(null)

  const used = Object.values(device.used).reduce((a, b) => a + b, 0)
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
      .then(() => onDevices())
      .catch(() => {})
      .finally(() => setJob(null))
  }

  return (
    <div className="device">
      <div className="dev-head">
        <Icon name={DEVICE_ICON[device.kind]} size={54} className="dev-glyph" />
        <div className="dev-id">
          <h2>{device.name}</h2>
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
        </div>
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
          <button onClick={() => start('backup')} disabled={!!job}>
            <Icon name="backup" size={11} /> Back Up
          </button>
          <button className="default" onClick={() => start('sync')} disabled={!!job}>
            <Icon name="sync" size={11} /> Sync
          </button>
        </div>
      </div>
    </div>
  )
}
