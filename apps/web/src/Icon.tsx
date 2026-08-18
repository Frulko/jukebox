import { PATHS, THEMED } from './iconPaths'

/**
 * Both tables above are keyed by closed literal unions, but the keys arrive
 * here as plain strings — a theme name off the DOM, an icon name any caller
 * can spell. One guarded lookup keeps the tables closed anyway.
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
  const theme = document.documentElement.dataset.theme ?? ''
  const themed = pick(THEMED, theme)
  const d = (themed && pick(themed, name)) ?? pick(PATHS, name) ?? ''
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} fillRule="evenodd" />
    </svg>
  )
}
