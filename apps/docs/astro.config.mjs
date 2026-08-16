// The docs site renders the repository's `docs/` folder as-is and embeds the
// real front end built in demo mode. One source of truth for the prose, the
// actual application for the screenshots.
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: process.env.ASTRO_SITE ?? 'https://frulko.github.io',
  base: process.env.ASTRO_BASE ?? '/jukebox',
  trailingSlash: 'always',
})
