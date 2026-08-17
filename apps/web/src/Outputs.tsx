import { useState } from 'react'
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react'
import type { Output, PlayerState } from '@jukebox/client-sdk'
import { api, useOutputs } from './api'
import { Icon } from './Icon'
import { t } from './i18n'

/** What each protocol is called by the people who bought the speaker. */
const KIND: Record<string, string> = {
  airplay: 'AirPlay',
  cast: 'Chromecast',
  upnp: 'UPnP · Sonos',
  satellite: 'Satellite',
}

/**
 * Where the music comes out.
 *
 * The server has had all of this since the beginning — an SSDP search that
 * finds UPnP renderers and Sonos, AirPlay receivers, Chromecasts, and
 * satellites that register themselves; a player target; and the driving, so
 * choosing a speaker starts it on the current track. None of it was reachable:
 * the app had no way to ask for the list and no way to say where to play, so
 * every library in the house came out of whichever tab was open.
 *
 * The list is a question about *now* rather than a stored set of devices. A
 * speaker that was unplugged should stop being offered, which is why there is a
 * "look again" instead of a remembered list — and why the entries do not
 * pretend to be a settings page.
 */
export function OutputPicker({
  target,
  onChoose,
}: {
  target: PlayerState['target']
  onChoose: (target: PlayerState['target']) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const { data, isPending, refetch, isFetching } = useOutputs(open)
  const { refs, floatingStyles } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top-end',
    strategy: 'fixed',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })

  const outputs = data?.items ?? []
  const remote = target.kind === 'output'

  const choose = async (next: PlayerState['target']) => {
    if (busy) return
    setBusy(true)
    try {
      await onChoose(next)
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        ref={refs.setReference}
        className={`sb-btn out-btn ${remote ? 'on' : ''}`}
        title={remote ? `${t('Playing on')} ${target.name}` : t('Play on a speaker')}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="radio" size={11} />
      </button>

      {open && (
        <>
          {/* A click anywhere else closes it, and does nothing else — a picker
              that swallows the click that dismissed it is the reason menus feel
              slow. */}
          <div className="out-catch" onMouseDown={() => setOpen(false)} />
          <div ref={refs.setFloating} style={floatingStyles} className="ctx out-menu">
            <button className={remote ? '' : 'on'} disabled={busy} onClick={() => void choose({ kind: 'local' })}>
              <span className="tick">{!remote ? '✓' : ''}</span>
              <span className="n">{t('This browser')}</span>
              <em className="dim">{t('the tab you are reading')}</em>
            </button>

            {outputs.length > 0 && <hr />}

            {outputs.map((o: Output) => {
              const chosen = target.kind === 'output' && target.id === o.id
              return (
                <button
                  key={o.id}
                  className={chosen ? 'on' : ''}
                  disabled={busy}
                  onClick={() => void choose({ kind: 'output', id: o.id, name: o.name })}
                >
                  <span className="tick">{chosen ? '✓' : ''}</span>
                  {/* One line, cut rather than wrapped: a UPnP name is often an
                      IP address and a model, and a wrapped one pushes the next
                      speaker into it. */}
                  <span className="n" title={o.address}>{o.name}</span>
                  <em className="dim">
                    {KIND[o.kind] ?? o.kind}
                    {o.model ? ` · ${o.model}` : ''}
                    {/* Registered and quiet for five minutes. Still offered,
                        because it is somebody's speaker and it comes back. */}
                    {o.stale ? ` · ${t('not answering')}` : ''}
                  </em>
                </button>
              )
            })}

            {isPending && <div className="ctx-empty">{t('Listening for speakers…')}</div>}
            {!isPending && outputs.length === 0 && (
              <div className="ctx-empty">{t('No speakers answered on this network.')}</div>
            )}

            <hr />
            <button disabled={isFetching} onClick={() => void refetch()}>
              {isFetching ? t('Looking…') : t('Look again')}
            </button>

            {/* The address a speaker will be told to fetch from. It is here
                because when it is wrong — a container with several interfaces,
                a server behind a proxy — every play fails in silence, and this
                is the one number that explains why. */}
            {data?.advertising && (
              <div className="out-advert">
                {t('Speakers fetch from')} <code>{data.advertising}</code>
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}

/**
 * The volume of whatever is actually making the sound.
 *
 * A slider that moves this tab's volume while the music comes out of a speaker
 * in another room is a control that does nothing, which is worse than one that
 * is not there. So it drives the speaker — and when the speaker cannot be
 * driven it says so instead of failing in silence: AirPlay keeps its volume in
 * RTSP, a protocol this server deliberately does not speak, and answers 501.
 *
 * Trailing edge only. A range input fires on every pixel of a drag, and a
 * request per pixel would reach the speaker as a stutter, out of order.
 */
let pending: ReturnType<typeof setTimeout> | undefined

export function setOutputVolume(
  target: PlayerState['target'],
  volume: number,
  onRefused: (reason: string) => void,
) {
  if (target.kind !== 'output') return
  clearTimeout(pending)
  pending = setTimeout(() => {
    void api.outputs.volume(target.id, volume).catch((err: unknown) => {
      onRefused(err instanceof Error ? err.message : t('That speaker did not take the volume'))
    })
  }, 150)
}
