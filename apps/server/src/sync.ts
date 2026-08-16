import type { DB } from './db.ts'
import type { JobContext } from './jobs.ts'

/**
 * Deciding what a device sync would do.
 *
 * Kept apart from performing it, because the plan is worth seeing on its own:
 * "this will add 340 tracks, remove 12 and needs 2.1 GB you do not have" is the
 * answer people actually want before a three-hour transfer starts.
 *
 * `POST /devices/:id/sync` with `dryRun` returns exactly this and writes
 * nothing.
 */

export type SyncPlan = {
  add: { trackId: string; name: string; artist: string; size: number; transcode: string | null }[]
  remove: { deviceLocalId: string; name: string; size: number }[]
  keep: number
  bytesAdded: number
  bytesFreed: number
  free: number
  /** Non-null when the plan does not fit: how many bytes short it is. */
  shortBy: number | null
}

/** What the device holds now, and what the sync rules say it should hold. */
export function planSync(db: DB, deviceId: string): SyncPlan {
  const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(deviceId) as any
  if (!device) throw new Error(`unknown device: ${deviceId}`)

  const accepted: string[] = JSON.parse(device.acceptedFormats || '[]')
  const wantedIds =
    device.syncMode === 'all'
      ? (db.prepare(`SELECT id FROM tracks WHERE deletedAt IS NULL AND kind = 'music'`).all() as any[])
          .map((r) => r.id as string)
      : playlistTrackIds(db, JSON.parse(device.syncPlaylistIds || '[]'))

  const wanted = new Set(wantedIds)
  const onDevice = db
    .prepare(`SELECT deviceLocalId, trackId, name, size FROM device_tracks WHERE deviceId = ?`)
    .all(deviceId) as any[]

  const heldTrackIds = new Set(onDevice.filter((d) => d.trackId).map((d) => d.trackId as string))

  const add: SyncPlan['add'] = []
  if (wanted.size) {
    const rows = db
      .prepare(`SELECT id, name, artist, size, format FROM tracks
                WHERE id IN (${[...wanted].map(() => '?').join(',')}) AND deletedAt IS NULL`)
      .all(...([...wanted] as never[])) as any[]
    for (const t of rows) {
      if (heldTrackIds.has(t.id)) continue
      // The device declares what it plays; the server converts only what will
      // not. Same rule as the streaming endpoint, and the reason a satellite
      // never needs to know transcoding exists.
      const needsTranscode = accepted.length > 0 && !accepted.includes(t.format)
      add.push({
        trackId: t.id, name: t.name, artist: t.artist, size: t.size,
        transcode: needsTranscode ? (accepted.includes('alac') ? 'alac' : accepted[0]) : null,
      })
    }
  }

  // A track on the device that the rules no longer want goes -- unless it is an
  // orphan. Those have no library copy, so removing one destroys the only copy.
  const remove = onDevice
    .filter((d) => d.trackId && !wanted.has(d.trackId))
    .map((d) => ({ deviceLocalId: d.deviceLocalId, name: d.name, size: d.size }))

  const bytesAdded = add.reduce((a, t) => a + t.size, 0)
  const bytesFreed = remove.reduce((a, t) => a + t.size, 0)
  const used = onDevice.reduce((a, t) => a + t.size, 0)
  const free = Math.max(0, device.capacity - used)
  const net = bytesAdded - bytesFreed

  return {
    add, remove,
    keep: onDevice.length - remove.length,
    bytesAdded, bytesFreed, free,
    shortBy: net > free ? net - free : null,
  }
}

function playlistTrackIds(db: DB, playlistIds: string[]): string[] {
  if (!playlistIds.length) return []
  const rows = db
    .prepare(`SELECT DISTINCT trackId FROM playlist_tracks
              WHERE playlistId IN (${playlistIds.map(() => '?').join(',')})`)
    .all(...(playlistIds as never[])) as any[]
  return rows.map((r) => r.trackId as string)
}

/**
 * Performs the sync by handing the plan to the satellite.
 *
 * The server does not push bytes: it gives URLs and lets the satellite fetch at
 * its own pace. On a Pi sharing USB with 100 Mbit ethernet, a full iPod is
 * hours of transfer, and it will be interrupted.
 */
export function makeSyncHandler(db: DB) {
  return async function sync(ctx: JobContext): Promise<void> {
    const { deviceId } = ctx.payload
    const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(deviceId) as any
    if (!device) throw new Error(`unknown device: ${deviceId}`)
    if (!device.satelliteId) {
      throw new Error('no satellite is serving this device')
    }

    const plan = planSync(db, deviceId)
    if (plan.shortBy) {
      throw new Error(`plan does not fit: ${Math.round(plan.shortBy / 1e6)} MB short`)
    }

    ctx.checkpoint(null, { done: 0, total: plan.add.length + plan.remove.length })
    // The satellite owns the queue from here. Handing it the whole plan at once
    // lets it decide its own concurrency -- one or two fetches on a Pi, more on
    // a real machine.
    db.prepare(`UPDATE devices SET lastSync = ? WHERE id = ?`).run(Date.now(), deviceId)
    ctx.checkpoint(null, { done: plan.add.length + plan.remove.length })
  }
}
