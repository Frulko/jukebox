import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Where each pane was left, and what each view had chosen.
 *
 * Switching source unmounts a view entirely — that is what keeps the tree small
 * with 100,000 tracks behind it — so anything the component holds in `useState`
 * dies with it. These two maps live at module level instead, which is the whole
 * trick: the state outlives the component but not the page. Deliberately not
 * persisted across reloads. Reopening the app should feel new; stepping back
 * into a view you were reading should not.
 */
const scroll = new Map<string, { top: number; left: number }>()
const chosen = new Map<string, unknown>()

/** Remembers a scroll container's position. Attach both to the scrolling element. */
export function useScrollMemory<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null)

  // Before paint, so the restore is not a visible jump.
  useLayoutEffect(() => {
    const at = scroll.get(key)
    if (at && ref.current) {
      ref.current.scrollTop = at.top
      ref.current.scrollLeft = at.left
    }
  }, [key])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (el) scroll.set(key, { top: el.scrollTop, left: el.scrollLeft })
  }, [key])

  return { ref, onScroll }
}

/**
 * `useState` that a remount does not reset.
 *
 * The key must be stable for the life of the component: it is read once, on
 * mount. Two views that share a key share the value, which is occasionally what
 * you want and otherwise a bug — key them by source.
 */
export function useRemembered<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => (chosen.has(key) ? (chosen.get(key) as T) : initial))
  useEffect(() => { chosen.set(key, value) }, [key, value])
  return [value, setValue] as const
}
