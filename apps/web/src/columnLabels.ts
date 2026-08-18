export const COLUMN_LABELS = {
  checked: '✓', index: '#', status: 'Status', name: 'Name', time: 'Time', artist: 'Artist', album: 'Album',
  genre: 'Genre', rating: 'Rating', playCount: 'Plays', year: 'Year', trackNumber: 'Track Number',
  discNumber: 'Disc Number', albumArtist: 'Album Artist', composer: 'Composer', grouping: 'Grouping',
  comments: 'Comments', bpm: 'BPM', kind: 'Kind', format: 'Format', size: 'Size', bitRate: 'Bit Rate',
  sampleRate: 'Sample Rate', dateAdded: 'Date Added', lastPlayed: 'Last Played', skipCount: 'Skips',
  devices: 'On device', tags: 'Tags',
}

/**
 * Column ids reach the table as plain strings — from persisted layouts, from
 * TanStack's own state — so the one lookup lives here rather than opening
 * COLUMN_LABELS' keys up to any string. Unknown ids fall back to themselves,
 * which is also what the header renderer wants.
 */
export function columnLabel(id: string): string {
  // SAFETY: the `in` check proves `id` is one of COLUMN_LABELS' own keys; TS
  // just cannot narrow a plain string through it.
  return id in COLUMN_LABELS ? COLUMN_LABELS[id as keyof typeof COLUMN_LABELS] : id
}

