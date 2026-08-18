// Generated cover art. No image files: each album gets a deterministic
// composition derived from its title, so the same album always looks the same
// and a wall of covers still reads as varied. Playlists get the 2x2 quilt
// iTunes and Apple Music build out of their first four albums.
//
// The covers carry their own text, the way a generated cover does — Apple
// Music's playlist art, Spotify's "This Is…" — which is the part with the
// actual engineering in it. Text inside artwork has to wrap on words, shrink
// when a single word is longer than the cover, stop at a sensible number of
// lines, and be legible against a background chosen by a hash. All four are
// below; the fifth rule is that none of it happens on a 24-pixel thumbnail,
// where type is texture rather than words.


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

function coverStyle(seed: string): React.CSSProperties {
  const h = hash(seed)
  const hue = h % 360
  const hue2 = (hue + 25 + (h % 60)) % 360
  const angle = 100 + (h % 8) * 20
  return {
    background: `linear-gradient(${angle}deg, hsl(${hue} 62% 56%), hsl(${hue2} 55% 32%))`,
  }
}

/**
 * How wide a string is, in units of its own font size.
 *
 * Measured rather than estimated, because the whole problem with text in
 * generated artwork is the one long word: an average character width is right
 * about a sentence and wrong about "Godspeed", and the failure mode is a title
 * that runs off the side of the cover. One canvas, measured at 100px and
 * divided down, so the answer is a ratio that works at any size — and cached,
 * since a wall of covers measures the same words repeatedly.
 */
const widths = new Map<string, number>()
let ctx: CanvasRenderingContext2D | null | undefined

function widthOf(text: string, weight: number) {
  const key = `${weight}|${text}`
  const known = widths.get(key)
  if (known !== undefined) return known

  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d')
  // No canvas — a test environment, or a browser refusing it. Fall back to an
  // average that errs wide, so text shrinks rather than overflows.
  const w = ctx
    ? ((ctx.font = `${weight} 100px "Helvetica Neue", Helvetica, Arial, sans-serif`), ctx.measureText(text).width / 100)
    : text.length * 0.58
  widths.set(key, w)
  return w
}

/**
 * Break a title into lines that fit, and say what size they fit at.
 *
 * Wraps on words first. A word too long for a line on its own is what decides
 * the size: rather than cutting it — "Godsp" over "eed" is worse than small
 * type — the whole block shrinks until the longest word fits. Past the line
 * limit the last line is cut with an ellipsis, because a cover is not a place
 * to read a paragraph.
 */
function layout(text: string, { width, size, maxLines, weight }: {
  width: number
  size: number
  maxLines: number
  weight: number
}) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  if (!words.length) return { lines, size }

  // The longest single word sets the ceiling: nothing can be narrower than it.
  const longest = Math.max(...words.map((w) => widthOf(w, weight)))
  const fitted = Math.min(size, width / longest)

  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (widthOf(next, weight) * fitted <= width || !line) {
      line = next
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    let last = kept[maxLines - 1]
    while (last && widthOf(`${last}…`, weight) * fitted > width) last = last.slice(0, -1).trimEnd()
    kept[maxLines - 1] = `${last}…`
    return { lines: kept, size: fitted }
  }
  return { lines, size: fitted }
}

