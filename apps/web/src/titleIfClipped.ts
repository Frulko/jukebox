import type { MouseEvent } from 'react'

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
export function titleIfClipped(e: MouseEvent<HTMLElement>) {
  const el = e.currentTarget
  if (el.scrollWidth > el.clientWidth + 1) el.title = el.innerText.trim()
  else el.removeAttribute('title')
}
