import { defineCollection } from 'astro:content'
import { docsSchema } from '@astrojs/starlight/schema'
import { glob } from 'astro/loaders'

// `docsLoader()` hardcodes `src/content/docs`; the glob loader is the supported
// way to point Starlight at a directory outside the Astro project.
export const collections = {
  docs: defineCollection({
    loader: glob({ base: '../../docs', pattern: '**/[^_]*.md' }),
    schema: docsSchema(),
  }),
}
