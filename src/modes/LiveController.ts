import { t } from '../i18n'
import { trackEvent } from '../telemetry'
import type { EnterOptions, ModeContext, ModeController } from './ModeController'

// Real-time performance surface. No MIDI file loaded; the piano roll is driven
// by the live note store and the loop station.
export class LiveController implements ModeController {
  readonly id = 'live' as const
  readonly capturesLivePerformance = true

  constructor(private ctx: ModeContext) {}

  enter(opts?: EnterOptions): void {
    const primeAudio = opts?.primeAudio ?? true
    const {
      services,
      trackPanel,
      dropzone,
      keyboardInput,
      midiInput,
      resetInteractionState,
      primeInteractiveAudio,
    } = this.ctx

    const wasAlreadyLive = services.store.mode.value === 'live'
    resetInteractionState()
    services.store.enterLive()
    services.renderer.clearMidi()
    trackPanel.close()
    dropzone.hide()
    keyboardInput.enable()
    document.title = t('doc.title.live')
    if (primeAudio) primeInteractiveAudio()
    if (!wasAlreadyLive) {
      trackEvent('live_mode_entered', {
        midi_connected: midiInput.status.value === 'connected',
      })
    }
  }
}
