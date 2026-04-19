---
title: Playing your MIDI keyboard in the browser — a 2026 guide to Web MIDI
description: How to plug a MIDI keyboard into a browser tab and play notes, including what actually works, what doesn't, and the latency expectations you should set.
path: /blog/playing-your-midi-keyboard-in-the-browser/
type: post
date: 2026-04-17
readingTime: 7 min read
---

# Playing your MIDI keyboard in the browser

Everything I know about using a MIDI keyboard with a browser-based music app in 2026 — learned the hard way building [midee](/). What actually works, what's janky, and the realistic latency you should expect.

## The short version

1. Plug your MIDI keyboard into your computer via USB. (Bluetooth MIDI works too but adds 15–40ms of latency.)
2. Open a browser that supports Web MIDI (Chrome, Edge, Opera, Safari 18+).
3. Open any Web MIDI app (midee, an online piano, etc.) and accept the MIDI permission prompt.
4. Start playing. Most apps auto-detect devices and start receiving notes within a second.

If that works on the first try, you're done. The rest of this post is for when it doesn't, or when you want to understand what's actually happening.

## What "Web MIDI" actually means

Web MIDI is a standard API — [MDN: Web MIDI API](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API) — that lets a webpage request access to connected MIDI devices through the browser. The code looks roughly like this:

```js
const access = await navigator.requestMIDIAccess({ sysex: false })

for (const input of access.inputs.values()) {
  input.addEventListener('midimessage', (e) => {
    const [status, pitch, velocity] = e.data
    // Handle note on / note off
  })
}
```

Browser-side, all the heavy work (driver detection, permission prompt, message routing) is handled by the browser. Your code gets a callback with the raw MIDI bytes for every event.

## Browser support

| Browser | Web MIDI |
| --- | --- |
| Chrome / Edge / Opera | ✅ Since 2015 |
| Safari | ✅ 18+ (2024) |
| Firefox | ✅ 108+ (2022) |
| Firefox on mobile | ❌ (desktop only) |
| iOS Safari | ❌ (iPadOS Safari 17.4+ works) |

As of 2026, Web MIDI is broadly deployable. The main gap is iPhone Safari, which still doesn't support it, and Firefox Android. If you're building for desktop or iPad, you're fine.

## What counts as a "MIDI keyboard" for this purpose

Any device that shows up to the OS as a MIDI class-compliant device. In practice:

- **USB MIDI controllers** — Akai, Arturia, Native Instruments, M-Audio, Nektar, Roland, etc. All standard-compliant. Plug in, done.
- **Bluetooth MIDI controllers** — Works but adds measurable latency. Fine for noodling, not for anything performance-critical.
- **DIN-MIDI keyboards + a USB-MIDI interface** — Same story. The OS sees a generic MIDI device via the interface.
- **iOS/iPad MIDI apps running as external controllers via Bluetooth or USB** — Also work, surprisingly reliably.

One thing that *doesn't* work: proprietary USB keyboards that require a company-specific driver and don't expose a standard MIDI interface. Very rare, but some older Yamaha and Roland keyboards fall into this category.

## The latency conversation

This is the question most people actually care about. Can you perform through a browser tab? Short answer: yes, for practice and casual jamming; it depends for anything performance-critical.

Approximate latencies you should expect:

| Component | Latency contribution |
| --- | --- |
| USB MIDI cable | <1 ms |
| Bluetooth MIDI | 15–40 ms |
| Browser event dispatch | 1–3 ms |
| Audio context scheduling | 0–20 ms depending on `baseLatency` |
| Speaker / headphone output | depends |
| **Total (USB + wired headphones)** | **~5–25 ms** |
| **Total (Bluetooth + Bluetooth headphones)** | **60–120 ms** ⚠ |

USB-to-wired-headphones is typically indistinguishable from a native DAW. Bluetooth-to-Bluetooth stacks the latency twice and becomes noticeable — good enough to practice with, not good enough to record takes against a metronome.

If you're feeling lag, the culprit is almost always:

1. Bluetooth audio output. Swap to wired headphones or a USB audio interface.
2. A browser tab with a lot of background work. Close other tabs.
3. An OS power-saving mode that's throttling the audio subsystem. On macOS, check "Low Power Mode"; on Windows, set the power plan to "Best performance."

