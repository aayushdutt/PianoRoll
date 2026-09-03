// Pure math/resolution helpers for the export pipeline.
//
// Extracted verbatim from `app.ts` (the orchestrator) so this risk-bearing
// logic — pitch-range fitting, audio-tail trimming, and dimension/bitrate
// resolution — can be unit-tested without spinning up the full `App` class or a
// browser AudioContext. `app.ts` re-imports these; there is intentionally no
// behavioral change.

import type { MidiFile } from '../core/midi/types'
import type { ExportResolution, ExportSpeed } from '../ui/ExportModal'
import type { ExportStage } from './VideoExporter'

// Scans the MIDI's notes for min/max pitch and pads outward by a few keys so
// the visible range feels natural rather than clipping right at the extremes.
// Clamps to the MIDI-usable octaves on 88-key piano.
export function fitPitchRange(midi: MidiFile): { min: number; max: number } {
  let lo = 108,
    hi = 21
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      if (n.pitch < lo) lo = n.pitch
      if (n.pitch > hi) hi = n.pitch
    }
  }
  if (hi < lo) return { min: 21, max: 108 }
  // Pad ~3 semitones each side; widen if the range is tiny so cards don't
  // look like a single-octave slice on a half-chorused piece.
  const pad = Math.max(3, Math.round((hi - lo) * 0.12))
  return {
    min: Math.max(21, lo - pad),
    max: Math.min(108, hi + pad),
  }
}

export function speedToPps(speed: ExportSpeed): number {
  switch (speed) {
    case 'compact':
      return 300
    case 'standard':
      return 200
    case 'drama':
      return 120
  }
}

// Pure sample-count math behind `trimAudioBuffer`. Returns the frame count the
// trimmed buffer should have for `durationSec`, or `null` when the source is
// already at/under that length (caller returns the source untouched — no copy).
//
// Floors at 1 frame so a zero/negative duration never yields an empty buffer.
// Uses `Math.ceil` so the trimmed audio is never SHORTER than the requested
// duration (a half-sample short cut would clip the final note's tail).
export function trimmedFrameCount(
  durationSec: number,
  sampleRate: number,
  sourceLength: number,
): number | null {
  const targetFrames = Math.max(1, Math.ceil(durationSec * sampleRate))
  if (targetFrames >= sourceLength) return null
  return targetFrames
}

export function trimAudioBuffer(audio: AudioBuffer, durationSec: number): AudioBuffer {
  const targetFrames = trimmedFrameCount(durationSec, audio.sampleRate, audio.length)
  if (targetFrames === null) return audio

  const trimmed = new AudioBuffer({
    length: targetFrames,
    numberOfChannels: audio.numberOfChannels,
    sampleRate: audio.sampleRate,
  })

  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    trimmed.copyToChannel(audio.getChannelData(ch).subarray(0, targetFrames), ch)
  }

  return trimmed
}

// Stable string for an active-pitch set so the chord overlay can short-circuit
// recomputation when nothing changed between frames.
export function pitchSignature(pitches: Set<number>): string {
  if (pitches.size === 0) return ''
  return Array.from(pitches)
    .sort((a, b) => a - b)
    .join('.')
}

// Resolves a user-facing resolution preset to concrete pixel dimensions.
// Returns `null` when the preset means "keep whatever the canvas currently is"
// so the caller can skip the resize entirely.
export function resolveExportDims(
  preset: ExportResolution,
): { width: number; height: number } | null {
  switch (preset) {
    case '720p':
      return { width: 1280, height: 720 }
    case '1080p':
      return { width: 1920, height: 1080 }
    case '2k':
      return { width: 2560, height: 1440 }
    case '4k':
      return { width: 3840, height: 2160 }
    case 'vertical':
      return { width: 1080, height: 1920 }
    case 'square':
      return { width: 1080, height: 1080 }
    case 'match':
      return null
  }
}

// ── Staged progress ─────────────────────────────────────────────────────────
// Maps each encoder stage onto a fixed window of ONE overall progress bar. The old per-stage bar reset to 0% on every stage
// change, which read as "stuck in a loop" — PostHog showed a 24.5 s median
// cancel time. Window sizes are rough wall-clock weights; exactness doesn't
// matter because the bar is clamped monotonic by the caller. Only the modes
// that show a progress card appear here ('midi' downloads instantly).

export type ProgressMode = 'av' | 'video-only' | 'audio-only'

export interface StageWindow {
  from: number // overall-bar fraction where this stage begins
  to: number // …and ends
}

