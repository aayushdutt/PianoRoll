---
title: MIDI to WAV: Free Lossless Online Converter (2026)
description: Convert .mid to WAV in your browser. Free, lossless 16-bit 44.1 kHz audio rendered with sampled instruments. No upload, no account, no watermark.
path: /midi-to-wav/
ogDescription: Lossless 16-bit WAV from any .mid file, rendered with sampled instruments in your browser. Free, no upload.
type: page
modified: 2026-09-05
---

# How to convert MIDI to WAV in your browser

To convert a MIDI file to WAV for free, open [midee](/), drop in the `.mid` file, click **Export**, choose the **Audio** tab, select **WAV**, and click **Start**. The browser performs the file with a sampled instrument and writes a 16-bit, 44.1 kHz stereo WAV straight to your Downloads folder. The file never leaves your computer.

WAV is the right choice when the audio is going somewhere else afterwards: a DAW session, a video editor, a mastering chain, or an archive. If you only need something to listen to or send, the [MIDI to MP3](/midi-to-mp3/) export is nine times smaller. If you need a video, see [MIDI to MP4](/midi-to-mp4/).

## Why WAV rather than MP3

A WAV file is uncompressed PCM audio. Every sample the renderer produced is stored exactly, so there are no encoding artefacts and nothing is lost if you later edit, time-stretch, pitch-shift, or re-encode the file. MP3 is a lossy format. It is fine as a final delivery format but poor as a source, because each further encode compounds the loss.

The trade-off is size. A WAV from midee is about 10 MB per minute. The MP3 is about 1.4 MB per minute. For a track you are going to drop into Logic, Ableton, Premiere, or DaVinci Resolve, the extra megabytes are worth it.

## Convert a MIDI file to WAV in six steps

1. Open [midee](/) in any current browser. WAV export needs only the standard Web Audio API, so it works in Chrome, Edge, Firefox, and Safari, on desktop and mobile.
2. Drag the `.mid` or `.midi` file onto the page, or click to browse.
3. Press play and audition instruments from the toolbar. Piano is the default. The other choices are Upright, Digital, Rhodes, Guitar, Violin, Flute, Marimba, Bells, Strings, Pad, Pluck, and Bass.
4. Mute any tracks you want left out. Muted tracks are excluded from the render.
5. Click **Export**, open the **Audio** tab, and select **WAV**.
6. Click **Start**. The render shows a progress bar and the file saves as `yourfile.wav` when it finishes.

{{cta:Convert a MIDI to WAV|Lossless, free, and nothing leaves your machine. Drop in a .mid and export from the Audio tab.}}

## What you get

| | |
| --- | --- |
| Container | WAV (RIFF), PCM |
| Bit depth | 16-bit |
| Sample rate | 44.1 kHz |
| Channels | Stereo |
| Size | About 10 MB per minute |
| Length | Exactly the MIDI's duration. The release tail after the last note is trimmed. |
| Filename | Same name as the MIDI, with a `.wav` extension |

16-bit 44.1 kHz is CD quality and is accepted by every DAW, editor, and upload service without conversion. The renderer works internally in 32-bit float and converts to 16-bit on write. The master volume slider in the app sets the level of the render, so set it before exporting to leave headroom or to make full use of the range.

## Settings that shape the recording

**Instrument.** The single most important choice. Every track in the file is played with the one instrument you select. midee ships 13 sampled instruments and does not read General MIDI program changes, so an arrangement written for several instruments will be rendered entirely on the one you choose.

**Track mutes.** Use the track panel to remove parts. This is how to bounce one hand of a piano piece, isolate a melody, or drop a drum track. Percussion tracks are not detected automatically. Drum notes would sound as pitched notes on the chosen instrument, so mute them.

**Volume.** Baked into the render. Nothing is normalised afterwards.

**Sustain pedal.** Controller 64 events are honoured, and pedalled notes ring for their full held length.

**Transpose.** A transposition set in the app is applied to the audio. The playback speed control is not applied; the render always runs at the file's own tempo.

## How the conversion works

Everything runs inside the browser tab:

1. The MIDI is parsed into notes, tempo map, and pedal intervals with `@tonejs/midi`.
2. The instrument's sample set is decoded and cached.
3. A Web Audio `OfflineAudioContext` renders the piece at 44.1 kHz, faster than real time and independent of your sound card. Nothing plays through your speakers.
4. The buffer is trimmed to the MIDI's duration and written as a 44-byte RIFF header followed by interleaved 16-bit PCM samples.
5. The bytes are wrapped in a blob and downloaded.

