// Generates the audio fixtures before running the tests.
//
// Without this, a dozen tests skip silently in local runs and are only green in
// CI — the worst of both worlds: the suite looks green while it never exercises
// tag writing. If ffmpeg is missing we say so instead of skipping quietly.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const DIR = '.fixtures'
let ok = true
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch {
  ok = false
  console.warn('\u26a0 ffmpeg not found \u2014 tag, fingerprint and SDK tests will be skipped.')
  console.warn('  macOS: brew install ffmpeg chromaprint \u00b7 Debian: apt install ffmpeg libchromaprint-tools\n')
}

if (ok && !existsSync(DIR)) execFileSync('node', ['scripts/fixtures.mjs', DIR], { stdio: 'inherit' })

try {
  execFileSync('node', [
    '--experimental-strip-types', '--no-warnings=ExperimentalWarning',
    '--test', 'apps/server/test/*.test.ts',
  ], { stdio: 'inherit', env: { ...process.env, ...(ok ? { JUKEBOX_FIXTURES: DIR } : {}) } })
} catch {
  process.exit(1)
}
