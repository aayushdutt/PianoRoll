import { t } from '../i18n'
import type { ModeContext, ModeController } from './ModeController'

// Landing surface — no loaded MIDI, no live session yet. Typing keyboard is
// kept live so the first key-press dissolves into live mode without an extra
// click (see App.handleLiveNoteOn for the `mode === 'home'` branch).
export class HomeController implements ModeController {
  readonly id = 'home' as const
  // Home dissolves to Live on the first keypress/note, so anything played
  // here is intended as a live performance — capture it.
  readonly capturesLivePerformance = true

  constructor(private ctx: ModeContext) {}

  enter(): void {
    const { services, trackPanel, dropzone, keyboardInput, resetInteractionState } = this.ctx
    resetInteractionState()
    services.store.enterHome()
    services.renderer.clearMidi()
    trackPanel.close()
    dropzone.show()
    keyboardInput.enable()
    document.title = t('doc.title.home')
  }
}
