import { browse, type Service } from './mdns.ts'
import { CastChannel, NS, type ChannelOptions } from './castv2.ts'

/**
 * Chromecast as an output.
 *
 * Same bargain as every other renderer here: the server hands over a URL and
 * the device fetches it. That is not a design choice made for this project —
 * it is how casting works — which is why a Chromecast slots in beside a UPnP
 * speaker and an AirPlay receiver without a second architecture.
 *
 * Getting there takes four steps, and the order is not negotiable:
 *
 *   1. connect, and open a *virtual* connection on top of the TCP one
 *   2. launch the Default Media Receiver, an app id everybody hardcodes
 *   3. connect again — to the app this time, at the transport id it just
 *      reported, which is the step that is easy to miss because nothing fails
 *      loudly without it; the LOAD is simply ignored
 *   4. LOAD, with a media session id that every later command has to quote
 */

export const SERVICE = '_googlecast._tcp.local'

/** Google's own receiver app. Plays a URL with no application of ours involved. */
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845'

export type CastDevice = {
  id: string
  name: string
  address: string
  port: number
  model: string
}

export function toDevice(s: Service): CastDevice | null {
  if (!s.address) return null
  return {
    // `id` in the TXT is the device's own uuid, stable across renames and
    // network changes — unlike the name, which is whatever the room is called
    // this week.
    id: s.txt.id ? `cast:${s.txt.id}` : `cast:${s.fqdn}`,
    // `fn` is the friendly name. The instance label is the same thing with the
    // spaces escaped, so the TXT is the better source.
    name: s.txt.fn || s.name,
    address: s.address,
    port: s.port || 8009,
    model: s.txt.md ?? '',
  }
}

export async function discover(opts: Parameters<typeof browse>[1] = {}): Promise<CastDevice[]> {
  const services = await browse(SERVICE, opts)
  return services.map(toDevice).filter((d): d is CastDevice => d !== null)
}

export type Media = {
  url: string
  contentType: string
  title?: string
  artist?: string
  album?: string
  duration?: number
  artwork?: string
}

/**
 * A session on one device: the four steps, then whatever comes next.
 *
 * Held open rather than reconnecting per command, because the media session id
 * only exists inside a connection — a pause that reconnects first has nothing
 * to pause.
 */
export class CastSession {
  #channel: CastChannel
  #transportId: string | null = null
  #mediaSessionId: number | null = null

  constructor(opts: ChannelOptions) {
    this.#channel = new CastChannel(opts)
  }

  get mediaSessionId(): number | null {
    return this.#mediaSessionId
  }

  async open(): Promise<void> {
    await this.#channel.open()
  }

  /**
   * Starts the receiver app and joins it.
   *
   * Launching an app that is already running returns its existing session
   * rather than restarting it, which is what makes this safe to call before
   * every load.
   */
  async launch(appId = DEFAULT_MEDIA_RECEIVER): Promise<string> {
    const status = await this.#channel.request(NS.receiver, { type: 'LAUNCH', appId })
    const app = (status?.status?.applications ?? []).find((a: any) => a.appId === appId)
      ?? status?.status?.applications?.[0]
    if (!app?.transportId) throw new Error('the device launched no app')

    this.#transportId = app.transportId
    // The second connection, to the app rather than to the device. Without it
    // the LOAD below is dropped in silence.
    this.#channel.send(NS.connection, { type: 'CONNECT' }, app.transportId)
    return app.transportId
  }

  async load(media: Media, autoplay = true): Promise<void> {
    if (!this.#transportId) await this.launch()

    const status = await this.#channel.request(NS.media, {
      type: 'LOAD',
      autoplay,
      currentTime: 0,
      media: {
        contentId: media.url,
        contentType: media.contentType,
        // BUFFERED, not LIVE: a live stream shows no duration and cannot be
        // seeked, and a song is neither of those things.
        streamType: 'BUFFERED',
        metadata: {
          // 3 is MusicTrackMediaMetadata, which is what makes a Chromecast show
          // an artist and an album rather than a filename.
          metadataType: 3,
          title: media.title ?? '',
          artist: media.artist ?? '',
          albumName: media.album ?? '',
          ...(media.artwork ? { images: [{ url: media.artwork }] } : {}),
        },
        ...(media.duration ? { duration: media.duration } : {}),
      },
    }, this.#transportId!)

    const session = status?.status?.[0]?.mediaSessionId
    if (typeof session === 'number') this.#mediaSessionId = session
  }

  /**
   * Every media command quotes the session; without it the device ignores them.
   *
   * `async` so the "nothing is loaded" case *rejects* rather than throwing
   * synchronously. An API that usually returns a promise and occasionally
   * throws before making one is a footgun: every caller doing `.catch()`
   * instead of try/catch gets an unhandled rejection at a distance.
   */
  async #media(type: string): Promise<any> {
    if (!this.#transportId || this.#mediaSessionId === null) {
      throw new Error('nothing is loaded on this device')
    }
    return this.#channel.request(NS.media, { type, mediaSessionId: this.#mediaSessionId }, this.#transportId)
  }

  pause = () => this.#media('PAUSE').then(() => undefined)
  resume = () => this.#media('PLAY').then(() => undefined)
  stop = () => this.#media('STOP').then(() => undefined)

  async seek(seconds: number): Promise<void> {
    if (!this.#transportId || this.#mediaSessionId === null) {
      throw new Error('nothing is loaded on this device')
    }
    await this.#channel.request(NS.media,
      { type: 'SEEK', mediaSessionId: this.#mediaSessionId, currentTime: seconds }, this.#transportId)
  }

  /** Volume is on the receiver, not the media session: it is the device's own. */
  async setVolume(percent: number): Promise<void> {
    const level = Math.max(0, Math.min(100, percent)) / 100
    await this.#channel.request(NS.receiver, { type: 'SET_VOLUME', volume: { level } })
  }

  async status(): Promise<any> {
    if (!this.#transportId) return null
    return this.#channel.request(NS.media, { type: 'GET_STATUS' }, this.#transportId)
  }

  close(): void {
    this.#channel.close()
    this.#transportId = null
    this.#mediaSessionId = null
  }
}
