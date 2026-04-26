import { parseMidiFile } from '../core/midi/parser'
import type { MidiFile } from '../core/midi/types'
import { fetchSampleMidi, getSample } from '../core/samples'
import { t } from '../i18n'
import type { ExerciseDescriptor } from '../learn/core/Exercise'
import { ExerciseRunner } from '../learn/core/ExerciseRunner'
import { createLearnState, type LearnState, type LearnStatus } from '../learn/core/LearnState'
import { createLearnProgressStore, type LearnProgressStore } from '../learn/core/progress'
import { playAlongDescriptor } from '../learn/exercises/play-along'
import { findExercise } from '../learn/hub/catalog'
import { LearnHub } from '../learn/hub/LearnHub'
import { LearnOverlay } from '../learn/overlays/LearnOverlay'
import { SessionSummary } from '../learn/ui/SessionSummary'
import { createEventSignal } from '../store/eventSignal'
import { watch } from '../store/watch'
import { track, trackEvent } from '../telemetry'
import type { ModeContext } from './ModeController'

// Learn mode host. Owns all Learn-scoped state (loaded MIDI, transport,
// progress, overlay) so Play and Live never see Learn's in-flight file, and
// Learn never disturbs Play's playhead. Exercises reach this state through
// `ExerciseContext`, never through the shared AppServices bag.
//
// Routing: the hub (catalog/streak/continue card) and the active exercise
// mount into sibling host elements. Switching between them is a class toggle,
// not a remount — cheap and avoids re-fetching the hub's data.
// Long-lived Learn-mode owner. Instantiated once by `createApp()`; methods
// `enter`/`exit` are driven by `<LearnMode/>`'s onMount/onCleanup. Not a
// `ModeController` anymore — mode dispatch lives in the Solid tree.
// `capturesLivePerformance` moved to MODE_CAPTURES_LIVE (see ModeController.ts).
export class LearnController {
  // Learn-owned state. Sibling to `appState`, not a subset of it.
  readonly learnState: LearnState = createLearnState()
  private readonly progress: LearnProgressStore = createLearnProgressStore()

  private hub: LearnHub
  private runner: ExerciseRunner | null = null
  // Cinematic overlay shared across exercises. Instantiated lazily (mounts
  // into the PixiJS stage on first enter so tests don't need a renderer)
  // and torn down on `exit` to free Pixi resources.
  private overlay: LearnOverlay | null = null
  // Which sub-view is visible. Exposed as a Signal so the hub UI can
  // subscribe for smooth show/hide transitions instead of imperative toggling.
  readonly view = createEventSignal<'hub' | 'exercise'>('hub')
  private hubHost: HTMLElement | null = null
  private exerciseHost: HTMLElement | null = null
  // Subscriptions scoped to the mode being active. Wired in `enter`,
  // disposed in `exit`. Keeps the Learn state out of AppStore's tick loop.
  private unsubs: Array<() => void> = []
  // One-shot flags reset each enter so new sessions re-fire activation events.
  private firstPlayLogged = false
  // MIDI handed off from another mode (e.g. Play's "Learn this" button), to
  // be loaded on the next `enter()`. Stored here instead of plumbed through
  // ModeContext because LearnMode's onMount races the mode flip — by the
  // time `enter()` runs, the cached MIDI is the cleanest way to hand context
  // across the async boundary.
  private pendingMidi: MidiFile | null = null

  constructor(private ctx: ModeContext) {
    this.hub = new LearnHub({
      progress: this.progress,
      learnState: this.learnState,
      launchExercise: (descriptor) => void this.launchExercise(descriptor),
      onOpenFilePicker: () => this.openLearnFilePicker(),
    })
  }

  enter(): void {
    const { services, trackPanel, dropzone, keyboardInput, resetInteractionState, overlay } =
      this.ctx
    const from = services.store.state.mode
    const wasAlreadyLearn = from === 'learn'
    resetInteractionState()
    // Halt the shared transport BEFORE switching modes. A Play-mode session
    // that was still playing would otherwise keep the clock ticking and its
    // synth scheduling MIDI into the background of Learn until something
    // explicitly pauses it.
    services.clock.pause()
    services.clock.seek(0)
    // Mode is a cross-cutting router concern, so it still lives on AppStore.
    // Everything else about Learn's transport lives on `this.learnState`.
    services.store.setState('mode', 'learn')
    services.renderer.clearMidi()
    // Hide the ascending live-note sprites — Learn surfaces show the scheduled
    // piece (if any) and user presses should only highlight the keyboard.
    services.renderer.setLiveNotesVisible(false)
    trackPanel.close()
    dropzone.hide()
    keyboardInput.enable()
    document.title = t('doc.title.learn')

    this.mountHostElements(overlay)
    this.showHubView()
    this.hub.mount(this.hubHost!)
    this.overlay = new LearnOverlay()
    services.renderer.addLayer(this.overlay)

    // Reflect any already-loaded learn song in the topbar — re-entering Learn
    // with a piece still loaded should still show its name.
    this.ctx.setLearnFileName(this.learnState.state.loadedMidi?.name ?? null)
    // Touch the streak so attendance counts even if the user bails before
    // finishing an exercise — "opened the app today" is still practice.
    this.progress.touchStreak()

    // Status watch keeps synth wired to Learn's transport. No per-tick
    // currentTime mirror anymore — nobody reads it reactively, and writing
    // to a Solid store at 60 Hz re-fires every effect that tracks that field.
    // Consumers that need the live time subscribe to `services.clock` directly.
    this.firstPlayLogged = false
    this.unsubs.push(
      watch(
        () => this.learnState.state.status,
        (status) => this.onStatusChange(status),
      ),
    )

    if (!wasAlreadyLearn) trackEvent('learn_mode_entered', { from })

    // Drain a queued hand-off (e.g. Play → "Learn this" button). Done at the
    // very end so host elements + overlay are already mounted by the time
    // consumeMidi → launchExercise mounts the exercise UI.
    if (this.pendingMidi) {
      const midi = this.pendingMidi
      this.pendingMidi = null
      void this.consumeMidi(midi)
    }
  }

