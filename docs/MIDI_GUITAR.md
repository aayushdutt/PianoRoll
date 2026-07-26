# MIDI Guitar Support & Visualization

**Date:** 2026-07-22
**Status:** Canonical Reference / Active Documentation

## Overview

Midee includes native 6-string guitar fretboard visualization alongside its
standard 88-key piano roll. The guitar engine renders note events on a 24-fret
fretboard with waterfall note lanes, real-time live performance mapping,
multi-track visibility filtering, a localized keyboard-accessible fret grid,
and WebCodecs MP4 video export.

### Timbre Independence

Visualization mode (`piano` vs `guitar`) is **completely independent** of output audio timbre:

- Users can switch between Piano roll and Guitar fretboard surfaces without altering audio synthesis settings.
- MIDI notes can be visualized on the Guitar surface while playing back with any selected sampled or synthesized Midee instrument.
- Audio synthesis engine settings (e.g. Tone.js samplers or pluck synths) remain decoupled from the active canvas visualization surface.

---

## Quick Start

1. Open a `.mid` file in **Play**, or enter **Live** to use a MIDI controller,
   the computer keyboard, or the on-screen fretboard.
2. Choose **Guitar** in the Piano/Guitar view selector in the top strip.
3. Click or touch a fret to play that exact position. Drag horizontally, use a
   horizontal wheel gesture, or hold Shift while scrolling to pan across all
   24 frets.
4. To use the fretboard without a pointer in Play or Guitar Play-Along, Tab to
   it and follow the keyboard controls below. Live currently reserves Tab for
   its session shortcut; see the limitation below.
5. With a MIDI file loaded in **Play**, keep **Guitar** selected when starting
   MP4 export. The active surface is fixed for the duration of that export.
   Live-only performances cannot be exported directly as video.

The selected visualization is stored in `localStorage` as
`midee.visualizationMode` and survives navigation and reloads. An exercise that
requires the piano surface temporarily overrides the selection without
rewriting the saved Guitar preference.

---

## Technical Profile & Fretboard Geometry

Midee uses a standard 6-string, 24-fret profile. Each string exposes 25
positions: the open string plus frets 1 through 24.

- **Tuning:** Standard EADGBE
  - String 1 (High E): E4 (MIDI pitch 64)
  - String 2 (B): B3 (MIDI pitch 59)
  - String 3 (G): G3 (MIDI pitch 55)
  - String 4 (D): D3 (MIDI pitch 50)
  - String 5 (A): A2 (MIDI pitch 45)
  - String 6 (Low E): E2 (MIDI pitch 40)
- **Fret Range:** Frets 0 through 24 (spanning pitches E2 / MIDI 40 to E6 / MIDI 88 inclusive).
- **Tablature & Highway Geometry:**
  - On the horizontal fretboard surface, String 1 (High E) is displayed at the top and String 6 (Low E) at the bottom, matching standard tablature conventions.
  - On the note highway, lanes map left-to-right from low E (String 6) to high E (String 1).

---

## Supported Modes & Workflows

1. **Play Mode (Scheduled MIDI):**
   - Maps notes from loaded decoded MIDI files (`MidiFile`) via `buildGuitarSchedule` and precomputes guitar fingerings using `precomputeGuitarFingerings` (in `src/guitar/GuitarSurface.ts` and `src/guitar/fingering.ts`).
   - Groups note events into 40 ms time clusters, evaluating movement distance penalties against immediately preceding cluster positions (at matching cluster-array indices) and soft MIDI channel affinity across time clusters to schedule 6-string fretboard and highway note events.
2. **Live Performance (`assignLiveGuitarVoices`):**
   - Active live performance notes are assigned frame-by-frame via `assignLiveGuitarVoices` (in `GuitarSurface.ts`).
   - Direct user touch/mouse interactions on the fretboard canvas (via `FretboardInteraction`) explicitly specify and preserve targeted string and fret positions (`position: { string, fret }`), reserving those physical strings.
   - For remaining currently held live MIDI notes without explicit string assignments, it calls `assignGuitarCluster` with an empty state (`EMPTY_STATE`).
   - The production live path does **not** carry prior-cluster movement scoring or channel affinity across live renders.
3. **Play-Along Exercises:**
   - Integrates with Midee's interactive practice engine for step-by-step guitar play-along verification.
