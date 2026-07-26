import type { GuitarPosition, GuitarProfile } from './types'

export const STANDARD_GUITAR_PROFILE: GuitarProfile = {
  strings: [40, 45, 50, 55, 59, 64].map((openPitch, index) => ({
    index,
    openPitch,
    maxFret: 24,
  })),
}

export function candidatePositions(
  pitch: number,
  profile: GuitarProfile = STANDARD_GUITAR_PROFILE,
): GuitarPosition[] {
  if (!Number.isInteger(pitch)) return []

  return profile.strings.flatMap((string) => {
    const fret = pitch - string.openPitch
    return fret >= 0 && fret <= string.maxFret ? [{ string: string.index, fret }] : []
  })
}
