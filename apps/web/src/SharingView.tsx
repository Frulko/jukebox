import { useQuery } from '@tanstack/react-query'
import { ApiError, type Account, type Source } from '@jukebox/client-sdk'
import { api, DEMO, useSources } from './api'
import { Icon } from './Icon'
import { useScrollMemory } from './viewState'
import { getLocale } from './i18n'

/** Where a remote source actually lives, for a page about who is on the other end. */
function hostOf(source: Source) {
  const url = String(source.config?.url ?? source.root ?? '')
  try {
    return new URL(url).host
  } catch {
    return url || 'unknown'
  }
}

// `local` never renders here — this page filters it out — but a total record
// over the source kinds keeps the lookup closed instead of stringly.
const KIND_LABEL = {
  jellyfin: 'Jellyfin server',
  emby: 'Emby server',
  plex: 'Plex server',
  rclone: 'rclone remote',
  local: 'local folder',
} satisfies Record<Source['kind'], string>

/**
 * Sharing — who may read this library, and whose libraries this one can read.
 *
 * The page exists to make the model legible, so it is organised by direction
 * rather than by feature, and it is explicit about which parts are built. Two
 * of the three are: a friend's Jellyfin or Plex server added as a source *is*
 * somebody sharing a library with you, and an account narrowed to some sources
 * *is* you sharing yours. The third — peer to peer, no server in the middle —
 * is a design and nothing more, and a page that let it look otherwise would be
 * the worst thing this one could do.
 */
export function SharingView({ onGoToSources }: { onGoToSources: () => void }) {
  const pane = useScrollMemory<HTMLDivElement>('sharing')
  const sources = useSources().data?.items ?? []
  const remote = sources.filter((s) => s.kind !== 'local')

  // Admin only, and the server answers 403 rather than an empty list — which is
  // the answer this page has to show as itself rather than as "nobody".
  const accounts = useQuery<{ items: Account[] }, ApiError>({
    queryKey: ['users'],
    queryFn: () => api.users.list(),
    retry: false,
    staleTime: 60_000,
  })
  const forbidden = accounts.error?.status === 403 || accounts.error?.status === 401
  const guests = (accounts.data?.items ?? []).filter((u) => u.role !== 'admin')

  // In the demo this page is served by a documentation site, which has no
  // `/rest` and never will: printing its origin would be a working-looking
  // address that answers nothing.
  const endpoint = DEMO ? 'http://your-server:8787/rest' : `${location.origin}/rest`

  return (
    <div className="media sharing" ref={pane.ref} onScroll={pane.onScroll}>
      <div className="view-head">
        <h2>Sharing</h2>
      </div>

      <p className="share-lead">
        Sharing here means <b>reading</b>, never copying: whoever is on the other end plays from the
        machine that holds the files, and whoever holds them keeps deciding what is offered and can stop
        offering it. Nothing is duplicated, nothing is uploaded, and taking a share back is one switch
        rather than a hunt for what has already spread.
      </p>

      <h3 className="share-h">Libraries shared with you</h3>
      <p className="dim">
        Another person's Plex, Jellyfin or Emby server, added as a source. Their music appears in your
        library, plays from their machine, and disappears again when they stop sharing or the server
        goes away — which is the shape the peer-to-peer version would keep.
      </p>

      {remote.length === 0 ? (
        <div className="share-empty">
          <p>Nobody is sharing a library with you yet.</p>
          <button onClick={onGoToSources}>Add one in Sources</button>
        </div>
      ) : (
        remote.map((s) => (
          <div key={s.id} className="share-row">
            <Icon name="cloud" size={12} />
            <span className="n">{s.name}</span>
            <em className="dim">{KIND_LABEL[s.kind]}</em>
            <span className="dim host">{hostOf(s)}</span>
            <span className="spacer" />
            <span className="share-flag">{s.writable ? 'you may write to it' : 'read-only'}</span>
          </div>
        ))
      )}

      <h3 className="share-h">What you are sharing</h3>
      <p className="dim">
        An account is how somebody else reaches this library. Its role decides what it may do, and
        narrowing it to some sources decides what it can see at all — the rest is not hidden in the
        interface, it is absent from every answer the server gives that account.
      </p>

      {forbidden ? (
        // Not "nobody": this account cannot be told, which is a different fact
        // and the one worth showing to the person reading it.
        <div className="share-empty">
          <p>Only an admin can see the accounts on this server.</p>
        </div>
      ) : guests.length === 0 ? (
        <div className="share-empty">
          <p>Nobody else has an account here — the library is yours alone.</p>
        </div>
      ) : (
        guests.map((u) => (
          <div key={u.id} className="share-row">
            <Icon name="artists" size={12} />
            <span className="n">{u.username}</span>
            <em className="dim">{u.role}</em>
            <span className="dim">
              {u.subsonic ? 'can use Subsonic clients' : 'browser only'}
            </span>
            <span className="spacer" />
            <span className="dim">
              {u.lastSeenAt ? `last seen ${new Date(u.lastSeenAt).toLocaleDateString(getLocale())}` : 'never signed in'}
            </span>
          </div>
        ))
      )}

      {!forbidden && guests.length > 0 && (
        <p className="share-endpoint">
          They can point any OpenSubsonic client at <code>{endpoint}</code> — which is how someone
          listens to your library from a phone without you sending them anything.
        </p>
      )}

      <h3 className="share-h">Peer to peer — not built</h3>
      <div className="share-plan">
        <p>
          The two above both need a server somebody runs and an address somebody can reach. The
          intention is to remove that: hand a friend a code, they browse your library read-only, and
          neither of you configures a router or trusts a third party with a list of what you own.
        </p>
        <ul>
          <li><b>Read-only, always.</b> A share is a window, not a transfer.</li>
          <li><b>Anonymous.</b> The other end learns what you offer, not who you are.</li>
          <li><b>Revocable.</b> Withdrawing a share ends it, because nothing was copied.</li>
          <li>
            <b>Blocked on the protocol.</b> The choice is not decided, and it decides everything else:
            NAT traversal, identity, and whether a share survives both ends being asleep. Nothing here
            is written yet — this page will show real peers when there are any, and shows none until
            then rather than a plausible list of nobody.
          </li>
        </ul>
      </div>
    </div>
  )
}
