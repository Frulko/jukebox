import { useState } from 'react'
import type { Playlist } from './data'
import { PlaylistCover } from './Artwork'
import type { Device } from './devices'
import { DEVICE_ICON } from './devices'
import { Icon } from './Icon'
import type { View } from './App'

const LIBRARY: Array<[string, string, string]> = [
  ['music', 'music', 'Music'],
  ['movies', 'movie', 'Movies'],
  ['tv', 'tv', 'TV Shows'],
  ['podcasts', 'podcast', 'Podcasts'],
  ['audiobooks', 'book', 'Audiobooks'],
  ['apps', 'apps', 'Apps'],
  ['radio', 'radio', 'Radio'],
]

const STORE: Array<[string, string, string]> = [
  ['store', 'store', 'iTunes Store'],
  ['purchased', 'cloud', 'Purchased'],
]

export function Sidebar({
  view,
  playlists,
  playlistArt,
  devices,
  onSelect,
  onDropTracks,
  onRename,
  onDelete,
  onNew,
}: {
  view: View
  playlists: Playlist[]
  /** Apple Music shows a generated quilt next to each playlist. */
  playlistArt: boolean
  devices: Device[]
  onSelect: (v: View) => void
  onDropTracks: (playlistId: string, ids: string[]) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onNew: () => void
}) {
  const [over, setOver] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  // The quilt is derived from the playlist name: the server does not send its
  // contents in the list, and fetching them just to draw a 16px thumbnail would
  // be one request per playlist on every sidebar render.
  const seedFor = (pl: Playlist) => `${pl.id} ${pl.name}`

  const item = (
    v: View,
    icon: string,
    label: string,
    extra?: React.HTMLAttributes<HTMLLIElement>,
    art?: React.ReactNode,
  ) => (
    <li
      key={`${v.kind}:${v.id}`}
      className={`src ${view.kind === v.kind && view.id === v.id ? 'on' : ''} ${over === v.id ? 'over' : ''}`}
      onClick={() => onSelect(v)}
      {...extra}
    >
      {art ?? <Icon name={icon} size={12} />}
      <span className="label">{label}</span>
    </li>
  )

  return (
    <div className="sidebar">
      <ul>
        <li className="section">LIBRARY</li>
        {LIBRARY.map(([id, ico, label]) => item({ kind: 'library', id }, ico, label))}

        {devices.length > 0 && <li className="section">DEVICES</li>}
        {devices.map((d) =>
          item({ kind: 'device', id: d.id }, DEVICE_ICON[d.kind], d.name, {
            onDragOver: (e) => {
              if (!e.dataTransfer.types.includes('application/x-tracks')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              setOver(d.id)
            },
            onDragLeave: () => setOver(null),
            onDrop: (e) => {
              setOver(null)
              e.preventDefault()
            },
          }),
        )}

        <li className="section">STORE</li>
        {STORE.map(([id, ico, label]) => item({ kind: 'store', id }, ico, label))}

        <li className="section">
          PLAYLISTS
          <button className="new-pl" onClick={onNew} title="New Playlist">
            <Icon name="plus" size={9} />
          </button>
        </li>
        {playlists.map((pl) =>
          editing === pl.id ? (
            <li key={pl.id} className="src editing">
              <Icon name={pl.smart ? 'gear' : 'music'} size={12} />
              <input
                autoFocus
                defaultValue={pl.name}
                onBlur={(e) => (onRename(pl.id, e.target.value.trim() || pl.name), setEditing(null))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setEditing(null)
                }}
              />
            </li>
          ) : (
            item(
              { kind: 'playlist', id: pl.id, smart: pl.smart ?? undefined },
              pl.smart ? 'gear' : 'music',
              pl.name,
              {
              onDoubleClick: () => !pl.smart && setEditing(pl.id),
              onDragOver: (e) => {
                if (pl.smart || !e.dataTransfer.types.includes('application/x-tracks')) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setOver(pl.id)
              },
              onDragLeave: () => setOver(null),
              onDrop: (e) => {
                const raw = e.dataTransfer.getData('application/x-tracks')
                setOver(null)
                if (!raw || pl.smart) return
                e.preventDefault()
                onDropTracks(pl.id, JSON.parse(raw))
              },
                onContextMenu: (e) => {
                  e.preventDefault()
                  if (!pl.smart && confirm(`Delete the playlist “${pl.name}”?`)) onDelete(pl.id)
                },
              },
              playlistArt ? <PlaylistCover seed={seedFor(pl)} size={16} className="pl-art" /> : undefined,
            )
          ),
        )}
      </ul>
    </div>
  )
}
