import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, useSources } from './api'
import { FolderBrowser } from './FolderBrowser'

/**
 * Two ways a podcast gets into a library, and they are not the same operation.
 *
 * **A feed** is a subscription: the server fetches it, keeps checking it, and
 * downloads what it is told to. **A folder** is already yours — episodes on
 * disk that the scanner has filed as music because nothing said otherwise.
 * Marking them is not a subscription and never will be: there is no feed to
 * check, nothing new will appear, and saying so is the difference between a
 * show that updates and one that does not.
 *
 * Hence a dialog rather than a field with a button. A single "Feed URL" box
 * makes the second way invisible, and the way to make a choice visible is to
 * ask it.
 */
export function AddPodcast({
  onClose,
  onNotice,
  onAdded,
}: {
  onClose: () => void
  onNotice: (message: string) => void
  onAdded: () => void
}) {
  const [how, setHow] = useState<'feed' | 'folder'>('feed')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sources = useSources().data?.items ?? []
  const [sourceId, setSourceId] = useState<string | null>(null)
  const source = sourceId ?? sources[0]?.id ?? null
  const [folder, setFolder] = useState<string | null>(null)

  const chosen = useQuery({
    queryKey: ['tracks', 'folder', source, folder],
    queryFn: () => api.tracks.list({ sourceId: source!, folder: folder!, limit: 500 }),
    enabled: how === 'folder' && !!source && !!folder,
  })
  const inFolder = chosen.data?.items ?? []

  const subscribe = async () => {
    const feedUrl = url.trim()
    if (!feedUrl || busy) return
    setBusy(true)
    setError(null)
    try {
      const added = await api.podcasts.subscribe({ feedUrl })
      onAdded()
      onNotice(`Subscribed to ${added.title || feedUrl} — fetching episodes`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the server refused that feed')
    } finally {
      setBusy(false)
    }
  }

  const markFolder = async () => {
    if (!inFolder.length || busy) return
    setBusy(true)
    setError(null)
    try {
      // The kind is what files a track under Podcasts rather than among the
      // songs. Nothing is moved, nothing is copied, and setting it back is the
      // same one call — which is why this needs no confirmation of its own.
      await api.tracks.patch(inFolder.map((t) => t.id), { kind: 'podcast' })
      onAdded()
      onNotice(`${inFolder.length} episodes filed under Podcasts — nothing was moved`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the server refused it')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal add-podcast" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-titlebar">
          <button className="close" onClick={onClose} />
          <span>Add a podcast</span>
        </div>

        <div className="tabs">
          <button className={how === 'feed' ? 'on' : ''} onClick={() => setHow('feed')}>
            From a feed
          </button>
          <button className={how === 'folder' ? 'on' : ''} onClick={() => setHow('folder')}>
            From a folder you have
          </button>
        </div>

        <div className="modal-body">
          {how === 'feed' ? (
            <>
              <p className="dim">
                A subscription. The server fetches the feed now and keeps checking it, and new episodes
                appear on their own — downloaded too, if you turn that on afterwards.
              </p>
              <input
                autoFocus
                className="ap-url"
                value={url}
                placeholder="https://example.com/feed.xml"
                onChange={(e) => (setUrl(e.target.value), setError(null))}
                onKeyDown={(e) => e.key === 'Enter' && void subscribe()}
              />
            </>
          ) : (
            <>
              <p className="dim">
                Episodes already on your disk. They are filed under Podcasts instead of among the songs —
                nothing is moved or copied. <b>This is not a subscription:</b> there is no feed to check,
                so nothing new will ever appear by itself.
              </p>

              <FolderBrowser
                sourceId={source}
                onSource={setSourceId}
                folder={folder}
                onFolder={setFolder}
              />

              {folder && (
                <p className="ap-preview">
                  {chosen.isPending
                    ? 'Counting…'
                    : `${inFolder.length} track${inFolder.length === 1 ? '' : 's'} under ${folder}`}
                  {inFolder.length > 0 && <span className="dim"> — “{inFolder[0].name}” and the rest</span>}
                </p>
              )}
            </>
          )}

          {error && <p className="pod-add-error">{error}</p>}
        </div>

        <div className="modal-foot">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          {how === 'feed' ? (
            <button className="default" disabled={!url.trim() || busy} onClick={() => void subscribe()}>
              {busy ? 'Adding…' : 'Subscribe'}
            </button>
          ) : (
            <button className="default" disabled={!inFolder.length || busy} onClick={() => void markFolder()}>
              {busy ? 'Filing…' : inFolder.length ? `File ${inFolder.length} episodes` : 'File them'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
