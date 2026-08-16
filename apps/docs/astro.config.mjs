// The docs site renders the repository's `docs/` folder as-is: one source of
// truth, readable on GitHub, published on Pages. No copy, no drift.
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://frulko.github.io',
  base: '/jukebox',
  integrations: [
    starlight({
      title: 'Jukebox',
      description: 'Self-hosted manager for your own music library.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Frulko/jukebox' },
      ],
      sidebar: [
        { label: 'Architecture', slug: 'architecture' },
        { label: 'Stack', slug: 'stack' },
        { label: 'API', slug: 'api' },
        { label: 'UI evolution', slug: 'ui-evolution' },
        { label: 'System map', link: '/map', attrs: { target: '_blank' } },
      ],
      editLink: {
        baseUrl: 'https://github.com/Frulko/jukebox/edit/main/docs/',
      },
    }),
  ],
})