4. **Track Visibility & Filtering:**
   - Multi-track MIDI control allows toggling visibility per channel/track, determining which tracks render on the guitar surface.
5. **Touch & Mobile Ergonomics:**
   - Fretboard layout enforces string heights and touch target dimensions of at least 44 px (`MIN_FRET_TARGET_PX = 44`) for high touch accuracy on mobile screens.
   - Includes horizontal fretboard panning/scrolling so full 24-fret positions are accessible on smaller viewports.
6. **Keyboard & Assistive Technology:**
   - A persistent 6-row × 25-column DOM grid mirrors all 150 canvas positions with localized note, string, and fret labels.
   - The grid uses one roving tab stop; arrow navigation pans the corresponding fret into view and suppresses playback auto-follow while keyboard focus remains on the fretboard.
   - The DOM hit areas are pointer-transparent, so mouse and touch gestures continue to belong to the canvas.
7. **Active-Surface MP4 Export:**
   - WebCodecs video export (`VideoExporter`) is available for a loaded MIDI file in Play and renders whichever surface is active when export starts. Exporting while Guitar is selected produces an MP4 of the 6-string fretboard visualization; Live-only performances are not directly video-exportable.
   - Guitar adapts its layout to the requested output dimensions. The portrait/square **Focus** and **Speed** presets alter the piano roll's pitch range and scroll speed only, so they do not change Guitar output.

---

## Accessible Fretboard Controls

The accessibility layer is a native-button grid with six displayed rows
(String 1 / high E at the top through String 6 / low E at the bottom) and 25
columns (frets 0 through 24). Its labels follow the active Midee locale.

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | In Play or Guitar Play-Along, enter or leave the fretboard through its single roving tab stop. |
| Left/Right arrow | Move one fret lower or higher. |
| Up/Down arrow | Move one displayed string up or down. |
| `Home` / `End` | Move to fret 0 or fret 24 on the current string. |
| `Enter` / `Space` | Play a short note at the focused string/fret position. |

Keyboard navigation stays inside the grid instead of triggering the global
octave or transport shortcuts. Moving focus recenters later frets, and a window
resize keeps the focused position in view. A pointer or wheel gesture on the
canvas releases grid focus; normal manual-pan timing and automatic fret-follow
rules then apply. The first keyboard or pointer interaction also participates
in Midee's normal browser audio-unlock path.

**Live limitation:** Live mode currently reserves `Tab` for its session
recording shortcut, so sequential Tab entry into the fretboard is unavailable
there. Once a fret button has focus, the grid's own navigation and activation
keys work as described above. Pointer, computer-keyboard, and MIDI input remain
available in Live.

The grid is hidden and inert whenever the Guitar surface is not visible, and it
is removed on teardown. It therefore leaves no stale controls in the tab order
during a mode switch or piano-only exercise.

---

## Fingering Inference & MIDI Channel Affinity

Fret positions for external MIDI inputs are dynamically computed via dynamic programming / heuristic scoring (`assignGuitarCluster`), with distinct semantics between precomputed scheduled MIDI playback and real-time live input:

### Scheduled MIDI Precomputation (`precomputeGuitarFingerings`)
Loaded MIDI files undergo batch precomputation via `precomputeGuitarFingerings`:
- **40 ms Cluster Windowing:** Groups note events into 40 ms time windows (`GUITAR_CLUSTER_WINDOW_MS = 40`).
- **Prior-Position Movement Scoring:** Computes a movement distance penalty against immediately preceding cluster positions at the same cluster-array index (`movement += Math.abs(position.fret - previous.fret)`). Movement scoring evaluates only the immediately prior cluster order, without persisting movement history beyond that prior cluster.
- **Soft MIDI Channel Affinity:** Tracks channel affinity (`affinityByChannel`). Matching a voice's MIDI channel to a previously used string provides a soft scoring bonus (`-affinityMatches` in the score vector), encouraging consecutive notes on the same MIDI channel to stay on the same physical string without hard-locking channel assignments.
- **Span Preference:** Evaluates positions with a preference for a 4-fret hand span ($\le 4$ frets incur no penalty; wider spans incur a score penalty).
- **Polyphony & Low Frets:** Enforces at most one note per physical string per time cluster and favors open strings / lower fret positions.