## How apps should schedule audio for low-latency input

If you're building a Web MIDI app, how you schedule audio matters enormously. The gotcha: `setTimeout(() => piano.play(pitch), 0)` inside a MIDI event handler feels laggy even on fast hardware, because `setTimeout` jitters and the audio-context clock is sample-accurate.

The right pattern is to use the `AudioContext.currentTime` as the scheduling clock. When a MIDI event arrives, get the current audio-context time and schedule the note to play at that exact time:

```js
input.addEventListener('midimessage', (e) => {
  const [status, pitch, velocity] = e.data
  if ((status & 0xF0) === 0x90 && velocity > 0) {
    const scheduleTime = audioContext.currentTime
    piano.triggerAttack(pitch, scheduleTime, velocity / 127)
  }
})
```

This is sample-accurate — the audio fires at exactly the right moment regardless of JavaScript jitter. midee's live-play path uses this pattern; the visualization is deferred slightly to match, so the falling particles line up with the audio even when the browser is under load.

## The quirks nobody warns you about

### First-note delay with sampled instruments

Real piano samples are big. A good sampled piano (like [Salamander](https://sfzinstruments.github.io/pianos/salamander), which midee uses) is ~15 MB of audio data. The first keypress has to wait for the samples to decode and load into the audio graph. Subsequent notes are instant.

The workaround: start loading samples on app startup instead of on first keypress. midee does this — by the time you actually play, the samples are warm.

### Chrome's "autoplay policy" needs a gesture first

Chrome and Safari won't let an `AudioContext` start making sound until there's been a "user gesture" — a click, tap, or keypress. If you plug in a MIDI keyboard, open the app, and immediately start playing without ever clicking anything, you'll hear silence until your first click.

Workaround: the first MIDI note can unlock the audio context, if you wire it that way. Some apps require an explicit "Click to enable audio" button; midee treats the first gesture (click, keypress, or even a MIDI note with the keyboard input path) as the unlock.

### Held notes across tab switches

If you're holding a key when you switch tabs, the browser may stop dispatching events to the background tab. The note-off never arrives, and when you switch back, the note is still ringing. Defensive code in the app should release all held notes on `visibilitychange` and `blur` events. midee handles this in [`src/app.ts`](https://github.com/aayushdutt/midee/blob/master/src/app.ts) — it's ~5 lines, but it's the difference between a polished experience and a phantom-held-note bug.

### Permission prompts

Browsers ask for permission on first `requestMIDIAccess()`. If the user denies, there's no way to prompt again except through browser settings. Apps should detect denial and show a helpful message pointing to `chrome://settings/content/midiDevices` (or equivalent).

### Sysex messages are separate permission

If you need system-exclusive messages (for patch dumps, firmware updates, or certain controller features), that's a separate, more intrusive permission (`{ sysex: true }`). Most musical apps don't need it. Don't ask for it unless you do — the prompt scares people.

## Browser vs. DAW: when to use which

For most hobbyist use, the browser is now a perfectly credible music environment. Plugging a MIDI keyboard into a browser tab gives you:

- Zero install, zero setup.
- Near-native latency on USB + wired headphones.
- Hardware-accelerated visualization (WebGL/WebGPU) if the app uses it.
- Cross-platform by default (Mac, Windows, Linux, ChromeOS).

Where the browser still loses to a native DAW:

- **Professional recording workflows.** Buffer size tuning, ASIO drivers, multi-input recording — the browser doesn't expose these knobs.
- **Heavy multi-instrument sessions.** Dozens of simultaneous software instruments stretch the browser's audio graph; native DAWs manage this better.
- **VST/AU plugin libraries.** Web apps can't load your plugin collection.

For quick jamming, practice, and turning a MIDI into a nice video to share, the browser is now the right tool. Not a compromise, not a toy — a legitimate environment.

## Try it

[midee](/) is one use case. Plug in your MIDI keyboard, open the app, play a few notes. You'll know within ten seconds whether it feels responsive enough for you.

---

*midee is a free, open-source MIDI visualizer and loop station built around this stack. [Source on GitHub](https://github.com/aayushdutt/midee).*