/** The motif layer, drawn in the same 100×100 space as the type. */
function motifs(h: number, ink: string) {
  // `>>>`, not `>>`: the hash is unsigned and half of all values have the top
  // bit set, so a signed shift turns them negative — and a negative remainder
  // indexes an array with `-2`, which is how a wall of covers becomes a blank
  // screen for half the albums in a library.
  const kind = h % PATTERNS
  const a = (h >>> 3) % 100
  const b = (h >>> 7) % 100
  const light = 'rgba(255,255,255,.24)'
  const dark = 'rgba(0,0,0,.22)'
  void ink

  if (kind === 0) {
    return (
      <>
        <circle cx={30 + a * 0.4} cy={38} r={30} fill={light} />
        <circle cx={30 + a * 0.4} cy={38} r={16} fill={dark} />
      </>
    )
  }
  if (kind === 1) {
    return (
      <>
        <rect x="0" y={50 + b * 0.2} width="100" height="8" fill={light} />
        <rect x="0" y={66 + b * 0.2} width="100" height="4" fill={light} />
        <rect x="0" y={76 + b * 0.2} width="100" height="2" fill={dark} />
      </>
    )
  }
  if (kind === 2) return <polygon points={`50,${8 + a * 0.2} 96,92 4,92`} fill={light} />
  if (kind === 3) {
    return (
      <>
        <rect x={10 + a * 0.3} y="0" width="14" height="100" fill={light} />
        <rect x={44 + b * 0.3} y="0" width="7" height="100" fill={dark} />
      </>
    )
  }
  if (kind === 4) {
    return (
      <>
        <circle cx="78" cy="24" r="20" fill={light} />
        <path d="M0 100 L46 34 L100 100 Z" fill={dark} />
      </>
    )
  }
  return (
    <>
      <rect x="14" y="14" width="72" height="72" fill="none" stroke={light} strokeWidth="7" />
      <rect x={32 + a * 0.1} y="32" width="36" height="36" fill={dark} />
    </>
  )
}

/** Where the type sits, and how loud it is. Four arrangements, picked by hash. */
const LAYOUTS = [
  { align: 'start' as const, x: 9, from: 'bottom' as const, size: 14, caps: false },
  { align: 'middle' as const, x: 50, from: 'middle' as const, size: 15, caps: false },
  { align: 'start' as const, x: 9, from: 'top' as const, size: 12, caps: true },
  { align: 'start' as const, x: 9, from: 'bottom' as const, size: 11, caps: false },
]

