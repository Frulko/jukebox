import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration, parseFeed } from '../src/feed.ts'

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>The Show</title>
    <description><![CDATA[A show about <b>things</b> &amp; stuff]]></description>
    <link>https://example.com</link>
    <itunes:author>Someone</itunes:author>
    <itunes:image href="https://example.com/cover.jpg"/>
    <item>
      <title>Episode Two</title>
      <guid isPermaLink="false">ep-002</guid>
      <pubDate>Tue, 11 Aug 2026 09:00:00 GMT</pubDate>
      <itunes:duration>1:02:03</itunes:duration>
      <itunes:episode>2</itunes:episode>
      <itunes:season>3</itunes:season>
      <enclosure url="https://cdn.example.com/2.mp3" length="48123456" type="audio/mpeg"/>
      <description><![CDATA[<p>Show notes</p>]]></description>
    </item>
    <item>
      <title>Episode One</title>
      <guid>ep-001</guid>
      <pubDate>Mon, 04 Aug 2026 09:00:00 GMT</pubDate>
      <itunes:duration>2431</itunes:duration>
      <enclosure url="https://cdn.example.com/1.mp3" length="30000000" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`

test('a feed yields its channel and its episodes', () => {
  const feed = parseFeed(FEED)
  assert.ok(feed)
  assert.equal(feed.title, 'The Show')
  assert.equal(feed.author, 'Someone')
  assert.equal(feed.imageUrl, 'https://example.com/cover.jpg')
  assert.equal(feed.siteUrl, 'https://example.com')
  // CDATA and entities come through decoded, not as raw markup.
  assert.match(feed.description, /A show about/)
  assert.equal(feed.episodes.length, 2)
})

test('an episode carries what is needed to download and sort it', () => {
  const [two, one] = parseFeed(FEED)!.episodes
  assert.equal(two.guid, 'ep-002')
  assert.equal(two.title, 'Episode Two')
  assert.equal(two.enclosureUrl, 'https://cdn.example.com/2.mp3')
  assert.equal(two.enclosureLength, 48123456)
  assert.equal(two.enclosureType, 'audio/mpeg')
  assert.equal(two.duration, 3723, 'hh:mm:ss')
  assert.equal(two.episodeNumber, 2)
  assert.equal(two.season, 3)
  assert.equal(two.pubDate, Date.parse('Tue, 11 Aug 2026 09:00:00 GMT'))
  assert.equal(one.duration, 2431, 'plain seconds')
  assert.equal(one.season, null, 'absent, not zero')
})

test('a guid that looks like a number stays a string', () => {
  // Parsed as a number it would stop matching the string stored last time, and
  // every refresh would re-import the same episode as new.
  const xml = FEED.replace('<guid>ep-001</guid>', '<guid>123456</guid>')
  const ep = parseFeed(xml)!.episodes.find((e) => e.title === 'Episode One')!
  assert.equal(ep.guid, '123456')
  assert.equal(typeof ep.guid, 'string')
})

test('an episode with no guid falls back to its enclosure URL', () => {
  const xml = FEED.replace('<guid isPermaLink="false">ep-002</guid>', '')
  const ep = parseFeed(xml)!.episodes[0]
  assert.equal(ep.guid, 'https://cdn.example.com/2.mp3')
})

test('a single-item feed is still a list', () => {
  // The parser hands back a bare object rather than an array when there is one
  // item — the classic way a one-episode feed reads as zero episodes.
  const xml = FEED.replace(/<item>\s*<title>Episode One<\/title>[\s\S]*?<\/item>/, '')
  const feed = parseFeed(xml)!
  assert.equal(feed.episodes.length, 1)
  assert.equal(feed.episodes[0].guid, 'ep-002')
})

test('what is not a feed is rejected rather than yielding an empty one', () => {
  assert.equal(parseFeed('<html><body>404</body></html>'), null)
  assert.equal(parseFeed('not xml at all <<<'), null)
  assert.equal(parseFeed(''), null)
})

test('durations come in three shapes, and anything else is zero not NaN', () => {
  assert.equal(parseDuration('3723'), 3723)
  assert.equal(parseDuration('62:03'), 3723)
  assert.equal(parseDuration('1:02:03'), 3723)
  assert.equal(parseDuration(''), 0)
  assert.equal(parseDuration('about an hour'), 0)
  // A NaN here would poison every sort and every duration column it reaches.
  assert.ok(Number.isFinite(parseDuration('nonsense:bad')))
})
