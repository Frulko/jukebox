import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, type Plugin } from '@jukebox/client-sdk'
import { api } from './api'

/** One entry a plugin asked to put in the track menu. */
export type PluginEntry = {
  pluginId: string
  pluginName: string
  id: string
  label: string
  command: string
  /**
   * A plugin that is installed but not running still contributes its entries —
   * they are in its manifest, not in its process. Drawing them greyed says
   * "this exists and is switched off", which is a different fact from a menu
   * that quietly gets shorter.
   */
  runnable: boolean
}

type Contribution = { id?: string; label?: string; command?: string }

function entriesOf(plugin: Plugin): PluginEntry[] {
  const zone = (plugin.contributes as Record<string, unknown>)?.['track.contextMenu']
  if (!Array.isArray(zone)) return []
  return (zone as Contribution[])
    .filter((c) => c.label && c.command)
    .map((c) => ({
      pluginId: plugin.id,
      pluginName: plugin.name,
      id: c.id ?? `${plugin.id}.${c.command}`,
      label: c.label!,
      command: c.command!,
      // `commands` is what can be invoked right now; `contributes` is what the
      // manifest claims. They disagree exactly when a plugin is stopped.
      runnable: Array.isArray(plugin.commands) && plugin.commands.includes(c.command!),
    }))
}

/** What went wrong, in words that name the right culprit. */
function explain(err: unknown, entry: PluginEntry): string {
  if (!(err instanceof ApiError)) return `${entry.pluginName} could not be reached`
  switch (err.status) {
    case 409:
      return `${entry.pluginName} is switched off`
    case 404:
      return `${entry.pluginName} no longer has that command`
    case 504:
      return `${entry.pluginName} did not answer`
    case 400:
      // The plugin's own message. It knows what it was doing; we do not.
      return err.message
    default:
      // A 500 is the server, not the plugin, and saying "the plugin failed"
      // there would send someone to debug the wrong thing.
      return 'The server failed to run that command'
  }
}

export type CommandResult =
  | { kind: 'done'; message?: string }
  | { kind: 'job'; job: unknown }
  | { kind: 'playlist'; id: string; name: string }
  | { kind: 'tracks'; ids: string[] }

export function usePluginMenu(handlers: {
  notice: (message: string) => void
  openPlaylist: (id: string) => void
  select: (ids: string[]) => void
}) {
  const qc = useQueryClient()
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list(), staleTime: 60_000 })

  const entries = (plugins.data?.items ?? []).flatMap(entriesOf)

  const run = async (entry: PluginEntry, trackIds: string[]) => {
    try {
      const r = (await api.plugins.command(entry.pluginId, entry.command, trackIds)) as CommandResult
      switch (r.kind) {
        case 'done':
          handlers.notice(r.message ?? `${entry.label} — done`)
          break
        case 'job':
          qc.invalidateQueries({ queryKey: ['jobs'] })
          handlers.notice(`${entry.label} started — watch it in the display`)
          break
        case 'playlist':
          qc.invalidateQueries({ queryKey: ['playlists'] })
          handlers.openPlaylist(r.id)
          handlers.notice(`${entry.pluginName} made “${r.name}”`)
          break
        case 'tracks':
          // Selected rather than saved: an exploratory command should not
          // litter the sidebar with a playlist nobody asked to keep.
          handlers.select(r.ids)
          handlers.notice(`${r.ids.length} track${r.ids.length > 1 ? 's' : ''} found — selected, not saved`)
          break
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) qc.invalidateQueries({ queryKey: ['plugins'] })
      handlers.notice(explain(err, entry))
    }
  }

  return { entries, run }
}
