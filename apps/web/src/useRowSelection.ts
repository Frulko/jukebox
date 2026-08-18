import { useRef, useState } from 'react'

/**
 * Selection for a list of hand-drawn rows — an album's tracks, a book's
 * chapters, a feed's episodes. The same grammar as the library list: plain
 * click replaces, cmd toggles, shift extends from the anchor, and a
 * right-click outside the selection makes that row the selection while one
 * inside it leaves the selection standing.
 *
 * TrackList keeps its own richer version (rubber band, drag, keyboard); this
 * is for every list too small to need a virtualizer.
 */
export function useRowSelection(ids: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchor = useRef<string | null>(null)

  const click = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor.current) {
      const a = ids.indexOf(anchor.current)
      const b = ids.indexOf(id)
      if (a > -1 && b > -1) return setSelected(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)))
    }
    anchor.current = id
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return setSelected(next)
    }
    setSelected(new Set([id]))
  }

  /** What a right-click on `id` acts on, in list order. */
  const forMenu = (id: string): string[] => {
    if (selected.has(id)) return ids.filter((x) => selected.has(x))
    setSelected(new Set([id]))
    anchor.current = id
    return [id]
  }

  return { selected, click, forMenu }
}
