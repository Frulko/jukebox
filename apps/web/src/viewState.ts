import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

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

/** Both setters below take a value or an updater, exactly as `setState` does. */
function resolve<T>(next: T | ((old: T) => T), old: T): T {
  // SAFETY: T is view state — a selection, a layout, an order — and is never
  // itself a function for any caller of these hooks, so a function here can
  // only be the updater.
  return next instanceof Function ? (next as (o: T) => T)(old) : next
}

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
  // SAFETY: the map only ever holds what this hook's own setter wrote under
  // this key, and callers that share a key share the type, so what comes back
  // is the T that went in.
  const [value, setValue] = useState<T>(() => (chosen.has(key) ? (chosen.get(key) as T) : initial))
  // Written in the setter, not in an effect watching the value. The store is
  // the point of this hook, so writing it *is* the update — deferring it to
  // after the render leaves a window where the component and the store
  // disagree, and unmounting inside that window loses the change entirely.
  const set = useCallback((next: T | ((old: T) => T)) => {
    setValue((old) => {
      const v = resolve(next, old)
      chosen.set(key, v)
      return v
    })
  }, [key])
  return [value, set] as const
}

/**
 * `useState` written through to localStorage — this one *does* survive a reload,
 * because a column layout or a sidebar order is a preference, not a place in a
 * list.
 *
 * `merge` reconciles what was stored with today's defaults. Without it, adding a
 * column leaves every existing user without it forever: their saved map predates
 * it, and nothing ever puts it back.
 */
export function usePersisted<T>(key: string, initial: T, merge?: (stored: T, fresh: T) => T) {
  const [v, setV] = useState<T>(() => {
    const raw = localStorage.getItem(key)
    if (!raw) return initial
    try {
      // SAFETY: whatever sits under this key was written by the setter below as
      // the JSON of a T; `merge` reconciles values saved by older versions, and
      // the catch swallows hand-edited garbage.
      const stored = JSON.parse(raw) as T
      return merge ? merge(stored, initial) : stored
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: T | ((old: T) => T)) =>
      setV((old) => {
        const val = resolve(next, old)
        localStorage.setItem(key, JSON.stringify(val))
        return val
      }),
    [key],
  )
  return [v, set] as const
}

/**
 * A hand-sorted order over a list that the app still owns.
 *
 * The stored order is merged with today's ids *at render*, not at mount: a
 * playlist created five minutes ago has to appear at the end of the sidebar
 * without waiting for a reload, and a deleted one has to disappear without
 * leaving a hole. Only the ids the user actually moved are persisted.
 *
 * ponytail: localStorage, so the order is per browser rather than per account.
 * It becomes a server field the day playlists need to look the same on the
 * tablet as on the desktop.
 */
export function useOrder(key: string, ids: string[]) {
  const [stored, setStored] = usePersisted<string[]>(key, [])

  const order = useMemo(
    () => [...stored.filter((id) => ids.includes(id)), ...ids.filter((id) => !stored.includes(id))],
    [stored, ids],
  )

  /** Moves `dragged` before `target`, or after it when the drop landed low. */
  const move = useCallback(
    (dragged: string, target: string, after: boolean) => {
      const next = order.filter((id) => id !== dragged)
      const at = next.indexOf(target)
      next.splice(at < 0 ? next.length : after ? at + 1 : at, 0, dragged)
      setStored(next)
    },
    [order, setStored],
  )

  return [order, move] as const
}

/**
 * Which playlists were opened, most recent first.
 *
 * The server does not record this and should not have to: "what was I listening
 * to" is a question about this browser, not about the library. Kept as ids so a
 * renamed or deleted playlist resolves to what it is now, or to nothing.
 */
export function useRecentPlaylists() {
  const [recent, setRecent] = usePersisted<string[]>('jukebox.recent.playlists', [])
  // Stable, because navigation is built on top of it: an identity that changed
  // every render would make every consumer of `setView` re-render with it.
  const remember = useCallback(
    (id: string) => setRecent((old) => [id, ...old.filter((x) => x !== id)].slice(0, 12)),
    [setRecent],
  )
  return [recent, remember] as const
}

/**
 * A search box that belongs to one view.
 *
 * The box in the player bar asks the server, across a whole source. This one
 * filters what the page is already holding — the albums it drew, the missing
 * files it listed, the playlists it has — which is honest precisely because
 * those views hold all of their rows. It would be a lie in the track list,
 * where the page is a window onto a hundred thousand rows, and that is the one
 * place it is not offered.
 *
 * Deliberately not remembered between visits. A filter you forgot you set is
 * indistinguishable from a view that has gone empty, and the whole point of
 * these pages is to answer "what have I got".
 */
export function useViewSearch() {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const matches = (...fields: Array<string | null | undefined>) =>
    !needle || fields.some((f) => f?.toLowerCase().includes(needle))
  return { query, setQuery, needle, matches }
}
