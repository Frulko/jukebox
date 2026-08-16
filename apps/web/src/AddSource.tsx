import { useState } from 'react'
import { api } from './api'
import { Icon } from './Icon'
import { t } from './i18n'

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
type Field = {
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

const KINDS: Array<{
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

export function AddSource({
  onClose,
  onNotice,
  onAdded,
}: {
  onClose: () => void
  onNotice: (message: string) => void
  onAdded: () => void
}) {
  const [kindId, setKindId] = useState<(typeof KINDS)[number]['id']>('local')
  const [name, setName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [writable, setWritable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const kind = KINDS.find((k) => k.id === kindId)!
  const value = (f: Field) => values[`${kindId}.${f.key}`] ?? ''
  const set = (f: Field, v: string) => (
    setValues((prev) => ({ ...prev, [`${kindId}.${f.key}`]: v })), setError(null)
  )
  const missing = kind.fields.filter((f) => !f.optional && !value(f).trim())

  const create = async () => {
    if (missing.length || !name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const config: Record<string, string> = {}
      let root = ''
      for (const f of kind.fields) {
        const v = value(f).trim()
        if (!v) continue
        if (f.config) config[f.config] = v
        else root = v
      }
      const made = await api.sources.create({
        name: name.trim(),
        root,
        kind: kindId,
        writable: kind.canWrite ? writable : false,
        config,
      })
      onAdded()

      // Asked straight away rather than left for a button on the card: someone
      // who just typed a URL and a token wants to know *now* whether they typed
      // them right, and the answer costs one request the server already serves.
      try {
        const probe = await api.sources.test(made.id)
        onNotice(
          probe.ok
            ? `Added ${made.name} — ${probe.name}${probe.version ? ` ${probe.version}` : ''} answered. Scan it to bring its music in.`
            : `Added ${made.name}, but it did not answer: ${probe.reason}`,
        )
      } catch {
        onNotice(`Added ${made.name} — scan it to bring its music in`)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the server refused it')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal add-source" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-titlebar">
          <button className="close" onClick={onClose} />
          <span>Add a source</span>
        </div>

        <div className="modal-body">
          {/* The kind first, because it decides what the rest of the dialog even
              asks for — a path and a server URL are not the same question. */}
          <div className="as-kinds">
            {KINDS.map((k) => (
              <button
                key={k.id}
                className={`as-kind ${k.id === kindId ? 'on' : ''}`}
                onClick={() => (setKindId(k.id), setError(null))}
              >
                <Icon name={k.icon} size={18} />
                <b>{k.label}</b>
                <em>{k.blurb}</em>
              </button>
            ))}
          </div>

          <label className="as-row">
            <span>Name</span>
            <input
              autoFocus
              value={name}
              placeholder="Vinyl rips"
              onChange={(e) => (setName(e.target.value), setError(null))}
            />
          </label>

          {kind.fields.map((f) => (
            <label key={f.key} className="as-row">
              <span>{f.label}</span>
              <span className="as-input">
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={value(f)}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f, e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void create()}
                />
                {f.hint && <em className="dim">{f.hint}</em>}
              </span>
            </label>
          ))}

          {kind.canWrite ? (
            <label className="as-check">
              <input type="checkbox" checked={writable} onChange={(e) => setWritable(e.target.checked)} />
              <span>
                <b>Writable</b> — the server may put files here and write tags back into them.
                Off by default; nothing is ever touched without it.
              </span>
            </label>
          ) : (
            // Not a checkbox that does nothing: the operations `writable` gates
            // — importing, converting, organising, writing tags back — all act
            // on files on disk, and a library read through someone else's API
            // is not that.
            <p className="dim as-note">
              Read-only. Importing, converting and writing tags back all act on files on a disk;
              a library read through another server’s API cannot be one.
            </p>
          )}

          {error && <p className="pod-add-error">{error}</p>}
        </div>

        <div className="modal-foot">
          <span className="spacer" />
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="default" disabled={!name.trim() || missing.length > 0 || busy} onClick={() => void create()}>
            {busy ? 'Adding…' : 'Add source'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The icon each kind is drawn with, shared with the cards on the page. */
export const kindIcon = (kind: string) => KINDS.find((k) => k.id === kind)?.icon ?? 'cloud'
export const kindLabel = (kind: string) => KINDS.find((k) => k.id === kind)?.label ?? kind
