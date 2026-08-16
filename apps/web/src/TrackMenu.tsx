import { useEffect, useState } from 'react'
import type { Playlist, Track } from './data'
import type { PluginEntry } from './pluginMenu'
import { MembershipsPopover } from './MembershipsPopover'
import { Submenu } from './Submenu'
import { useMenuPosition } from './useMenuPosition'
import { num, t, useLocale } from './i18n'

/**
 * Everything a track can be told to do.
 *
 * One bundle rather than eighteen props threaded through four views: the menu
 * is the same menu whether you right-click a row in the library, a line in an
 * album, or a track under an artist, and the only way to keep it the same is to
 * have one of it. Assembled once in the app, where the mutations live.
 */
export type TrackActions = {
  /** The second argument is the list this play starts from, in the order shown. */
  onPlay: (id: string, queue?: string[]) => void
  onEnqueue: (ids: string[]) => void
  onPlayNext: (ids: string[]) => void
  onConvert: (ids: string[]) => void
  onGetInfo: (ids: string[]) => void
  onOpenAlbum: (album: string, artist: string) => void
  onUpdate: (ids: string[], patch: Partial<Track>) => void
  onDelete: (ids: string[]) => void
  onAddToPlaylist: (playlistId: string, ids: string[]) => void
  onAddToDevice: (deviceId: string, ids: string[]) => void
  onNewPlaylistFrom: (ids: string[]) => void
  onTag: (ids: string[], add: string[], remove: string[]) => void
  playlists: Playlist[]
  devices: { id: string; name: string }[]
  tags: { value: string; count: number }[]
  pluginEntries: PluginEntry[]
  onPluginCommand: (entry: PluginEntry, ids: string[]) => void
}

/**
 * The track context menu, wherever a track is drawn.
 *
 * `open` takes the tracks themselves rather than ids: three of the entries are
 * about what the selection *is* — which album to go to, which tags every one of
 * them already carries, whether the delete says "remove from playlist" — and a
 * menu that has to look those up somewhere else is a menu each caller gets
 * subtly differently.
 */
