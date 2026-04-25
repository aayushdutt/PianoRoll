import { getContext, Synth, start as toneStart } from 'tone'
import { createEventSignal } from '../store/eventSignal'

// Simple click-track metronome. Look-ahead scheduling keeps timing tight
// (< ~5ms jitter) regardless of page repaints or garbage collection.
//
// Design: a 25ms polling loop checks whether any beat falls within the next
// 100ms window; if so, it schedules a synth trigger at the exact AudioContext
// time. This is the "two-clock" pattern from the Web Audio metronome playbook
// — timer clock drives the lookahead, audio clock drives the actual onset.

const LOOKAHEAD_SEC = 0.1
const POLL_INTERVAL_MS = 25
const BEATS_PER_BAR = 4
const ACCENT_FREQ = 1600
const BEAT_FREQ = 900
const CLICK_DURATION = 0.035

export class Metronome {
  readonly running = createEventSignal<boolean>(false)
  readonly bpm = createEventSignal<number>(120)
  // Increments once per audible click; subscribers use `count % 4 === 0` to
  // detect the downbeat. Visual consumers stay tightly synced to audio because
  // we fire this via setTimeout aligned to the scheduled AudioContext time.
  readonly beatCount = createEventSignal<number>(0)

  private synth: Synth | null = null
  private nextBeatTime = 0
  private beatCounter = 0
  private pollHandle: ReturnType<typeof setTimeout> | null = null

  start(): void {
    if (this.running.value) return
    void toneStart()
    this.ensureSynth()
    this.beatCounter = 0
    this.nextBeatTime = getContext().currentTime + 0.05
    this.running.set(true)
    this.poll()
  }

  stop(): void {
    if (!this.running.value) return
    this.running.set(false)
    if (this.pollHandle !== null) clearTimeout(this.pollHandle)
    this.pollHandle = null
  }

  toggle(): void {
    if (this.running.value) this.stop()
    else this.start()
  }

  setBpm(bpm: number): void {
    // Clamp to musically useful range; extreme values just make the click
    // useless for a beginner.
    const clamped = Math.max(40, Math.min(240, Math.round(bpm)))
    this.bpm.set(clamped)
  }

  dispose(): void {
    this.stop()
    this.synth?.dispose()
    this.synth = null
  }

  private ensureSynth(): void {
    if (this.synth) return
    this.synth = new Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.02 },
    }).toDestination()
    this.synth.volume.value = -12
  }

  private poll = (): void => {
    if (!this.running.value) return
    const ctx = getContext()
    const horizon = ctx.currentTime + LOOKAHEAD_SEC
    const secPerBeat = 60 / this.bpm.value

    while (this.nextBeatTime < horizon) {
      const isDownbeat = this.beatCounter % BEATS_PER_BAR === 0
      const freq = isDownbeat ? ACCENT_FREQ : BEAT_FREQ
      this.synth?.triggerAttackRelease(freq, CLICK_DURATION, this.nextBeatTime)

      // Fire the visual signal at wall time aligned to the audio onset so the
      // UI pulse doesn't race ahead of the click.
      const delayMs = Math.max(0, (this.nextBeatTime - ctx.currentTime) * 1000)
      const snapshot = this.beatCounter
      setTimeout(() => {
        if (this.running.value) this.beatCount.set(snapshot + 1)
      }, delayMs)

      this.nextBeatTime += secPerBeat
      this.beatCounter++
    }

    this.pollHandle = setTimeout(this.poll, POLL_INTERVAL_MS)
  }
}
