import { useEffect } from 'react'
import { autoUpdate, flip, shift, useFloating } from '@floating-ui/react'

/**
 * Places a menu at a pointer, and keeps it on screen.
 *
 * Right-clicking near the bottom of a long list used to open a menu that ran
 * off the window: the last entries were unreachable, and the ones at the bottom
 * of a menu are conventionally the destructive ones.
 *
 * Floating UI rather than arithmetic, deliberately. Flipping, shifting,
 * scrollbars, page zoom, a menu taller than the viewport — each is a line of
 * maths that looks right until one of them is wrong, and none of them is
 * interesting to own.
 */
export function useMenuPosition(point: { x: number; y: number } | null) {
  const { refs, floatingStyles } = useFloating({
    open: point !== null,
    // A context menu hangs down and to the right of the pointer when it fits;
    // `flip` turns it over when it does not, `shift` slides it back in.
    placement: 'right-start',
    middleware: [flip({ crossAxis: false }), shift({ padding: 6 })],
    whileElementsMounted: autoUpdate,
  })

  useEffect(() => {
    if (!point) return
    // The pointer is a zero-sized virtual element: there is no node under the
    // cursor to anchor to, only a coordinate.
    refs.setPositionReference({
      getBoundingClientRect: () => ({
        width: 0,
        height: 0,
        x: point.x,
        y: point.y,
        top: point.y,
        left: point.x,
        right: point.x,
        bottom: point.y,
      }),
    })
  }, [point?.x, point?.y, refs])

  return { setFloating: refs.setFloating, floatingStyles }
}
