import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeName, stripComponents, untar } from '../src/untar.ts'

/**
 * Driven against archives made by the system `tar`, because the risk in this
 * module is my reading of the format being wrong, and a fixture I generated
 * myself would agree with my misreading.
 */

async function makeArchive(build: (dir: string) => Promise<void>, gzip = true): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-tar-'))
  try {
    await mkdir(join(dir, 'plugin'), { recursive: true })
    await build(join(dir, 'plugin'))
    const out = join(dir, 'a.tar' + (gzip ? '.gz' : ''))
    execFileSync('tar', [gzip ? '-czf' : '-cf', out, '-C', dir, 'plugin'])
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a real tarball reads back file for file', async () => {
  const archive = await makeArchive(async (d) => {
    await writeFile(join(d, 'plugin.json'), '{"id":"x"}')
    await mkdir(join(d, 'lib'))
    await writeFile(join(d, 'lib', 'index.mjs'), 'export const a = 1')
  })

  const entries = stripComponents(untar(archive))
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]))
  assert.equal(byName['plugin.json'].data.toString(), '{"id":"x"}')
  assert.equal(byName['lib/index.mjs'].data.toString(), 'export const a = 1')
  assert.equal(byName['lib'].type, 'dir')
})

test('an uncompressed tarball works too', async () => {
  const archive = await makeArchive(async (d) => {
    await writeFile(join(d, 'plugin.json'), '{}')
  }, false)
  assert.ok(stripComponents(untar(archive)).some((e) => e.name === 'plugin.json'))
})

test('a file larger than one block survives the padding', async () => {
  // 512-byte blocks: anything that is not an exact multiple is where an
  // off-by-one in the padding arithmetic shows up.
  const body = 'x'.repeat(1500)
  const archive = await makeArchive(async (d) => {
    await writeFile(join(d, 'big.txt'), body)
    await writeFile(join(d, 'after.txt'), 'still here')
  })
  const byName = Object.fromEntries(stripComponents(untar(archive)).map((e) => [e.name, e]))
  assert.equal(byName['big.txt'].data.toString(), body)
  // The one that proves the reader resynchronised rather than losing its place.
  assert.equal(byName['after.txt'].data.toString(), 'still here')
})

test('a name too long for the 100-byte field still reads', async () => {
  const deep = 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/' + 'c'.repeat(40)
  const archive = await makeArchive(async (d) => {
    await mkdir(join(d, 'a'.repeat(60), 'b'.repeat(60)), { recursive: true })
    await writeFile(join(d, deep), 'deep')
  })
  const found = stripComponents(untar(archive)).find((e) => e.name === deep)
  assert.ok(found, 'the prefix field or a GNU long name header was handled')
  assert.equal(found.data.toString(), 'deep')
})

test('a symlink is refused, not silently skipped', async () => {
  const archive = await makeArchive(async (d) => {
    await writeFile(join(d, 'plugin.json'), '{}')
    // The second half of the classic attack: a link out, then a write through it.
    await symlink('/etc', join(d, 'escape'))
  })
  assert.throws(() => untar(archive), /contains a link/)
})

test('a path that climbs out is refused', () => {
  // Checked on the archive's own name, before any joining -- `join` resolves
  // `..` away and would hide exactly this.
  assert.ok(!safeName('../etc/passwd'))
  assert.ok(!safeName('a/../../b'), 'any segment, not only a leading one')
  assert.ok(!safeName('/etc/passwd'))
  assert.ok(!safeName('C:/windows'))
  assert.ok(!safeName(''))
  assert.ok(safeName('plugin/lib/index.mjs'))
  assert.ok(safeName('a..b/c'), 'a name that merely contains dots is fine')
})

test('an oversized archive is refused before it is unpacked', async () => {
  const archive = await makeArchive(async (d) => {
    await writeFile(join(d, 'big.bin'), Buffer.alloc(200_000))
  })
  assert.throws(() => untar(archive, { maxBytes: 100_000 }), /larger than/)
  assert.ok(untar(archive, { maxBytes: 1_000_000 }).length > 0)
})

test('trailing rubbish after the end blocks is ignored', async () => {
  const archive = await makeArchive(async (d) => {
    await writeFile(join(d, 'plugin.json'), '{}')
  }, false)
  const withJunk = Buffer.concat([archive, Buffer.from('not a header at all')])
  assert.ok(stripComponents(untar(withJunk)).some((e) => e.name === 'plugin.json'))
})
