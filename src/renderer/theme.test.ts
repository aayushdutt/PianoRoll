import { describe, expect, it } from 'vitest'
import { type MidiTrack, TRACK_COLOR_SLOTS } from '../core/midi/types'
import { accentCSS, getTrackColor, liveNoteColor, THEMES, type Theme, type ThemeId } from './theme'

// Compile-time exhaustiveness over the `ThemeId` union.
const EXPECTED_THEME_IDS: Record<ThemeId, true> = {
  dark: true,
  midnight: true,
  neon: true,
  sunset: true,
  ocean: true,
}

const track = (colorIndex: number): MidiTrack => ({
  id: 't',
  name: 't',
  channel: 0,
  instrument: 0,
  isDrum: false,
  notes: [],
  colorIndex,
})

describe('getTrackColor', () => {
  // The TrackPanel swatch resolves through this function so the dropdown
  // colour matches the on-canvas note. If this drifts, swatches lie about
  // which track is which — the bug we just fixed.
  it.each(THEMES)('returns the theme palette colour for $name', (theme) => {
    for (let i = 0; i < theme.trackColors.length; i++) {
      expect(getTrackColor(track(i), theme)).toBe(theme.trackColors[i])
    }
  })

  it('wraps colorIndex past the palette length so a 9th track still gets a colour', () => {
    const theme = THEMES[0]!
    const len = theme.trackColors.length
    expect(getTrackColor(track(len), theme)).toBe(theme.trackColors[0])
    expect(getTrackColor(track(len + 3), theme)).toBe(theme.trackColors[3])
  })
})

describe('accentCSS', () => {
  it('renders the numeric accent as a #rrggbb string', () => {
    expect(accentCSS({ accent: 0xf97316 } as Theme)).toBe('#f97316')
    expect(accentCSS({ accent: 0x0000ff } as Theme)).toBe('#0000ff')
  })

  it('every built-in theme has a unique id and an in-range accent', () => {
    const ids = new Set(THEMES.map((t) => t.id))
    expect(ids.size).toBe(THEMES.length)
    for (const theme of THEMES) {
      expect(theme.accent).toBeGreaterThanOrEqual(0)
      expect(theme.accent).toBeLessThanOrEqual(0xffffff)
    }
  })
})

describe('liveNoteColor', () => {
  it('uses the first track palette slot', () => {
    const theme = THEMES[0]!
    expect(liveNoteColor(theme)).toBe(theme.trackColors[0])
  })

  it('falls back to the now-line colour for an empty palette', () => {
    expect(liveNoteColor({ trackColors: [], nowLine: 0xabcdef } as unknown as Theme)).toBe(0xabcdef)
  })
})

describe('theme roster', () => {
  it('ships exactly one theme per ThemeId', () => {
    const ids = THEMES.map((t) => t.id)
    expect([...ids].sort()).toEqual(Object.keys(EXPECTED_THEME_IDS).sort())
  })

  it.each(THEMES)('$name has exactly TRACK_COLOR_SLOTS track colours', (theme) => {
    expect(theme.trackColors).toHaveLength(TRACK_COLOR_SLOTS)
  })
})
