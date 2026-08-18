import type { Track } from './data'

/** One seed per sleeve: the artwork quilt and every cover derive from it. */
export const albumSeed = (t: Track) => `${t.albumArtist} — ${t.album}`
