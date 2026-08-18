// Fake content for the non-music library sources. Same deterministic seed trick
// as data.ts so the shelves look identical on every reload.

function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Episode = {
  id: string
  title: string
  index: number
  season: number
  runtime: number
  date: number
  unplayed: boolean
  size: number
  summary: string
}

export type Show = {
  id: string
  title: string
  subtitle: string
  hue: number
  episodes: Episode[]
}

export type App = {
  id: string
  name: string
  category: string
  version: string
  size: number
  hue: number
  universal: boolean
}

export type Station = { id: string; name: string; bitrate: number; listeners: number }
export type RadioGenre = { name: string; stations: Station[] }

const PODCASTS: Array<[string, string, number]> = [
  ['Song Exploder Redux', 'Weekly · Music', 14],
  ['The Vinyl Hours', 'Twice monthly · Culture', 9],
  ['Compression', 'Weekly · Audio engineering', 18],
  ['Late Night Frequencies', 'Monthly · Interviews', 7],
]

const BOOKS: Array<[string, string, number]> = [
  ['The Sound of One Room', 'Read by Anouk Duval', 9],
  ['Analog Days', 'Read by Marcus Coleman', 12],
  ['Notes on Listening', 'Read by Lena Vasquez', 6],
]

const APPS: Array<[string, string]> = [
  ['Metronome', 'Music'], ['TapeDeck', 'Music'], ['Chord Atlas', 'Reference'],
  ['Field Notes', 'Productivity'], ['Sparrow', 'Utilities'], ['Tuner Pro', 'Music'],
  ['Waveform', 'Music'], ['Setlist', 'Productivity'], ['Radio Dial', 'Entertainment'],
  ['Loop Machine', 'Music'], ['Gig Book', 'Reference'], ['Levels', 'Utilities'],
]

const RADIO: Array<[string, string[]]> = [
  ['Alt/Modern Rock', ['Radio Paradise', 'Indie Pop Rocks', 'The Current', 'Frequence 3']],
  ['Ambient', ['Drone Zone', 'Space Station Soma', 'Deep Space One', 'Ambient Sleeping Pill']],
  ['Classic Rock', ['Classic Vinyl HD', 'The Vault', 'Album Rock 101']],
  ['Electronica', ['Groove Salad', 'Beat Blender', 'Defcon Radio', 'Sector 9']],
  ['Jazz', ['Sonic Universe', 'Blue Note Radio', 'Left Bank Jazz']],
  ['Public', ['NPR Program Stream', 'BBC World Service', 'France Culture']],
  ['Reggae/Dub', ['Dub Step Beyond', 'Roots Reggae FM']],
  ['Talk/News', ['Talk Radio One', 'The Daily Brief']],
]

const EP_WORDS = ['Signal', 'Static', 'Reel', 'Cutting Room', 'Feedback', 'Blackout', 'Tape', 'Monitor', 'Playback', 'Overtones', 'Silence', 'Encore', 'Drift', 'Ground Loop', 'The Master', 'Room Tone', 'Bounce', 'Take Two']

const r = rng(4242)
const MIN = 60

function makeEpisodes(prefix: string, season: number, count: number, base: number): Episode[] {
  return Array.from({ length: count }, (_, i) => {
    const runtime = 22 + Math.floor(r() * 38)
    return {
      id: `${prefix}-e${i}`,
      title: `${EP_WORDS[Math.floor(r() * EP_WORDS.length)]} ${i + 1}`,
      index: i + 1,
      season,
      runtime,
      date: base - (count - i) * 7 * 864e5,
      unplayed: r() > 0.55,
      size: Math.round(runtime * MIN * 0.9e6),
      summary: 'Episode description not available offline.',
    }
  })
}

const NOW = Date.UTC(2026, 7, 16)

export const PODCAST_LIST: Show[] = PODCASTS.map(([title, subtitle, count], i) => ({
  id: `pc${i}`,
  title,
  subtitle,
  hue: Math.floor(r() * 360),
  episodes: makeEpisodes(`pc${i}`, 1, count, NOW),
}))

export const AUDIOBOOKS: Show[] = BOOKS.map(([title, subtitle, count], i) => ({
  id: `ab${i}`,
  title,
  subtitle,
  hue: Math.floor(r() * 360),
  episodes: makeEpisodes(`ab${i}`, 1, count, NOW).map((e, n) => ({ ...e, title: `Chapter ${n + 1}` })),
}))

export const APP_LIST: App[] = APPS.map(([name, category], i) => ({
  id: `ap${i}`,
  name,
  category,
  version: `${1 + Math.floor(r() * 4)}.${Math.floor(r() * 9)}.${Math.floor(r() * 9)}`,
  size: Math.round((2 + r() * 90) * 1e6),
  hue: Math.floor(r() * 360),
  universal: r() > 0.5,
}))

export const RADIO_GENRES: RadioGenre[] = RADIO.map(([name, stations]) => ({
  name,
  stations: stations.map((s, i) => ({
    id: `${name}-${i}`,
    name: s,
    bitrate: [64, 96, 128, 128, 192, 256][Math.floor(r() * 6)],
    listeners: 40 + Math.floor(r() * 9000),
  })),
}))

export const fmtMin = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`
export const fmtBytes = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`

/** Status-bar summary per source, so the bottom line is never stale. */
export function mediaSummary(id: string) {
  const total = (xs: Show[]) => xs.reduce((a, s) => a + s.episodes.length, 0)
  switch (id) {
    case 'podcasts':
      return `${PODCAST_LIST.length} podcasts, ${total(PODCAST_LIST)} episodes`
    case 'audiobooks':
      return `${AUDIOBOOKS.length} audiobooks, ${total(AUDIOBOOKS)} chapters`
    case 'apps':
      return `${APP_LIST.length} apps, ${fmtBytes(APP_LIST.reduce((a, x) => a + x.size, 0))}`
    case 'radio':
      return `${RADIO_GENRES.reduce((a, g) => a + g.stations.length, 0)} streams in ${RADIO_GENRES.length} genres`
    default:
      return ''
  }
}
