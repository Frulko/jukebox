import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, type CommandResult, type Plugin } from '@jukebox/client-sdk'
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

/**
 * A tab a plugin asked to add to the track's information window.
 *
 * Same shape as a menu entry and deliberately so: a plugin declares *where* and
 * *what it is called*, the host runs the command and draws the answer. Nothing
 * of the plugin's runs in the page, which is why a third-party tab cannot
 * restyle the window or read the rest of it.
 */
export type PluginTab = PluginEntry

type Contribution = { id?: string; label?: string; command?: string }

function entriesOf(plugin: Plugin, zoneName = 'track.contextMenu'): PluginEntry[] {
  const zone = plugin.contributes?.[zoneName]
  if (!Array.isArray(zone)) return []
  // SAFETY: `contributes` is the plugin manifest's own JSON, and a zone, when
  // present, is declared as a list of contributions. The filter below keeps
  // only entries carrying the two fields the menu needs, so an entry of the
  // wrong shape is dropped rather than drawn.
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
function explain(err: Error, entry: PluginEntry): string {
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

/** Runs a tab's command and hands back the answer instead of acting on it. */
export async function runPluginTab(tab: PluginTab, trackId: string): Promise<CommandResult> {
  return api.plugins.command(tab.pluginId, tab.command, [trackId])
}

/** The sentence to show when a tab's command fails, naming the right culprit. */
export const explainTab = explain

export function usePluginMenu(handlers: {
  notice: (message: string) => void
  openPlaylist: (id: string) => void
  select: (ids: string[]) => void
}) {
  const qc = useQueryClient()
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: () => api.plugins.list(), staleTime: 60_000 })

  const entries = (plugins.data?.items ?? []).flatMap((p) => entriesOf(p))
  // A tab that cannot run has nothing to show, so unlike a menu entry — which
  // is drawn greyed to say "this exists and is switched off" — a stopped
  // plugin's tab is not drawn at all: an empty tab is a worse answer than a
  // window that simply has one tab fewer.
  const tabs: PluginTab[] = (plugins.data?.items ?? [])
    .flatMap((p) => entriesOf(p, 'track.tab'))
    .filter((t) => t.runnable)

  const run = async (entry: PluginEntry, trackIds: string[]) => {
    try {
      const r = await api.plugins.command(entry.pluginId, entry.command, trackIds)
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
        case 'text':
          // A menu entry has nowhere to put a page of text; the status line
          // gets the title, and the tab is where it belongs.
          handlers.notice(r.title ?? `${entry.label} — answered`)
          break
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) qc.invalidateQueries({ queryKey: ['plugins'] })
      // The catch's `unknown` is normalised here, at the boundary: everything
      // the SDK throws is an Error, and anything else becomes one.
      handlers.notice(explain(err instanceof Error ? err : new Error(String(err)), entry))
    }
  }

  return { entries, tabs, run }
}
