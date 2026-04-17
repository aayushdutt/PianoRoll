# midee

A beautifully-designed, web-native MIDI studio. Drop a `.mid` and it plays on a full 88-key piano with cascading notes, glowing keys, and particle bursts. Plug in a MIDI controller — or use your laptop keyboard — to play along. Loop what you played, layer it, bounce it out as a 1080p MP4. Everything runs locally inside one browser tab. No install, no upload, no server, no watermark.

Try it at **[midee.app](https://midee.app)**.

<!-- ![midee in motion](docs/hero.gif) -->

## What's in the box

- **MIDI playback** — drop any `.mid`, multi-track, per-track color, full 88 keys.
- **Live mode** — Web MIDI controllers or QWERTY (FL Studio layout). Sample-accurate AudioContext scheduling.
- **Loop recorder** — bar-snapped to the metronome, layerable, undo stack, export as `.mid`.
- **Instruments** — sampled Salamander Grand piano, Rhodes, pad, pluck. Lazy-loaded.
- **Five themes + growing particle styles** — Dark, Midnight, Neon, Sunset, Ocean.
- **MP4 export** — 60 fps, frame-accurate, audio baked in. 720p / 1080p / vertical (TikTok, Reels) / square / native. Rendered locally via WebCodecs — no ffmpeg.wasm, no COOP/COEP gymnastics, no watermark.

## Why

Every existing tool asks you to give something up — money, polish, or your browser tab.

- **SeeMusic** — beautiful, native, paid.
- **MIDIano** — free and web-native, but built like a 2012 learning tool.
- **midi2vidi** — server-side, slow, aesthetic of a batch job.

midee is the one that doesn't. Web-native, free, open source, and one click from cinema-quality MP4.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static bundle → dist/
```

Node 18+ and a modern browser with [Web MIDI](https://caniuse.com/midi) and [WebCodecs](https://caniuse.com/webcodecs) — Chrome 94+, Safari 16.4+, Firefox 130+.

## Controls

| Key                       | Action                   |
| ------------------------- | ------------------------ |
| `Space`                   | Play / pause             |
| `Z`..`M` · `Q`..`P`       | Play notes (two octaves) |
| `S D G H J` · `2 3 5 6 7` | Black keys               |
| `←` / `→`                 | Octave down / up         |

Drop a `.mid` anywhere on the window to load it. Click the theme, instrument, or particle buttons in the HUD to cycle.

## Under the hood

- **Rendering** — [PixiJS 8](https://pixijs.com/) (WebGL/WebGPU). One `Graphics` per track so same-color notes batch into a single draw call; glow applied only to the active-notes container for perf.
- **MIDI parse** — [@tonejs/midi](https://github.com/Tonejs/Midi), normalized through a local type layer so nothing downstream depends on it.
- **Audio** — [Tone.js](https://tonejs.github.io/) transport + [@tonejs/piano](https://github.com/Tonejs/Piano) (Salamander Grand samples, lazy-loaded), `Tone.PolySynth` fallback when samples aren't ready.
- **Video export** — [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) + WebCodecs `VideoEncoder`. Frames driven by the render clock (not wall time), so export is deterministic and matches live playback bit-for-bit.
- **Build** — Vite + strict TypeScript (`noUncheckedIndexedAccess`).

## Contributing

midee is young and opinionated. New themes, particle styles, or instruments are the easiest wedge — open a PR with a short clip. For bigger changes, open an issue first so we can align on direction.
