import { cloneElement, useState, type HTMLAttributes, type ReactElement, type Ref } from 'react'
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
} from '@floating-ui/react'

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
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
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

/**
 * Puts a `title` on a cell only when its text is actually cut off.
 *
 * Attached on hover rather than rendered: a table of three hundred rows and ten
 * columns would otherwise mount three thousand tooltip components to explain
 * the handful of cells that are too narrow.
 *
 * Measured on every hover rather than remembered. Caching the answer was the
 * first version and it was wrong: columns here are resizable, so a cell that
 * fitted when you first passed over it is exactly the cell that will not fit
 * after you drag its edge in. One layout read per hover is the price of being
 * right, and hovering is rare.
 */
export function titleIfClipped(e: React.MouseEvent<HTMLElement>) {
  const el = e.currentTarget
  if (el.scrollWidth > el.clientWidth + 1) el.title = el.innerText.trim()
  else el.removeAttribute('title')
}
