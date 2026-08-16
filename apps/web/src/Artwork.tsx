// Generated cover art. No image files: each album gets a deterministic gradient +
// geometric composition derived from its title, so the same album always looks the
// same and a wall of covers still reads as varied. Playlists get the 2x2 quilt
// iTunes/Apple Music build out of their first four albums.

import type { Track } from './data'

/** Stable 32-bit hash so art survives reloads and never depends on array order. */
function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const PATTERNS = 6

export function coverStyle(seed: string): React.CSSProperties {
  const h = hash(seed)
  const hue = h % 360
  const hue2 = (hue + 25 + (h % 60)) % 360
  const angle = 100 + (h % 8) * 20
  return {
    background: `linear-gradient(${angle}deg, hsl(${hue} 62% 56%), hsl(${hue2} 55% 32%))`,
  }
}

/** The shape layer, drawn as an SVG so it scales from 24px to 220px cleanly. */
function Pattern({ seed }: { seed: string }) {
  const h = hash(seed)
  const kind = h % PATTERNS
  const a = (h >> 3) % 100
  const b = (h >> 7) % 100
  const light = 'rgba(255,255,255,.24)'
  const dark = 'rgba(0,0,0,.22)'

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="cover-pattern" aria-hidden="true">
      {kind === 0 && (
        <>
          <circle cx={30 + a * 0.4} cy={38} r={30} fill={light} />
          <circle cx={30 + a * 0.4} cy={38} r={16} fill={dark} />
        </>
      )}
      {kind === 1 && (
        <>
          <rect x="0" y={50 + b * 0.2} width="100" height="8" fill={light} />
          <rect x="0" y={66 + b * 0.2} width="100" height="4" fill={light} />
          <rect x="0" y={76 + b * 0.2} width="100" height="2" fill={dark} />
        </>
      )}
      {kind === 2 && <polygon points={`50,${8 + a * 0.2} 96,92 4,92`} fill={light} />}
      {kind === 3 && (
        <>
          <rect x={10 + a * 0.3} y="0" width="14" height="100" fill={light} />
          <rect x={44 + b * 0.3} y="0" width="7" height="100" fill={dark} />
        </>
      )}
      {kind === 4 && (
        <>
          <circle cx="78" cy="24" r="20" fill={light} />
          <path d="M0 100 L46 34 L100 100 Z" fill={dark} />
        </>
      )}
      {kind === 5 && (
        <>
          <rect x="14" y="14" width="72" height="72" fill="none" stroke={light} strokeWidth="7" />
          <rect x={32 + a * 0.1} y="32" width="36" height="36" fill={dark} />
        </>
      )}
    </svg>
  )
}

export function Cover({
  seed,
  size,
  label,
  className = '',
}: {
  seed: string
  size: number
  /** Shown over the art above ~64px, the way generated covers print their title. */
  label?: string
  className?: string
}) {
  return (
    <div className={`cover ${className}`} style={{ ...coverStyle(seed), width: size, height: size }}>
      <Pattern seed={seed} />
      {label && size >= 64 && <span className="cover-label">{label}</span>}
    </div>
  )
}

/**
 * The iTunes 2x2 quilt. It is derived from a seed rather than the real
 * contents: fetching every playlist's tracks just to draw a 16px thumbnail
 * would be one request per playlist on every sidebar render.
 */
export function PlaylistCover({ seed, size, className = '' }: { seed: string; size: number; className?: string }) {
  const quarters = [0, 1, 2, 3].map((i) => `${seed}#${i}`)
  return (
    <div className={`cover quilt ${className}`} style={{ width: size, height: size }}>
      {quarters.map((q) => (
        <div key={q} className="quilt-cell" style={coverStyle(q)}>
          <Pattern seed={q} />
        </div>
      ))}
    </div>
  )
}

export const albumSeed = (t: Track) => `${t.albumArtist} — ${t.album}`
