import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { type CommandResult, type Plugin } from '@jukebox/client-sdk'
import { api } from './api'
import { explainPlugin } from './pluginMenu'

/**
 * A plugin's settings, drawn by the host from the manifest.
 *
 * The plugin declares fields, actions and a health check in `contributes`;
 * nothing of the plugin's runs in this page. The host renders the form, saves
 * the values, and invokes commands over the same route the track menu uses —
 * which is what keeps a third-party settings pane unable to restyle the app
 * or read what is on screen.
 */

/** One field, as the manifest declares it. Unknown shapes are dropped, not drawn. */
type SettingField = {
  key: string
  label: string
  type?: 'text' | 'password' | 'number' | 'check'
  default?: unknown
  help?: string
}

type Action = { id?: string; label: string; command: string }

const fieldsOf = (p: Plugin): SettingField[] => {
  const zone = p.contributes?.settings
  if (!Array.isArray(zone)) return []
  // SAFETY: `contributes` is the manifest's own JSON; the filter keeps only
  // entries carrying what the form needs, so a wrong shape is dropped.
  return (zone as SettingField[]).filter((f) => typeof f?.key === 'string' && f.label)
}

const actionsOf = (p: Plugin): Action[] => {
  const zone = p.contributes?.commands
  if (!Array.isArray(zone)) return []
  return (zone as Action[]).filter((a) => a?.label && a.command)
}

const checkOf = (p: Plugin): Action | null => {
  const c = p.contributes?.check as Action | undefined
  return c && typeof c.command === 'string' ? { label: c.label || 'Check', command: c.command } : null
}

/** What a command's answer looks like in the one answer slot this modal has. */
const said = (r: CommandResult): { ok: boolean | null; body: string } => {
  switch (r.kind) {
    case 'check':
      return { ok: r.ok, body: r.message }
    case 'done':
      return { ok: null, body: r.message ?? 'Done.' }
    case 'text':
      return { ok: null, body: r.title ? `${r.title}\n${r.body}` : r.body }
    default:
      // Jobs, playlists, selections — things started rather than said. The
      // pages that show them are elsewhere; here it is enough to say so.
      return { ok: null, body: 'Started.' }
  }
}

export function PluginSettingsModal({ plugin, onClose }: { plugin: Plugin; onClose: () => void }) {
  const qc = useQueryClient()
  const fields = fieldsOf(plugin)
  const actions = actionsOf(plugin)
  const check = checkOf(plugin)

  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      fields.map((f) => [f.key, plugin.config[f.key] ?? f.default ?? (f.type === 'check' ? false : '')]),
    ))
  // Whether the form differs from what the server holds. A check or an action
  // runs against *saved* settings, so unsaved edits are saved first — a "Test
  // the token" that quietly tests the previous token would be worse than none.
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // 'save' or the command in flight
  const [answer, setAnswer] = useState<{ ok: boolean | null; body: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const set = (key: string, value: unknown) => {
    setValues((old) => ({ ...old, [key]: value }))
    setDirty(true)
  }

  // Merged over the stored config, not replacing it: a plugin may keep things
  // there the form never shows — Last.fm's session key lives beside its fields,
  // and a save that dropped it would silently disconnect the account.
  const persist = async () => {
    await api.plugins.configure(plugin.id, { ...plugin.config, ...values })
    setDirty(false)
    await qc.invalidateQueries({ queryKey: ['plugins'] })
  }

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      await persist()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the server refused it')
      setBusy(null)
    }
  }

  const run = async (a: Action) => {
    setBusy(a.command)
    setError(null)
    setAnswer(null)
    try {
      if (dirty) await persist()
      const r = await api.plugins.command(plugin.id, a.command)
      if (r.kind === 'job') qc.invalidateQueries({ queryKey: ['jobs'] })
      setAnswer(said(r))
    } catch (err) {
      setAnswer({
        ok: false,
        body: explainPlugin(err instanceof Error ? err : new Error(String(err)), plugin.name),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal plugin-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-titlebar">
          <button className="close" onClick={onClose} />
          <span>{plugin.name} — Settings</span>
        </div>

        <div className="modal-head">
          <div className="head-meta">
            <b>
              {plugin.name} <span className="dim">{plugin.version}</span>{' '}
              <span className={`p-state ${plugin.state}`}>{plugin.state}</span>
            </b>
            <span className="dim">{plugin.description}</span>
            {plugin.error && <span className="p-error">{plugin.error}</span>}
          </div>
        </div>

        <div className="modal-body">
          {fields.length === 0 && <p className="dim">This plugin has nothing to configure.</p>}
          <div className="fields">
            {fields.map((f) => (
              <span key={f.key} className="p-setting">
                <label className={`field ${f.type === 'check' ? 'bool' : ''}`}>
                  <span className="lbl">{f.label}</span>
                  {f.type === 'check' ? (
                    <input
                      type="checkbox"
                      checked={Boolean(values[f.key])}
                      onChange={(e) => set(f.key, e.target.checked)}
                    />
                  ) : (
                    <span className="input-wrap">
                      <input
                        type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                        value={String(values[f.key] ?? '')}
                        onChange={(e) => set(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)}
                      />
                    </span>
                  )}
                </label>
                {f.help && <span className="p-help">{f.help}</span>}
              </span>
            ))}
          </div>

          {(actions.length > 0 || check) && (
            <div className="p-actions">
              {actions.map((a) => (
                <button
                  key={a.command}
                  disabled={busy !== null || !plugin.enabled}
                  title={plugin.enabled ? undefined : 'Enable the plugin first'}
                  onClick={() => run(a)}
                >
                  {busy === a.command ? '…' : a.label}
                </button>
              ))}
              {check && (
                <button
                  disabled={busy !== null || !plugin.enabled}
                  title={plugin.enabled ? undefined : 'Enable the plugin first'}
                  onClick={() => run(check)}
                >
                  {busy === check.command ? '…' : check.label}
                </button>
              )}
            </div>
          )}
          {answer && (
            <pre className={`p-answer ${answer.ok === true ? 'ok' : answer.ok === false ? 'bad' : ''}`}>
              {answer.body}
            </pre>
          )}
        </div>

        <div className="modal-foot">
          {error && <span className="p-error">{error}</span>}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="default" disabled={busy !== null || fields.length === 0} onClick={save}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
