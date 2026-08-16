import { gunzipSync } from 'node:zlib'

/**
 * Reading a tar archive, safely.
 *
 * Written rather than depended on, and rather than shelled out to the system
 * `tar`, because the safety rules are the entire point and here they are mine
 * to enforce. An archive downloaded from a plugin store is untrusted input, and
 * the attack is thirty years old and still works: an entry named
 * `../../../../etc/cron.d/x`, or a symlink to `/etc`, followed by a second
 * entry writing "through" it. Every extractor that has ever been caught by this
 * was calling a library and trusting a flag.
 *
 * The ustar format is small enough to read in one sitting: 512-byte headers,
 * octal numbers, entries padded to the block size, two zero blocks at the end.
 */

export type TarEntry = {
  name: string
  size: number
  /** Regular files and directories only; everything else is refused. */
  type: 'file' | 'dir'
  data: Buffer
}

const BLOCK = 512

const str = (b: Buffer, off: number, len: number): string => {
  const slice = b.subarray(off, off + len)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim()
}

const octal = (b: Buffer, off: number, len: number): number => {
  const s = str(b, off, len).replace(/[^0-7]/g, '')
  return s ? parseInt(s, 8) : 0
}

/**
 * Is this entry name safe to write under a root?
 *
 * Checked on the archive's own name, before any path joining: `join` resolves
 * `..` away and would hide exactly what needs catching.
 */
export function safeName(name: string): boolean {
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  if (name.includes('\0')) return false
  // Any segment, not just a leading one: `a/../../b` is as dangerous as `../b`.
  return !name.split('/').includes('..')
}

/**
 * Extracts entries from a tar (optionally gzipped) buffer.
 *
 * Refuses rather than skips: an archive containing a symlink is an archive
 * doing something an honest plugin never needs to, and quietly dropping the
 * entry would install a half plugin while hiding the attempt.
 */
export function untar(input: Buffer, opts: { maxBytes?: number } = {}): TarEntry[] {
  // gzip magic. The store serves .tar.gz; accepting both costs one check.
  const buf = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024

  const entries: TarEntry[] = []
  let offset = 0
  let total = 0
  let longName: string | null = null

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK)
    // Two consecutive zero blocks end the archive; one is enough to stop on.
    if (header.every((b) => b === 0)) break

    const size = octal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156]) || '0'
    const prefix = str(header, 345, 155)
    const raw = str(header, 0, 100)
    // Directory entries conventionally end in a slash. Normalised here so no
    // caller has to know that, and so `lib` and `lib/` cannot both appear.
    const name = (longName ?? (prefix ? `${prefix}/${raw}` : raw)).replace(/\/+$/, '')
    longName = null

    offset += BLOCK
    const body = buf.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK

    // GNU long names arrive as a pseudo-entry whose body is the real name.
    if (typeflag === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/, '')
      continue
    }
    // pax extended headers describe the next entry; the ustar fields still
    // carry a usable name, so they are skipped rather than parsed.
    if (typeflag === 'x' || typeflag === 'g') continue

    if (typeflag === '2' || typeflag === '1') {
      throw new Error(`archive contains a link (${name}); plugins are plain files`)
    }
    if (!['0', '\0', '5', ''].includes(typeflag)) {
      throw new Error(`archive contains an unsupported entry type ${typeflag} (${name})`)
    }
    if (!safeName(name)) {
      throw new Error(`archive contains an unsafe path: ${name}`)
    }

    total += size
    if (total > maxBytes) throw new Error(`archive is larger than ${maxBytes} bytes`)

    entries.push({
      name,
      size,
      type: typeflag === '5' ? 'dir' : 'file',
      data: typeflag === '5' ? Buffer.alloc(0) : Buffer.from(body),
    })
  }

  return entries
}

/**
 * Drops the leading path segment every archive of a folder carries.
 *
 * `tar czf x.tgz plugin/` produces `plugin/plugin.json`, and a release tarball
 * from a forge adds a version to it. Entries that consist only of that segment
 * disappear, which is correct: the directory itself is what we are unpacking
 * into.
 */
export function stripComponents(entries: TarEntry[], count = 1): TarEntry[] {
  return entries
    .map((e) => ({ ...e, name: e.name.split('/').slice(count).join('/') }))
    .filter((e) => e.name !== '')
}