### Real-Time Live Input Assignment (`assignLiveGuitarVoices`)
Live performance notes are assigned per render frame via `assignLiveGuitarVoices`:
- **Direct Interaction Preservation:** Direct touch/mouse clicks on the fretboard canvas explicitly set string and fret (`position: { string, fret }`), reserving those physical strings.
- **Stateless Frame Assignment:** Unassigned live notes are passed to `assignGuitarCluster` with an empty state (`EMPTY_STATE`). The production live path does not carry prior-cluster movement history or channel affinity state across live renders.

### Direct Interaction vs. Inferred Fingering
- **Direct Interaction:** Clicking or touching specific fretboard coordinates explicitly sets the string and fret, preserving the exact performed position.
- **External MIDI Fingering:** Fret assignments for external MIDI files or live MIDI controllers without string metadata are algorithmically inferred for ergonomics and visual clarity. They do **not** represent or attempt to reconstruct exact performed tablature or original performer finger placements.

---

## Handling of Unsupported Voices & Out-of-Range Notes

- **Pitch Range Bounds:** Standard EADGBE 24-fret range covers MIDI pitches 40 (E2) through 88 (E6) inclusive.
- **Behavior for Out-of-Range or Exceeded Polyphony Notes:**
  - **Audio Engine Path:** Out-of-range notes (pitch < 40 or pitch > 88) and notes exceeding 6-string polyphony continue to play through Midee's normal audio and synthesizer path (`SynthEngine`).
  - **Visible:** Out-of-range/exceeded notes remain visible on the UI and note highway.
  - **Play-Along Verification:** Marked as unassigned/unsupported (`supported: false`, `position: null`). They are **not required** for Guitar Play-Along exercise step matching or progress validation.

---

## Learn Mode Preference Persistence

- **Current Exercise Boundary:** Play-Along is the current Learn exercise that keeps Guitar available. The other current Learn exercises require the 88-key piano surface.
- **Piano-Forced Exercises:** Exercises in Learn mode designed specifically for 88-key piano temporarily force piano visualization (`visualizationForced = 'piano'`).
- **Forced-State Feedback:** While such an exercise is active, the view selector is disabled and announces why piano visualization is required; the Guitar canvas and accessibility grid are hidden.
- **Preference Restoration:** When leaving a piano-only exercise or unsetting the forced state (`visualizationForced = null`), the UI automatically restores the user's persisted visualization preference (`visualizationMode`, saved in `localStorage` as `'piano'` or `'guitar'`). Returning to Play or Live makes the restored Guitar surface and fret grid available again.

---

## Explicit v1 Exclusions

The following capabilities are **explicitly excluded** from v1:

1. **Microphone & Raspberry Pi Guitar Transcription:** Microphone and Raspberry Pi guitar audio-to-MIDI transcription is absent in v1 (the separate Raspberry Pi verification harness `?pi=1` is strictly piano-oriented for 88-key piano LED strip verification).
2. **Alternate Tunings:** Tuning is strictly standard EADGBE (no Drop D, DADGAD, Open G, or custom tunings).
3. **Continuous Pitch Bends & MPE:** Pitch bend wheel modulation and MIDI Polyphonic Expression (MPE) pitch curves are excluded in v1.
4. **Exact Performed Tablature:** Fret positions for external MIDI are algorithmically inferred for ergonomics rather than extracted from exact performer tablature.

---

## Related Research: Model Evaluation

For background research on ML-based guitar audio transcription (evaluating Basic Pitch and GAPS / François Leduc model checkpoints on GuitarSet), refer to the separate evaluation report:

- [Guitar Transcription Model Evaluation](./GUITAR_TRANSCRIPTION_MODEL_EVALUATION.md)

**Integration decision (2026-07-22):** that document represents an isolated
research spike. No evaluated audio-transcription model or dependency is
imported by the production app. Midee v1 Guitar mode accepts note events from
MIDI, computer-keyboard, and direct fretboard input; it does not accept
microphone or Pi guitar audio.

---

## Verification

The normal repository gate covers the guitar unit, integration, localization,
accessibility, and track-visibility behavior:

```bash
npm run check
```

Browser coverage includes MIDI playback, live MIDI and computer-keyboard input,
the accessible fret grid, pointer/touch interaction, Play-Along gating,
Learn-mode restoration, and surface ownership:

```bash
npm run test:e2e
```

The heavy suite additionally creates and parses a real 720p, 24 fps,
video-only Guitar MP4:

```bash
npm run test:e2e:heavy
```
