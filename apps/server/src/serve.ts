import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import { createApp } from './app.ts'

const port = Number(process.env.PORT ?? 8787)
const dbFile = process.env.JUKEBOX_DB ?? './data/library.db'

const { app, jobs, scheduler, plugins, closeOutputs } = createApp(dbFile)

/**
 * The web app, when it has been built.
 *
 * Served from the entry point rather than from `createApp`, because it is a
 * packaging concern: in development Vite serves it on its own port, and the
 * tests have no interest in it. In a container it is the whole product — an
 * image that exposed only an API would be a server nobody can use.
 *
 * Mounted after the API routes so `/api/v1` and `/rest` keep their paths, and
 * with a fallback to `index.html` because the front end routes client-side: a
 * deep link would otherwise 404 on reload.
 */
const webRoot = process.env.JUKEBOX_WEB ?? './apps/web/dist'
if (existsSync(webRoot)) {
  app.use('/*', serveStatic({ root: webRoot }))
  app.notFound(async (c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/rest/')) {
      return c.json({ error: { code: 'not_found', message: 'unknown route' } }, 404)
    }
    const index = await serveStatic({ root: webRoot, path: 'index.html' })(c as never, async () => {})
    return (index as Response) ?? c.text('not found', 404)
  })
}

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
    // A cast session is a live socket: the process will not exit while one is
    // open, and the receiver keeps showing an app nobody is talking to.
    closeOutputs()
    // Plugins get told too: one holding a socket open would otherwise keep the
    // process from closing cleanly, and its own `deactivate` never runs.
    void Promise.all(plugins.active().map((id) => plugins.deactivate(id)))
    server.close(() => process.exit(0))
  })
}
