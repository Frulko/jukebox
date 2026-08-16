import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Converting audio.
 *
 * ffmpeg is a binary on PATH, not a dependency. The project ships zero native
 * modules on purpose, so the alternative would be bundling a fifty-megabyte
 * static build per architecture — and every platform that runs this server
 * already has ffmpeg a package manager away.
 *
 * The consequence has to be handled honestly rather than hopefully: it may not
 * be there. `tools()` answers that so the UI can disable conversion with a
 * reason, instead of queueing a job that fails once per track.
 */

export type Tools = {
  ffmpeg: string | null
  ffprobe: string | null
  /** Chromaprint. Its absence downgrades matching, it does not break it. */
  fpcalc: string | null
}

/** What an encoder needs, per target format. */
const ENCODERS: Record<string, { codec: string; ext: string; lossless: boolean; defaultQuality?: string }> = {
  mp3: { codec: 'libmp3lame', ext: 'mp3', lossless: false, defaultQuality: '320k' },
  aac: { codec: 'aac', ext: 'm4a', lossless: false, defaultQuality: '256k' },
  opus: { codec: 'libopus', ext: 'opus', lossless: false, defaultQuality: '160k' },
  alac: { codec: 'alac', ext: 'm4a', lossless: true },
  flac: { codec: 'flac', ext: 'flac', lossless: true },
  wav: { codec: 'pcm_s16le', ext: 'wav', lossless: true },
}

export const FORMATS = Object.keys(ENCODERS)

export const encoderFor = (format: string) => ENCODERS[format.toLowerCase()] ?? null

let cached: Tools | null = null

/**
 * Which tools are on PATH. Cached: this shells out three times and the answer
 * does not change while the process runs.
 */
export async function tools(refresh = false): Promise<Tools> {
  if (cached && !refresh) return cached

  const find = async (bin: string): Promise<string | null> => {
    try {
      const { stdout } = await run(bin, ['-version'], { timeout: 5000 })
      return stdout.split('\n')[0]?.trim() ?? bin
    } catch {
      return null
    }
  }
  const [ffmpeg, ffprobe, fpcalc] = await Promise.all([find('ffmpeg'), find('ffprobe'), find('fpcalc')])
  cached = { ffmpeg, ffprobe, fpcalc }
  return cached
}

/**
 * Converts one file.
 *
 * `-map 0:a:0` takes the first audio stream and nothing else. Cover art is an
 * attached picture stream, and copying it across containers fails often enough
 * that the conversion would become the unreliable part; artwork is served from
 * the track rather than from the file, so nothing on screen changes.
 *
 * `-map_metadata 0` carries the tags, which does matter: a converted file
 * landing on an iPod with no artist is worse than no converted file.
 */
export async function transcode(
  input: string,
  output: string,
  format: string,
  quality?: string,
): Promise<void> {
  const enc = encoderFor(format)
  if (!enc) throw new Error(`cannot convert to ${format}`)

  const { ffmpeg } = await tools()
  if (!ffmpeg) throw new Error('ffmpeg is not installed on this server')

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-map', '0:a:0',
    '-map_metadata', '0',
    '-c:a', enc.codec,
  ]
  // A bitrate on a lossless codec is a fatal argument error rather than a
  // no-op, so it is only ever passed where it means something.
  if (!enc.lossless) args.push('-b:a', quality || enc.defaultQuality || '256k')
  // `-y` last: overwriting is the caller's decision, and the caller writes to a
  // temporary name it owns.
  args.push('-y', output)

  try {
    await run('ffmpeg', args, { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 })
  } catch (err: any) {
    // ffmpeg says why on stderr and nowhere else. Without this the failure is
    // "Command failed", which tells nobody anything.
    const reason = String(err?.stderr ?? '').trim().split('\n').pop()
    throw new Error(reason ? `ffmpeg: ${reason}` : `ffmpeg failed converting to ${format}`)
  }
}
