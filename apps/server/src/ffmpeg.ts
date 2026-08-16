import { execFile, spawn, type ChildProcess } from 'node:child_process'
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

/**
 * The container to write when the output is a pipe.
 *
 * Not the same question as "which file extension", and this is where a
 * streaming transcode goes wrong: an `.m4a` is an MP4, MP4 needs to seek back
 * and write the index at the front, and a pipe cannot be seeked. ffmpeg says
 * "muxer does not support non seekable output" and the request dies.
 *
 * ADTS is AAC without that problem, and Ogg is the streamable Opus container.
 * ALAC has no streamable container at all here, so it is refused rather than
 * attempted.
 */
const MUXERS: Record<string, { muxer: string; mime: string } | null> = {
  mp3: { muxer: 'mp3', mime: 'audio/mpeg' },
  aac: { muxer: 'adts', mime: 'audio/aac' },
  opus: { muxer: 'ogg', mime: 'audio/ogg' },
  flac: { muxer: 'flac', mime: 'audio/flac' },
  wav: { muxer: 'wav', mime: 'audio/wav' },
  alac: null,
}

export const streamableFormats = Object.entries(MUXERS)
  .filter(([, v]) => v !== null)
  .map(([k]) => k)

export const canStreamTo = (format: string) => Boolean(MUXERS[format.toLowerCase()])

export const streamMimeFor = (format: string) => MUXERS[format.toLowerCase()]?.mime ?? 'application/octet-stream'

/**
 * Transcodes into a pipe, for a device that cannot play what the library holds.
 *
 * Returns the child rather than a promise, because the caller has to be able to
 * **kill it**. A browser that closes the tab, a speaker that drops off the
 * wifi, a `<audio>` element that switches track — each abandons a running
 * encoder, and on a Raspberry Pi three abandoned encoders is the whole machine.
 * Ownership of that process is the point of this signature.
 */
export async function transcodeStream(
  input: string,
  format: string,
  quality?: string,
  seconds = 0,
): Promise<ChildProcess> {
  const enc = encoderFor(format)
  const mux = MUXERS[format.toLowerCase()]
  if (!enc || !mux) throw new Error(`cannot stream ${format} on the fly`)

  const { ffmpeg } = await tools()
  if (!ffmpeg) throw new Error('ffmpeg is not installed on this server')

  const args = ['-hide_banner', '-loglevel', 'error']
  // Seeking before the input is the cheap form: ffmpeg jumps rather than
  // decoding everything up to that point and throwing it away.
  if (seconds > 0) args.push('-ss', String(seconds))
  args.push(
    '-i', input,
    '-map', '0:a:0',
    '-map_metadata', '0',
    '-c:a', enc.codec,
  )
  if (!enc.lossless) args.push('-b:a', quality || enc.defaultQuality || '256k')
  args.push('-f', mux.muxer, 'pipe:1')

  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })

  // stderr has to be drained even though nothing reads it: a full pipe buffer
  // blocks ffmpeg mid-encode, and the symptom is a stream that stops partway
  // through a long track for no visible reason.
  child.stderr?.resume()
  return child
}
