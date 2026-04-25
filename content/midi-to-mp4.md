---
title: How to turn a MIDI file into an MP4 video (free, in your browser)
description: How to turn a .mid file into a shareable MP4 — free, no install, no upload. Piano-roll visualization in 1080p, TikTok/Reels, or square aspect.
path: /midi-to-mp4/
type: page
---

# How to turn a MIDI file into an MP4 video

If you've got a `.mid` file and want a shareable MP4 video — piano-roll visualization, audio baked in, ready for YouTube or TikTok — you've got a few options, and most of them are more complicated than they need to be.

This page walks through the fastest way: open [midee](/), drop the MIDI in, hit export. Free, no account, no upload.

## The short version

1. Open [midee.app](/) in Chrome, Safari, or Firefox.
2. Drag your `.mid` file anywhere on the page.
3. Pick a theme, instrument, and particle style if you care (defaults look fine).
4. Click **Export** in the top right.
5. Pick a resolution: 720p, 1080p, vertical for TikTok/Reels, square, or native.
6. Click **Start**. Wait a few seconds to a minute depending on length.
7. An MP4 downloads to your device. Share, post, done.

That's it. The rest of this page explains how it works and what options exist if the defaults aren't what you want.

## Why most other options are slower

**Screen recording:** Open Synthesia or MIDIano, capture with OBS or QuickTime, trim in iMovie. Works, but you're now managing three tools, and the audio syncs poorly unless you're careful about frame rates.

**Upload-to-render services (midi2vidi, etc.):** Upload a MIDI, wait for a server to process it, download. Fine for one-off renders but slow, privacy-unfriendly, and the output aesthetic is dated.

**Pay for native software (SeeMusic, etc.):** Works beautifully if you pay the license fee. If you're rendering occasionally, it's overkill.

midee exists because none of the above were quick, free, and didn't involve uploading your MIDI somewhere.

## Picking the right aspect ratio

midee exports in five aspect ratios. Match the ratio to where you're posting:

| Destination | Pick | Resolution |
| --- | --- | --- |
| YouTube (landscape) | 1080p or 720p | 1920×1080 / 1280×720 |
| YouTube Shorts, TikTok, Reels, Stories | Vertical | 1080×1920 |
| Instagram feed (square) | Square | 1080×1080 |
| Embedding in a blog post | 720p or native | 1280×720 or your window's native ratio |

If you're unsure, pick 1080p. YouTube, Twitter, Discord, and blog embeds all handle 16:9 1080p beautifully.

## Picking a theme

Each theme changes the overall palette and mood. Click the theme button in the top HUD to cycle. The five options:

- **Dark** — classic black background, high-contrast notes. Readable on any device.
- **Midnight** — deep blues, softer contrast. Good for melancholy pieces.
- **Neon** — saturated accents, high-energy. Pairs with electronic tracks and upbeat pop covers.
- **Sunset** — warm oranges/reds. The community favorite for classical and film-score pieces.
- **Ocean** — teals and aquamarines. Calming, great for ambient or minimalist MIDIs.

Your theme persists across reloads, so you can set it once and forget it.

## Picking an instrument

By default midee uses a sampled Salamander Grand piano (the samples are about 15 MB and load on first note). The other three instruments are synthesized and load instantly:

- **Rhodes** — electric piano, warm and mellow. Great for ballads and jazz.
- **Pad** — sustained synth pad. Works for ambient and slow pieces.
- **Pluck** — short, percussive. Good for arpeggios and fast runs.

For piano pieces, stick with the sampled Grand. For anything else, experiment — the synthesized instruments are lightweight and load in a few hundred milliseconds.

## Particle styles

Particles bloom on every note-on. Click the particles button in the HUD to cycle through the styles. There's no wrong choice — it's mostly personal taste. Embers and Sparks are the most popular.

## How the export actually works

When you click Start, midee:

1. Rewinds the MIDI to time zero and walks through it frame by frame at your target frame rate (60fps by default).
2. At each frame, renders the piano-roll scene onto an HTML canvas (PixiJS does the heavy lifting via WebGL).
3. Hands the canvas to the browser's [WebCodecs `VideoEncoder`](https://developer.mozilla.org/en-US/docs/Web/API/VideoEncoder), which encodes it to H.264 — using your GPU's hardware encoder when available.
4. In parallel, renders the audio through [Tone.js](https://tonejs.github.io/)'s offline audio context — which runs ~30× faster than realtime, so audio is done before video usually finishes.
5. Muxes the video and audio streams into an MP4 container using [Mediabunny](https://mediabunny.dev/) (ISOBMFF / MP4 writer; tree-shaken in the export path).
6. Offers the finished MP4 as a download.

All of this happens in your browser tab. No server sees your MIDI, your rendered frames, or the final video. The entire pipeline is local, hardware-accelerated, and open source.

If you're curious about the technical decisions, there's a [longer blog post](/blog/why-i-replaced-ffmpeg-wasm-with-webcodecs/) on why midee uses WebCodecs instead of the more common `ffmpeg.wasm` approach.

## Troubleshooting

**"It's slow on my machine."**
Export speed depends on your GPU's video encoder and your CPU. On a modern laptop, a 60-second MIDI typically exports in 2-6 seconds. If it's taking significantly longer: close other tabs; WebCodecs falls back to software encoding on older GPUs, which is 10-20× slower.

**"The audio sounds thin."**
The default Salamander piano samples are realistic but opinionated. Try a different instrument (Rhodes or Pad both have a warmer character) or layer multiple tracks if your MIDI has them.

**"Firefox export doesn't start."**
Firefox's WebCodecs `VideoEncoder` shipped in Firefox 130 (Sept 2024). If you're on an older version, upgrade, or use Chrome/Safari.

**"My MIDI has a lot of tracks and the colors overlap."**
midee assigns each track a distinct color automatically. Toggle tracks in the Tracks panel (top-right) to hide/show individual ones before exporting.

**"Is there a way to trim or edit the MIDI before exporting?"**
Not yet — midee plays and renders what's in the `.mid`. For light trimming, tools like [MidiEditor](https://www.midieditor.org/) (free, cross-platform) work well upstream.

## Try it with the demo MIDIs

If you don't have a MIDI handy, midee ships with three public-domain pieces on the home screen:

- Bach — Prelude in C (BWV 846), 1:30 — sparkles, instantly recognizable.
- Erik Satie — Gnossienne No. 1, 3:12 — slow, proves sustained notes shine.
- Chopin — Nocturne in E♭ major, Op. 9 No. 2, 4:30 — dramatic, tests multi-voice.

Click any of them on the home screen to load and autoplay. Then click Export in the top right to try a render end-to-end.

## Try it

[Open midee](/), drop a MIDI, hit Export. If it's useful, tell someone. midee is open source on [GitHub](https://github.com/aayushdutt/midee) — stars and issues welcome.
