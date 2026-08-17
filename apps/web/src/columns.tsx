import { createColumnHelper } from '@tanstack/react-table'
import { fmtDate, fmtSize, fmtTime, type Track } from './data'
import { Icon } from './Icon'
import { badgesFor, type BadgeContext } from './trackBadges'
import { Tooltip } from './Tooltip'
import type { features } from './tableFeatures'
import { num, t } from './i18n'

const h = createColumnHelper<typeof features, Track>()

export type CellActions = {
  toggleChecked: (id: string) => void
  /** Every row at once, from the box in the column's own header. */
  setChecked: (ids: string[], next: boolean) => void
  /**
   * How many tracks the current filter matches on the server, when that is more
   * than the list is holding. The header box acts on what is shown, and this is
   * what lets it say so instead of implying it did the library.
   */
  total?: number
  rate: (id: string, rating: number) => void
  /** Connected devices, so the presence column can label its dots. */
  devices: { id: string; name: string }[]
  /** What the status column needs besides the track. */
  badgeContext: BadgeContext
}

/**
 * Device presence.
 *
 * One dot per device holding the track, with the device's initial. This answers
 * "where is this track?" — a passive question you glance at. "What do I still
 * need to sync?" is the filter's job, and that one runs in SQL.
 */
function Presence({ ids, devices }: { ids: string[]; devices: { id: string; name: string }[] }) {
  if (ids.length === 0) return null
  return (
    <span className="presence">
      {ids.map((id) => {
        const d = devices.find((x) => x.id === id)
        return (
          <i key={id} title={d?.name ?? id}>
            {(d?.name ?? '?').trim()[0]?.toUpperCase()}
          </i>
        )
      })}
    </span>
  )
}

/**
 * The status zone: none, one or several icons, each with its own sentence.
 *
 * It sits early in the row because it is scanned rather than read — the eye
 * runs down it looking for the one that is orange.
 */
function Status({ track, ctx }: { track: Track; ctx: BadgeContext }) {
  const badges = badgesFor(track, ctx)
  if (!badges.length) return null
  return (
    <span className="badges">
      {badges.map((b) => (
        <Tooltip key={b.id} label={b.title}>
          <i className={`badge ${b.tone}`}>
            <Icon name={b.icon} size={9} />
          </i>
        </Tooltip>
      ))}
    </span>
  )
}

function Stars({ value, onRate }: { value: number; onRate: (n: number) => void }) {
  return (
    <span className="stars" onMouseDown={(e) => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map((n) => (
        <i key={n} className={n <= value ? 'on' : 'off'} onClick={() => onRate(value === n && n === 1 ? 0 : n)}>
          <Icon name="star" size={10} />
        </i>
      ))}
    </span>
  )
}

