/**
 * What a source of each kind actually needs.
 *
 * The server has taken all five kinds since the beginning — `POST /sources`
 * carries a `kind` and a `config`, and the scanners for rclone, Plex, Emby and
 * Jellyfin are all there. What the page offered was a two-field form hard-coded
 * to `kind: 'local'`, so four of the five could only be created by hand against
 * the API. That is the whole of this: asking for the fields each kind has,
 * instead of asking for a folder and hoping.
 *
 * A field is `root` or it is `config`, because that is the split the server
 * makes: `root` is *where this source lives* — a path, a remote, a server URL —
 * and everything else a kind needs to open it travels in `config`.
 */
export type Field = {
  key: string
  label: string
  placeholder: string
  /** Kept out of `root` and put in `config` under this name. */
  config?: string
  optional?: boolean
  /** A token or a password: masked, and never remembered by the page. */
  secret?: boolean
  hint?: string
}

export const KINDS: Array<{
  id: 'local' | 'rclone' | 'plex' | 'emby' | 'jellyfin'
  icon: string
  label: string
  blurb: string
  fields: Field[]
  /** Only file-backed kinds can be written to; see the note in the dialog. */
  canWrite?: boolean
}> = [
  {
    id: 'local',
    icon: 'folder',
    label: 'Folder',
    blurb: 'Music on a disk the server can read.',
    canWrite: true,
    fields: [
      {
        key: 'root',
        label: 'Path',
        placeholder: '/srv/music',
        hint: 'Read on the machine running the server — not on this one.',
      },
    ],
  },
  {
    id: 'rclone',
    icon: 'rclone',
    label: 'rclone remote',
    blurb: 'Anything rclone can mount: Drive, S3, SFTP, a NAS.',
    fields: [
      { key: 'root', label: 'Remote', placeholder: 'gdrive:Music', hint: 'The remote and path, as rclone writes them.' },
      { key: 'url', label: 'Daemon', placeholder: 'http://127.0.0.1:5572', config: 'url', hint: 'Where `rclone rcd` is listening.' },
      { key: 'user', label: 'User', placeholder: 'optional', config: 'user', optional: true },
      { key: 'pass', label: 'Password', placeholder: 'optional', config: 'pass', optional: true, secret: true },
    ],
  },
  {
    id: 'plex',
    icon: 'plex',
    label: 'Plex',
    blurb: 'A library on a Plex Media Server.',
    fields: [
      { key: 'root', label: 'Server', placeholder: 'http://192.168.1.10:32400' },
      { key: 'token', label: 'Token', placeholder: 'X-Plex-Token', config: 'token', secret: true },
      { key: 'section', label: 'Section', placeholder: 'optional — the library id', config: 'section', optional: true },
    ],
  },
  {
    id: 'emby',
    icon: 'emby',
    label: 'Emby',
    blurb: 'A library on an Emby server.',
    fields: [
      { key: 'root', label: 'Server', placeholder: 'http://192.168.1.10:8096' },
      { key: 'token', label: 'API key', placeholder: 'from the server’s dashboard', config: 'token', secret: true },
      { key: 'parentId', label: 'Library', placeholder: 'optional — the library id', config: 'parentId', optional: true },
    ],
  },
  {
    id: 'jellyfin',
    icon: 'jellyfin',
    label: 'Jellyfin',
    blurb: 'A library on a Jellyfin server.',
    fields: [
      { key: 'root', label: 'Server', placeholder: 'http://192.168.1.10:8096' },
      { key: 'token', label: 'API key', placeholder: 'from the server’s dashboard', config: 'token', secret: true },
      { key: 'parentId', label: 'Library', placeholder: 'optional — the library id', config: 'parentId', optional: true },
    ],
  },
]


/** What a kind of source asks for, shared with the editor on each card. */
export const fieldsOf = (kind: string) => KINDS.find((k) => k.id === kind)?.fields ?? []
export const canWrite = (kind: string) => !!KINDS.find((k) => k.id === kind)?.canWrite

/** The icon each kind is drawn with, shared with the cards on the page. */
export const kindIcon = (kind: string) => KINDS.find((k) => k.id === kind)?.icon ?? 'cloud'
export const kindLabel = (kind: string) => KINDS.find((k) => k.id === kind)?.label ?? kind
