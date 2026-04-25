import { createEffect, onMount } from 'solid-js'
import { useApp } from '../store/AppCtx'
import { track, trackEvent } from '../telemetry'

// Playback surface for a loaded MIDI file. Mount happens when the store's
// mode transitions to 'play' — which only occurs in `completePlayLoad`, so
// `loadedMidi` is already set by the time onMount runs for the "fresh
// load" path. For the "re-entry from live/learn" path, loadedMidi was
// preserved from the earlier play session.
//
// Why createEffect for the renderer side? New-file-loaded while already in
// play mode changes `loadedMidi` without remounting the component. The
// effect re-runs on that change so the renderer/trackPanel/title all
// reflect the new file.
export function PlayMode() {
  const { services, trackPanel, dropzone, keyboardInput, openFilePicker, resetInteractionState } =
    useApp()

  onMount(() => {
    const midi = services.store.state.loadedMidi
    const status = services.store.state.status
    if (!midi) {
      // Null midi can arrive two ways:
      //   1. User clicked Play with nothing loaded → route to picker.
      //   2. beginPlayLoad flipped mode='play' mid-load (loadedMidi still
      //      null, status='loading'). Wait for completePlayLoad to settle
      //      via the createEffect below. Firing analytics here would
      //      surface a "play_mode_entered" event for a mode we're still
      //      loading into — matches pre-port semantics of analytics firing
      //      only on explicit mode navigation.
      if (status === 'loading') return
      // Halt any prior surface (Live looper / sessionRec / metronome / etc.)
      // BEFORE opening the picker so audio doesn't ghost through while the
      // user chooses a file.
      resetInteractionState()
      trackPanel.close()
      dropzone.hide()
      keyboardInput.enable()
      openFilePicker()
      return
    }
    resetInteractionState()
    // Dual-fire during the 2-week rename migration window. `play_mode_entered`
    // is the canonical successor; `file_mode_entered` is scheduled for
    // removal after 2026-05-07.
    const props = { duration_s: Math.round(midi.duration) }
    trackEvent('play_mode_entered', props)
    track('file_mode_entered', props)
  })

  createEffect(() => {
    const midi = services.store.state.loadedMidi
    if (!midi) return
    services.renderer.loadMidi(midi)
    trackPanel.render(midi)
    dropzone.hide()
    keyboardInput.enable()
    document.title = `${midi.name} · midee`
  })

  return null
}
