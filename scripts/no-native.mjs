// The "no native modules shipped" rule does not hold on its own: it is always a
// transitive dependency that breaks it, and you find out when an armhf user
// opens an issue. This script fails first.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const runtime = new Set()

// Production dependencies of the shipped workspaces — not devDependencies.
for (const ws of ['apps/server', 'apps/web']) {
  const pkg = JSON.parse(readFileSync(join(ROOT, ws, 'package.json'), 'utf8'))
  for (const d of Object.keys(pkg.dependencies ?? {})) runtime.add(d)
}

const findings = []
const seen = new Set()

// A .node inside a runtime package. We do not sweep all of node_modules: build
// tools ship binaries of their own, but they are never delivered to users.
function nodeFilesIn(dir, depth = 0) {
  const out = []
  if (depth > 4) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...nodeFilesIn(p, depth + 1))
    else if (e.name.endsWith('.node')) out.push(p.slice(dir.length + 1))
  }
  return out
}

function inspect(name, dir) {
  if (seen.has(dir) || !existsSync(dir)) return
  seen.add(dir)

  if (existsSync(join(dir, 'binding.gyp'))) findings.push(`${name} · binding.gyp`)
  for (const f of nodeFilesIn(dir)) findings.push(`${name} · compiled binary ${f}`)

  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { return }

  for (const hook of ['preinstall', 'install', 'postinstall']) {
    const s = pkg.scripts?.[hook]
    if (s) findings.push(`${name} · script ${hook}: ${s}`)
  }
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    inspect(dep, join(ROOT, 'node_modules', dep))
  }
}

for (const name of runtime) inspect(name, join(ROOT, 'node_modules', name))

// TypeScript syntax that requires a transform, and is therefore forbidden under
// --experimental-strip-types: it breaks neither the typecheck nor the lint, only
// runtime, and often in a file nobody has re-run since.
const EMIT_ONLY = [
  [/\bconstructor\s*\([^)]*\b(readonly|public|private|protected)\s/, 'parameter property'],
  [/^\s*(export\s+)?enum\s/m, 'enum'],
  [/^\s*(export\s+)?namespace\s/m, 'namespace'],
  [/^\s*@[A-Za-z_$][\w$]*\s*(\(|$)/m, 'decorator'],
]
function scanSources(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { scanSources(p); continue }
    if (!/\.tsx?$/.test(e.name)) continue
    // Comments are stripped first: a comment that *describes* the rule must not
    // trigger it.
    const src = readFileSync(p, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const [re, label] of EMIT_ONLY) {
      if (re.test(src)) findings.push(`${p.slice(ROOT.length)} · ${label} — incompatible with --experimental-strip-types`)
    }
  }
}
for (const d of ['apps', 'packages', 'scripts']) {
  if (existsSync(join(ROOT, d))) scanSources(join(ROOT, d))
}

if (findings.length) {
  console.error('\u2717 Install or runtime would break:\n')
  for (const f of findings) console.error('  ' + f)
  console.error('\nSee docs/stack.md.')
  process.exit(1)
}
console.log(`\u2713 ${seen.size} runtime packages inspected \u2014 no native code, no install scripts.`)
console.log('\u2713 sources are --experimental-strip-types compatible.')
