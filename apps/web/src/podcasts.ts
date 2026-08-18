import type { Episode, Podcast, Track } from '@jukebox/client-sdk'

/** The publisher's host, for a line that says where the sound comes from. */
export const hostOf = (url: string) => {
  try { return new URL(url).hostname } catch { return 'the publisher' }
}

/**
 * An episode dressed as a track, for the parts of the interface that only know
 * how to show a track — the LCD, the cover, the marquee.
 *
 * The id is prefixed `ep:` deliberately: it is not a library id, and anything
 * tempted to send it to the server has to notice.
 */
export function episodeAsTrack(e: Episode, show: Podcast): Track {
  return {
    id: `ep:${e.id}`,
    sourceId: '',
    path: e.enclosureUrl ?? '',
    kind: 'podcast',
    name: e.title,
    artist: show.author || show.title,
    albumArtist: show.author || show.title,
    album: show.title,
    genre: 'Podcast',
    composer: '',
    year: e.pubDate ? new Date(e.pubDate).getFullYear() : 0,
    trackNumber: e.episodeNumber ?? 0,
    trackCount: 0,
    discNumber: e.season ?? 1,
    duration: e.duration,
    bitRate: 0,
    sampleRate: 0,
    format: (e.enclosureType || '').split('/')[1] ?? '',
    size: e.enclosureLength,
    rating: 0,
    loved: false,
    enabled: true,
    comments: '',
    grouping: '',
    bpm: 0,
    compilation: false,
    playCount: 0,
    skipCount: 0,
    dateAdded: e.pubDate ?? 0,
    lastPlayed: null,
    artwork: e.imageUrl ?? show.imageUrl,
    devices: [],
    tags: [],
    renditions: [],
    rev: 0,
  }
}

