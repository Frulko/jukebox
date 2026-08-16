import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { Icon } from './Icon'

/** Bitrate means nothing to a lossless encoder, and ffmpeg treats it as an error. */
const LOSSY = new Set(['mp3', 'aac', 'opus', 'vorbis'])

const QUALITIES = ['128k', '192k', '256k', '320k']

/**
 * Convert a selection to another format.
 *
 * The question the dialog exists to ask is not the format — it is what happens
 * to the file you already have. Replacing is destructive and irreversible;
 * keeping both is the case worth having, because an iPod that takes AAC and a
 * browser that wants the FLAC are the same song and the library should know it.
 */
export function ConvertDialog({
  ids,
  onClose,
  onStarted,
}: {
  ids: string[]
  onClose: () => void
  onStarted: (message: string) => void
}) {
  const qc = useQueryClient()
  // ffmpeg is a binary on PATH, not a dependency: "not installed" is a state
  // this dialog has to be able to show, not an error to discover on submit.
  const caps = useQuery({
    queryKey: ['transcode', 'capabilities'],
    queryFn: () => api.transcode.capabilities(),
    staleTime: 5 * 60_000,
  })
  const formats = caps.data?.formats ?? []
  const [format, setFormat] = useState('')
  const [quality, setQuality] = useState('256k')
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const target = format || formats[0] || ''
  const lossy = LOSSY.has(target)

  const run = async () => {
    if (!target) return
    setBusy(true)
    setFailed(null)
    try {
      await api.transcode.run({ ids, format: target, quality: lossy ? quality : undefined, replace })
      qc.invalidateQueries({ queryKey: ['jobs'] })
      onStarted(`Converting ${ids.length} track${ids.length > 1 ? 's' : ''} to ${target.toUpperCase()}`)
      onClose()
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The server refused the conversion')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal convert" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-titlebar">
          <button className="close" onClick={onClose} />
          <span>Convert</span>
        </div>

        <div className="modal-body">
          {caps.isPending && <p className="dim">Asking the server what it can convert…</p>}

          {caps.data && !caps.data.available && (
            <div className="convert-unavailable">
              <Icon name="alert" size={12} />
              <div>
                <b>This server cannot convert.</b>
                <p>{caps.data.reason ?? 'ffmpeg was not found.'}</p>
                <p className="dim">
                  Conversion shells out to ffmpeg, which is a binary on the server's PATH rather than
                  something this app ships. Install it and reopen this dialog.
                </p>
              </div>
            </div>
          )}

          {caps.data?.available && (
            <>
              <p className="convert-lead">
                {ids.length.toLocaleString('en-US')} track{ids.length > 1 ? 's' : ''} selected. A track that is
                already in the target format is skipped rather than converted twice.
              </p>

              <label className="convert-row">
                <span>Format</span>
                <select value={target} onChange={(e) => setFormat(e.target.value)}>
                  {formats.map((f) => (
                    <option key={f} value={f}>
                      {f.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>

              {/* Only for lossy targets: a bitrate handed to FLAC is a fatal
                  argument, and a field that does nothing is worse than absent. */}
              {lossy && (
                <label className="convert-row">
                  <span>Bit rate</span>
                  <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                    {QUALITIES.map((q) => (
                      <option key={q} value={q}>
                        {q}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <fieldset className="convert-what">
                <legend>What happens to the file you have</legend>
                <label className={replace ? '' : 'on'}>
                  <input type="radio" checked={!replace} onChange={() => setReplace(false)} />
                  <span>
                    <b>Keep both</b>
                    <em>
                      The new file joins the track as another rendition. The original keeps playing and
                      stays the one listings show — the iPod can take the {target.toUpperCase()} while the
                      browser gets the original.
                    </em>
                  </span>
                </label>
                <label className={replace ? 'on' : ''}>
                  <input type="radio" checked={replace} onChange={() => setReplace(true)} />
                  <span>
                    <b>Replace the original</b>
                    <em>
                      The old file is deleted and the converted one takes its place. Ratings, play counts
                      and playlists are untouched — the file changes, the track does not. This cannot be
                      undone.
                    </em>
                  </span>
                </label>
              </fieldset>

              {failed && <p className="convert-failed">{failed}</p>}
            </>
          )}
        </div>

        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button
            className="prim"
            disabled={!caps.data?.available || busy || !target}
            onClick={run}
          >
            {busy ? 'Starting…' : replace ? 'Convert and replace' : 'Convert'}
          </button>
        </div>
      </div>
    </div>
  )
}
