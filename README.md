# midee

**A beautiful, browser-native MIDI studio.** Drop a `.mid` and it plays on a full
88-key piano with cascading notes, glowing keys, and particle bursts. Plug in a
MIDI controller — or just use your laptop keyboard — to play along, loop
phrases, learn songs, and bounce takes out as a 1080p MP4.

Everything runs locally in one browser tab. No install, no upload, no server,
no watermark.

> [**midee.app**](https://midee.app) — open it and drop a file.

<!-- Drop a hero gif/screenshot here when ready: docs/hero.gif -->

---

## Features

**Visualizer**

- 88-key piano with multi-track playback, per-track color, and live note glow.
- Five themes (Dark, Midnight, Neon, Sunset, Ocean) and a growing library of
  particle styles.
- Resizable keyboard, pinnable HUD, chord readout overlay.

**Live performance**

- Web MIDI controllers, with sustain pedal (CC64) support.
- QWERTY keyboard fallback (FL Studio layout) for laptops without a controller.
- Sample-accurate AudioContext scheduling — what you press is what you hear.
- Sampled instruments.
  Lazy-loaded so the first paint stays fast.

**Looping & recording**

- Loop station with bar-snap to the metronome, layered overdubs, and an undo
  stack. Export the loop as `.mid`.
- Full-session record — capture an entire performance, then save as `.mid` or
  drop it back into file mode to render an MP4.

**Practice mode**

- Synthesia-style "wait for the right notes" — pauses the song until you play
  the upcoming chord, then resumes in time. Respects muted tracks.

**MP4 export**

- 60 fps, frame-accurate, audio baked in.
- 720p, 1080p, vertical (TikTok / Reels), square, or native canvas size.
- Rendered locally via WebCodecs — no `ffmpeg.wasm`, no `COOP/COEP`
  gymnastics, no watermark.

**Polish**

- Localized in English, Spanish, French, and Brazilian Portuguese.
- Touch-friendly on tablets; bottom-sheet popovers on small screens.
- Privacy-friendly: zero file uploads, zero account, telemetry is opt-in.

---

## Why

Existing tools force a tradeoff:

| Tool      | Tradeoff                                   |
| --------- | ------------------------------------------ |
| SeeMusic  | Beautiful and native — but paid.           |
| MIDIano   | Free and web-native — but feels like 2012. |
| midi2vidi | Server-side, slow, unrefined output.       |

midee is the option that doesn't ask you to give something up. Web-native,
free, open source, and one click from a publish-ready MP4.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static bundle → dist/
```

**Requirements:** Node 18+ and a modern browser with
[Web MIDI](https://caniuse.com/midi) and
[WebCodecs](https://caniuse.com/webcodecs) — Chrome 94+, Safari 16.4+,
Firefox 130+.

---

## Keyboard

| Key                       | Action                   |
| ------------------------- | ------------------------ |
| `Space`                   | Play / pause             |
| `Z`–`M` · `Q`–`P`         | Play notes (two octaves) |
| `S D G H J` · `2 3 5 6 7` | Black keys               |
| `←` / `→`                 | Octave down / up         |

Drop a `.mid` anywhere on the window to load it. Click the customize button in
the HUD to switch theme, particles, or chord readout.

---

## Architecture

Single-page Vite + TypeScript app. Strict layering — nothing in `core/` knows
about the DOM; nothing in `renderer/` knows about audio.

```
core/      pure logic (MIDI types, clock, chord/practice engines)
audio/     Tone.js + sampled instruments + offline render
renderer/  PixiJS scene, particles, beat grid, keyboard
midi/      Web MIDI input, loop engine, session recorder
ui/        vanilla TS + CSS shell (controls, modals, menus)
export/    WebCodecs encoder + Mediabunny (MP4 mux)
i18n/      string tables (en bundled, others lazy-loaded)
store/     tiny Signal<T> reactive primitive
```

**Rendering** — [PixiJS 8](https://pixijs.com/) on WebGL/WebGPU. One
`Graphics` per track so same-color notes batch into a single draw call; the
glow filter is applied only to the active-notes container so per-frame cost
stays flat as the song grows.

**MIDI parse** — [@tonejs/midi](https://github.com/Tonejs/Midi), normalized
through a local type layer so nothing downstream depends on it directly.

**Video export** — [Mediabunny](https://mediabunny.dev/) (successor to mp4-muxer) +
WebCodecs `VideoEncoder`. Frames are driven by the render clock, not wall
time, so export is deterministic and matches live playback bit-for-bit.

**Tooling** — Vite, TypeScript (strict, `noUncheckedIndexedAccess`), Biome
for lint/format, Vitest for unit tests.

---

## Scripts

```bash
npm run dev          # vite dev server
npm run build        # type-check + production build
npm run preview      # serve dist/
npm run typecheck    # tsc --noEmit
npm run lint         # biome check
npm run test         # vitest run
npm run check        # typecheck + lint + tests (CI gate)
```