There is no server involved. Once the app and the instrument samples have loaded, the export completes with no network connection. The same offline renderer produces the audio for [MP4 exports](/midi-to-mp4/), so a WAV from this page and the soundtrack of a video export are identical.

## Common uses for a MIDI to WAV export

- **Bouncing a MIDI mock-up for a video edit.** Import the WAV into the editor's timeline; no transcoding needed.
- **Sharing a demo with a collaborator who does not have your plugins.** The WAV plays identically everywhere.
- **Getting a clean stem to process.** Add reverb, EQ, or compression in your DAW, starting from a lossless source.
- **Making a reference track for practice.** Export at full quality, then slow it down in a practice app without MP3 artefacts becoming audible.

## Limitations

- **One instrument per export.** No per-track instrument assignment.
- **No General MIDI bank.** 13 curated instruments, not 128 GM programs.
- **16-bit 44.1 kHz only.** There is no 24-bit or 48 kHz option. If a delivery spec requires 48 kHz, resample in your DAW.
- **Percussion is not filtered.** Mute drum tracks manually.
- **Very long files use a lot of memory.** The whole render is held in memory before it is written. Pieces over an hour may exceed what a browser tab allows. Split the MIDI first.

## Frequently asked questions

**Is MIDI to WAV conversion free?**
Yes. midee is open source, with no paid tier, signup, or watermark.

**Does it upload my file?**
No. Parsing, rendering, and writing the WAV all happen in your browser. Nothing is sent anywhere.

**Is the WAV really lossless?**
Yes. It is uncompressed 16-bit PCM straight from the renderer. The only lossy step in midee's audio pipeline is the optional MP3 encode, which WAV export skips.

**Why does the file sound different from my DAW's playback?**
Because the instrument is different. A MIDI file has no sound of its own; the WAV reflects midee's sampled instrument, not the plugin you used to write the piece. Pick the instrument closest to what you intended.

**Can I get a 24-bit or 48 kHz WAV?**
Not directly. Export 16-bit 44.1 kHz and convert in your DAW. Going up in bit depth or sample rate does not add information, so the result is equivalent for editing purposes.

**Can I convert WAV to MIDI?**
No. That is transcription, which midee does not do.

**Does it work in Firefox and Safari?**
Yes. WAV export uses only the Web Audio API, which every modern browser ships. It does not depend on WebCodecs the way video export does.

**Does it work offline?**
The export makes no network requests. You need a connection to load the app and the instrument's samples; after that you can disconnect and export.

## Try it

[Open midee](/), drop in a `.mid` file, pick an instrument, and export WAV from the **Audio** tab. For a smaller file, use [MIDI to MP3](/midi-to-mp3/). For every output midee supports, see the [MIDI converter](/midi-converter/) overview.

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Is MIDI to WAV conversion in midee free?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. midee is open source, with no paid tier, signup, or watermark."
      }
    },
    {
      "@type": "Question",
      "name": "Does midee upload my MIDI file to convert it to WAV?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. Parsing, rendering, and writing the WAV all happen in your browser. Nothing is sent to a server."
      }
    },
    {
      "@type": "Question",
      "name": "Is the exported WAV lossless?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. It is uncompressed 16-bit 44.1 kHz stereo PCM written directly from the offline renderer. The only lossy step in midee's audio pipeline is the optional MP3 encode, which WAV export skips."
      }
    },
    {
      "@type": "Question",
      "name": "Why does the WAV sound different from my DAW's playback?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "A MIDI file has no sound of its own. The WAV reflects the sampled instrument you pick in midee, not the plugin you used to write the piece. midee ships 13 instruments and plays every track with the one you select."
      }
    },
    {
      "@type": "Question",
      "name": "Can I export a 24-bit or 48 kHz WAV?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Not directly. midee writes 16-bit 44.1 kHz. Convert in your DAW if a delivery spec requires another format; upsampling adds no information, so the result is equivalent for editing."
      }
    },
    {
      "@type": "Question",
      "name": "Does MIDI to WAV export work in Firefox and Safari?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. WAV export uses only the Web Audio API, which every modern browser ships, and does not depend on WebCodecs the way video export does."
      }
    },
    {
      "@type": "Question",
      "name": "How big is a WAV exported from a MIDI file?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "About 10 MB per minute of music at 16-bit 44.1 kHz stereo. The MP3 export is about 1.4 MB per minute."
      }
    },
    {
      "@type": "Question",
      "name": "Does MIDI to WAV conversion work offline?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The export makes no network requests. A connection is needed to load the app and the instrument's samples; after that you can disconnect and export."
      }
    }
  ]
}
</script>
