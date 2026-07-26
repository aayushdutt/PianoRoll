import { render } from '@solidjs/testing-library'
import type { JSX } from 'solid-js'
import { vi } from 'vitest'
import type { AppServices } from '../core/services'
import { AppCtx, type AppCtxValue } from '../store/AppCtx'
import { createAppStore } from '../store/state'

// ── Component test harness ────────────────────────────────────────────────
//
// Every `.tsx` mode component calls `useApp()` (src/store/AppCtx.ts), which
// throws outside an `<AppCtx.Provider>`. `renderWithApp` mounts a component
// inside a provider wired with a *fake* `AppCtxValue` so the component can
// render in jsdom without a real `App` (no Pixi/WebGL/Tone/AudioContext).
//
// Design:
//   · The store is a REAL Solid store (`createAppStore()` is cheap and pure),
//     so reactive reads (`store.state.mode`, etc.) behave exactly as in prod.
//   · Every other service/handle/callback is a `vi.fn()`-backed stub, following
//     the `null as never` pattern from learn/core/ExerciseRunner.test.ts for
//     slots a given component never touches. Each stub is a spy so tests can
//     assert intent-method calls on interaction.
//   · `overrides` deep-patch any slot per test (replace a service, swap a
//     callback, or pre-seed the store via `overrides.services.store`).
//
// The harness returns the `@solidjs/testing-library` result PLUS the assembled
// `ctx` so tests can both drive the UI (clicks) and assert against the fakes
// (`ctx.resetInteractionState`, `ctx.services.renderer.clearMidi`, …).

/** A `vi.fn()`-backed renderer stub satisfying `AppServices['renderer']`
 * (the `VisualizationSurface` contract — see `renderer/VisualizationSurface.ts`),
 * not the concrete `PianoRollRenderer`. Only the methods mode components call
 * are present; cast to the full type for the rest (never invoked in these tests). */
function fakeRenderer(): AppServices['renderer'] {
  return {
    clearMidi: vi.fn(),
    loadMidi: vi.fn(),
    setVisible: vi.fn(),
    setLiveNotesVisible: vi.fn(),
  } as unknown as AppServices['renderer']
}

/** Minimal services bag: real store, fake renderer, `null as never` for the
 * audio/clock/input slots no mode component reaches in jsdom. */
function fakeServices(): AppServices {
  const store = createAppStore()
  return {
    store,
    clock: null as never,
    synth: null as never,
    metronome: null as never,
    renderer: fakeRenderer(),
    input: null as never,
  }
}

/** Build the default fake `AppCtxValue`. Every field is a spy or a real store
 * so a test can assert on it without further setup. */
function makeFakeCtx(): AppCtxValue {
  const services = fakeServices()
  return {
    services,
    // `store` mirrors `services.store` — both surfaces resolve the same store
    // in the real `createApp()` wiring (see createApp.ts).
    store: services.store,
    trackPanel: { close: vi.fn(), render: vi.fn() } as unknown as AppCtxValue['trackPanel'],
    dropzone: { show: vi.fn(), hide: vi.fn() } as unknown as AppCtxValue['dropzone'],
    keyboardInput: {
      enable: vi.fn(),
      disable: vi.fn(),
    } as unknown as AppCtxValue['keyboardInput'],
    midiInput: {
      status: { value: 'disconnected' },
    } as unknown as AppCtxValue['midiInput'],
    // Resolves to a benign fake controller (enter/exit are no-ops) so the
    // Learn mode shell mounts without crashing. Override per test to assert on
    // the resolved controller or to make the chunk-load reject.
    ensureLearnController: vi.fn(
      async () =>
        ({ enter: vi.fn(), exit: vi.fn() }) as unknown as Awaited<
          ReturnType<AppCtxValue['ensureLearnController']>
        >,
    ) as unknown as AppCtxValue['ensureLearnController'],
    resetInteractionState: vi.fn(),
    openFilePicker: vi.fn(),
    primeInteractiveAudio: vi.fn(),
  }
}

/** Deep-merge `overrides` into the base fake ctx — one level into `services`
 * so a test can replace just `services.renderer` (or `services.store`) without
 * restating the whole bag. */
function applyOverrides(base: AppCtxValue, overrides?: DeepPartialCtx): AppCtxValue {
  if (!overrides) return base
  const { services: serviceOverrides, ...rest } = overrides
  const merged: AppCtxValue = { ...base, ...rest } as AppCtxValue
  if (serviceOverrides) {
    merged.services = { ...base.services, ...serviceOverrides }
    // Keep the top-level `store` handle in lock-step with `services.store`.
    if (serviceOverrides.store) merged.store = serviceOverrides.store
  }
  return merged
}

/** Per-test overrides: patch any top-level ctx field, or any single service. */
export type DeepPartialCtx = Partial<Omit<AppCtxValue, 'services'>> & {
  services?: Partial<AppServices>
}

/** Result of {@link renderWithApp}: the testing-library render result plus the
 * assembled fake `ctx` (spies + real store) for assertions. */
export type RenderWithAppResult = ReturnType<typeof render> & { ctx: AppCtxValue }

/**
 * Render a Solid component inside a fake `<AppCtx.Provider>`.
 *
 * @param ui        A zero-arg function returning the component's JSX (the
 *                  `@solidjs/testing-library` render callback form).
 * @param overrides Optional per-test patches for the fake ctx (top-level
 *                  fields and/or individual `services` slots; passing
 *                  `services.store` swaps the store and keeps the top-level
 *                  `store` handle aligned).
 * @returns The testing-library result extended with `ctx` (the fake
 *          `AppCtxValue` — spies for handles/callbacks, a real store).
 *
 * @example
 *   const { ctx } = renderWithApp(() => <HomeMode />)
 *   expect(ctx.resetInteractionState).toHaveBeenCalled()
 *   expect(ctx.services.renderer.clearMidi).toHaveBeenCalled()
 */
export function renderWithApp(
  ui: () => JSX.Element,
  overrides?: DeepPartialCtx,
): RenderWithAppResult {
  const ctx = applyOverrides(makeFakeCtx(), overrides)
  const result = render(() => <AppCtx.Provider value={ctx}>{ui()}</AppCtx.Provider>)
  return Object.assign(result, { ctx })
}