export const makeColumns = (a: CellActions) =>
  h.columns([
    h.display({
      id: 'checked',
      /**
       * The box that does the whole column.
       *
       * It reads as the state of what is in front of you — ticked when every
       * row is, half-ticked when some are — and one click flips all of them.
       * Acting on the rows *shown* rather than on the query behind them is the
       * honest reading: the list holds a page, the server holds the library,
       * and a box that quietly ticked forty thousand tracks because it looked
       * like it meant "all" would be the worst kind of convenience. When the
       * two numbers differ the title says both.
       */
      header: ({ table }) => {
        const rows = table.getRowModel().rows
        const ids = rows.map((r) => r.original.id)
        const on = rows.filter((r) => r.original.enabled).length
        const all = rows.length > 0 && on === rows.length
        const some = on > 0 && !all
        const shown = rows.length
        const more = a.total !== undefined && a.total > shown ? a.total : 0
        return (
          <input
            type="checkbox"
            className="hdr-check"
            checked={all}
            ref={(el) => {
              // Half-ticked is a third state the DOM only takes as a property,
              // and it is the one that matters here: "some of these are on" is
              // the state a list of a few hundred is usually in.
              if (el) el.indeterminate = some
            }}
            disabled={shown === 0}
            title={
              (all ? t('Untick the {n} shown', { n: shown }) : t('Tick the {n} shown', { n: shown })) +
              // Said in the same breath as the action, not afterwards: this is a
              // list of a few hundred standing in for a library of thousands,
              // and the box is about to look like it meant all of them.
              (more ? ` — ${t('{total} in all, the rest are not touched', { total: num(more) })}` : '') +
              `. ${t('Ticked tracks play when the list plays through; nothing to do with what is selected.')}`
            }
            onMouseDown={(e) => e.stopPropagation()}
            onChange={() => a.setChecked(ids, !all)}
          />
        )
      },
      size: 24,
      enableResizing: false,
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={row.original.enabled}
          // The tick is a property of the track, stored on the server, and it
          // survives you closing the app. Selection is what you are pointing at
          // right now. Two different questions, so they say which they answer.
          title={
            row.original.enabled
              ? 'Plays when this list plays through — untick to skip it'
              : 'Skipped when this list plays through — tick to include it'
          }
          onMouseDown={(e) => e.stopPropagation()}
          onChange={() => a.toggleChecked(row.original.id)}
        />
      ),
    }),
    h.display({
      id: 'index',
      header: '',
      size: 34,
      enableResizing: false,
      cell: ({ row }) => <span className="num dim">{row.getDisplayIndex() + 1}</span>,
    }),
    h.display({
      id: 'status',
      header: '',
      size: 46,
      enableResizing: false,
      cell: ({ row }) => <Status track={row.original} ctx={a.badgeContext} />,
    }),
    h.accessor('name', { header: 'Name', size: 230 }),
    h.accessor('duration', {
      id: 'time',
      header: 'Time',
      size: 52,
      cell: (c) => <span className="num">{fmtTime(c.getValue())}</span>,
    }),
    h.accessor('artist', { header: 'Artist', size: 150 }),
    h.accessor('album', { header: 'Album', size: 160 }),
    h.accessor('genre', { header: 'Genre', size: 95 }),
    h.accessor('rating', {
      header: 'Rating',
      size: 78,
      cell: (c) => <Stars value={c.getValue()} onRate={(n) => a.rate(c.row.original.id, n)} />,
    }),
    h.accessor('playCount', {
      header: 'Plays',
      size: 46,
      cell: (c) => <span className="num">{c.getValue() || ''}</span>,
    }),
    h.accessor('year', {
      header: 'Year',
      size: 44,
      cell: (c) => <span className="num">{c.getValue()}</span>,
    }),
    h.accessor('trackNumber', {
      id: 'trackNumber',
      header: 'Track #',
      size: 56,
      cell: (c) => <span className="num">{`${c.getValue()} of ${c.row.original.trackCount}`}</span>,
    }),
    h.accessor('discNumber', {
      header: 'Disc #',
      size: 50,
      cell: (c) => <span className="num">{c.getValue() || ''}</span>,
    }),
    h.accessor('albumArtist', { header: 'Album Artist', size: 150 }),
    h.accessor('composer', { header: 'Composer', size: 150 }),
    h.accessor('grouping', { header: 'Grouping', size: 110 }),
    h.accessor('comments', { header: 'Comments', size: 160 }),
    h.accessor('bpm', {
      header: 'BPM',
      size: 46,
      cell: (c) => <span className="num">{c.getValue() || ''}</span>,
    }),
    h.accessor('kind', { header: 'Kind', size: 150 }),
    h.accessor('format', {
      header: 'Format',
      size: 64,
      // Upper case because these are file formats, not words: FLAC and MP3 are
      // read as tokens, and a column of them scans faster than "flac", "mp3".
      cell: (c) => <span className="format">{c.getValue().toUpperCase()}</span>,
    }),
    h.accessor('size', {
      header: 'Size',
      size: 62,
      cell: (c) => <span className="num">{fmtSize(c.getValue())}</span>,
    }),
    h.accessor('bitRate', {
      header: 'Bit Rate',
      size: 62,
      cell: (c) => <span className="num">{c.getValue()} kbps</span>,
    }),
    h.accessor('sampleRate', {
      header: 'Sample Rate',
      size: 82,
      cell: (c) => <span className="num">{(c.getValue() / 1000).toFixed(3)} kHz</span>,
    }),
    h.accessor('dateAdded', {
      header: 'Date Added',
      size: 100,
      cell: (c) => fmtDate(c.getValue()),
    }),
    h.accessor('lastPlayed', {
      header: 'Last Played',
      size: 100,
      cell: (c) => fmtDate(c.getValue()),
    }),
    h.accessor('devices', {
      header: 'On device',
      size: 74,
      cell: (c) => <Presence ids={c.getValue()} devices={a.devices} />,
    }),
    h.accessor('skipCount', {
      header: 'Skips',
      size: 46,
      cell: (c) => <span className="num">{c.getValue() || ''}</span>,
    }),
    h.accessor('tags', {
      header: 'Tags',
      size: 130,
      // Joined rather than drawn as pills: this is a table cell that can be
      // narrowed to nothing, and the tooltip that reveals a clipped cell works
      // on text. Pills would clip to half a pill.
      cell: (c) => c.getValue().join(', '),
    }),
  ])

/** Columns iTunes shows out of the box; everything else lives in View Options. */
export const DEFAULT_VISIBLE = new Set([
  'checked', 'index', 'status', 'name', 'time', 'artist', 'album', 'genre', 'rating', 'playCount',
  // Shown by default, but TrackList hides it while no device is connected —
  // a column that cannot have content is just wasted width.
  'devices',
])

export const COLUMN_LABELS: Record<string, string> = {
  checked: '✓', index: '#', status: 'Status', name: 'Name', time: 'Time', artist: 'Artist', album: 'Album',
  genre: 'Genre', rating: 'Rating', playCount: 'Plays', year: 'Year', trackNumber: 'Track Number',
  discNumber: 'Disc Number', albumArtist: 'Album Artist', composer: 'Composer', grouping: 'Grouping',
  comments: 'Comments', bpm: 'BPM', kind: 'Kind', format: 'Format', size: 'Size', bitRate: 'Bit Rate',
  sampleRate: 'Sample Rate', dateAdded: 'Date Added', lastPlayed: 'Last Played', skipCount: 'Skips',
  devices: 'On device', tags: 'Tags',
}

/** Columns whose values are right-aligned in iTunes. */
export const NUMERIC = new Set([
  'index', 'time', 'playCount', 'year', 'trackNumber', 'discNumber', 'bpm', 'size',
  'bitRate', 'sampleRate', 'skipCount',
])