export function useTrackMenu(actions: TrackActions, options: { inPlaylist?: boolean } = {}) {
  const [menu, setMenu] = useState<{ x: number; y: number; tracks: Track[]; queue: string[] } | null>(null)
  /** "Where is this?" — opened from the menu, at the same point. */
  const [where, setWhere] = useState<{ id: string; x: number; y: number } | null>(null)
  const position = useMenuPosition(menu)
  useLocale()

  /** `queue` is what playing from here would play through, in the order shown. */
  const open = (e: React.MouseEvent, tracks: Track[], queue?: string[]) => {
    e.preventDefault()
    // A track's menu is drawn inside things that have their own — an album
    // block under an artist has a group menu on it — and without this both
    // open at once, stacked on the same corner.
    e.stopPropagation()
    if (!tracks.length) return
    setMenu({ x: e.clientX, y: e.clientY, tracks, queue: queue ?? tracks.map((t) => t.id) })
  }

  const close = () => setMenu(null)

  /**
   * Closing belongs to the menu, not to whoever opened it.
   *
   * The track list happened to close it from its own container's mousedown, so
   * the first view that reused this one — an album under an artist — left it
   * open on the screen while the *next* menu opened beside it. A menu that
   * every caller has to remember to dismiss is a menu that will be left open.
   */
  useEffect(() => {
    if (!menu) return
    const away = () => setMenu(null)
    window.addEventListener('mousedown', away)
    window.addEventListener('scroll', away, true)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('scroll', away, true)
    }
  }, [menu])

  const ids = menu?.tracks.map((t) => t.id) ?? []
  const many = ids.length > 1

  const node = (
    <>
      {where && (
        <MembershipsPopover trackId={where.id} point={{ x: where.x, y: where.y }} onClose={() => setWhere(null)} />
      )}

      {menu && (
        <div
          className="ctx"
          ref={position.setFloating}
          style={position.floatingStyles}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button onClick={() => (actions.onPlay(ids[0], menu.queue), close())}>{t('Play')}</button>
          <button onClick={() => (actions.onPlayNext(ids), close())}>{t('Play Next')}</button>
          <button onClick={() => (actions.onEnqueue(ids), close())}>
            {many ? t('Add {n} to Queue', { n: ids.length }) : t('Add to Queue')}
          </button>
          <button onClick={() => (actions.onGetInfo(ids), close())}>
            {many ? `${t('Get Info')} (${num(ids.length)})` : t('Get Info')}
          </button>
          {/* The album of the track you pointed at, not of the selection: ten
              selected rows can be ten albums, and going to one of them is not
              something the menu should choose on its own. */}
          {menu.tracks[0].album && (
            <button
              onClick={() => (actions.onOpenAlbum(menu.tracks[0].album, menu.tracks[0].albumArtist), close())}
            >
              {t('Go to Album')}
            </button>
          )}
          <button
            onClick={() => {
              setWhere({ id: ids[0], x: menu.x, y: menu.y })
              close()
            }}
          >
            {t('Where is this track…')}
          </button>
          <button onClick={() => (actions.onConvert(ids), close())}>
            {many ? t('Convert {n} Tracks…', { n: ids.length }) : t('Convert…')}
          </button>

          {actions.pluginEntries.length > 0 && <hr />}
          {actions.pluginEntries.map((entry) => (
            <button
              key={entry.id}
              disabled={!entry.runnable}
              title={entry.runnable ? `${entry.pluginName} · ${entry.command}` : `${entry.pluginName} is switched off`}
              onClick={() => (actions.onPluginCommand(entry, ids), close())}
            >
              {entry.label}
              <em className="ctx-from">{entry.pluginName}</em>
            </button>
          ))}

          <hr />
          <Submenu label={t('Rating')}>
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <button key={n} onClick={() => (actions.onUpdate(ids, { rating: n }), close())}>
                {n ? '★'.repeat(n) : t('None')}
              </button>
            ))}
          </Submenu>

          {/* Tags the listener wrote, which are not the file's own fields. A tag
              is ticked only when *every* selected track carries it, so choosing
              it on a mixed selection adds it to the rest rather than toggling
              half of them off. */}
          <Submenu label={t('Tag')}>
            <input
              className="tag-new"
              placeholder={t('New tag…')}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const value = (e.target as HTMLInputElement).value.trim()
                if (!value) return
                actions.onTag(ids, [value], [])
                close()
              }}
            />
            {actions.tags.length > 0 && <hr />}
            {actions.tags.map((tag) => {
              const all = menu.tracks.every((x) => x.tags.includes(tag.value))
              return (
                <button
                  key={tag.value}
                  className={all ? 'on' : ''}
                  onClick={() => (actions.onTag(ids, all ? [] : [tag.value], all ? [tag.value] : []), close())}
                >
                  {all ? '✓' : ' '}&nbsp;&nbsp;{tag.value}
                  <em className="dim">{num(tag.count)}</em>
                </button>
              )
            })}
          </Submenu>

          <Submenu label={t('Add to Playlist')}>
            <button onClick={() => (actions.onNewPlaylistFrom(ids), close())}>{t('New Playlist…')}</button>
            <hr />
            {actions.playlists
              .filter((pl) => !pl.smart)
              .map((pl) => (
                <button key={pl.id} onClick={() => (actions.onAddToPlaylist(pl.id, ids), close())}>
                  {pl.name}
                </button>
              ))}
          </Submenu>

          {/* Absent with nothing connected — iTunes never showed a menu entry
              that could not do anything. */}
          {actions.devices.length > 0 && (
            <Submenu label={t('Add to Device')}>
              {actions.devices.map((d) => (
                <button key={d.id} onClick={() => (actions.onAddToDevice(d.id, ids), close())}>
                  {d.name}
                </button>
              ))}
            </Submenu>
          )}

          <hr />
          <button onClick={() => (actions.onUpdate(ids, { enabled: true }), close())}>{t('Check Selection')}</button>
          <button onClick={() => (actions.onUpdate(ids, { enabled: false }), close())}>{t('Uncheck Selection')}</button>
          <button onClick={() => (actions.onUpdate(ids, { playCount: 0, lastPlayed: null }), close())}>
            {t('Reset Plays')}
          </button>
          <hr />
          <button onClick={() => (actions.onDelete(ids), close())}>
            {options.inPlaylist ? t('Remove from Playlist') : t('Delete from Library')}
          </button>
        </div>
      )}
    </>
  )

  return { open, close, node, isOpen: menu !== null }
}
