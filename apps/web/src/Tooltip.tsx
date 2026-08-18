import { cloneElement, useCallback, useState, type HTMLAttributes, type ReactElement, type Ref } from 'react'
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
  type OpenChangeReason,
} from '@floating-ui/react'

/**
 * When the pointer last actually moved. One listener for every tooltip: the
 * question "did the person move, or did the page move under them?" is global.
 */
let lastPointerMove = 0
window.addEventListener('pointermove', () => { lastPointerMove = Date.now() }, { capture: true, passive: true })

/**
 * A tooltip for things that cannot say what they are.
 *
 * An icon with no label is a rebus. The native `title` does the job, badly: it
 * waits about a second, it cannot be styled to match a theme, it never appears
 * on keyboard focus, and on touch it does not exist at all. This is the same
 * contract with those four things fixed.
 *
 * Not for every element — a tooltip on something already labelled is noise.
 * Icons, truncated text and controls whose consequence is not written on them.
 */
export function Tooltip({
  label,
  placement = 'top',
  children,
}: {
  label: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
  /** Any single element that can take a ref — React 19 passes it as a prop. */
  children: ReactElement<HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> }>
}) {
  const [open, setOpen] = useState(false)
  /**
   * A tooltip must be *pointed at*. While a scan streams tracks in, the list
   * slides under a parked cursor and every row that passes gets a mouseenter
   * from the browser's re-hit-testing — nobody moved, but hover-opens arrive
   * in a loop and the tip strobes open/closed for as long as the job runs. A
   * real hover is always preceded by the pointer moving moments ago (the open
   * delay is 350ms), so an open whose pointer has been still for over a
   * second is the page moving, and is refused. Focus opens are exempt: a
   * keyboard user's pointer is parked by definition.
   */
  const guardedSetOpen = useCallback((next: boolean, _event?: Event, reason?: OpenChangeReason) => {
    if (next && reason === 'hover' && Date.now() - lastPointerMove > 1000) return
    setOpen(next)
  }, [])
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: guardedSetOpen,
    placement,
    middleware: [offset(6), flip(), shift({ padding: 6 })],
    whileElementsMounted: autoUpdate,
  })

  const { getReferenceProps, getFloatingProps } = useInteractions([
    // Long enough not to fire while the pointer crosses the row on its way
    // somewhere else, short enough to feel like an answer.
    useHover(context, { delay: { open: 350, close: 60 }, move: false }),
    // Keyboard users get the same explanation, which `title` never gave them.
    useFocus(context),
    useDismiss(context),
    useRole(context, { role: 'tooltip' }),
  ])

  return (
    <>
      {cloneElement(children, { ref: refs.setReference, ...getReferenceProps() })}
      {open && (
        // Portalled: a tooltip inside a row that clips its overflow would be
        // cut in half by the very cell it is explaining.
        <FloatingPortal>
          <div ref={refs.setFloating} style={floatingStyles} className="tip" {...getFloatingProps()}>
            {label}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
