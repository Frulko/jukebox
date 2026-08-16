import { serve } from '@hono/node-server'
import { createApp } from './app.ts'

const port = Number(process.env.PORT ?? 8787)
const dbFile = process.env.JUKEBOX_DB ?? './data/library.db'

const { app, jobs } = createApp(dbFile)

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`jukebox · http://localhost:${info.port}/api/v1 · db ${dbFile}`)
})

// An interrupted scan is lost work: let the queue shut down cleanly.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    jobs.stop()
    server.close(() => process.exit(0))
  })
}
