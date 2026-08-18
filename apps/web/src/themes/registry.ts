import { useSyncExternalStore } from 'react'

/**
 * The themes, as a registry rather than a hardcoded table.
 *
 * A skin used to be three entries in three places: a CSS block in itunes.css,
 * a line in THEMES and a number in THEME_ROW_H. Now a theme is **one module**
 * — its CSS, its numbers, its icon overrides — registered here as a side
 * effect of being imported. Delete the import in `themes/index.ts` and the
 * whole skin leaves the bundle; a plugin can call the same `registerTheme` at
 * runtime, which is how a theme arrives without shipping in the app at all.
 */

export type ThemeDef = {
  /** Goes on `data-theme` on the document, so it is also a CSS scope. */
  id: string
  /** What the picker shows. */
  label: string
  /** Must match the theme's `--row-h`; the virtualiser needs the number. */
  rowHeight: number
  /** Generated playlist art next to each sidebar playlist. */
  playlistArt?: boolean
  /**
   * Glyphs this theme draws differently, name → path data. Anything not named
   * falls back to the app's own set, so a theme redraws only what it must.
   */
  icons?: Record<string, string>
  /** The box the override paths are drawn in. The app's own set is 16×16. */
  iconViewBox?: string
}

const themes = new Map<string, ThemeDef>()
let version = 0
const listeners = new Set<() => void>()

export function registerTheme(def: ThemeDef): void {
  themes.set(def.id, def)
  version++
  listeners.forEach((l) => l())
}

/** For plugin themes: the plugin went away, its skin goes with it. */
export function unregisterTheme(id: string): void {
  if (!themes.delete(id)) return
  version++
  listeners.forEach((l) => l())
}

export const themeById = (id: string | null | undefined): ThemeDef | undefined =>
  id ? themes.get(id) : undefined

/** Registration order — built-ins first, plugin themes after. */
export const themeList = (): ThemeDef[] => [...themes.values()]

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/**
 * The list, as something React re-renders on. Built-ins register before the
 * first render; a plugin theme lands whenever its manifest does, and the
 * picker has to grow a button at that moment.
 */
export function useThemes(): ThemeDef[] {
  useSyncExternalStore(subscribe, () => version)
  return themeList()
}
