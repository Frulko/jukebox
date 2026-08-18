import type { Device, DeviceKind } from '@jukebox/api-types'

/**
 * Devices come from the server. This module keeps only what is display
 * related — the icon per kind, the segments of the capacity bar.
 */
export type { Device, DeviceKind }

export const DEVICE_ICON = {
  'ipod-classic': 'ipod',
  'ipod-nano': 'ipod',
  'ipod-shuffle': 'shuffle-device',
  iphone: 'iphone',
  ipad: 'iphone',
} satisfies Record<DeviceKind, string>

export const CAPACITY_SEGMENTS = [
  ['audio', 'Audio', '#f0c419'],
  ['video', 'Video', '#5aa9e6'],
  ['photos', 'Photos', '#e07a5f'],
  ['apps', 'Apps', '#8fbf6b'],
  ['other', 'Other', '#b0a8c8'],
] as const
