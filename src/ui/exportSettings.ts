// Pure state → settings mapping, the estimates shown under the export preview,
// and the geometry behind the Audio/MIDI stage thumbnails. Kept out of
// ExportModal.tsx so the dialog's decisions (which destination, which format,
// what the caption says, where each bar/note lands) are unit-testable without
// Solid or a DOM — the .tsx only owns the canvas strokes.

import type { MidiFile } from '../core/midi/types'
import { resolveExportDims } from '../export/exportMath'
import type {
  ExportAudioFormat,
  ExportFocus,
  ExportResolution,
  ExportSettings,
  ExportSpeed,
} from './ExportModal'

export type ExportDest = 'video' | 'audio' | 'midi'
export type ExportFormat = 'landscape' | 'vertical' | 'square'
export type ExportQuality = '720p' | '1080p' | '2k' | '4k' | 'match'
export type ExportFps = 30 | 60

// What the dialog holds. `quality` only applies to landscape (social formats
// are fixed at 1080 wide) but is kept across format switches so flipping to
// Vertical and back doesn't lose the choice.
export interface ExportUiState {
  dest: ExportDest
  format: ExportFormat
  quality: ExportQuality
  fps: ExportFps
  includeAudio: boolean
  focus: ExportFocus
  speed: ExportSpeed
  audioFormat: ExportAudioFormat
}

export const QUALITIES: readonly ExportQuality[] = ['720p', '1080p', '2k', '4k', 'match']
export const FORMATS: readonly ExportFormat[] = ['landscape', 'vertical', 'square']
export const FPS_OPTIONS: readonly ExportFps[] = [30, 60]

export function resolutionFor(format: ExportFormat, quality: ExportQuality): ExportResolution {
  return format === 'landscape' ? quality : format
}

export function toExportSettings(ui: ExportUiState): ExportSettings {
  return {
    fps: ui.fps,
    resolution: resolutionFor(ui.format, ui.quality),
    output:
      ui.dest === 'video'
        ? ui.includeAudio
          ? 'av'
          : 'video-only'
        : ui.dest === 'audio'
          ? 'audio-only'
          : 'midi',
    focus: ui.focus,
    speed: ui.speed,
    audioFormat: ui.audioFormat,
  }
}

// Pixel size the preview and caption describe. `window` follows the live
// canvas, so the caller passes its current size.
export function previewDims(
  ui: Pick<ExportUiState, 'format' | 'quality'>,
  windowSize: { width: number; height: number },
): { width: number; height: number } {
  return resolveExportDims(resolutionFor(ui.format, ui.quality)) ?? windowSize
}

// Encoder throughput measured on this machine by the last export, in
// pixels per second (frames × width × height ÷ seconds). Encoders scale
// roughly with pixel count, so one number predicts every preset.
export const THROUGHPUT_KEY = 'midee.export.throughput'

export function throughputFrom(stats: {
  framesEncoded: number
  width: number
  height: number
  videoEncodeMs: number
}): number | null {
  if (stats.videoEncodeMs <= 0 || stats.framesEncoded <= 0) return null
  return (stats.framesEncoded * stats.width * stats.height) / (stats.videoEncodeMs / 1000)
}

// null when there is nothing measured yet — the caption says so instead of
// inventing a number.
export function estimateSeconds(
  throughputPxPerSec: number | null,
  dims: { width: number; height: number },
  fps: number,
  durationSec: number,
): number | null {
  if (throughputPxPerSec === null || throughputPxPerSec <= 0) return null
  return (durationSec * fps * dims.width * dims.height) / throughputPxPerSec
}

// ── Audio tab: note-activity waveform ────────────────────────────────────
// The Audio stage draws the piece as an audio-thumbnail-style bar chart. The
// value of a bucket is how much *sound energy* lands in it: every note
// contributes `velocity × seconds it overlaps the bucket`, so a held fortissimo
// chord reads louder than a quiet run of grace notes. Output is normalised to
// the loudest bucket (0…1) — the drawing code just scales it to the stage.

export const ACTIVITY_BUCKETS = 120

// Zero/near-zero-length notes (drum hits, imported blips) would otherwise
// contribute nothing at all and punch holes in the waveform.
const MIN_NOTE_SEC = 0.02

export function activityBuckets(midi: MidiFile | null, count = ACTIVITY_BUCKETS): number[] {
  const n = Math.max(1, Math.floor(count))
  const out = new Array<number>(n).fill(0)
  if (!midi || midi.duration <= 0) return out
  const width = midi.duration / n
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      const start = Math.min(Math.max(note.time, 0), midi.duration)
      const end = Math.min(start + Math.max(note.duration, MIN_NOTE_SEC), midi.duration)
      const first = Math.min(Math.floor(start / width), n - 1)
      const last = Math.min(Math.floor(end / width), n - 1)
      for (let i = first; i <= last; i++) {
        const overlap = Math.min(end, (i + 1) * width) - Math.max(start, i * width)
        if (overlap > 0) out[i] = out[i]! + note.velocity * overlap
      }
    }
  }
  let max = 0
  for (const v of out) if (v > max) max = v
  if (max <= 0) return out
  return out.map((v) => v / max)
}

// ── MIDI tab: piano-roll thumbnail ───────────────────────────────────────
// One rect per note in stage pixels: x/width from time, y from pitch with
// MIDI_MAX at the top. Colour is the caller's business (it needs the theme),
// so this stays a pure geometry pass.