  // Hand-off for cross-mode launches. Caller flips `store.mode` to 'learn'
  // separately; this just queues the MIDI for `enter()` to drain. We pass a
  // parsed `MidiFile` rather than re-loading from a sample id / file to avoid
  // the duplicate parse + fetch when Play already has it in memory.
  queueMidi(midi: MidiFile): void {
    this.pendingMidi = midi
  }

  exit(): void {
    // Close any active exercise as abandoned — this is a mode-level swap,
    // not an explicit "I'm done" signal.
    if (this.runner?.isActive) this.runner.close('abandoned')
    for (const off of this.unsubs) off()
    this.unsubs = []
    this.hub.unmount()
    this.unmountHostElements()
    this.ctx.services.renderer.setVisible(true)
    if (this.overlay) {
      this.ctx.services.renderer.removeLayer(this.overlay)
      this.overlay = null
    }
    // Restore live-note sprite visibility so Live/Play modes aren't left with
    // a silently-suppressed renderer from a previous Learn session.
    this.ctx.services.renderer.setLiveNotesVisible(true)
    // Clear Learn-owned MIDI + transport so a future re-entry starts fresh.
    this.learnState.clearMidi()
    this.runner = null
    this.view.set('hub')
    // Drop the topbar context — we're leaving Learn, the next mode owns it.
    this.ctx.setLearnFileName(null)
  }

  // ── Loaders ─────────────────────────────────────────────────────────────
  //
  // Learn's own MIDI pipeline. Never touches `AppStore.loadedMidi` — Play's
  // currently-loaded piece survives Learn sessions untouched. Shared pieces
  // are just: parse the file, hand it to the synth, flip `learnState`.

  async loadMidiFromFile(file: File, source: 'drag' | 'picker' = 'picker'): Promise<void> {
    this.learnState.beginLoad()
    try {
      const midi = await parseMidiFile(file)
      await this.consumeMidi(midi)
      track('midi_loaded', {
        source,
        target: 'learn',
        track_count: midi.tracks.length,
        duration_s: Math.round(midi.duration),
        file_size_kb: Math.round(file.size / 1024),
      })
    } catch (err) {
      console.error('[LearnController] loadMidiFromFile failed:', err)
      track('midi_load_failed', { source, target: 'learn', error_type: 'parse' })
      this.learnState.setState('status', 'ready')
      this.showError(
        err instanceof Error && err.name === 'EmptyMidiError'
          ? 'That MIDI has no notes in it.'
          : "Could not read that file — make sure it's a valid MIDI.",
      )
    }
  }

  async loadSample(sampleId: string): Promise<void> {
    const sample = getSample(sampleId)
    if (!sample) return
    // Sample click counts as the user gesture that unlocks audio.
    this.ctx.primeInteractiveAudio()
    this.learnState.beginLoad()
    try {
      const midi = await fetchSampleMidi(sample)
      await this.consumeMidi(midi)
      track('midi_loaded', {
        source: 'sample',
        target: 'learn',
        sample_id: sampleId,
        track_count: midi.tracks.length,
        duration_s: Math.round(midi.duration),
      })
    } catch (err) {
      console.error('[LearnController] loadSample failed:', err)
      this.learnState.setState('status', 'ready')
      this.showError(t('error.sample.fetchFailed'))
    }
  }

  private async consumeMidi(midi: MidiFile): Promise<void> {
    // Load the synth asynchronously — we don't await so the hub reflects the
    // new MIDI immediately while samples finish downloading in the background.
    this.ctx.services.synth.load(midi).catch((err) => {
      console.error('[LearnController] SynthEngine.load failed:', err)
    })
    this.learnState.completeLoad(midi)
    // Update the topbar so the user sees what they're learning.
    this.ctx.setLearnFileName(midi.name)
    // Auto-launch Play-Along on every MIDI load. Loading a MIDI in Learn is
    // a strong signal of intent ("I want to play this piece") — making the
    // user click "Start" again afterward is friction. The runner closes
    // gracefully if a previous exercise is still active (mode-level swap).
    void this.launchExercise(playAlongDescriptor)
  }

