import { XMLParser } from 'fast-xml-parser'

/**
 * Reading a podcast feed.
 *
 * Parsing is delegated: podcast RSS in the wild carries CDATA, three competing
 * namespaces, HTML inside descriptions and entities in every field. A regex
 * scanner handles the first ten feeds and fails on the eleventh, and the
 * failure looks like an episode quietly missing rather than an error.
 *
 * What is *not* delegated is the interpretation, because that is where feeds
 * disagree: what identifies an episode, what a duration means, which of four
 * possible tags holds the artwork.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Every text node comes back as a string. Otherwise a guid of "123456" is
  // parsed as a number and stops matching the string stored last time, and the
  // same episode is re-imported on every refresh.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

export type FeedEpisode = {
  guid: string
  title: string
  description: string
  pubDate: number | null
  duration: number
  episodeNumber: number | null
  season: number | null
  enclosureUrl: string | null
  enclosureLength: number
  enclosureType: string
  imageUrl: string | null
}

export type Feed = {
  title: string
  description: string
  author: string
  imageUrl: string | null
  siteUrl: string | null
  episodes: FeedEpisode[]
}

/** First non-empty value among several possible tags. Feeds disagree constantly. */
const pick = (...vals: unknown[]): string => {
  for (const v of vals) {
    const s = text(v)
    if (s) return s
  }
  return ''
}

/**
 * The text of a node, whatever shape the parser gave it.
 *
 * `<title>x</title>` is a string, `<title foo="1">x</title>` is an object with
 * a `#text` key, and an empty tag is an empty object. All three appear in real
 * feeds, sometimes in the same one.
 */
function text(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return text(v[0])
  if (typeof v === 'object' && '#text' in (v as any)) return text((v as any)['#text'])
  return ''
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])

/**
 * `itunes:duration` in the three forms feeds actually use: seconds, `mm:ss`,
 * and `hh:mm:ss`. Anything else is 0 rather than NaN — a duration is cosmetic,
 * and a NaN would poison the sort and the display.
 */
export function parseDuration(raw: string): number {
  const s = raw.trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').map((p) => Number(p))
  if (parts.some((p) => !Number.isFinite(p))) return 0
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

const parseDate = (raw: string): number | null => {
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : null
}

/** Parses an RSS 2.0 podcast feed. Returns `null` if it is not one. */
export function parseFeed(xml: string): Feed | null {
  let doc: any
  try {
    doc = parser.parse(xml)
  } catch {
    return null
  }
  const channel = doc?.rss?.channel
  if (!channel) return null

  const episodes: FeedEpisode[] = []
  for (const item of asArray<any>(channel.item)) {
    const enclosure = Array.isArray(item.enclosure) ? item.enclosure[0] : item.enclosure
    const url = enclosure?.['@url'] ?? null

    // The guid identifies the episode; the URL does not. A feed moving to a new
    // CDN rewrites every enclosure URL while keeping its guids, and keying on
    // the URL would re-import the entire back catalogue as new episodes.
    const guid = pick(item.guid) || url || pick(item.title)
    if (!guid) continue

    episodes.push({
      guid,
      title: pick(item.title, item['itunes:title']),
      description: pick(item.description, item['itunes:summary'], item['content:encoded']),
      pubDate: parseDate(pick(item.pubDate)),
      duration: parseDuration(pick(item['itunes:duration'])),
      episodeNumber: Number(pick(item['itunes:episode'])) || null,
      season: Number(pick(item['itunes:season'])) || null,
      enclosureUrl: url,
      enclosureLength: Number(enclosure?.['@length']) || 0,
      enclosureType: enclosure?.['@type'] ?? '',
      imageUrl: item['itunes:image']?.['@href'] ?? null,
    })
  }

  return {
    title: pick(channel.title, channel['itunes:title']),
    description: pick(channel.description, channel['itunes:summary']),
    author: pick(channel['itunes:author'], channel.managingEditor),
    // Four places artwork hides, in descending order of how often it is right.
    imageUrl: channel['itunes:image']?.['@href'] ?? (text(channel.image?.url) || null),
    siteUrl: pick(channel.link) || null,
    episodes,
  }
}
