import { useState } from 'react'
import { useFacets, useSources } from './api'
import { Icon } from './Icon'
import { ViewSearch } from './ViewSearch'
import { num } from './i18n'

/**
 * A folder in a source, wherever the question comes up — filing a folder of
 * episodes as a podcast, hunting for where a missing file went.
 *
 * The list comes from the folders facet: every folder holding a track, counted
 * in SQL over the whole library, never from the page in hand. Two drawings of
 * the same answer — a tree to walk down, a flat list to scan — plus a filter,
 * because a real library's folder list is hundreds long. The chosen value is a
 * path prefix ending in `/`, which is exactly what a track query's `folder`
 * matches on, so picking a parent means everything under it.
 */

type Node = { name: string; path: string; count: number; children: Node[] }

function buildTree(folders: Array<{ value: string; count: number }>): Node[] {
  const root: Node = { name: '', path: '', count: 0, children: [] }
  const byPath = new Map<string, Node>([['', root]])
  const ensure = (path: string): Node => {
    const found = byPath.get(path)
    if (found) return found
    const parts = path.slice(0, -1).split('/')
    const parentPath = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : ''
    // An absolute path's first segment is empty; "/" is its honest name.
    const node: Node = { name: parts[parts.length - 1] || '/', path, count: 0, children: [] }
    ensure(parentPath).children.push(node)
    byPath.set(path, node)
    return node
  }
  for (const f of folders) ensure(f.value).count += f.count
  // A parent's number is everything under it — the same answer a query for
  // that folder gives, since `folder` matches by prefix.
  const rollUp = (n: Node): number => {
    for (const c of n.children) n.count += rollUp(c)
    return n.count
  }
  for (const c of root.children) rollUp(c)
  return root.children
}

/**
 * One folder as a row: the parent half of the path dimmed, the folder itself
 * full strength, the count on the right. The flat view of the browser is made
 * of these, and it stands alone anywhere a folder needs naming in a list.
 */
export function FolderRow({
  path,
  count,
  on = false,
  onClick,
}: {
  path: string
  count?: number
  on?: boolean
  onClick?: () => void
}) {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const cut = trimmed.lastIndexOf('/')
  const parent = cut >= 0 ? trimmed.slice(0, cut + 1) : ''
  const name = trimmed.slice(cut + 1) || '/'
  return (
    <button className={`fb-row ${on ? 'on' : ''}`} title={path} onClick={onClick}>
      <Icon name="folder" size={11} />
      <span className="fb-name">
        {parent ? <span className="crumb">{parent}</span> : null}
        {name}
      </span>
      {count !== undefined && <em className="fb-count">{num(count)}</em>}
    </button>
  )
}

export function FolderBrowser({
  sourceId,
  onSource,
  folder,
  onFolder,
  className = '',
}: {
  /** The source being browsed. The caller resolves the default (usually the first). */
  sourceId: string | null
  onSource: (id: string) => void
  /** The chosen folder — a path prefix ending in `/` — or null for none. */
  folder: string | null
  onFolder: (path: string | null) => void
  className?: string
}) {
  const sources = useSources().data?.items ?? []
  const facets = useFacets({ sourceId: sourceId ?? undefined })
  const folders = facets.data?.folders ?? []
  const [mode, setMode] = useState<'tree' | 'flat'>('tree')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())

  const needle = q.trim().toLowerCase()
  const matches = needle ? folders.filter((f) => f.value.toLowerCase().includes(needle)) : folders
  const tree = buildTree(folders)

  const toggle = (path: string, force?: boolean) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (force ?? !next.has(path)) next.add(path)
      else next.delete(path)
      return next
    })

  const pick = (path: string) => onFolder(folder === path ? null : path)

  const renderNode = (n: Node, depth: number): React.ReactNode => {
    const opened = open.has(n.path)
    return (
      <div key={n.path}>
        <button
          className={`fb-row ${folder === n.path ? 'on' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          title={n.path}
          onClick={() => {
            pick(n.path)
            if (n.children.length) toggle(n.path, true)
          }}
        >
          {/* The chevron is its own hit target: clicking the name selects,
              clicking the triangle only opens or closes. */}
          <span
            className="fb-tri"
            onClick={(e) => {
              if (!n.children.length) return
              e.stopPropagation()
              toggle(n.path)
            }}
          >
            {n.children.length > 0 && <i className={`tri ${opened ? 'open' : ''}`} />}
          </span>
          <Icon name="folder" size={11} />
          <span className="fb-name">{n.name}</span>
          <em className="fb-count">{num(n.count)}</em>
        </button>
        {opened && n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className={`folder-browser ${className}`}>
      <div className="fb-head">
        {sources.length > 1 && (
          <select
            value={sourceId ?? ''}
            title="Source"
            onChange={(e) => {
              onSource(e.target.value)
              // A folder belongs to its source; keeping it across a switch
              // would point at a path the new source may not have.
              onFolder(null)
            }}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <ViewSearch value={q} onChange={setQ} placeholder="Filter folders" count={matches.length} />
        <div className="seg">
          <button className={mode === 'tree' ? 'on' : ''} title="Tree" onClick={() => setMode('tree')}>
            <Icon name="folder" size={10} />
          </button>
          <button className={mode === 'flat' ? 'on' : ''} title="Every folder" onClick={() => setMode('flat')}>
            <Icon name="queue" size={10} />
          </button>
        </div>
      </div>
      <div className="fb-body">
        {facets.isPending && <p className="fb-empty">Asking the server…</p>}
        {!facets.isPending && folders.length === 0 && (
          <p className="fb-empty">Nothing scanned under that source yet.</p>
        )}
        {/* A filter answers with paths, and paths read best flat — so typing
            switches the drawing, and clearing goes back to the tree. */}
        {needle || mode === 'flat'
          ? matches.map((f) => (
              <FolderRow
                key={f.value}
                path={f.value}
                count={f.count}
                on={folder === f.value}
                onClick={() => pick(f.value)}
              />
            ))
          : tree.map((n) => renderNode(n, 0))}
        {needle.length > 0 && folders.length > 0 && matches.length === 0 && (
          <p className="fb-empty">No folder matches “{q}”.</p>
        )}
      </div>
    </div>
  )
}