  // ── Exercise lifecycle ──────────────────────────────────────────────────

  private async launchExercise(descriptor: ExerciseDescriptor): Promise<void> {
    if (!this.exerciseHost || !this.overlay) return
    // Close the hub view so the exercise has the whole overlay.
    this.showExerciseView()
    if (!this.runner) {
      this.runner = new ExerciseRunner({
        services: this.ctx.services,
        learnState: this.learnState,
        progress: this.progress,
        overlay: this.overlay,
        host: this.exerciseHost,
        onClose: (reason) => this.closeActiveExercise(reason),
      })
    }
    await this.runner.launch(descriptor)
  }

  // Called by the runner's `onClose` (triggered from an exercise via
  // `ctx.onClose`) or by external callers (hub back button). Idempotent —
  // returning with no active runner is a harmless no-op.
  closeActiveExercise(reason: 'completed' | 'abandoned' = 'abandoned'): void {
    if (!this.runner?.isActive) return
    const lastDescriptor = this.runner.activeId
    const xpBefore = this.progress.xp
    const streakBefore = this.progress.streakDays
    const result = this.runner.close(reason)
    this.showHubView()
    if (result && lastDescriptor) {
      // Compute post-close deltas so the summary reads "+X XP, streak +1"
      // regardless of which internals changed.
      const summary = new SessionSummary({
        onAgain: () => this.relaunchById(lastDescriptor),
        onNext: () => {
          // No next recommendation yet — just dismiss (auto-fade also dismisses).
        },
      })
      const host = this.hubHost
      if (host) {
        summary.show(host, result, {
          streakExtended: this.progress.streakDays > streakBefore,
          xpGained: Math.max(0, this.progress.xp - xpBefore),
        })
      }
    }
  }

  private relaunchById(id: string): void {
    // Thin helper so the summary's "Again" button can re-enter the last
    // exercise without reaching into the catalog from UI code.
    const d = findExercise(id)
    if (d) void this.launchExercise(d)
  }

  // ── Internal ────────────────────────────────────────────────────────────

  // Drives the synth off `learnState.status`. Split from the App's appState
  // listener so Learn never races Play for control over the synth.
  private onStatusChange(status: LearnStatus): void {
    const { synth, clock } = this.ctx.services
    if (status === 'playing') {
      void synth.play(clock.currentTime)
      if (!this.firstPlayLogged) {
        this.firstPlayLogged = true
        const midi = this.learnState.state.loadedMidi
        track('first_play', {
          mode: 'learn',
          duration_s: midi ? Math.round(midi.duration) : null,
        })
      }
    } else if (status === 'paused') {
      synth.pause()
    }
  }

  // ── Host element management ────────────────────────────────────────────

  private mountHostElements(overlay: HTMLElement): void {
    if (this.hubHost && this.exerciseHost) return
    const hub = document.createElement('div')
    hub.className = 'learn-host learn-host--hub'
    const ex = document.createElement('div')
    ex.className = 'learn-host learn-host--exercise'
    overlay.appendChild(hub)
    overlay.appendChild(ex)
    this.hubHost = hub
    this.exerciseHost = ex
  }

  private unmountHostElements(): void {
    this.hubHost?.remove()
    this.exerciseHost?.remove()
    this.hubHost = null
    this.exerciseHost = null
  }

  private showHubView(): void {
    if (!this.hubHost || !this.exerciseHost) return
    this.hubHost.classList.remove('learn-host--hidden')
    this.exerciseHost.classList.add('learn-host--hidden')
    this.view.set('hub')
    // The hub never shows the rolling piano — flush any MIDI + live notes an
    // exiting exercise (or a prior Play-mode session) left on the renderer so
    // the background stays quiet behind the hub chrome.
    this.ctx.services.renderer.clearMidi()
    // Hide the Pixi stage (notes lane + keyboard strip) while the catalog is
    // showing — exercise mount restores it. stage.visible=false also skips
    // per-frame draw work, not just compositing.
    this.ctx.services.renderer.setVisible(false)
  }

  private showExerciseView(): void {
    if (!this.hubHost || !this.exerciseHost) return
    this.hubHost.classList.add('learn-host--hidden')
    this.exerciseHost.classList.remove('learn-host--hidden')
    this.view.set('exercise')
    this.ctx.services.renderer.setVisible(true)
  }

  // App opens the shared file picker, but the file's destination is
  // mode-aware: see the DropZone wiring in App.init.
  private openLearnFilePicker(): void {
    this.ctx.openFilePicker()
  }

  private showError(msg: string): void {
    const el = document.createElement('div')
    el.className = 'toast'
    el.textContent = msg
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 4000)
  }
}
