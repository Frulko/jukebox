import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'

/**
 * Browsing a source, and the favorites starred while doing it.
 *
 * The connection settings prove a source answers; the browse is what proves it
 * holds the music, and the only moment a root can be chosen by walking instead
 * of typing — it is immutable afterwards.
 */

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-browse-'))
  const app = createApp(join(dir, 'db.sqlite'))

  // A little filesystem worth looking at: two folders of music, a nested one,
  // a dotfile to skip and a text file that is not audio.
  const music = join(dir, 'music')
  await mkdir(join(music, 'Albums', 'Discovery'), { recursive: true })
  await mkdir(join(music, 'Singles'), { recursive: true })
  await writeFile(join(music, 'Albums', 'Discovery', 'One More Time.mp3'), 'x')
  await writeFile(join(music, 'Singles', 'loose.flac'), 'x')
  await writeFile(join(music, 'notes.txt'), 'x')
  await writeFile(join(music, '.DS_Store'), 'x')

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.app.fetch(new Request(`http://x/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  return { app, music, call, cleanup: () => { app.jobs.stop(); return rm(dir, { recursive: true, force: true }) } }
}

test('a local source lists folders first, audio files after, noise never', async () => {
  const h = await harness()
  try {
    const made = await h.call('POST', '/sources', { name: 'Music', root: h.music })
    const { status, body } = await h.call('GET', `/sources/${made.body.id}/browse`)
    assert.equal(status, 200)
    assert.deepEqual(body.entries.map((e: any) => e.name), ['Albums', 'Singles'],
      'the txt and the dotfile are nobody’s music')

    const deeper = await h.call('GET', `/sources/${made.body.id}/browse?path=Albums/Discovery`)
    assert.deepEqual(deeper.body.entries, [
      { name: 'One More Time.mp3', path: 'Albums/Discovery/One More Time.mp3', dir: false },
    ])
  } finally { await h.cleanup() }
})

test('a path that tries to leave the source is a refusal, not a join', async () => {
  const h = await harness()
  try {
    const made = await h.call('POST', '/sources', { name: 'Music', root: h.music })
    for (const path of ['..', 'Albums/../..', encodeURIComponent('/etc')]) {
      const { status, body } = await h.call('GET', `/sources/${made.body.id}/browse?path=${path}`)
      assert.equal(status, 400, `"${path}" must not browse outside the root`)
      assert.equal(body.error.code, 'bad_path')
    }
    assert.equal((await h.call('GET', '/sources/nope/browse')).status, 404)
  } finally { await h.cleanup() }
})

test('a draft browses before the source exists — the root is picked, not typed', async () => {
  const h = await harness()
  try {
    const { status, body } = await h.call('POST', '/sources/browse', { root: h.music })
    assert.equal(status, 200)
    assert.deepEqual(body.entries.filter((e: any) => e.dir).map((e: any) => e.name), ['Albums', 'Singles'])

    const gone = await h.call('POST', '/sources/browse', { root: join(h.music, 'no-such-dir') })
    assert.equal(gone.status, 502, 'a folder that is not there is the source’s failure, said as such')
  } finally { await h.cleanup() }
})

test('favorites survive the round trip, replace whole, and refuse non-lists', async () => {
  const h = await harness()
  try {
    const made = await h.call('POST', '/sources', { name: 'Music', root: h.music })
    assert.deepEqual(made.body.favorites, [], 'born with none')

    const starred = await h.call('PATCH', `/sources/${made.body.id}`,
      { favorites: ['Albums/Discovery', ' Singles ', 'Albums/Discovery'] })
    assert.deepEqual(starred.body.favorites,
      [{ path: 'Albums/Discovery', kind: null }, { path: 'Singles', kind: null }],
      'trimmed, deduped — a bare string is a bookmark with no kind')

    const listed = await h.call('GET', '/sources')
    assert.deepEqual(listed.body.items[0].favorites,
      [{ path: 'Albums/Discovery', kind: null }, { path: 'Singles', kind: null }])

    const kinded = await h.call('PATCH', `/sources/${made.body.id}`,
      { favorites: [{ path: 'Albums/', kind: 'audiobook' }] })
    assert.deepEqual(kinded.body.favorites, [{ path: 'Albums', kind: 'audiobook' }],
      'the trailing slash goes, the kind stays')

    const cleared = await h.call('PATCH', `/sources/${made.body.id}`, { favorites: [] })
    assert.deepEqual(cleared.body.favorites, [], 'an emptied list has to be sayable')

    assert.equal((await h.call('PATCH', `/sources/${made.body.id}`, { favorites: 'Albums' })).status, 400)
    assert.equal((await h.call('PATCH', `/sources/${made.body.id}`, { favorites: [1] })).status, 400)
    assert.equal((await h.call('PATCH', `/sources/${made.body.id}`,
      { favorites: [{ path: 'Albums', kind: 'video' }] })).status, 400,
      'a kind the library does not have is a refusal')
  } finally { await h.cleanup() }
})

test('a favorite with a kind files what is under it — now, and on the next scan', async () => {
  const h = await harness()
  try {
    const made = await h.call('POST', '/sources', { name: 'Music', root: h.music })
    const id = made.body.id
    await h.call('POST', `/sources/${id}/scan`)
    await settle(h.app.jobs)

    const kinds = async () => Object.fromEntries(
      ((await h.call('GET', '/tracks?limit=50')).body.items as any[]).map((t) => [t.path, t.kind]))
    assert.deepEqual(await kinds(), {
      'Albums/Discovery/One More Time.mp3': 'music',
      'Singles/loose.flac': 'music',
    }, 'nothing said otherwise, so everything is music')

    // Starring with a kind refiles what is already scanned…
    await h.call('PATCH', `/sources/${id}`, { favorites: [{ path: 'Albums', kind: 'audiobook' }] })
    assert.equal((await kinds())['Albums/Discovery/One More Time.mp3'], 'audiobook')
    assert.equal((await kinds())['Singles/loose.flac'], 'music', 'the unstarred folder is untouched')

    // …and files what a later scan brings in.
    await writeFile(join(h.music, 'Albums', 'chapter two.mp3'), 'x')
    await h.call('POST', `/sources/${id}/scan`)
    await settle(h.app.jobs)
    assert.equal((await kinds())['Albums/chapter two.mp3'], 'audiobook')

    // The closest starred parent decides.
    await h.call('PATCH', `/sources/${id}`, { favorites: [
      { path: 'Albums', kind: 'audiobook' },
      { path: 'Albums/Discovery', kind: 'music' },
    ] })
    const after = await kinds()
    assert.equal(after['Albums/Discovery/One More Time.mp3'], 'music')
    assert.equal(after['Albums/chapter two.mp3'], 'audiobook')
  } finally { await h.cleanup() }
})

/** Waits for the queue to drain — more reliable than a fixed delay. */
async function settle(jobs: any, ms = 4000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const busy = jobs.list({}).some((j: any) => j.state === 'queued' || j.state === 'running')
    if (!busy) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('the queue never drains')
}

test('the folder tree is the machine’s layout: admins browse, guests do not', async () => {
  const h = await harness()
  try {
    const made = await h.call('POST', '/sources', { name: 'Music', root: h.music })
    await h.call('POST', '/auth/setup', { username: 'boss', password: 'correct horse battery' })
    const admin = (await h.call('POST', '/auth/login', { username: 'boss', password: 'correct horse battery' })).body.token

    await h.app.app.fetch(new Request('http://x/api/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify({ username: 'kid', password: 'another long one here', role: 'guest' }),
    }))
    const guest = (await h.call('POST', '/auth/login', { username: 'kid', password: 'another long one here' })).body.token

    const ask = (token: string) => h.app.app.fetch(new Request(`http://x/api/v1/sources/${made.body.id}/browse`, {
      headers: { authorization: `Bearer ${token}` },
    }))
    assert.equal((await ask(admin)).status, 200)
    assert.equal((await ask(guest)).status, 403)

    // Favorites follow the root's rule in the listing, too.
    await h.app.app.fetch(new Request(`http://x/api/v1/sources/${made.body.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify({ favorites: ['Albums'] }),
    }))
    const asGuest = await (await h.app.app.fetch(new Request('http://x/api/v1/sources', {
      headers: { authorization: `Bearer ${guest}` },
    }))).json() as any
    assert.deepEqual(asGuest.items[0].favorites, [], 'a folder name is the machine’s layout')
  } finally { await h.cleanup() }
})
