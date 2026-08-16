import type { Playlist, Track, TrackKind } from '@jukebox/api-types'

/**
 * The front end speaks the same shape as the server: `Track` comes from
 * `@jukebox/api-types`. The generator below is now only used by demo mode
 * (Astro site, fake backend) — it produces exactly the same shape, otherwise
 * the demo would be lying about the app.
 */
export type { Playlist, Track, TrackKind }

// ponytail: mulberry32, 4 lines vs a seedrandom dep
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CATALOG: Array<[artist: string, genre: string, albums: Array<[string, number]>]> = [
  ['Fleetwood Mac', 'Rock', [['Rumours', 1977], ['Tusk', 1979], ['Tango in the Night', 1987]]],
  ['Miles Davis', 'Jazz', [['Kind of Blue', 1959], ['Bitches Brew', 1970], ['In a Silent Way', 1969]]],
  ['Daft Punk', 'Electronic', [['Discovery', 2001], ['Homework', 1997], ['Random Access Memories', 2013]]],
  ['Radiohead', 'Alternative', [['OK Computer', 1997], ['Kid A', 2000], ['In Rainbows', 2007]]],
  ['Nina Simone', 'Jazz', [['Pastel Blues', 1965], ['Wild Is the Wind', 1966]]],
  ['The Beatles', 'Rock', [['Abbey Road', 1969], ['Revolver', 1966], ['Rubber Soul', 1965]]],
  ['Aphex Twin', 'Electronic', [['Selected Ambient Works 85-92', 1992], ['Richard D. James Album', 1996]]],
  ['Serge Gainsbourg', 'Pop', [['Histoire de Melody Nelson', 1971], ['L’Homme à tête de chou', 1976]]],
  ['J Dilla', 'Hip Hop', [['Donuts', 2006], ['The Shining', 2006]]],
  ['Talking Heads', 'New Wave', [['Remain in Light', 1980], ['Fear of Music', 1979]]],
  ['Björk', 'Alternative', [['Homogenic', 1997], ['Vespertine', 2001], ['Post', 1995]]],
  ['John Coltrane', 'Jazz', [['A Love Supreme', 1965], ['Blue Train', 1958]]],
  ['Portishead', 'Trip Hop', [['Dummy', 1994], ['Third', 2008]]],
  ['Kraftwerk', 'Electronic', [['Trans-Europe Express', 1977], ['Computer World', 1981]]],
  ['Air', 'Electronic', [['Moon Safari', 1998], ['Talkie Walkie', 2004]]],
  ['Stevie Wonder', 'R&B', [['Innervisions', 1973], ['Songs in the Key of Life', 1976]]],
  ['The Cure', 'New Wave', [['Disintegration', 1989], ['Head on the Door', 1985]]],
  ['A Tribe Called Quest', 'Hip Hop', [['The Low End Theory', 1991], ['Midnight Marauders', 1993]]],
  ['Erik Satie', 'Classical', [['Gymnopédies & Gnossiennes', 1888]]],
  ['Massive Attack', 'Trip Hop', [['Blue Lines', 1991], ['Mezzanine', 1998]]],
  ['Pink Floyd', 'Rock', [['The Dark Side of the Moon', 1973], ['Wish You Were Here', 1975]]],
  ['Burial', 'Electronic', [['Untrue', 2007]]],
  ['Ella Fitzgerald', 'Vocal', [['Sings the Cole Porter Songbook', 1956]]],
  ['LCD Soundsystem', 'Dance', [['Sound of Silver', 2007], ['This Is Happening', 2010]]],
]

const WORDS_A = ['Blue', 'Midnight', 'Golden', 'Silent', 'Electric', 'Paper', 'Velvet', 'Hollow', 'Neon', 'Bitter', 'Slow', 'Wild', 'Little', 'Broken', 'Summer', 'Northern', 'Glass', 'Crystal', 'Cold', 'Sweet']
const WORDS_B = ['Morning', 'Machine', 'Heart', 'River', 'Dancer', 'Ghost', 'Letter', 'Avenue', 'Season', 'Radio', 'Window', 'Lullaby', 'Signal', 'Garden', 'Highway', 'Motion', 'Fever', 'Shadow', 'Number 9', 'Parade']
const FIRST = ['Jean', 'Marcus', 'Lena', 'Otis', 'Yuki', 'Carla', 'Dmitri', 'Rosa', 'Idris', 'Anouk']
const LAST = ['Moreau', 'Coleman', 'Vasquez', 'Okafor', 'Lindqvist', 'Baptiste', 'Ferrer', 'Nakamura', 'Weiss', 'Duval']
const KINDS = ['mp3', 'aac', 'alac', 'flac']

