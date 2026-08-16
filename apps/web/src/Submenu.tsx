import { useState, type ReactNode } from 'react'
import {
  autoUpdate, flip, offset, safePolygon, shift, size, useDismiss, useFloating, useHover,
  useInteractions,
} from '@floating-ui/react'

/**
 * A submenu of the context menu, placed rather than assumed.
 *
 * The parent menu already flips and shifts to stay on screen; its flyouts did
 * not — they were `left: 100%` in CSS, so a right-click near the right edge put
 * "Add to Playlist" off the side of the window, and one near the bottom ran a
 * list of playlists past the bottom of it. The menu being placed properly made
 * this worse rather than better: a menu that flips to the left of the pointer
 * still grew its submenu to the right, straight off the screen.
 *
 * `fixed` rather than a portal, on purpose. The flyout stays a child of the
 * menu, so it keeps the menu's `mousedown` guard — a portal would put it
 * outside, where the first click on a playlist name would close the menu it was
 * opening from. Fixed positioning is what stops an ancestor's overflow from
 * clipping it.
 *
 * `safePolygon` is the reason this is worth a component: the pointer has to
 * cross a diagonal gap between the parent row and the flyout, and closing on
 * plain mouseleave means the submenu vanishes on the way to it.
 */
export function Submenu({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'right-start',
    strategy: 'fixed',
    middleware: [
      // Aligned with the row it comes from, and overlapping the menu's border
      // by a pixel so there is no gap to fall into.
      offset({ mainAxis: -1, crossAxis: -5 }),
      flip({ fallbackPlacements: ['left-start'] }),
      shift({ padding: 6 }),
      size({
        padding: 6,
        apply({ availableHeight, elements }) {
          // Never taller than the room it has, and never taller than a menu
          // anyone wants to read: a list of forty playlists scrolls inside the
          // flyout instead of running off the screen or filling it.
          elements.floating.style.maxHeight = `${Math.max(120, Math.min(320, availableHeight))}px`
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  })

  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context, { handleClose: safePolygon({ blockPointerEvents: false }) }),
    useDismiss(context),
  ])

  return (
    <div ref={refs.setReference} className={`ctx-sub ${open ? 'open' : ''}`} {...getReferenceProps()}>
      {label}
      {open && (
        <div
          ref={refs.setFloating}
          className="ctx-flyout"
          style={floatingStyles}
          {...getFloatingProps()}
        >
          {children}
        </div>
      )}
    </div>
  )
}
