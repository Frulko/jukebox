// Types, tests, guardrail — in that order, stopping at the first failure.
//
// `npm run check | tail -1 && npm test` protects nothing: the pipe yields
// `tail`'s exit code, not `tsc`'s. That is how a red typecheck gets committed.
import { execFileSync } from 'node:child_process'

for (const [label, script] of [['types', 'check'], ['tests', 'test'], ['guardrail', 'no-native']]) {
  process.stdout.write(`— ${label}… `)
  try {
    execFileSync('npm', ['run', '--silent', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    console.log('ok')
  } catch (err) {
    console.log('FAILED\n')
    process.stdout.write(String(err.stdout ?? ''))
    process.stderr.write(String(err.stderr ?? ''))
    process.exit(1)
  }
}
console.log('\n\u2713 all green')
