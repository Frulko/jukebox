/** Prefixes an internal path with the site's base, so the same build works at the root of a
 *  domain or under `/<repo>/` on GitHub Pages. */
export const url = (path: string): string => {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  return `${base}${path}`
}
