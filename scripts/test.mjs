// Generates the audio fixtures before running the tests.
//
// Without this, a dozen tests skip silently in local runs and are only green in
// CI — the worst of both worlds: the suite looks green while it never exercises
// tag writing. If ffmpeg is missing we say so instead of skipping quietly.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DIR = '.fixtures'
// The four files the tests are written against. The directory also serves as
// the dev server's source root, so manual testing drifts it \u2014 a renamed
// format, an extra album \u2014 and "the directory exists" stops meaning "the
// fixtures are there". Checking the canon is what catches the afternoon where
// 03.flac had become 03.m4a and the transcode tests ran against a ghost.
const CANON = [
  'Daft Punk/Discovery/01.mp3',
  'Daft Punk/Discovery/02.mp3',
  'Daft Punk/Discovery/03.flac',
  'Radiohead/Kid A/01.m4a',
]
let ok = true
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch {
  ok = false
  console.warn('\u26a0 ffmpeg not found \u2014 tag, fingerprint and SDK tests will be skipped.')
  console.warn('  macOS: brew install ffmpeg chromaprint \u00b7 Debian: apt install ffmpeg libchromaprint-tools\n')
}

// Regenerated whenever the canon is incomplete, not only when the directory is
// missing. Regeneration is a clean rebuild: anything added by hand goes with it.
if (ok && !CANON.every((f) => existsSync(join(DIR, f)))) {
  execFileSync('node', ['scripts/fixtures.mjs', DIR], { stdio: 'inherit' })
}

try {
  execFileSync('node', [
    '--experimental-strip-types', '--no-warnings=ExperimentalWarning',
    // Every app with tests, not just the server. The satellite's were written
    // and then never run: `verify` reported all green while an entire
    // application's suite sat unexecuted, which is a worse lie than having no
    // tests at all — nobody doubts a suite that does not exist.
    '--test', 'apps/server/test/*.test.ts', 'apps/satellite/test/*.test.ts',
  ], { stdio: 'inherit', env: { ...process.env, ...(ok ? { JUKEBOX_FIXTURES: DIR } : {}) } })
} catch {
  process.exit(1)
}
