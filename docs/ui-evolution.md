---
title: UI evolution
description: iTunes 8 → iTunes 12 → Apple Music, then Studio — the spec behind the four themes.
---

Reference notes for the prototype's themes. A theme is not just a palette:
navigation, density and the relationship to artwork all change from one era to
the next. This document is the spec for the themes.

## Overview

| | **iTunes 8–11** (2008-2013) | **iTunes 12** (2014-2019) | **Music.app** (2019→) |
|---|---|---|---|
| Chrome | Gradients, aqua, inset LCD | Flat, white, red accent | Flat, dark by default, red accent |
| Navigation | Permanent source list, everything at the same level | Media picker + top-center tabs + sidebar for Playlists only | Everything in the sidebar, a single column |
| Sub-navigation | Column browser (Genre / Artist / Album) | Songs / Albums / Artists / Genres / Composers tabs | Sidebar entries: Listen Now, Browse, Radio, then Recently Added / Artists / Albums / Songs |
| Listing | Dense table, ~17 px, checkboxes, stars | ~21 px table, artwork in the Name column, checkboxes gone | ~26 px table, artwork everywhere, rounded pill selection |
| Artwork | Marginal (Cover Flow aside) | Album grid front and center | Omnipresent, rounded, shadowed, play button on hover |
| Rating | 1-5 stars | Stars (hidden by default) | Love / Dislike |
| Density | Maximal, everything is information | In between | Airy, the artwork carries the information |

## The three moments

### iTunes 8–11 — peak density

The source list lists everything: libraries, Store, devices, playlists. The
**column browser** filters Genre → Artist → Album in cascade above the table.
Every row shows an "enabled" checkbox, a row of stars, the play count. The
aesthetic is Aqua's: gradients, 1 px borders, engraved text (white 1 px
`text-shadow`). The player is an LCD inset in the middle of the chrome, with 34 px
artwork, bold title, artist — album, and an inset scrubber.

### iTunes 12 — the flattening

The sidebar is hidden by default; you navigate through a **media picker** (a
Music / Movies / TV Shows dropdown) and a row of **tabs** at the top center.
12.4 brings back a persistent sidebar after the protests, with the media picker
right above it. The Songs / Albums / Artists views become the normal way to
browse: the album grid, with large artwork, replaces the column browser. Every
gradient disappears, and the accent becomes Apple Music red/pink.

### Music.app — everything in the sidebar

Catalina kills iTunes and splits the media into three apps. All navigation moves
back into a **single left column**: Listen Now, Browse, Radio, then the library
(Recently Added, Artists, Albums, Songs) then the playlists — removing the
back-and-forth iTunes 12 had between tabs and sidebar. Density drops, and artwork
becomes the basic visual unit: rounded grids, a thumbnail in every row, a
generated 2×2 quilt for playlists without an image.

## Studio — leaving the lineage

The three above are archaeology: they reconstruct what Apple shipped. **Studio**
is the first skin that answers to nothing but the app, and it borrows from where
music software actually went after Catalina — Spotify's desktop client, Plexamp,
Navidrome's newer web clients.

What it takes from the current consensus, and why:

- **The transport moves to the bottom.** This is the layout every streaming
  client converged on: library on the left, content in the middle, and a bar
  across the full width at the bottom holding what is playing. The player is
  still rendered *first* in the DOM — where it belongs for the keyboard and for
  a screen reader — and the three children of the shell are reordered with flex
  `order`. No component knows about it.
- **A canvas, not a window.** The other three fill one framed rectangle. Studio
  puts the sidebar and the content on a near-black canvas as separate rounded
  panels with a gap between them. The panel edges do the work borders used to.
- **An elevation ladder.** Canvas `#0a0b0e` → content `#0d0f13` → sidebar
  `#101217` → popovers `#171a21`. A surface is higher because it is lighter, not
  because it is outlined. Flat dark themes lose their hierarchy the moment two
  panels touch; this is the fix that stuck.
- **No glass.** A blurred now-playing card was the first thing tried and the
  first thing cut: it is the decoration a dark theme reaches for when it has
  nothing to say. The panels are opaque, the separation comes from the gap
  between them.
