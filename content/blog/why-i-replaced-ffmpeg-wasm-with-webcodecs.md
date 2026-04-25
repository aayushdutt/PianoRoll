---
title: Why I replaced ffmpeg.wasm with WebCodecs for video export
description: How ditching MediaRecorder + ffmpeg.wasm for WebCodecs cut browser video export time by 10×, dropped peak memory 40%, and removed 30 MB of WASM.
path: /blog/why-i-replaced-ffmpeg-wasm-with-webcodecs/
type: post
date: 2026-04-18
readingTime: 8 min read
---

# Why I replaced ffmpeg.wasm with WebCodecs for video export

The first version of midee's MP4 export pipeline worked like this: capture the canvas with `MediaRecorder` into a WebM blob, then transcode that blob to H.264 MP4 via `ffmpeg.wasm`. It shipped in a day, it worked, and it was also the single worst-performing subsystem in the app.

A 60-second MIDI took 30–120 seconds to export depending on the machine. Every export re-downloaded 30 MB of WASM from unpkg. And because the browser was double-encoding (first WebM via a hardware VP9 encoder, then H.264 via WASM with no GPU access), the output quality was capped by the first pass, and then the second pass could only make things worse.

After migrating to [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) plus a small in-browser MP4 muxer ([Mediabunny](https://mediabunny.dev/) today; originally [mp4-muxer](https://github.com/Vanilagy/mp4-muxer), now deprecated in favor of Mediabunny), the same 60-second MIDI exports in 2–6 seconds — a 10–30× speedup — with better quality, lower memory, zero WASM, and zero runtime network fetches. This post walks through why the old pipeline was slow, how WebCodecs fixes it, and the sharp edges I ran into during the migration.

## The old pipeline, and why it was slow

```
Canvas frames
  │ (captureStream + requestFrame)
  ▼
MediaRecorder  ── WebM chunks (VP9, 8 Mbps) ──► in-memory Blob
  │
  ▼
ffmpeg.wasm  ◄── 30 MB WASM fetched from unpkg every export
  │ (transcode: libx264 ultrafast, CRF 20)
  ▼
output.mp4 ──► download
```

Three problems with this, in order of severity:

**1. Double lossy pass.** Every pixel went through two lossy codecs. First VP9 (hardware-accelerated, opaque, good) then libx264 (CPU-only inside WASM, no SIMD-level tricks available to a browser-sandboxed WASM, quality capped by the VP9 intermediate). The second pass couldn't improve on the first; it could only degrade or match.

**2. No hardware acceleration for the MP4 encode.** Every modern GPU has a dedicated H.264 encoder. `ffmpeg.wasm` can't touch it — WASM has no API to the GPU's video-encode block. So the final encode was running on my laptop's CPU, single-threaded-ish, while the GPU's H.264 encoder sat idle right next to it.

**3. 30 MB of WASM fetched per export.** No caching, no pre-load, no self-hosting. The first export paid a 1–3 second cold start on top of the encode. Three back-to-back exports meant three full downloads.

The fix for problem 3 is easy — cache the WASM, preload it, self-host it. The fix for problems 1 and 2 requires a different architecture entirely.

## What WebCodecs actually is

WebCodecs is a set of browser APIs — `VideoEncoder`, `VideoDecoder`, `AudioEncoder`, `AudioDecoder`, `VideoFrame`, `AudioData` — that give you direct access to the browser's underlying codec implementations. Those implementations are the same ones `<video>` and `MediaRecorder` already use internally, but WebCodecs exposes them as a low-level API you can drive from your own code.

Which means:

- The H.264 encoder that powers `<video autoplay>` is also the encoder you can call from JavaScript.
- On Chrome/Edge/Safari, that encoder is hardware-accelerated. VideoToolbox on macOS, Media Foundation on Windows, V4L2 on Linux. You don't write any GPU code — the browser does the right thing.
- You don't get a container (no MP4, no WebM). Just raw encoded chunks. You pick a muxer.

That last point is what makes WebCodecs feel different from `MediaRecorder`. `MediaRecorder` gives you a self-contained WebM/MP4 blob. WebCodecs gives you a stream of `EncodedVideoChunk`s and makes you assemble the final file yourself. For a visualizer that's fine — a tree-shaken ISOBMFF muxer handles it.

## The new pipeline

```
Canvas
  │ (new VideoFrame(canvas, { timestamp }))
  ▼
VideoEncoder  ── EncodedVideoChunk (H.264, hardware-accelerated) ──►
  │
  ▼
Muxer (Mediabunny MP4 output, pure TS)
  │
  ▼
MP4 Blob → download
```

No WASM. No transcode. Single lossy pass. Hardware accelerated. Here's the encoder setup:

```ts
import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'

const target = new BufferTarget()
const output = new Output({
  format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
  target,
})
const videoSource = new EncodedVideoPacketSource('avc')
output.addVideoTrack(videoSource, { frameRate: 60 })
await output.start()

let muxDrain = Promise.resolve()
const encoder = new VideoEncoder({
  output: (chunk, meta) => {
    muxDrain = muxDrain.then(() =>
      videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta),
    )
  },
  error: (e) => console.error(e),
})

encoder.configure({
  codec: 'avc1.42001f',
  width: canvas.width,
  height: canvas.height,
  bitrate: 8_000_000,
  framerate: 60,
  hardwareAcceleration: 'prefer-hardware',
  latencyMode: 'quality',
})
```

And the per-frame loop:

```ts
for (let i = 0; i <= totalFrames; i++) {
  renderSceneAt(i / fps)

  const frame = new VideoFrame(canvas, {
    timestamp: (i * 1_000_000) / fps,
  })
  encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 })
  frame.close()

  if (encoder.encodeQueueSize > 30) {
    await new Promise(r => setTimeout(r, 0))
  }
}

await encoder.flush()
await muxDrain
videoSource.close()
await output.finalize()
const blob = new Blob([target.buffer!], { type: 'video/mp4' })
```

That's the whole export — ~40 lines. The ffmpeg-based version was closer to 200.

## Sharp edges I ran into

### VideoFrame lifetime

Every `new VideoFrame(canvas, ...)` allocates a GPU texture. If you don't call `frame.close()`, you leak GPU memory — and browsers will eventually stall the encoder when the pool fills up. It's easy to miss in happy-path code. I wrap each `encode()` call so the close is guaranteed even if the encode throws.

### Encoder queue backpressure

You can render frames faster than the encoder consumes them. `encoder.encodeQueueSize` tells you how many are pending. If you don't check it, memory balloons. The fix is the `if (encoder.encodeQueueSize > 30)` yield in the loop above — classic async backpressure.

### Codec string negotiation

`avc1.42001f` is H.264 Baseline Level 3.1 — the most compatible option, max resolution 1280×720. For 1080p you want `avc1.4d0029` (Main 4.1) or `avc1.640029` (High 4.1). Different browsers and GPUs support different profiles, so I call `VideoEncoder.isConfigSupported(config)` first and pick the best tier that works.

```ts
const configs = [
  { codec: 'avc1.640029', ... }, // High
  { codec: 'avc1.4d0029', ... }, // Main
  { codec: 'avc1.42001f', ... }, // Baseline (always supported)
]
for (const config of configs) {
  const { supported } = await VideoEncoder.isConfigSupported(config)
  if (supported) return config
}
```

### Keyframe cadence

WebCodecs encoders don't insert keyframes on their own. You tell each frame whether it's a keyframe via `encoder.encode(frame, { keyFrame: true })`. I keyframe every 2 seconds (`i % (fps * 2) === 0`). Too few keyframes and the output MP4 is un-seekable in video players; too many and the file bloats.

### `fastStart: 'in-memory'`

The `moov` atom — the MP4 metadata that tells a player where everything is — normally lives at the *end* of the file. Video players can't start playback until they've downloaded the moov. `fastStart: 'in-memory'` makes the muxer rewrite the file so the moov is at the front. Costs a small amount of memory but makes the output playable from byte zero, important for users who open the MP4 in a browser tab immediately after download.

### The COOP/COEP dance that WebCodecs *doesn't* need

`ffmpeg.wasm` requires `SharedArrayBuffer`, which requires your site to send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. That breaks anything that embeds from a different origin — most third-party analytics, most CDN-hosted fonts, and any `<iframe>` that doesn't opt in. It's a mess to manage, especially across development and production environments.

WebCodecs doesn't use `SharedArrayBuffer`. No COOP, no COEP, no cross-origin headaches. For a static-hosted web app this is a big ergonomic win; I was able to drop multiple deployment config files once the migration was done.

## The speedup in numbers

| | ffmpeg.wasm pipeline | WebCodecs pipeline |
| --- | --- | --- |
| 60s MIDI export (M1 MBP) | ~35s | ~3s |
| 60s MIDI export (2018 Intel laptop) | ~90s | ~12s |
| Peak memory | ~80 MB | ~48 MB |
| Bundle size added | ~30 MB WASM at runtime | muxer in dynamic export chunk (Mediabunny) |
| Network fetches at export time | 2 (ffmpeg-core.js, .wasm) | 0 |
| Double lossy pass | Yes | No |

The `isConfigSupported` fallback keeps the door open for fallback-to-software-encode on older hardware, but in practice, every machine with hardware H.264 (which is basically everything shipped since 2015) gets the GPU-accelerated path.

## When ffmpeg.wasm is still the right call

`ffmpeg.wasm` isn't wrong; it was just wrong for *this* app. If you need container conversion (MKV to MP4, MOV to WebM), stream remuxing, codec translation for playback-only scenarios, or any of ffmpeg's 300-plus filters (crop, scale, overlay, drawtext, etc.), WebCodecs won't help you — it encodes and decodes, it doesn't filter.

Rule of thumb:

- **Recording/encoding original video in a browser** → WebCodecs.
- **Format conversion or post-processing** → ffmpeg.wasm.

If your app does both, you can combine them: WebCodecs for the capture path, ffmpeg.wasm for whatever post-processing happens off the hot path. Don't chain them like I did at first, though — each lossy pass compounds.

## Browser support as of 2026

| Browser | `VideoEncoder` (H.264) |
| --- | --- |
| Chrome / Edge | ✅ 94+ (Aug 2021) |
| Safari | ✅ 16.4+ (March 2023) |
| Firefox | ✅ 130+ (Sept 2024) |

Firefox was the last holdout. With 130+ shipping hardware-accelerated `VideoEncoder` on every desktop platform, WebCodecs is now broadly deployable, and I was comfortable defaulting to it in midee and keeping the ffmpeg fallback only for truly ancient browsers. In practice, the fallback basically never runs.

## Takeaways

1. **`MediaRecorder` + re-encode is almost always a mistake.** Two lossy passes for one output is wasted CPU, wasted memory, and degraded quality. If the browser can give you the target codec directly, use it.
2. **WebCodecs skips the container layer.** That's a feature, not a drawback — pair it with a small in-browser muxer and you skip the 30 MB of WASM entirely.
3. **Hardware acceleration matters more than any algorithmic optimization you can write.** A CPU-bound H.264 encoder in WASM with manual SIMD will still lose to the GPU's dedicated encode block by an order of magnitude. Pick the hardware path first.
4. **Pure-TS muxers are surprisingly good.** Mediabunny (and the earlier `mp4-muxer` it supersedes) handles MP4 box structure, `moov` placement, fast-start, and multi-track interleaving. You don't need to write an MP4 parser.

If you're shipping a browser app that needs to produce a video file — a recorder, a visualizer, a presentation tool — WebCodecs is now the default. There's very little reason to reach for `MediaRecorder + transcode` in 2026.

---

*[midee](/) is the MIDI visualizer I built this pipeline for. It's free, open source, and runs entirely in your browser. [Source on GitHub](https://github.com/aayushdutt/midee).*
