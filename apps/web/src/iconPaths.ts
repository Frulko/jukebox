// One monochrome SVG set for the whole app. Emoji were rendering in colour from
// Apple Color Emoji while the rest of the chrome was greyscale — nothing lines up
// when half the icons come from a different font. These inherit `currentColor`,
// so an icon on a selected blue row turns white for free.

export const PATHS = {
  music: 'M13.6 1.4 5.8 3v7.7a2.2 2.2 0 1 0 1.4 2V5.6l5-1v5.3a2.2 2.2 0 1 0 1.4 2z',
  movie:
    'M1.6 3h12.8a.6.6 0 0 1 .6.6v8.8a.6.6 0 0 1-.6.6H1.6a.6.6 0 0 1-.6-.6V3.6a.6.6 0 0 1 .6-.6zm1 1.4v1.7h2.1V4.4zm0 3v1.7h2.1V7.4zm0 3v1.7h2.1v-1.7zm7.7-6v1.7h2.1V4.4zm0 3v1.7h2.1V7.4zm0 3v1.7h2.1v-1.7z',
  tv: 'M1.8 2.6h12.4a.8.8 0 0 1 .8.8v7.2a.8.8 0 0 1-.8.8H1.8a.8.8 0 0 1-.8-.8V3.4a.8.8 0 0 1 .8-.8zm3 10h6.4v1.3H4.8z',
  podcast:
    'M8 1.2a2.1 2.1 0 0 1 2.1 2.1v4.2a2.1 2.1 0 1 1-4.2 0V3.3A2.1 2.1 0 0 1 8 1.2zM3.9 7a.7.7 0 0 1 1.4 0 2.7 2.7 0 0 0 5.4 0 .7.7 0 0 1 1.4 0 4.1 4.1 0 0 1-3.4 4v1.8h1.7a.7.7 0 0 1 0 1.4H5.6a.7.7 0 0 1 0-1.4h1.7v-1.8A4.1 4.1 0 0 1 3.9 7z',
  book: 'M1.4 2.4h4.4c1 0 1.7.3 2.2.9v9.4c-.5-.5-1.2-.8-2.2-.8H1.4zm13.2 0h-4.4c-1 0-1.7.3-2.2.9v9.4c.5-.5 1.2-.8 2.2-.8h4.4z',
  apps: 'M2 2.2h5v5H2zm7 0h5v5H9zm-7 7h5v5H2zm7 0h5v5H9z',
  radio:
    'M8 5.9a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8zM7.2 9.4h1.6L10.4 15H8.9L8 12.2 7.1 15H5.6zM4.1 2l1 1a4.6 4.6 0 0 0 0 6.5l-1 1a6 6 0 0 1 0-8.5zm7.8 0a6 6 0 0 1 0 8.5l-1-1a4.6 4.6 0 0 0 0-6.5z',
  store:
    'M5.1 4.2v-.6a2.9 2.9 0 0 1 5.8 0v.6h2.3l.7 9.2a1 1 0 0 1-1 1.1H3.1a1 1 0 0 1-1-1.1l.7-9.2zm1.4 0h3v-.6a1.5 1.5 0 0 0-3 0z',
  cloud: 'M4.8 12.6A3.7 3.7 0 0 1 4.5 5.3a4.5 4.5 0 0 1 8.4 1.4 3.1 3.1 0 0 1-.6 5.9z',
  gear:
    'M8 1.2 9.3 3l2-.6.5 2 2 .5-.6 2 1.7 1.3-1.7 1.3.6 2-2 .5-.5 2-2-.6L8 14.8 6.7 13l-2 .6-.5-2-2-.5.6-2L1.1 7.8l1.7-1.3-.6-2 2-.5.5-2 2 .6zM8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z',
  search:
    'M6.6 1.3a5.3 5.3 0 0 1 4.2 8.5l3.6 3.6-1.3 1.3-3.6-3.6A5.3 5.3 0 1 1 6.6 1.3zm0 1.7a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z',
  volumeLow: 'M7.4 3 4.4 5.6H1.8v4.8h2.6l3 2.6zm2 2.9a3.2 3.2 0 0 1 0 4.2l1 1a4.6 4.6 0 0 0 0-6.2z',
  volumeHigh:
    'M7.4 3 4.4 5.6H1.8v4.8h2.6l3 2.6zm2 2.9a3.2 3.2 0 0 1 0 4.2l1 1a4.6 4.6 0 0 0 0-6.2zm2.1-2.2a6.3 6.3 0 0 1 0 8.6l1 1a7.7 7.7 0 0 0 0-10.6z',
  play: 'M4.6 2.6 13.2 8l-8.6 5.4z',
  pause: 'M4.2 2.8h2.7v10.4H4.2zm4.9 0h2.7v10.4H9.1z',
  prev: 'M3.4 2.8h2.1v10.4H3.4zm9.6 0v10.4L5.8 8z',
  next: 'M10.5 2.8h2.1v10.4h-2.1zM3 2.8 10.2 8 3 13.2z',
  shuffle:
    'M9.9 2.4 14 4.9l-4.1 2.5V6.1H8.6c-.8 0-1.4.3-1.9 1l-3 3.8c-.8 1-1.7 1.5-3 1.5H0v-1.7h.7c.6 0 1-.2 1.4-.7l3-3.8c.8-1 1.8-1.5 3.1-1.5h1.7zM0 3.6h.7c1.3 0 2.3.5 3.1 1.5l.7.9-1.1 1.4-.8-1c-.4-.5-.8-.8-1.4-.8H0zm9.9 5.1 4.1 2.5-4.1 2.5v-1.3H8.6c-1.3 0-2.3-.5-3.1-1.5l-.7-.9L5.9 9l.8 1c.5.5.9.7 1.5.7h1.7z',
  repeat:
    'M4.7 2.9h6.6a3.1 3.1 0 0 1 3.1 3.1v1.7h-1.8V6c0-.7-.6-1.3-1.3-1.3H4.7v1.8L.9 3.8 4.7 1.1zM1.6 8.3v1.7c0 1.7 1.4 3.1 3.1 3.1h6.6v1.8l3.8-2.7-3.8-2.7v1.8H4.7c-.7 0-1.3-.6-1.3-1.3V8.3z',
  columns: 'M1 2.8h4v10.4H1zm5.5 0h3v10.4h-3zm4.5 0h4v10.4h-4z',
  plus: 'M7.1 2h1.8v5.1H14v1.8H8.9V14H7.1V8.9H2V7.1h5.1z',
  star: 'M8 1.4 10 5.5l4.5.7-3.3 3.2.8 4.5L8 11.7l-4 2.2.8-4.5L1.5 6.2 6 5.5z',
  close: 'M8 6.6 11.5 3 13 4.5 9.4 8l3.6 3.5-1.5 1.5L8 9.4 4.5 13 3 11.5 6.6 8 3 4.5 4.5 3z',
  ipod: 'M4.4 1h7.2a1.4 1.4 0 0 1 1.4 1.4v11.2a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 13.6V2.4A1.4 1.4 0 0 1 4.4 1zm.4 1.6v3.6h6.4V2.6zM8 7.6a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zm0 1.7a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z',
  'shuffle-device':
    'M3.4 3.2h9.2a1.3 1.3 0 0 1 1.3 1.3v7a1.3 1.3 0 0 1-1.3 1.3H3.4a1.3 1.3 0 0 1-1.3-1.3v-7a1.3 1.3 0 0 1 1.3-1.3zM8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zm0 1.7a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z',
  iphone:
    'M4.6 1h6.8a1.3 1.3 0 0 1 1.3 1.3v11.4a1.3 1.3 0 0 1-1.3 1.3H4.6a1.3 1.3 0 0 1-1.3-1.3V2.3A1.3 1.3 0 0 1 4.6 1zm2.1 1.3v.5h2.6v-.5zM4.7 4.2v7.6h6.6V4.2zM8 12.5a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z',
  sync: 'M8 1.5a6.5 6.5 0 0 1 5.7 3.4l1.4-1.4V8h-4.6l1.8-1.8A4.8 4.8 0 0 0 3.2 8H1.5A6.5 6.5 0 0 1 8 1.5zm0 13A6.5 6.5 0 0 1 2.3 11l-1.4 1.4V8h4.6l-1.8 1.8A4.8 4.8 0 0 0 12.8 8h1.7A6.5 6.5 0 0 1 8 14.5z',
  backup:
    'M8 1.6 12 6H9.4v4.2H6.6V6H4zM2 11.4h12a.8.8 0 0 1 .8.8v1.4a.8.8 0 0 1-.8.8H2a.8.8 0 0 1-.8-.8v-1.4a.8.8 0 0 1 .8-.8zm10.4 1.1a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z',
  eject: 'M8 2.2 13.4 9H2.6zM2.6 10.6h10.8v2.8H2.6z',
  home: 'M8 1.4 15 7.6h-2v6.6H9.6V10H6.4v4.2H3V7.6H1z',
  // A record sleeve seen square on, and a person: the two ways a library is
  // browsed when it is not a list of songs.
  albums: 'M2.4 2.4h11.2v11.2H2.4zm5.6 3a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zm0 1.8a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6z',
  artists: 'M8 1.8a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM2.6 14.2c0-3 2.4-5.4 5.4-5.4s5.4 2.4 5.4 5.4z',
  // A list with the playing item marked: what is coming, in order.
  queue: 'M1.6 3h9.2v1.7H1.6zm0 4.2h9.2v1.7H1.6zm0 4.2h6v1.7h-6zM13.4 9.2 9.6 11.8V6.6z',
  // One mark per kind of source. Not brand logos — a chevron, a badge and a
  // pair of drops that sit at the same weight as the rest of the set: what they
  // have to do is tell five rows apart at 18px, which colour and a wordmark
  // would do worse.
  folder: 'M1.2 2.6h4.4l1.4 1.7h7.8a.8.8 0 0 1 .8.8v8.1a.8.8 0 0 1-.8.8H1.2a.8.8 0 0 1-.8-.8V3.4a.8.8 0 0 1 .8-.8z',
  rclone: 'M4.8 10.6A3.4 3.4 0 0 1 4.5 3.7a4.3 4.3 0 0 1 8 1.3 2.9 2.9 0 0 1-.6 5.6zM6.3 12h3.4L8 14.8z',
  plex: 'M3.6 1.6h4L12.4 8l-4.8 6.4h-4L8.4 8z',
  emby: 'M8 1.2 14.4 4.8v6.4L8 14.8 1.6 11.2V4.8zm-1.4 4v5.6L11 8z',
  jellyfin: 'M8 1.8c2.4 1.6 3.9 4.2 3.9 6.6 0 2-1.7 3.4-3.9 3.4S4.1 10.4 4.1 8.4c0-2.4 1.5-5 3.9-6.6zm0 3.4c-1 1-1.6 2.2-1.6 3.2 0 .8.7 1.4 1.6 1.4s1.6-.6 1.6-1.4c0-1-.6-2.2-1.6-3.2z',
  // A file the scanner could not find: a warning, not an error — nothing was lost.
  alert: 'M8 1.6 15 14H1zm-.9 4.4h1.8v4.4H7.1zm0 5.4h1.8v1.8H7.1z',
}

/** Every glyph in the base set, for the design-system page to lay out. */
export const ICON_NAMES = Object.keys(PATHS)