- **One saturated colour, used four times.** The playing row, the scrubber under
  the cursor, the active mode and focus. Selection is a grey fill and the stars
  are a light grey: tinting those too turned the table into a wall of green, and
  an accent that is everywhere marks nothing. The play button is the single
  filled control, in white, so the eye finds it without hunting.
- **Bigger targets.** 30 px rows, 32 px sidebar entries, 8 px radii, pill
  controls. Density was iTunes 8's argument; it is not this one's.

It is not a repaint. Because every structural branch is keyed off
`theme !== 'classic'`, Studio inherits the mode tabs, the album and artist grids
and the row artwork for free — the skin changes the *shape* of the app, not only
its colours, which is the whole reason the theme system is not a stylesheet
swap.

| | **Music.app** | **Studio** |
|---|---|---|
| Player | Top bar, LCD in the middle | Full-width bar at the bottom |
| Ground | One window, black | Canvas, panels floating on it |
| Hierarchy | Borders + fills | Elevation and shadow |
| Accent | Apple red | One green |
| Rows | 26 px, pill selection | 30 px, grey fill; the playing row is marked in the margin |
| Radius | 6 px | 8 px controls, 12 px panels |
| Type | SF Pro, 12 px | Inter, 12.5 px, uppercase micro-heads |

## What the prototype implements

- **CSS tokens** (`itunes.css`): each theme only redefines variables — colors,
  gradients, `--row-h`, `--row-radius`, font. No component is conditioned on a
  theme for its *style*.
- **Structural differences**, on the other hand, are explicit in `App.tsx`:
  - `classic` → column browser, no mode tabs.
  - `itunes12` / `music` → Songs / Albums / Artists tab bar, no column browser,
    artwork thumbnail in the Name column.
  - `music` / `studio` → generated playlist quilt in the sidebar, tall rows,
    rounded selection, row hover.
  - `studio` → the frame itself changes: the shell becomes a canvas, the sidebar
    and content become floating panels, and the player is reordered to the
    bottom.
- **Row height crosses the CSS/JS boundary.** `THEME_ROW_H` must track `--row-h`
  in the matching theme block, because the virtualiser positions rows from the
  number and the browser draws them from the token. They also have to be
  re-measured when the theme changes: TanStack Virtual caches its measurements
  and a new `estimateSize` does not invalidate them, so before the fix every
  theme switch left the rows on the *previous* pitch — a 30 px row in a 21 px
  slot, its hover and selection band spilling onto the rows above and below.
- **Generated artwork** (`Artwork.tsx`): FNV-1a hash of the artist—album pair →
  hue, angle and one of six geometric patterns. Deterministic, so an album keeps
  its artwork from one reload to the next. Playlists reuse iTunes' 2×2 quilt,
  built from their first four distinct albums.

## Not aligned yet

- Apple Music's `Listen Now` / `Browse` / `Radio` (editorial sections).
- iTunes 12's media picker dropdown (the prototype keeps the permanent sidebar).
- The album detail panel opens at the bottom of the grid, whereas iTunes inserts
  it right under the clicked row.
- Love / Dislike on the `music` theme (stars are still everywhere).

## Sources

- [Examining iTunes 12's New Interface — TidBITS](https://tidbits.com/2014/10/20/examining-itunes-12s-new-interface/)
- [Master the media views in iTunes 12 — Macworld](https://www.macworld.com/article/226144/master-the-media-views-in-itunes-12.html)
- [iTunes 12.4 to include new sidebar — AppleInsider](https://appleinsider.com/articles/16/05/08/itunes-124-to-reportedly-include-new-sidebar-minor-ui-tweaks)
- [After iTunes: macOS Catalina and the New Media Apps — Kirkville](https://kirkville.com/macos-catalina-and-the-new-media-apps-aka-after-itunes/)
- [macOS Catalina: The MacStories Review](https://www.macstories.net/stories/macos-catalina-the-macstories-review/4/)
- [Apple previews macOS Catalina — Apple Newsroom](https://www.apple.com/newsroom/2019/06/apple-previews-macos-catalina/)
