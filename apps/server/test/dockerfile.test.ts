import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../../..')

/**
 * What the shipped image actually contains.
 *
 * The build stage copies the whole repository; the runtime stage cherry-picks,
 * and the cherry-picking is where things go missing. `plugins/` was missing —
 * so every plugin was absent from the only deployment target that matters, and
 * nothing said so: a server with no plugins is indistinguishable from one whose
 * plugins are all switched off, and the CI smoke test passes because /health
 * answers perfectly well with none.
 *
 * A test rather than care, because care is what failed.
 */

/** Every path the server needs at runtime, and why it needs it. */
const REQUIRED = [
  ['node_modules', 'hono and the workspace links'],
  ['package.json', 'the workspace root, which resolves @jukebox/* imports'],
  ['apps/server', 'the server itself'],
  ['apps/web/dist', 'the built front end, which serve.ts mounts'],
  ['packages', 'api-types and the client SDK'],
  ['plugins', 'the default JUKEBOX_PLUGINS path'],
] as const

test('the runtime image contains everything the server reads at runtime', async () => {
  const dockerfile = await readFile(join(ROOT, 'Dockerfile'), 'utf8')

  // Only the final stage. The build stage does `COPY . .`, which would make
  // every one of these look satisfied.
  const stages = dockerfile.split(/^FROM /m)
  const runtime = stages.at(-1) ?? ''
  assert.ok(runtime.includes('COPY --from=build'), 'the last stage is the runtime one')

  const missing = REQUIRED
    .filter(([path]) => !new RegExp(`COPY --from=build /app/${path}\\b`).test(runtime))
    .map(([path, why]) => `${path} — ${why}`)

  assert.deepEqual(missing, [], 'these are not in the shipped image')
})

test('nothing that comes from the repository is excluded by .dockerignore', async () => {
  const ignore = await readFile(join(ROOT, '.dockerignore'), 'utf8')
  const patterns = ignore.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

  // Only the paths that arrive with the source. `node_modules` and
  // `apps/web/dist` are built inside the image by `npm ci` and `npm run build`,
  // so excluding them from the build context is right rather than wrong — it is
  // what stops a stale host build being baked in.
  //
  // For the rest, an entry here empties the directory in the build stage, the
  // runtime COPY then succeeds and copies nothing, and the result is the same
  // silent absence arrived at from the other end.
  const fromRepo = ['package.json', 'apps/server', 'packages', 'plugins']
  for (const path of fromRepo) {
    const top = path.split('/')[0]
    assert.ok(!patterns.includes(top) && !patterns.includes(path),
      `.dockerignore excludes ${path}, which the image needs from the source`)
  }
})
