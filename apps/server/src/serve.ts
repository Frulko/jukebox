import { serve } from '@hono/node-server'
import { createApp } from './app.ts'

const port = Number(process.env.PORT ?? 8787)
const dbFile = process.env.JUKEBOX_DB ?? './data/library.db'

const { app, jobs, scheduler, plugins } = createApp(dbFile)

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`jukebox · http://localhost:${info.port}/api/v1 · db ${dbFile}`)
})

// After the port is open: a plugin that hangs on load delays its own
// activation, never the server answering requests.
plugins.discover()
  .then(() => plugins.activateAll())
  .then(() => {
    const active = plugins.active()
    if (active.length) console.log(`jukebox · ${active.length} plugins active: ${active.join(', ')}`)
  })
  .catch((err) => console.error('plugins failed to load:', err instanceof Error ? err.message : err))

// An interrupted scan is lost work: let the queue shut down cleanly.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    jobs.stop()
    scheduler.stop()
    // Plugins get told too: one holding a socket open would otherwise keep the
    // process from closing cleanly, and its own `deactivate` never runs.
    void Promise.all(plugins.active().map((id) => plugins.deactivate(id)))
    server.close(() => process.exit(0))
  })
}
