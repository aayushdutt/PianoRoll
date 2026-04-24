// Renders a MIDI file to a raw AudioBuffer faster-than-real-time via
// `Tone.OfflineContext`, so the video exporter can bake audio into the MP4
// without needing realtime playback during frame capture.
//
// We use `Tone.OfflineContext` directly (instead of the `Tone.Offline()`
// convenience wrapper) so we can schedule `rawContext.suspend(t)` checkpoints
// and emit real progress updates. The native `OfflineAudioContext.suspend()`
// API pauses the render at a specified render-time point and yields back to
// the main thread; we report progress, then `resume()` to continue.

import * as Tone from 'tone'
import type { MidiFile } from '../core/midi/types'
import {
  createInstrument,
  type InstrumentId,
  midiToNoteName,
  preloadSampleBuffers,
} from './instruments'

export interface OfflineRenderOptions {
  midi: MidiFile
  instrumentId: InstrumentId
  volume: number // 0–1
  sampleRate?: number
  // Progress in [0, 1] — how far through the render we are. Called ~20 times
  // across the render, driven by OfflineAudioContext.suspend() checkpoints.
  onProgress?: (pct: number) => void
}

// 44.1 kHz matches AAC output in the muxer — rendering at 48 kHz cost ~9% more
// per render for no audible benefit on the downstream MP4 track. The exported
// AudioBuffer is what the WebCodecs AudioEncoder consumes, so its sample rate
// flows straight through to the MP4's audio stream.
const DEFAULT_SAMPLE_RATE = 44_100

// Small tail past midi.duration so release envelopes on the final notes don't
// clip mid-swell. The exporter still trims video to midi.duration, and the
// muxer tolerates slightly-longer audio — AAC's last frames beyond the video
// are dropped on playback start, which is preferable to a hard audio cutoff.
const TAIL_SECONDS = 1.5

// Number of progress checkpoints across the render. More = finer-grained bar
// motion, but each suspend/resume is an extra promise hop. 20 gives a visibly
// smooth bar without measurable overhead on typical MIDIs.
const PROGRESS_STEPS = 20

interface NoteEvent {
  time: number
  note: string
  duration: number
  velocity: number
}

export async function renderAudioOffline(opts: OfflineRenderOptions): Promise<AudioBuffer> {
  const { midi, instrumentId, volume, onProgress } = opts
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE

  // Pre-decode sample buffers against the online context BEFORE building the
  // offline context. Decoding inside the offline scope is the single biggest
  // reason exports stall — see Tone.js issue #405. The Sampler built inside
  // the offline context picks up the cached AudioBuffers directly and has no
  // async init work left to do.
  await preloadSampleBuffers(instrumentId)

  // Flatten all tracks into one time-ordered event list up-front. Avoids N×M
  // nested scheduling inside the offline context and lets Tone.Part slot the
  // whole batch into a single transport entry instead of 2×notes entries.
  const events: NoteEvent[] = []
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      events.push({
        time: note.time,
        note: midiToNoteName(note.pitch),
        duration: note.duration,
        velocity: note.velocity,
      })
    }
  }

  const renderDuration = Math.max(0.1, midi.duration + TAIL_SECONDS)

  // Build a NATIVE OfflineAudioContext and hand it to Tone, rather than letting
  // Tone create one via its `standardized-audio-context` polyfill. The polyfill
  // omits `OfflineAudioContext.suspend(time)` — which is the browser API we
  // need for mid-render progress checkpoints. Tone accepts a pre-built offline
  // context as its first constructor arg and uses it directly, so `rawContext`
  // ends up being the native one with `suspend` available.
  const rawContext = new OfflineAudioContext(2, Math.ceil(renderDuration * sampleRate), sampleRate)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offline = new (Tone as any).OfflineContext(rawContext)
  const prevContext = Tone.getContext()
  Tone.setContext(offline)

  try {
    const inst = await createInstrument(instrumentId)
    Tone.getDestination().volume.value = Tone.gainToDb(volume)

    const transport = Tone.getTransport()
    transport.bpm.value = midi.bpm

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const part = new (Tone as any).Part(
      (time: number, ev: NoteEvent) => {
        inst.triggerAttackRelease(ev.note, ev.duration, time, ev.velocity)
      },
      events.map((ev) => [ev.time, ev]),
    )
    part.start(0)
    transport.start()

    // Schedule suspend checkpoints BEFORE calling render(). Each resolves as
    // the render sweeps past its timestamp, reports progress, and resumes the
    // render. If the browser lacks `OfflineAudioContext.suspend(time)` (older
    // Safari), fall through silently — the render still completes, the bar
    // just doesn't move for this stage.
    if (onProgress && typeof rawContext.suspend === 'function') {
      for (let i = 1; i <= PROGRESS_STEPS; i++) {
        // Leave a small gap before renderDuration — suspending exactly at the
        // end is a race with render completion.
        const t = Math.min((i / PROGRESS_STEPS) * renderDuration, renderDuration - 0.001)
        try {
          void rawContext.suspend(t).then(() => {
            onProgress(i / PROGRESS_STEPS)
            void rawContext.resume()
          })
        } catch {
          // suspend() threw synchronously (unsupported) — give up on progress
          // for the rest of this render without failing the export.
          break
        }
      }
    }

    const toneBuffer = await offline.render()
    const raw = toneBuffer.get()
    if (!raw) throw new Error('Offline audio render produced no buffer')
    return raw
  } finally {
    Tone.setContext(prevContext)
  }
}
