// Renders a MIDI file to a raw AudioBuffer faster-than-real-time via
// `Tone.Offline`, so the video exporter can bake audio into the MP4 without
// needing realtime playback during frame capture.

import * as Tone from 'tone'
import type { MidiFile } from '../core/midi/types'
import { createInstrument, type InstrumentId, midiToNoteName } from './instruments'

export interface OfflineRenderOptions {
  midi: MidiFile
  instrumentId: InstrumentId
  volume: number // 0–1
  sampleRate?: number
}

const DEFAULT_SAMPLE_RATE = 48_000

export async function renderAudioOffline(opts: OfflineRenderOptions): Promise<AudioBuffer> {
  const { midi, instrumentId, volume } = opts
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE

  // Render exactly midi.duration seconds to match the video track. Any release
  // tail on a note ending at the very end clips, which is accepted to keep
  // audio and video durations identical for muxing.
  const renderDuration = Math.max(0.1, midi.duration)

  const toneBuffer = await Tone.Offline(
    async () => {
      const inst = await createInstrument(instrumentId)
      Tone.getDestination().volume.value = Tone.gainToDb(volume)

      const transport = Tone.getTransport()
      transport.bpm.value = midi.bpm

      for (const track of midi.tracks) {
        for (const note of track.notes) {
          transport.schedule((time) => {
            inst.triggerAttack(midiToNoteName(note.pitch), time, note.velocity)
          }, note.time)
          transport.schedule((time) => {
            inst.triggerRelease(midiToNoteName(note.pitch), time)
          }, note.time + note.duration)
        }
      }

      transport.start()
    },
    renderDuration,
    2,
    sampleRate,
  )

  const raw = toneBuffer.get()
  if (!raw) throw new Error('Offline audio render produced no buffer')
  return raw
}
