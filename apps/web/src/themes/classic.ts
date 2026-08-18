import { registerTheme } from './registry'

/**
 * The base skin. Its CSS *is* itunes.css's `:root` block — every other theme
 * is a redefinition of those tokens — so this module registers the numbers
 * and brings no stylesheet of its own.
 */
registerTheme({ id: 'classic', label: 'iTunes 8', rowHeight: 17 })