export function Cover({
  seed,
  size,
  label,
  sublabel,
  className = '',
}: {
  seed: string
  size: number
  /** Printed on the art itself, above ~64px — the way a generated cover works. */
  label?: string
  /** The artist, under the title, when there is room for both. */
  sublabel?: string
  className?: string
}) {
  const h = hash(seed)
  const hue = h % 360
  const hue2 = (hue + 25 + (h % 60)) % 360
  const angle = 100 + (h % 8) * 20
  // The gradient runs dark at one end, so type is white with a shadow rather
  // than a colour computed per corner — one rule that holds for every hue
  // instead of one that holds for most of them.
  const rad = (angle * Math.PI) / 180
  const x2 = (50 + Math.cos(rad) * 50) / 100
  const y2 = (50 + Math.sin(rad) * 50) / 100

  const id = `cv${h.toString(36)}`
  const withText = !!label && size >= 64
  const plan = LAYOUTS[(h >>> 11) % LAYOUTS.length]

  const title = withText
    ? layout(plan.caps ? label!.toUpperCase() : label!, {
        width: plan.align === 'middle' ? 82 : 82,
        size: plan.size,
        maxLines: size >= 120 ? 3 : 2,
        weight: 700,
      })
    : { lines: [], size: 0 }
  const sub = withText && sublabel && size >= 120
    ? layout(sublabel.toUpperCase(), { width: 82, size: 6, maxLines: 1, weight: 600 })
    : { lines: [], size: 0 }

  // Vertical placement, from the block's own height rather than from a guess:
  // three lines and one line are not the same shape, and a title that hangs off
  // the bottom edge is the failure this replaces.
  const lead = 1.12
  const blockH = title.lines.length * title.size * lead + (sub.lines.length ? sub.size * 1.6 : 0)
  const top =
    plan.from === 'bottom' ? 92 - blockH
      : plan.from === 'top' ? 14
        : 50 - blockH / 2 + title.size * 0.8

  return (
    <div className={`cover ${className}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="cover-art" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2={x2} y2={y2}>
            <stop offset="0%" stopColor={`hsl(${hue} 62% 56%)`} />
            <stop offset="100%" stopColor={`hsl(${hue2} 55% 32%)`} />
          </linearGradient>
        </defs>
        <rect width="100" height="100" fill={`url(#${id})`} />
        {motifs(h, '#fff')}

        {withText && (
          <>
            {/* A scrim that fades rather than a band that ends.
                White type has to hold against a pale corner of a gradient, and
                the flat rectangle that does it reads as a bug — a visible edge
                across the artwork. This is the same darkening with its edges
                given away, which is what every generated cover does. */}
            <defs>
              <linearGradient id={`${id}s`} x1="0" y1={plan.from === 'top' ? '1' : '0'} x2="0" y2={plan.from === 'top' ? '0' : '1'}>
                <stop offset="0%" stopColor="rgba(0,0,0,0)" />
                <stop offset="45%" stopColor="rgba(0,0,0,.30)" />
                <stop offset="100%" stopColor="rgba(0,0,0,.46)" />
              </linearGradient>
            </defs>
            <rect
              x="0"
              y={plan.from === 'top' ? 0 : Math.max(0, top - title.size * 2.4)}
              width="100"
              height={plan.from === 'top' ? Math.min(100, blockH + title.size * 2.6) : Math.min(100, 100 - Math.max(0, top - title.size * 2.4))}
              fill={`url(#${id}s)`}
            />
            {title.lines.map((line, i) => (
              <text
                key={i}
                x={plan.x}
                y={top + i * title.size * lead}
                fill="#fff"
                fontSize={title.size}
                fontWeight="700"
                textAnchor={plan.align}
                letterSpacing={plan.caps ? '0.08em' : '-0.01em'}
              >
                {line}
              </text>
            ))}
            {sub.lines.map((line, i) => (
              <text
                key={`s${i}`}
                x={plan.x}
                y={top + title.lines.length * title.size * lead + sub.size * 0.9}
                fill="rgba(255,255,255,.82)"
                fontSize={sub.size}
                fontWeight="600"
                textAnchor={plan.align}
                letterSpacing="0.14em"
              >
                {line}
              </text>
            ))}
          </>
        )}
      </svg>
    </div>
  )
}

/**
 * The iTunes 2x2 quilt. It is derived from a seed rather than the real
 * contents: fetching every playlist's tracks just to draw a 16px thumbnail
 * would be one request per playlist on every sidebar render.
 */
export function PlaylistCover({
  seed,
  size,
  label,
  className = '',
}: {
  seed: string
  size: number
  /** The playlist's name, printed across the quilt when it is big enough. */
  label?: string
  className?: string
}) {
  const quarters = [0, 1, 2, 3].map((i) => `${seed}#${i}`)
  const withText = !!label && size >= 96
  const title = withText
    ? layout(label!.toUpperCase(), { width: 84, size: 11, maxLines: 3, weight: 700 })
    : { lines: [], size: 0 }
  const lead = 1.15
  const top = 50 - (title.lines.length * title.size * lead) / 2 + title.size * 0.75

  return (
    <div className={`cover quilt ${className}`} style={{ width: size, height: size }}>
      {quarters.map((q) => (
        <div key={q} className="quilt-cell" style={coverStyle(q)} />
      ))}
      {withText && (
        <svg viewBox="0 0 100 100" className="cover-art quilt-type" aria-hidden="true">
          {/* Across the seam rather than inside one quarter: a playlist is the
              four of them together, and type centred over the join is what says
              so. */}
          <rect x="0" y={top - title.size} width="100" height={title.lines.length * title.size * lead + title.size * 0.6} fill="rgba(0,0,0,.34)" />
          {title.lines.map((line, i) => (
            <text
              key={i}
              x="50"
              y={top + i * title.size * lead}
              fill="#fff"
              fontSize={title.size}
              fontWeight="700"
              textAnchor="middle"
              letterSpacing="0.06em"
            >
              {line}
            </text>
          ))}
        </svg>
      )}
    </div>
  )
}

