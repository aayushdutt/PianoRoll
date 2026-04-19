import type { MidiTrack } from '../core/midi/types'

export interface Theme {
  name: string
  background: number

  noteRadius: number
  noteGlowStrength: number
  noteGlowDistance: number

  whiteKey: number
  whiteKeyActive: number // color of white key when pressed
  blackKey: number
  blackKeyActive: number // color of black key when pressed
  keyBorder: number

  nowLine: number
  nowLineAlpha: number
  nowLineGlow: number

  beatLineAlpha: number
  barLineAlpha: number

  uiAccentCSS: string

  // Per-track note/particle colors — indexed by MidiTrack.colorIndex
  trackColors: number[]
}

export function getTrackColor(track: MidiTrack, theme: Theme): number {
  return theme.trackColors[track.colorIndex % theme.trackColors.length]!
}

export const darkTheme: Theme = {
  name: 'Dark',
  background: 0x09090f,
  noteRadius: 4,
  noteGlowStrength: 2.5,
  noteGlowDistance: 12,
  whiteKey: 0xe8e8f0,
  whiteKeyActive: 0xb0b4ff, // soft indigo when pressed
  blackKey: 0x1a1a2e,
  blackKeyActive: 0x5558cc, // deeper indigo
  keyBorder: 0x1e1e30,
  nowLine: 0xffffff,
  nowLineAlpha: 0.18,
  nowLineGlow: 0xffffff,
  beatLineAlpha: 0.028,
  barLineAlpha: 0.07,
  uiAccentCSS: '#6366f1',
  trackColors: [0x6366f1, 0x818cf8, 0x60a5fa, 0xa78bfa, 0xf472b6, 0x34d399, 0xfbbf24, 0xfb923c],
}

export const midnightTheme: Theme = {
  name: 'Midnight',
  background: 0x050510,
  noteRadius: 4,
  noteGlowStrength: 2.2,
  noteGlowDistance: 14,
  whiteKey: 0xd0d0f0,
  whiteKeyActive: 0xc4b0ff, // lavender when pressed
  blackKey: 0x0e0e28,
  blackKeyActive: 0x7c5ce8, // violet
  keyBorder: 0x14142a,
  nowLine: 0xaaaaff,
  nowLineAlpha: 0.16,
  nowLineGlow: 0xaaaaff,
  beatLineAlpha: 0.025,
  barLineAlpha: 0.06,
  uiAccentCSS: '#a78bfa',
  trackColors: [0xa78bfa, 0xc084fc, 0x818cf8, 0xe879f9, 0x7dd3fc, 0xf9a8d4, 0x93c5fd, 0x6ee7b7],
}

export const neonTheme: Theme = {
  name: 'Neon',
  background: 0x030306,
  noteRadius: 4,
  noteGlowStrength: 4.5,
  noteGlowDistance: 20,
  whiteKey: 0xf0f0f0,
  whiteKeyActive: 0x80ffcc, // mint green when pressed
  blackKey: 0x111116,
  blackKeyActive: 0x00bb7a, // deep teal
  keyBorder: 0x181820,
  nowLine: 0x00ffaa,
  nowLineAlpha: 0.28,
  nowLineGlow: 0x00ffaa,
  beatLineAlpha: 0.035,
  barLineAlpha: 0.09,
  uiAccentCSS: '#00d4aa',
  trackColors: [0x00ffaa, 0x00e5ff, 0x39ff14, 0xff6bff, 0xffe600, 0xff4040, 0x00bfff, 0xff9100],
}

export const sunsetTheme: Theme = {
  name: 'Sunset',
  background: 0x0e0608,
  noteRadius: 4,
  noteGlowStrength: 3.0,
  noteGlowDistance: 15,
  whiteKey: 0xf2e8e8,
  whiteKeyActive: 0xffb08a, // warm orange when pressed
  blackKey: 0x200e10,
  blackKeyActive: 0xcc4e20, // burnt orange
  keyBorder: 0x271416,
  nowLine: 0xff8c5a,
  nowLineAlpha: 0.22,
  nowLineGlow: 0xff8c5a,
  beatLineAlpha: 0.03,
  barLineAlpha: 0.075,
  uiAccentCSS: '#f97316',
  trackColors: [0xf97316, 0xfbbf24, 0xef4444, 0xec4899, 0xff8c5a, 0xfde68a, 0xff6b9d, 0xfca5a5],
}

export const oceanTheme: Theme = {
  name: 'Ocean',
  background: 0x040d14,
  noteRadius: 4,
  noteGlowStrength: 2.8,
  noteGlowDistance: 16,
  whiteKey: 0xe0eef8,
  whiteKeyActive: 0x7dd8ff, // sky blue when pressed
  blackKey: 0x081825,
  blackKeyActive: 0x0a6ea8, // deep ocean blue
  keyBorder: 0x0c1e2e,
  nowLine: 0x38bdf8,
  nowLineAlpha: 0.2,
  nowLineGlow: 0x38bdf8,
  beatLineAlpha: 0.028,
  barLineAlpha: 0.07,
  uiAccentCSS: '#38bdf8',
  trackColors: [0x38bdf8, 0x06b6d4, 0x6366f1, 0x34d399, 0xa78bfa, 0x4ade80, 0x22d3ee, 0x67e8f9],
}

export const THEMES: Theme[] = [darkTheme, midnightTheme, neonTheme, sunsetTheme, oceanTheme]
