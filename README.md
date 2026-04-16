# Piano Roll

A luminous, zero-install piano-roll player for the browser. Drop in a MIDI file and watch notes cascade past a full 88-key keyboard — or plug in a controller (or your laptop keyboard) and play live with particle trails, glow, and swappable themes.

Built on PixiJS (WebGL) + Tone.js, with an in-browser MP4 exporter via WebCodecs.

## Features

- **MIDI playback** — drag in any `.mid` / `.midi`, multi-track, per-track color.
- **Live mode** — Web MIDI devices or QWERTY keyboard (FL Studio layout).
- **Four instruments** — Piano (sampled), Rhodes, Pad, Pluck.
- **Particle bursts & glow** — with sustained trails while notes are held.
- **Five themes** — Dark, Midnight, Neon, Sunset, Ocean.
- **MP4 export** — frame-accurate, 720p / 1080p / match-window, fully offline.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static bundle → dist/
```

Requires **Node 18+** and a browser with [Web MIDI](https://caniuse.com/midi) and [WebCodecs](https://caniuse.com/webcodecs) (Chrome 94+, Safari 16.4+, Firefox 130+).

## Controls

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `Z`..`M` · `Q`..`P` | Play notes (two octaves) |
| `S D G H J` · `2 3 5 6 7` | Black keys |
| `←` / `→` | Octave down / up |

Drop a MIDI file anywhere on the window to load it. Click the theme, instrument, or particle buttons in the HUD to cycle.

## Tech stack

[Vite](https://vitejs.dev/) · TypeScript · [PixiJS 8](https://pixijs.com/) · [Tone.js](https://tonejs.github.io/) + [@tonejs/piano](https://github.com/Tonejs/Piano) · [@tonejs/midi](https://github.com/Tonejs/Midi) · [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) + WebCodecs

## License

MIT.
