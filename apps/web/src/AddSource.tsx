import { useState } from 'react'
import { api } from './api'
import { Icon } from './Icon'
import { t } from './i18n'
import { KINDS, type Field } from './sourceKinds'

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
