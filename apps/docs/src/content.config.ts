import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

// The site renders the repository's `docs/` folder in place: one source of
// truth, readable on GitHub, published here. No copy, no drift.
export const collections = {
  docs: defineCollection({
    loader: glob({ base: '../../docs', pattern: '**/[^_]*.md' }),
    schema: z.object({
      title: z.string(),
      description: z.string().optional(),
    }),
  }),
}