const STAGE_WINDOWS: Record<ProgressMode, Partial<Record<ExportStage, StageWindow>>> = {
  // Audio renders and encodes concurrently with the video loop, so the bar
  // follows the encode; the two audio stages only surface if audio is still
  // in flight after the last video frame, hence their thin windows.
  av: {
    Encoding: { from: 0, to: 0.9 },
    'Rendering audio': { from: 0.9, to: 0.93 },
    'Encoding audio': { from: 0.93, to: 0.95 },
    Finalizing: { from: 0.95, to: 0.98 },
    Saving: { from: 0.98, to: 1 },
    Done: { from: 1, to: 1 },
  },
  'video-only': {
    Encoding: { from: 0, to: 0.9 },
    Finalizing: { from: 0.9, to: 0.98 },
    Saving: { from: 0.98, to: 1 },
    Done: { from: 1, to: 1 },
  },
  'audio-only': {
    'Rendering audio': { from: 0, to: 0.85 },
    Saving: { from: 0.85, to: 1 },
    Done: { from: 1, to: 1 },
  },
}

// Total-range fallback for stage/mode combos that shouldn't occur (e.g. an
// 'av' export whose audio render failed skips 'Encoding audio') — the bar
// stays sane instead of throwing mid-export.
export function stageWindow(mode: ProgressMode, stage: ExportStage): StageWindow {
  return STAGE_WINDOWS[mode][stage] ?? { from: 0, to: 1 }
}

// Overall-bar position for a per-stage fraction. Callers clamp monotonic.
export function overallProgress(mode: ProgressMode, stage: ExportStage, pct: number): number {
  const w = stageWindow(mode, stage)
  const clamped = Math.min(1, Math.max(0, pct))
  return w.from + clamped * (w.to - w.from)
}

// Stage-local ETA in seconds, or null while the estimate would still be junk
// (too early in the stage for the rate to have stabilised).
export function stageEtaSeconds(elapsedMs: number, pct: number): number | null {
  if (pct < 0.04 || elapsedMs < 3000) return null
  return ((elapsedMs / 1000) * (1 - pct)) / pct
}

// H.264 bitrate per preset. Lower than YouTube's recommendations but tuned
// for visual fidelity of a piano-roll (mostly dark background, few gradients)
// — the encoder doesn't need YouTube's overhead for live-action footage.
export function resolveExportBitrate(preset: ExportResolution): number {
  switch (preset) {
    case '720p':
      return 5_000_000
    case '1080p':
      return 8_000_000
    case '2k':
      return 16_000_000
    case '4k':
      return 35_000_000
    case 'vertical':
      return 8_000_000
    case 'square':
      return 5_000_000
    case 'match':
      return 8_000_000
  }
}

// Resolution is a SHARPNESS choice, not a layout choice.
//
// Every renderer constant (keyboard height, glow distance, line widths,
// particle sizes) is in logical pixels, so rendering a 4K export at a 3840×2160
// logical canvas produced a 1080p layout shrunk to a quarter size — the piano
// looked proportionally much shorter at 4K than at 720p. Instead each format
// renders at a FIXED logical size and Pixi's `resolution` multiplier scales the
// backing store up/down to the requested pixel size.
//
// Invariant: `Math.round(logical × resolution)` equals `resolveExportDims()` for
// every preset (Pixi rounds pixel dimensions the same way), so the encoder still
// sees the exact dimensions the user picked.
export interface ExportRenderPlan {
  logicalWidth: number
  logicalHeight: number
  resolution: number
}

const LANDSCAPE_LOGICAL = { width: 1920, height: 1080 }

// `windowSize.resolution` is the live canvas density (devicePixelRatio, capped),
// so 'match' exports the window exactly as displayed — Retina stays sharp.
export function resolveExportRender(
  preset: ExportResolution,
  windowSize: { width: number; height: number; resolution?: number },
): ExportRenderPlan {
  if (preset === 'match') {
    return {
      logicalWidth: windowSize.width,
      logicalHeight: windowSize.height,
      resolution: windowSize.resolution ?? 1,
    }
  }
  const dims = resolveExportDims(preset)
  // Unreachable: 'match' is the only preset without dims. Keeps the compiler
  // honest without a non-null assertion.
  if (!dims) {
    return { logicalWidth: windowSize.width, logicalHeight: windowSize.height, resolution: 1 }
  }
  if (preset === 'vertical' || preset === 'square') {
    return { logicalWidth: dims.width, logicalHeight: dims.height, resolution: 1 }
  }
  // Landscape presets share one 16:9 logical stage; only the sharpness varies.
  return {
    logicalWidth: LANDSCAPE_LOGICAL.width,
    logicalHeight: LANDSCAPE_LOGICAL.height,
    resolution: dims.width / LANDSCAPE_LOGICAL.width,
  }
}
