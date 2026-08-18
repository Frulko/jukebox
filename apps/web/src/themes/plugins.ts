import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { registerTheme, unregisterTheme } from './registry'

/**
 * A theme that arrives with a plugin instead of shipping in the app.
 *
 * The manifest declares it the way it declares a menu entry:
 *
 * ```jsonc
 * "contributes": {
 *   "theme": {
 *     "label": "Hot Dog Stand",
 *     "rowHeight": 22,
 *     "tokens": { "--accent": "#ff0000", "--content": "#ffff00" },
 *     "css": ".optional-extra-rules {}"
 *   }
 * }
 * ```
 *
 * `tokens` is the 90% case — a skin *is* a block of token redefinitions, so
 * the host writes that block itself and the plugin never ships CSS at all.
 * `css` is for the rest, and it must scope its own rules under
 * `[data-theme="plugin-<pluginId>"]`: the id is forced through that prefix so
 * a plugin can never shadow a built-in skin or another plugin's.
 *
 * Manifest data styles the page but never runs in it: tokens and css land in
 * a `<style>` element, which is styling, not script. A plugin that is
 * disabled takes its skin with it — wearing the theme of something switched
 * off would be the one place where "off" visibly kept working.
 */

type ThemeContribution = {
  label?: string
  rowHeight?: number
  playlistArt?: boolean
  tokens?: Record<string, string>
  css?: string
}

/** Style elements this hook wrote, by theme id, so a gone plugin is undone. */
const injected = new Map<string, HTMLStyleElement>()

export function usePluginThemes(): void {
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list(), staleTime: 60_000 })

  useEffect(() => {
    const seen = new Set<string>()
    for (const p of plugins.data?.items ?? []) {
      if (p.state !== 'active') continue
      // SAFETY: the manifest's own JSON; every field is checked for presence
      // and coerced before use, and a contribution missing what a theme needs
      // is skipped rather than drawn.
      const t = p.contributes['theme'] as ThemeContribution | undefined
      if (!t || !t.label) continue

      const id = `plugin-${p.id}`
      const tokenLines = Object.entries(t.tokens ?? {})
        // Only custom properties, so a manifest cannot smuggle arbitrary
        // declarations onto the root element through the "tokens" door.
        .filter(([k]) => k.startsWith('--'))
        .map(([k, v]) => `${k}: ${String(v)};`)
      const css =
        (tokenLines.length ? `[data-theme="${id}"] {\n  ${tokenLines.join('\n  ')}\n}\n` : '') +
        (t.css ?? '')
      if (!css) continue

      let style = injected.get(id)
      if (!style) {
        style = document.createElement('style')
        style.dataset.pluginTheme = id
        document.head.appendChild(style)
        injected.set(id, style)
      }
      if (style.textContent !== css) style.textContent = css

      registerTheme({
        id,
        label: t.label,
        rowHeight: Number(t.rowHeight) || 21,
        playlistArt: !!t.playlistArt,
      })
      seen.add(id)
    }

    // A plugin that was disabled or removed takes its skin with it. The app
    // falls back to drawing the base skin under the stale data-theme value,
    // which reads as classic — honest for a theme that no longer exists.
    for (const [id, style] of injected) {
      if (seen.has(id)) continue
      style.remove()
      injected.delete(id)
      unregisterTheme(id)
    }
  }, [plugins.data])
}
