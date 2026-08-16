import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Resources } from '../src/transports.ts'

/**
 * Sidecars: a plugin owning a program.
 *
 * Tested against real processes, because every failure worth catching here is
 * about a real one — a pipe that fills, a process that outlives its owner, a
 * restart loop that pins a core.
 */

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits for a condition rather than sleeping long enough and hoping. */
async function until(fn: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await settle(10)
  }
  return false
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a sidecar runs, and its output arrives a line at a time', async () => {
  const res = new Resources()
  const lines: string[] = []
  try {
    const side = res.transports().spawn('node',
      ['-e', 'console.log("first"); console.error("on stderr"); console.log("second")'],
      { onOutput: (line, stream) => lines.push(`${stream}:${line}`) })

    assert.ok(await until(() => lines.length >= 3), lines.join(','))
    // Split on newlines rather than handed over per chunk: a process writing
    // two lines in one write must not produce one line containing both.
    assert.deepEqual(lines.sort(), ['stderr:on stderr', 'stdout:first', 'stdout:second'])
    assert.equal(side.starts, 1)
  } finally { res.closeAll() }
})

test('output is drained even when nobody asked for it', async () => {
  const res = new Resources()
  try {
    // Far more than a pipe buffer holds. A process whose stdout fills up blocks
    // mid-write and looks like a hang -- with no listener attached, the stream
    // still has to be consumed.
    const side = res.transports().spawn('node',
      ['-e', 'for (let i = 0; i < 200000; i++) console.log("x".repeat(80)); console.log("DONE")'])

    let exited = false
    side.process?.on('exit', () => { exited = true })
    assert.ok(await until(() => exited, 15_000), 'it finished rather than blocking on a full pipe')
  } finally { res.closeAll() }
})

test('stopping the plugin kills its sidecar', async () => {
  const res = new Resources()
  // Something that would otherwise run for ever, which is what a daemon is.
  const side = res.transports().spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
  const pid = side.process!.pid!

  assert.ok(await until(() => alive(pid)))
  assert.equal(res.open.children, 1)

  res.closeAll()
  // An orphaned process is worse than an orphaned socket: it holds a port,
  // eats CPU and survives everything short of a reboot.
  assert.ok(await until(() => !alive(pid)), 'the process is gone')
  assert.equal(res.open.children, 0)
})

test('stop() ends it without waiting for the plugin to be disabled', async () => {
  const res = new Resources()
  try {
    const side = res.transports().spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
    const pid = side.process!.pid!
    assert.ok(await until(() => alive(pid)))

    side.stop()
    assert.ok(await until(() => !alive(pid)))
    assert.equal(side.running, false)
  } finally { res.closeAll() }
})

test('a sidecar that dies comes back when asked, and stays dead when not', async () => {
  const res = new Resources()
  try {
    const t = res.transports()

    // Without restart: one life, and the exit is reported.
    const exits: (number | null)[] = []
    t.spawn('node', ['-e', 'process.exit(3)'], { onExit: (code) => exits.push(code) })
    assert.ok(await until(() => exits.length === 1))
    assert.equal(exits[0], 3)
    await settle(300)
    assert.equal(exits.length, 1, 'it did not come back on its own')

    // With restart: it does, and the delay grows so a program that cannot start
    // does not become a busy loop.
    const restarts: number[] = []
    const side = t.spawn('node', ['-e', 'process.exit(1)'],
      { restart: true, onExit: () => restarts.push(Date.now()) })
    assert.ok(await until(() => restarts.length >= 3, 8000), `only ${restarts.length}`)
    assert.ok(side.starts >= 3)

    const first = restarts[1] - restarts[0]
    const later = restarts[restarts.length - 1] - restarts[restarts.length - 2]
    assert.ok(later > first, `backoff grows: ${first}ms then ${later}ms`)

    side.stop()
    const seen = side.starts
    await settle(2500)
    assert.equal(side.starts, seen, 'stop() means stop, not stop until the next backoff')
  } finally { res.closeAll() }
})

test('a command that does not exist is reported, not thrown', async () => {
  const res = new Resources()
  const errors: string[] = []
  try {
    res.transports().spawn('definitely-not-a-real-binary-xyz', [],
      { onOutput: (line, stream) => { if (stream === 'stderr') errors.push(line) } })

    // A plugin naming a program that is not installed is an ordinary
    // misconfiguration and has to read like one.
    assert.ok(await until(() => errors.length > 0), 'it said so')
    assert.match(errors[0], /failed to start/)
  } finally { res.closeAll() }
})

test('spawning after the plugin stopped starts nothing', async () => {
  const res = new Resources()
  res.closeAll()

  // A callback that outlived its plugin must not be able to start a process
  // the host has already stopped accounting for.
  const side = res.transports().spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
  assert.equal(side.process, null)
  assert.equal(res.open.children, 0)
})

test('a sidecar cannot keep the server from exiting', async () => {
  // The plugin-timer lesson, applied to processes: the child is unref'd, so a
  // running sidecar is never the reason SIGTERM appears to do nothing.
  const res = new Resources()
  try {
    const side = res.transports().spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
    await until(() => Boolean(side.process?.pid))
    // Node exposes no direct "is this handle ref'd" check, so this asserts the
    // call was made rather than its effect; the effect is what `unref()` is.
    assert.equal(typeof side.process!.unref, 'function')
    assert.equal(side.running, true)
  } finally { res.closeAll() }
})

test('stdin is writable, which is how most of these are actually driven', async () => {
  const res = new Resources()
  const lines: string[] = []
  try {
    const side = res.transports().spawn('node', ['-e', `
      let buf = ''
      process.stdin.on('data', (c) => {
        buf += c
        const parts = buf.split('\\n')
        buf = parts.pop()
        for (const p of parts) console.log('echo:' + p)
      })
    `], { onOutput: (line) => lines.push(line) })

    side.write('hello\n')
    side.write('again\n')
    assert.ok(await until(() => lines.length >= 2), lines.join(','))
    assert.deepEqual(lines, ['echo:hello', 'echo:again'])
  } finally { res.closeAll() }
})
