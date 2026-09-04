---
title: Midi2Vidi vs midee: Two Free Browser MIDI Visualizers Compared (2026)
description: Midi2Vidi and midee both turn MIDI files into falling-note piano videos in the browser for free. Here is how they differ on visuals, sound, export, practice features, and privacy.
path: /vs/midi2vidi/
ogDescription: Two free browser MIDI visualizers, compared on sound, visuals, export, practice features, and privacy.
type: page
modified: 2026-09-05
---

# Midi2Vidi vs midee

Midi2Vidi and midee solve the same first problem: you have a MIDI file and want a falling-notes piano video without installing anything or paying for a licence. Both are free, both run entirely in the browser, and both export MP4. If that is all you need, either will do the job. The differences show up in how the result sounds, how much control you have over the look, and what else you can do with the file once it is open.

This comparison is written from midee's side, so treat the judgement calls accordingly. The facts about Midi2Vidi come from its public site and changelog as of September 2026.

## What Midi2Vidi is

[Midi2Vidi](https://midi2vidi.com/) is a one-page web app by Dave Dixson, a UK developer, first made public in June 2024 and rewritten as a fully browser-based visualizer in June 2026. You drop in a MIDI, set a video width and height, choose a background colour, and export. Falling notes, particle effects, audio in the export, an instrument picker, and a playback-speed control were all added between June and July 2026. It is supported by donations, and its GitHub repository exists for issue tracking; the source is not published.

It is deliberately small. There are a handful of settings, no account, and no modes beyond play and export.

## What midee is

[midee](/) is an open-source browser app that started as a MIDI visualizer and grew into a player, a practice tool, and a live-performance surface. The visualizer side gives you five themes, thirteen sampled instruments, particle styles, per-track colours with mute and hide, transpose, speed, and export to MP4, MP3, WAV, or MIDI. Beyond that, Learn mode turns any file into wait-mode practice with a connected keyboard, and Live mode visualizes a MIDI keyboard in real time with a loop station.

## Quick comparison

|  | Midi2Vidi | midee |
| --- | --- | --- |
| Price | Free, donation supported | Free, open source |
| Runs in | Browser | Browser |
| Files uploaded | No | No |
| Falling notes over a keyboard | Yes | Yes |
| Visual options | Width, height, background colour, opacity, active-key colour, particles on or off | Five themes, particle styles, track colours, note glow |
| Sound | Yes, with an instrument picker | Thirteen sampled instruments, sustain pedal honoured |
| Per-track control | Select which instruments play, export MIDI for the selection | Hide, mute, or isolate any track |
| Playback speed | Yes | Yes |
| Transpose | No | Yes |
| Looping a section | No | Yes, in Learn mode |
| Video export | MP4, custom width and height | MP4 at 720p, 1080p, 4K; landscape, vertical, square presets |
| Audio-only export | No | MP3 and WAV |
| Practice mode with a MIDI keyboard | No | Yes, wait mode and sight-reading |
| Live MIDI keyboard visualization | No | Yes, with a loop station |
| Source code | Private, issues on GitHub | Public on GitHub |

{{cta:Try midee with your file|Free, in your browser, nothing uploaded. Drop in the same MIDI and compare.}}

## Where Midi2Vidi is the better pick

**You want the fewest decisions.** Midi2Vidi's settings fit on one panel. Set a size, pick a background colour, press export. There is less to learn and less to get wrong.

**You need an unusual video size.** Midi2Vidi takes any width and height you type. midee offers presets for the common platforms plus a native option that matches your window, which covers most cases but not every custom banner size.

**You only ever need a video.** If you will never use practice, live input, or audio export, midee's extra surface is weight you do not need.

## Where midee is the better pick

**Sound quality and instrument choice.** midee renders through multi-sampled instruments, so a piano MIDI comes out sounding like a recorded piano, and you can switch to Rhodes, strings, guitar, marimba, and others. Sustain pedal events are followed, which is most of the difference between a performance and a sequence of notes.

**Control over the look.** Themes change the whole palette in one click, particles come in several styles, and each track has its own colour so a two-hand arrangement reads as two hands.

**More than a video.** Audio-only MP3 and WAV export, transposition, section looping in Learn mode, and the MIDI download cover the things people usually want to do next with the same file.

**Learning and playing.** Wait-mode practice, the sight-reading trainer, and live keyboard visualization do not exist in Midi2Vidi. If a MIDI keyboard is plugged into your computer, midee uses it.

**Auditability.** midee's source is public. You can read exactly what happens to your file.

## Privacy

Both apps keep your MIDI on your device. Midi2Vidi's site says processing happens in the browser and its code loads the browser's own video encoder, and midee is a static app with no upload path. Neither requires an account. If privacy is the reason you are choosing between them, it is a tie.

## Export quality

Both apps use the browser's built-in video encoder, so the MP4 quality is comparable at a given resolution and neither adds a watermark. midee encodes at 8 Mbps and 30 fps by default with hardware acceleration when available, and offers 4K where the machine supports it. Midi2Vidi's output size is whatever you type in. Both need a browser with video encoding support, which means current Chrome, Edge, Firefox, and Safari.

## When to pick which

| Situation | Pick |
| --- | --- |
| Quickest possible falling-notes MP4 with default look | Either. Midi2Vidi has fewer steps. |
| The video needs to sound good | midee |
| Custom, non-standard video dimensions | Midi2Vidi |
| You want the audio as MP3 or WAV too | midee |
| You want to practise the piece with a keyboard | midee |
| You play live and want it visualized | midee |
| You want to read the code | midee |

## Frequently asked questions

**Is Midi2Vidi free?**
Yes. It is donation supported, with no paid tier listed on its site.

**Is midee free?**
Yes. It is open source with no paid tier, account, or watermark.

**Do either of them upload my MIDI file?**
No. Both run in the browser and process the file locally.

**Which produces the better-sounding video?**
midee, because it uses multi-sampled instruments and honours sustain pedal events. Midi2Vidi added audio support in June 2026 with an instrument picker; its sound engine is not documented, so judge it by ear with your own file.

**Can I use my MIDI keyboard with either?**
Only midee. It has a live mode and a practice mode that use a connected keyboard through Web MIDI.

## Try midee

[Open midee](/), drop in the same MIDI file you were going to use, and compare. It is free, open source, and nothing leaves your browser.

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Is Midi2Vidi free?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. Midi2Vidi is donation supported, with no paid tier listed on its site."
      }
    },
    {
      "@type": "Question",
      "name": "Is midee free?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. midee is open source with no paid tier, account, or watermark."
      }
    },
    {
      "@type": "Question",
      "name": "Do Midi2Vidi or midee upload my MIDI file?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. Both run in the browser and process the MIDI file locally."
      }
    },
    {
      "@type": "Question",
      "name": "Which produces the better-sounding video, Midi2Vidi or midee?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "midee uses thirteen multi-sampled instruments and honours sustain pedal events. Midi2Vidi added audio with an instrument picker in June 2026, but its sound engine is not documented, so compare with your own file."
      }
    },
    {
      "@type": "Question",
      "name": "Can I use a MIDI keyboard with Midi2Vidi or midee?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Only midee. It has a live mode and a practice mode that use a connected keyboard through Web MIDI."
      }
    }
  ]
}
</script>
