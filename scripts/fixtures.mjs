// Builds real audio files for the tests. `ffmpeg` is already a project
// dependency for transcoding — better to use it than to commit binaries.
import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const OUT = process.argv[2] ?? './.fixtures'

const TRACKS = [
  ['Daft Punk/Discovery/01.mp3',  440, 3, 'One More Time', 'Daft Punk', 'Discovery', 1],
  ['Daft Punk/Discovery/02.mp3',  494, 2, 'Aerodynamic',   'Daft Punk', 'Discovery', 2],
  ['Daft Punk/Discovery/03.flac', 523, 2, 'Digital Love',  'Daft Punk', 'Discovery', 3],
  ['Radiohead/Kid A/01.m4a',      587, 2, 'Everything In Its Right Place', 'Radiohead', 'Kid A', 1],
]

await rm(OUT, { recursive: true, force: true })
for (const [rel, hz, sec, title, artist, album, track] of TRACKS) {
  const path = join(OUT, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `sine=frequency=${hz}:duration=${sec}`,
    '-metadata', `title=${title}`, '-metadata', `artist=${artist}`,
    '-metadata', `album=${album}`, '-metadata', `track=${track}`,
    '-metadata', 'date=2000', '-metadata', 'genre=Electronic', '-y', path])
}
console.log(`\u2713 ${TRACKS.length} files in ${OUT}`)
