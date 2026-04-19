---
title: A free, open-source alternative to Synthesia
description: Honest comparison of Synthesia and midee — a free, open-source, browser-based piano-roll visualizer. When to use each, what's different, and why midee exists.
path: /vs/synthesia/
type: page
---

# A free, open-source alternative to Synthesia

If you've searched for "Synthesia alternative" you probably want one of two things:

1. A free tool to watch MIDI files play on a piano roll without paying for Synthesia's custom-song unlock.
2. A way to turn a MIDI into a nice-looking video you can post online.

Synthesia is great at what it does, but it's a native Windows/Mac/iOS/Android app focused on learning. For visualizing and sharing, there's a simpler option: **[midee](/)**, a free, open-source MIDI visualizer that runs entirely in your browser.

This page is a genuine comparison, not a hatchet job — Synthesia is the right choice for plenty of people. Here's how the two differ and when each makes sense.

## Quick comparison

|  | Synthesia | midee |
| --- | --- | --- |
| Platform | Windows, macOS, iOS, Android | Any browser (Chrome, Safari, Firefox) |
| Cost | Free with 150 built-in songs; **$29** one-time to unlock custom MIDIs on desktop | **Free, forever** |
| Open source | No | Yes, MIT license |
| Install required | Yes | No — just visit the URL |
| Primary focus | Learning to play the piano | Visualizing and exporting MIDI |
| Falling-notes display | Yes | Yes |
| MP4 video export | No (requires third-party screen recording) | Yes, built-in (1080p, TikTok/Reels aspect ratios) |
| Live play from a MIDI keyboard | Yes | Yes |
| Loop station / recording | No | Yes, bar-snapped |
| Themes / visual styles | A few built-in | Five themes + cycleable particle styles |
| Watermark on output | N/A (no export) | No watermark, ever |
| Your MIDI files leave your device? | No | No |

## Where Synthesia wins

Synthesia is the established tool in the category and there are real reasons to use it:

- **"Falling notes" for learning.** Synthesia was built around the teach-yourself-piano use case. The scoring, the left/right-hand split view, the wait-for-you mode — all of that is polished and tested.
- **Offline-first native app.** Once installed, you don't need a browser or an internet connection. If you teach piano lessons in a basement studio with spotty Wi-Fi, that matters.
- **Library of ready-to-play songs.** 150+ songs ship built-in; more are available for purchase.
- **Mature iPad and Android apps.** If your practice setup is iPad-only, Synthesia is ahead.

If learning piano is the main thing, Synthesia is probably the right fit.

## Where midee fits

midee didn't start as a Synthesia clone — it started because there was no browser-native tool that turned a MIDI into a nice-looking video without uploading anything or installing anything.

- **Zero install.** Open [midee.app](/) and it's running. No account, no download. If you want to share a link with a friend who's never heard of it, they can try it in five seconds.
- **Built-in MP4 export.** This is the thing Synthesia doesn't do. Hit record inside midee and you get a frame-accurate 1080p MP4 with audio baked in. 720p, 1080p, vertical for TikTok and Reels, square, or native resolution. Rendered locally in your browser via WebCodecs — no server, no upload.
- **Beautiful out of the box.** Five themes (Dark, Midnight, Neon, Sunset, Ocean), four instruments (sampled Salamander Grand piano, Rhodes, pad, pluck), and a rotating roster of particle styles. Your picks persist across reloads.
- **Free and open source.** MIT-licensed. No paywall, no unlock code for custom MIDIs. The [source code is on GitHub](https://github.com/aayushdutt/midee) and PRs are welcome.
- **Live mode + loop station.** Plug in a MIDI keyboard (Web MIDI) or use your laptop keyboard. Loop a phrase bar-snapped to the metronome. Record a session and export to `.mid` or straight to video.
- **Fully client-side.** Your MIDI file and the rendered video never leave your browser. There's no server to store, mine, or leak them.

## When to pick which

Use **Synthesia** if:

- You're learning piano and want scored lessons and a wait-mode.
- You're on iPad or Android and don't want a web app.
- You want a polished library of teacher-selected songs ready to play.

Use **midee** if:

- You want to turn a MIDI into a shareable video for YouTube, TikTok, Reels, or Instagram.
- You want to watch a MIDI file play beautifully without installing software.
- You're on a Chromebook, a locked-down work machine, or any platform where you can't install apps.
- You value open source, no watermark, no account, fully client-side.
- You want to jam on your MIDI controller without firing up a DAW.

The two tools don't cancel each other out — plenty of piano learners use Synthesia to practice and midee to render a final "here's what I've been working on" clip.

## Common questions

**Is midee really free, or free-with-upsell?**
Really free. MIT licensed. There's no paid tier, no custom-song unlock, no export watermark. No account required.

**Can I use the MIDI files I bought for Synthesia?**
Yes. midee reads any standard `.mid` or `.midi` file. Drag it into the browser window.

**Does midee upload my MIDI to a server?**
No. Everything runs in your browser. The MIDI file is parsed locally; audio and video are rendered locally; the exported MP4 is produced locally. Nothing is uploaded to midee at any point.

**Which browsers work?**
Chrome 94+, Safari 16.4+, Firefox 130+. The bottleneck is WebCodecs (for video export) and Web MIDI (for controller input). Desktop recommended; iPad works; phones are limited.

**Is it as pretty as SeeMusic?**
Different aesthetic. SeeMusic leans cinematic and heavy; midee leans design-forward and clean. Try both and pick the look you prefer. midee has the advantage that trying it is one click.

## Try it

midee is one URL away. [Open it](/), drop in a `.mid`, and see whether it earns a spot next to Synthesia in your workflow.
