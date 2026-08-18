import { PATHS } from './iconPaths'
import { themeById } from './themes/registry'

/**
 * PATHS is keyed by a closed literal union, but the name arrives here as a
 * plain string — any caller can spell one. One guarded lookup keeps the table
 * closed anyway.
 */
function pick<K extends string, V>(table: Record<K, V>, key: string): V | undefined {
  // SAFETY: the `in` check proves `key` is one of `table`'s own keys; TS just
  // cannot narrow a plain string through it.
  return key in table ? table[key as K] : undefined
}

export function Icon({ name, size = 12, className = '' }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  // Read off the document rather than threaded through props: an icon sits at
  // the bottom of every tree in the app, and the theme is already an attribute
  // on the root — set before the render that follows a change, so this never
  // shows the previous skin's glyph.
  const theme = themeById(document.documentElement.dataset.theme)
  // A theme brings its own glyphs — Studio's heavier set, Material's actual
  // Material Symbols — and names only what it redraws; the rest falls back.
  // An override set comes with the box it was drawn in.
  const themed = theme?.icons?.[name]
  const d = themed ?? pick(PATHS, name) ?? ''
  const viewBox = themed ? theme?.iconViewBox ?? '0 0 16 16' : '0 0 16 16'
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox={viewBox} aria-hidden="true">
      <path d={d} fillRule="evenodd" />
    </svg>
  )
}