/** What a listener might have written on their own tracks. Invented, like the rest. */
const TAGS = ['chill', 'workout', 'late night', 'road trip', 'to sort']

export function makeLibrary(): Track[] {
  const r = rng(20260816)
  const tracks: Track[] = []
  const now = Date.UTC(2026, 7, 16)
  let n = 0

  for (const [artist, genre, albums] of CATALOG) {
    const compilation = r() < 0.08
    for (const [album, year] of albums) {
      const count = 7 + Math.floor(r() * 7)
      const discCount = count > 12 ? 2 : 1
      const addedAt = now - Math.floor(r() * 1400) * 864e5
      for (let i = 1; i <= count; i++) {
        const plays = Math.floor(r() * r() * 90)
        const bitRate = [128, 160, 192, 256, 320][Math.floor(r() * 5)]
        const time = 95 + Math.floor(r() * 400)
        // Drawn once and used twice: the flat `format` is the preferred
        // rendition's by definition, and two draws would make the row disagree
        // with the file it claims to describe.
        const format = KINDS[Math.floor(r() * KINDS.length)]
        const bytes = Math.round((bitRate * 1000 * time) / 8)
        tracks.push({
          id: `t${++n}`,
          sourceId: 'demo',
          path: `${artist}/${album}/${i}.flac`,
          kind: 'music' as TrackKind,
          enabled: r() > 0.06,
          name: `${WORDS_A[Math.floor(r() * WORDS_A.length)]} ${WORDS_B[Math.floor(r() * WORDS_B.length)]}`,
          artist: compilation ? `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}` : artist,
          albumArtist: artist,
          album,
          genre,
          composer: `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`,
          grouping: '',
          comments: r() < 0.15 ? 'Ripped from vinyl' : '',
          year,
          trackNumber: i,
          trackCount: count,
          discNumber: discCount === 2 && i > count / 2 ? 2 : 1,
          duration: time,
          bpm: r() < 0.5 ? 0 : 70 + Math.floor(r() * 90),
          rating: r() < 0.55 ? 0 : 1 + Math.floor(r() * 5),
          playCount: plays,
          skipCount: Math.floor(r() * 4),
          dateAdded: addedAt + i * 6e4,
          lastPlayed: plays ? now - Math.floor(r() * 400) * 864e5 : null,
          bitRate,
          sampleRate: 44100,
          size: bytes,
          format,
          compilation,
          loved: r() < 0.1,
          artwork: null,
          devices: [],
          // A few tracks carry a tag, most carry none: a library where
          // everything is tagged is a library nobody has, and the filter would
          // never show the empty case it has to handle.
          tags: r() < 0.22 ? [TAGS[Math.floor(r() * TAGS.length)]] : [],
          // One file per track here. The demo does not fabricate several
          // formats of the same song: that is the conversion feature's story to
          // tell, and inventing it now would show a library nobody could have.
          renditions: [{
            id: `r${n}`,
            format,
            bitRate,
            sampleRate: 44100,
            channels: 2,
            size: bytes,
            lossless: 0 as const,
            preferred: 1 as const,
            path: `${artist}/${album}/${i}.flac`,
            sourceId: 'demo',
          }],
          rev: n,
        })
      }
    }
  }
  return tracks
}

export const fmtTime = (s: number) => {
  if (!s && s !== 0) return ''
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export const fmtSize = (b: number) =>
  b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`

export const fmtDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : ''

/** iTunes status bar: "1,234 songs, 3.2 days, 8.45 GB" */
export function summarize(tracks: Track[]) {
  const secs = tracks.reduce((a, t) => a + t.duration, 0)
  const bytes = tracks.reduce((a, t) => a + t.size, 0)
  const days = secs / 86400
  const dur =
    days >= 1
      ? `${days.toFixed(1)} days`
      : secs >= 3600
        ? `${Math.floor(secs / 3600)}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
        : fmtTime(secs)
  return `${tracks.length.toLocaleString('en-US')} songs, ${dur}, ${fmtSize(bytes)}`
}
