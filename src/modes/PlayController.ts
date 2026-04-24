import { track, trackEvent } from '../telemetry'
import type { ModeContext, ModeController } from './ModeController'

// Playback surface for a loaded MIDI file. Enter is a no-op + file picker if no
// MIDI has been loaded yet — the caller (App.requestMode) handles that edge so
// this controller can assume a file exists when invoked.
export class PlayController implements ModeController {
  readonly id = 'play' as const
  readonly capturesLivePerformance = true

  constructor(private ctx: ModeContext) {}

  enter(): void {
    const midi = this.ctx.services.store.loadedMidi.value
    if (!midi) {
      this.ctx.openFilePicker()
      return
    }
    const { services, trackPanel, dropzone, keyboardInput, resetInteractionState } = this.ctx
    const wasAlreadyPlay = services.store.mode.value === 'play'
    resetInteractionState()
    services.store.enterPlay()
    services.renderer.loadMidi(midi)
    trackPanel.render(midi)
    dropzone.hide()
    // Typing keyboard stays enabled — users can play along with the file.
    keyboardInput.enable()
    document.title = `${midi.name} · midee`
    if (!wasAlreadyPlay) {
      // Dual-fire during the 2-week rename migration window (started
      // 2026-04-23). Remove `file_mode_entered` after 2026-05-07 —
      // `play_mode_entered` is the canonical successor.
      const props = { duration_s: Math.round(midi.duration) }
      trackEvent('play_mode_entered', props)
      track('file_mode_entered', props)
    }
  }
}
