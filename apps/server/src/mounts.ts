import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const run = promisify(execFile)

/**
 * Which filesystem a path is actually on.
 *
 * A library on an NFS or SMB share is a *local* source as far as this project
 * is concerned — the kernel mounted it, the path works, nothing here needs a
 * protocol. That is the whole reason 4.2 is small: the operating system already
 * did the hard part.
 *
 * What it is not is invisible. A share that goes away leaves the mountpoint
 * behind as an empty directory, so the path still resolves, the scan still
 * completes, and it finds nothing at all — which is indistinguishable from a
 * library somebody deleted unless you ask the question this file answers.
 */

export type Mount = {
  device: string
  point: string
  type: string
  /** Whether losing the network loses the files. */
  network: boolean
  readOnly: boolean
}

/**
 * The filesystems that vanish when a cable does.
 *
 * `fuse.*` covers sshfs, rclone's own mount and anything else in userspace,
 * which is the same risk wearing a different name.
 */
const NETWORK = new Set([
  'nfs', 'nfs4', 'cifs', 'smbfs', 'smb3', 'afpfs', 'afp', 'webdav', 'davfs', 'davfs2',
  'ftp', 'ftpfs', 'sshfs', 'fuseblk.smb', '9p',
])

const isNetwork = (type: string) =>
  NETWORK.has(type) || type.startsWith('fuse.') || type.startsWith('nfs')

/** Linux: `/proc/self/mounts` is device, point, type, options. */
function parseProcMounts(text: string): Mount[] {
  const out: Mount[] = []
  for (const line of text.split('\n')) {
    const [device, point, type, options = ''] = line.split(/\s+/)
    if (!point || !type) continue
    out.push({
      // Octal escapes are how the kernel writes a space in a path, and a music
      // library is full of them.
      device: unescapeOctal(device),
      point: unescapeOctal(point),
      type,
      network: isNetwork(type),
      readOnly: options.split(',').includes('ro'),
    })
  }
  return out
}

const unescapeOctal = (s: string) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))

/** macOS and the BSDs: `device on /point (type, options)`. */
function parseMountOutput(text: string): Mount[] {
  const out: Mount[] = []
  for (const line of text.split('\n')) {
    const m = /^(.+?) on (.+?) \(([^)]*)\)/.exec(line.trim())
    if (!m) continue
    const options = m[3].split(',').map((o) => o.trim())
    const type = options[0] ?? ''
    out.push({
      device: m[1],
      point: m[2],
      type,
      network: isNetwork(type),
      readOnly: options.includes('read-only'),
    })
  }
  return out
}

export async function readMounts(): Promise<Mount[]> {
  try {
    if (process.platform === 'linux') {
      return parseProcMounts(await readFile('/proc/self/mounts', 'utf8'))
    }
    const { stdout } = await run('mount', [], { timeout: 5000 })
    return parseMountOutput(stdout)
  } catch {
    // A container without /proc, a platform without `mount`. Knowing nothing is
    // a fine answer — everything downstream treats it as "no information".
    return []
  }
}

/**
 * The mount a path sits on: the longest mountpoint that is a prefix of it.
 *
 * Longest, not first: `/` is a prefix of everything, so matching on the first
 * hit reports every path as being on the root filesystem and the network share
 * underneath is never noticed.
 */
export function mountFor(path: string, mounts: Mount[]): Mount | null {
  const target = resolve(path)
  let best: Mount | null = null
  for (const m of mounts) {
    if (target !== m.point && !target.startsWith(m.point.endsWith('/') ? m.point : `${m.point}/`)) continue
    if (!best || m.point.length > best.point.length) best = m
  }
  return best
}

/** What to show beside a source, and what to think twice about before sweeping. */
export async function describe(path: string): Promise<Mount | null> {
  return mountFor(path, await readMounts())
}

/**
 * Whether this path can actually be written to.
 *
 * Asked of the filesystem rather than inferred from the mount's flags, because
 * on macOS the mount table gives a true answer to a different question. The
 * root volume is sealed and read-only, and firmlinks put `/private`, `/Users`
 * and everything else people keep music in *under* it while the bytes live on
 * a separate writable volume. Longest-prefix matching therefore reports a
 * perfectly writable music folder as read-only — and a UI believing it would
 * grey out editing on a library that edits fine.
 *
 * `access(W_OK)` costs one syscall and answers the question that was actually
 * being asked.
 */
export async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}
