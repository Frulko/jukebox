import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SourceFavorite } from '@jukebox/client-sdk'
import { api } from './api'
import { Icon } from './Icon'

/**
 * The favorite folders of one source, and what each files things as.
 *
 * A favorite says where the music actually is once you are inside the source.
 * Give it a kind and it becomes a rule: everything scanned under that folder
 * is filed as that — music, audiobooks or podcasts — now and on every scan.
 * With no kind it is just a bookmark.
 *
 * The browser walks the source's real directories (`/sources/:id/browse`), not
 * the folders facet: favorites are picked before a scan has filed anything,
 * which is exactly when picking them pays.
 */

const KIND_LABEL: Record<string, string> = {
  music: 'Music', audiobook: 'Audiobooks', podcast: 'Podcasts',
}

export function favoriteKindLabel(kind: string | null): string | null {
  return kind ? (KIND_LABEL[kind] ?? kind) : null
}

export function SourceFavorites({
  sourceId,
  value,
  onChange,
}: {
  sourceId: string
  value: SourceFavorite[]
  onChange: (next: SourceFavorite[]) => void
}) {
  const [path, setPath] = useState('')

  const browse = useQuery({
    queryKey: ['source-browse', sourceId, path],
    queryFn: () => api.sources.browse(sourceId, path),
    retry: false,
  })
  const dirs = (browse.data?.entries ?? []).filter((e) => e.dir)
  const starred = new Set(value.map((f) => f.path))
  const up = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

  const toggle = (p: string) =>
    onChange(starred.has(p) ? value.filter((f) => f.path !== p) : [...value, { path: p, kind: null }])
  const setKind = (p: string, kind: SourceFavorite['kind']) =>
    onChange(value.map((f) => (f.path === p ? { ...f, kind } : f)))

  return (
    <div className="source-favorites">
      {value.map((f) => (
        <div key={f.path} className="sf-fav">
          <Icon name="star" size={11} />
          <span className="sf-path" title={f.path}>{f.path}</span>
          {/* The kind is the select's whole business, so "nothing" is a real
              option rather than an absence someone has to guess at. */}
          <select
            value={f.kind ?? ''}
            title="What everything under this folder is filed as"
            onChange={(e) => setKind(f.path, (e.target.value || null) as SourceFavorite['kind'])}
          >
            <option value="">No kind — a bookmark</option>
            <option value="music">Music</option>
            <option value="audiobook">Audiobooks</option>
            <option value="podcast">Podcasts</option>
          </select>
          <button type="button" className="sf-remove" title="Remove" onClick={() => toggle(f.path)}>
            ×
          </button>
        </div>
      ))}

      <div className="sf-browser">
        <div className="sf-crumb">
          {path && (
            <button type="button" title="Up one folder" onClick={() => setPath(up)}>
              ‹
            </button>
          )}
          <span className="sf-here" title={path || '/'}>{path || '/'}</span>
        </div>
        <div className="sf-body">
          {browse.isPending && <p className="sf-empty">Asking the source…</p>}
          {browse.isError && (
            <p className="sf-empty">
              {browse.error instanceof Error ? browse.error.message : 'The source did not answer.'}
            </p>
          )}
          {browse.data && dirs.length === 0 && <p className="sf-empty">No folders in here.</p>}
          {dirs.map((d) => (
            <div key={d.path} className="sf-dir">
              <button type="button" className="sf-open" title={d.path} onClick={() => setPath(d.path)}>
                <Icon name="folder" size={11} />
                <span>{d.name}</span>
              </button>
              <button
                type="button"
                className={`sf-star ${starred.has(d.path) ? 'on' : ''}`}
                title={starred.has(d.path) ? 'Unstar' : 'Star as a favorite'}
                onClick={() => toggle(d.path)}
              >
                <Icon name="star" size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <p className="dim sf-note">
        A favorite says where the music is in this source. Give it a kind and everything scanned
        under it is filed as that — music, audiobooks or podcasts — now and on every scan. With no
        kind it is just a bookmark.
      </p>
    </div>
  )
}
