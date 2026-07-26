# Guitar transcription model evaluation (M1 spike, M1R/M1R2 corrections)

**Date:** 2026-07-21 (M1), corrected/extended 2026-07-21 (M1R), CPU
benchmarks + wording fixes 2026-07-21 (M1R2)
**Status:** Complete (non-blocking research spike)
**Owner artifacts:** [`tools/guitar-model-spike/`](../tools/guitar-model-spike/) (isolated tooling, deterministic manifest/runner), this document.
**Does not touch:** root `package.json`/`package-lock.json`, `src/`, or any shipped Midee code path.

**Integration decision (2026-07-22):** No evaluated model was adopted in
Midee v1. Shipped Guitar mode accepts note events from MIDI,
computer-keyboard, and direct fretboard input rather than raw audio. Basic
Pitch remains the most direct browser experiment candidate; the GAPS
checkpoints remain Python/offline candidates pending licensing,
representative polyphonic evaluation, and target-hardware validation.

> **M1R correction notice:** the original M1 pass of this document
> concluded that GAPS / high-resolution guitar transcription had **no
> publicly available code or weights** and was a hard blocker. That
> conclusion was **wrong** — it was accurate for the sources checked at the
> time (the paper's companion GitHub Pages site and the author's repo list
> as enumerated then) but missed that the same author has since published
> a working package and hosted checkpoints elsewhere on Hugging Face. This
> revision corrects every claim built on that error: see the rewritten
> "Model 2" section, comparison table, conclusion, risks, and pinned
> revisions below. The Basic Pitch findings and measurements from M1 are
> unchanged and are reproduced here verbatim (see git history for the
> original commit if you want a byte-for-byte diff).

> **M1R2 addendum:** M1R's GAPS benchmarks ran on Apple Silicon **MPS**
> (auto-selected), which is not comparable to Basic Pitch's CPU-JS-backend
> RTF. This revision reruns both GAPS checkpoints with `--device cpu`
> forced (results now apples-to-apples with Basic Pitch's CPU numbers),
> keeps the MPS numbers alongside for reference, and surfaces a genuinely
> important finding those CPU runs revealed: **peak memory on CPU is
> ~7.3-7.7GB — roughly 7-8x the MPS figure — which matters more for
> Pi-feasibility than the (perfectly fine) CPU real-time factor does.**
> This revision also fixes two wording issues from M1R: it no longer calls
> Basic Pitch "the only one... directly usable" in the same breath as
> calling GAPS "directly usable" two bullets later (the two aren't usable
> in the same *way* — browser-direct vs. Python/offline — see below), and
> it replaces the "Basic Pitch has zero license ambiguity" claim with
> narrower, evidence-backed wording about its distributed artifact's
> license, since this spike never audited Basic Pitch's own training data.
>
> **A second acceptance-audit pass on this same revision fixed further
> issues**: (1) `run_gaps_eval.py` previously wrote `--revision` into the
> output JSON without actually enforcing it — the model constructor's own
> checkpoint resolution never accepts a revision argument, so an
> uncached fresh run could silently fetch `main`. The script now
> explicitly resolves and downloads the checkpoint via
> `hf_hub_download(..., revision=...)` first and hands the constructor
> that exact local path, and every result JSON now records the resolved
> `checkpointSha256`, separate requested and resolved checkpoint revisions,
> portable checkpoint source fields,
> `dependencyVersions`, installed Git dependency revisions, and the
> requirements-lock hash, not just the requested revision. (2) The
> transitive `piano-transcription-inference` git
> dependency (unpinned in `hf-midi-transcription`'s own `pyproject.toml`)
> is now pinned in a committed lock file,
> `tools/guitar-model-spike/python/requirements-lock.txt` (`uv pip freeze`
> output), not just narrated in prose. (3) Absolutist "monophonic-only by
> design" / "fail by design" language has been replaced with
> evidence-based wording: the checkpoints are documented as
> optimized/trained/validated for monophonic performance, which is a
> training-scope claim the underlying 88-class CRNN's output layer doesn't
> architecturally enforce. (4) The "all four candidates output pitch-only"
> claim has been corrected to clarify FretNet is the one architectural
> exception (string/fret by design) that simply has no published weights
> to produce any output today, rather than a contradiction. (5) The TL;DR
> no longer flattens the GAPS code license to "MIT" without the
> missing-LICENSE-file caveat used everywhere else. (6) "Default to
> `guitar-fl.pth`" has been replaced with "evaluate both checkpoints on a
> larger set" — a 12-track subset is not enough evidence to pick a
> default over the package's own documented choice. (7) The 4.66s figure
> in the install narrative is now correctly described as cached-checkpoint
> model *initialization* time, not a demonstration of fast download+load.
> (8) The probe README's bug count is corrected from three to four. (9)
> First-track RTF is now flagged as warm-up-inflated in both the script
> output (`isFirstInference`, `meanRealTimeFactorExcludingFirstInference`)
> and this document's tables, since it's visibly elevated (e.g. 0.323 vs.
> 0.06-0.09 for later tracks on one CPU run).

## TL;DR

None of the four candidates is "same-level" as Midee's current piano
approach (an Onsets & Velocities piano-transcription model — see
`README.md`'s Bluetooth-audio data-flow diagram — which reaches near-studio
note accuracy on a well-understood, decades-mature MIR task). For guitar:

- **Spotify Basic Pitch (TS)** is the only one of the four that is
  **directly usable in the browser** *today*: real license, real npm
  package, real ~900KB model, installs and builds cleanly under an
  isolated Vite 8 project, and was actually run end-to-end against 12 real
  GuitarSet excerpts in this spike. With the correct (upstream Python)
  inference thresholds it reaches a **0.750 mean onset F1 @ 50ms** but only
  **0.543 mean onset+offset F1** across the 12 real tracks measured —
  decent onset detection, much weaker sustained-note timing, and it is
  instrument-agnostic (not guitar-specialized). Good enough to prototype
  against, not good enough to treat as ground truth.
- **GAPS / high-resolution guitar transcription** (Xavier Riley et al.) —
  **correction: this is now directly usable offline in Python, not
  blocked** (M1's "no artifact" finding was wrong — see Model 2). It is
  **not** a browser candidate the way Basic Pitch is: it's a PyTorch/CRNN
  model with no JS/WASM/ONNX export path found in this spike, so "directly
  usable" here means *installable and runnable via `uv`/pip today*, not
  *shippable in Midee's static Vite SPA today*. A working package
  ([`xavriley/hf_midi_transcription`](https://github.com/xavriley/hf_midi_transcription),
  **MIT-intended** — README + `pyproject.toml` classifier both say MIT,
  but the repo ships no `LICENSE` file, so treat it as asserted, not
  formally instantiated) and real pretrained checkpoints
  ([`xavriley/midi-transcription-models`](https://huggingface.co/xavriley/midi-transcription-models)
  on Hugging Face, MIT model card: `guitar-gaps.pth` ~99.2MB,
  `guitar-fl.pth` ~98.9MB, `guitar_kroma.safetensors` ~49.4MB) exist and
  were installed, loaded, and benchmarked in this spike via an isolated
  `uv` environment — on both Apple Silicon GPU (MPS) and CPU-forced, with
  the exact checkpoint pinned by revision and verified by sha256 on every
  run (see Model 2). Both checkpoints are **documented by their authors as
  optimized/trained/validated for monophonic performance** (not proof of a
  hard architectural ceiling — see Model 2 for why), so neither is a
  polyphonic competitor to Basic Pitch in practice. CPU inference used
  **~7.3-7.7GB peak RSS** despite a good real-time factor (this is an
  Apple Silicon Mac, *not* a Raspberry Pi measurement — see Model 2), and
  the underlying GAPS/François Leduc *training* datasets both have
  **license discrepancies that still block a confident commercial-use
  claim** — see Model 2 below and the
  Risks section. See measured results below for what was actually run.
- **GuitarMidi-LV2** is a hobbyist LV2 plugin with real, if narrow,
  functionality (documented, self-reported low latency) but unverified on
  Raspberry Pi/ARM in this spike (no Pi hardware available) and has
  documented accuracy limitations (fixed velocity, notes above ~E5 not
  detected, major/minor chord bias).
- **FretNet** is openly-licensed (MIT) research code accompanying an
  ICASSP 2023 paper, with no released pretrained weights — remains
  research-only / unverified for direct use.

Whichever model (if any) is eventually adopted, its job is narrow: **all
runnable artifacts evaluated here output pitch/note events, not tablature
or fingering** — that pitch-only signal is exactly the shape Midee's
pipeline already consumes end-to-end for piano (`MIDI note → ergonomic
mapper → LED index`). FretNet is the architectural exception: it is
string/fret-aware, but has no published weights and therefore was not
runnable in this evaluation. String/fret-aware output is not required for
Midee's current mapping approach.

### Candidate freshness check — 2026-07-22

A July 22, 2026 paper/GitHub/Hugging Face search also checked **TART**
(arXiv:2510.02597) and **Velocity Prediction for Guitar Tablature
Transcription** (arXiv:2606.24912). That search found no linked public
implementation paired with pretrained weights for either paper. This is
strictly a record of what the current search surfaced, not a claim that
such artifacts do not exist or cannot be released later. Separately,
`guitar_kroma.safetensors` exists in the evaluated
`xavriley/midi-transcription-models` repository, but it is undocumented
and not wired into `instruments.json`; this spike found no supported way
to select or load it, so it is not directly usable here.

---

## Methodology

### Deterministic 12-track GuitarSet v1.1 subset

GuitarSet v1.1 ([Xi et al. 2018, ISMIR](https://zenodo.org/records/3371780),
CC-BY-4.0) contains 360 excerpts: 6 players (`00`-`05`) × 5 styles × 3
progressions × 2 tempi × {comp, solo}. Per the spike's requirements, this
evaluation uses exactly **12 tracks: one `comp` and one `solo` excerpt per
player**.

Selection is deterministic and reproducible
(`tools/guitar-model-spike/scripts/select-subset.mjs`): the real, verified
list of all 360 `track_id`s (obtained by listing the actual `annotation.zip`
fetched from the primary Zenodo record, not guessed or reconstructed from
combinatorics — see provenance block in
`tools/guitar-model-spike/data/guitarset-track-list.json`) is grouped by
`(player, comp|solo)`, and within each 30-candidate group the track with the
**lexicographically smallest SHA-256 hash of its `track_id`** is picked.
This is independent of list order, download order, or wall-clock time, so
re-running `node scripts/select-subset.mjs` against the frozen input always
yields the same 12 tracks:

| Player | Comp | Solo |
| --- | --- | --- |
| 00 | `00_SS1-68-E_comp` | `00_BN1-129-Eb_solo` |
| 01 | `01_BN2-166-Ab_comp` | `01_Jazz1-130-D_solo` |
| 02 | `02_Rock3-148-C_comp` | `02_SS1-100-C#_solo` |
| 03 | `03_Jazz1-200-B_comp` | `03_Jazz2-110-Bb_solo` |
| 04 | `04_SS3-98-C_comp` | `04_Jazz1-200-B_solo` |
| 05 | `05_SS1-68-E_comp` | `05_Rock2-85-F_solo` |

### Data access without full-archive downloads

GuitarSet's audio archives on Zenodo are 657MB-3.6GB each. This
environment's measured network throughput was **~70-85 KB/s** (confirmed
consistently against zenodo.org, huggingface.co, and registry.npmjs.org —
a sandbox-wide cap, not host-specific), which would make a full-archive
download take ~2.5 hours. Because Zenodo's file-serving endpoint *does*
honor HTTP `Range` requests (verified: `Range: bytes=0-1000` against
`audio_mono-mic.zip` returns `206 Partial Content` /
`Content-Range: bytes 0-1000/656927981`), `tools/guitar-model-spike/scripts/remote-zip.mjs`
implements a small dependency-free partial-ZIP reader (parses the End-Of-
Central-Directory and Central Directory records via ranged reads, then
range-fetches and inflates only the requested members). This pulled just
the 12 needed `_mic.wav` files (+ 12 matching `.jams` annotation files)
totaling ~30MB, in a few minutes, instead of downloading ~700MB of audio
that would go unused.

### Real audio and ground truth used

All 12 tracks' real microphone recordings (`{track_id}_mic.wav`, 44.1kHz
16-bit PCM) and real ground-truth note annotations
(`{track_id}.jams` → merged `note_midi` observations across all 6 strings)
were fetched from the canonical Zenodo record and cached locally
(`.cache/`, gitignored, never committed). SHA-256 checksums of every
fetched file are recorded in `results/fetch-report.json`.

### Metrics

`tools/guitar-model-spike/scripts/metrics.mjs` implements mir_eval-style
note-transcription metrics:

- **Onset F1 @ 50ms**: predicted note matches a ground-truth note if MIDI
  pitch is exact and `|onset_pred - onset_gt| ≤ 50ms`.
- **Onset+offset F1**: same onset criterion, plus
  `|offset_pred - offset_gt| ≤ max(50ms, 0.2 × gt_duration)`.
- Matching is greedy nearest-onset assignment (a documented simplification
  of mir_eval's Hungarian-algorithm optimum; collisions are rare for solo
  guitar and don't materially change P/R/F1 at this scale).
- False positives / negatives, precision, recall reported alongside F1.

---

## Model 1: Spotify Basic Pitch (TypeScript) — **directly usable, validated**

- **Primary sources:** [`spotify/basic-pitch-ts`](https://github.com/spotify/basic-pitch-ts) (commit `2d498f82b61c71898edf0e8dd661b99076676c8b`, tag `v1.0.1`), npm `@spotify/basic-pitch@1.0.1`. Python sibling [`spotify/basic-pitch`](https://github.com/spotify/basic-pitch) (commit `fa5997af0a8210982619003269994a1be25eddf3`) used only to confirm upstream inference-threshold defaults.
- **License:** Apache-2.0 (both repo and npm `license` field).
- **Paper:** Bittner et al., "A Lightweight Instrument-Agnostic Model for Polyphonic Note Transcription and Multipitch Estimation," ICASSP 2022. Instrument-agnostic — not guitar-specialized.
- **Model weights:** shipped inside the npm package: `model.json` (174,537 bytes) + `group1-shard1of1.bin` (742,392 bytes) = **916,929 bytes (~896 KiB) total**, verified by direct inspection of the installed `node_modules/@spotify/basic-pitch/model/`.
- **Inference window:** 2-second frames, 22050 Hz mono input (resampled internally), FFT hop 256 (≈86.13 fps annotation rate), 30-frame overlap between windows.
- **Output features:** per-frame pitch/onset/contour activations converted to discrete note events (`startTimeSeconds`, `durationSeconds`, `pitchMidi`, `amplitude`, optional `pitchBends[]`) — pitch-only, no string/fret/tab information.

### Isolated Vite 8 browser build — actually run

```
tools/guitar-model-spike$ npm run build:browser-smoke
✓ 1242 modules transformed, built in 168ms
dist/index.html                    0.24 kB │ gzip:   0.18 kB
dist/assets/model-*.json         174.53 kB │ gzip:   8.41 kB
dist/assets/index-*.js         1,031.66 kB │ gzip: 256.59 kB
```

This confirms `@spotify/basic-pitch` bundles cleanly under this repo's
pinned Vite major version (`vite: "^8.0.0"` in root `package.json`). Real
gzip payload for the JS bundle (includes `@tensorflow/tfjs` + basic-pitch +
`@tonejs/midi`, all pulled in transitively) is **256.59 KB**.

**Integration finding:** the weight shard (`group1-shard1of1.bin`, 742KB)
is **not** automatically picked up by Vite's static-asset scanner — only
`model.json` was, because the shard path is referenced dynamically inside
the JSON manifest at *runtime* (by `tf.io`'s browser HTTP loader), not
through a statically-analyzable `new URL(...)` Vite can follow. A real
integration needs an explicit step (e.g. `vite-plugin-static-copy`, or
placing model files under `public/`) to ship the `.bin` shard. This is
worth flagging now — it's an easy silent-failure trap (model.json loads,
then the shard 404s at runtime) if not accounted for during any real
integration attempt.

### Node inference harness — actually run against all 12 tracks

Running full browser inference (WebGL/WASM) required a headless browser
(Playwright), whose binary downloads were not practical at this
environment's measured ~70-85 KB/s. Instead,
`scripts/basic-pitch-runner.mjs` runs the **same `@spotify/basic-pitch`
package code** via the pure-JS `@tensorflow/tfjs` **CPU** backend in plain
Node (no `@tensorflow/tfjs-node` native binary — its postinstall pulls a
~100MB+ prebuilt TensorFlow C library, also impractical at this bandwidth).
This is disclosed explicitly because it changes what the RTF number means:
the numbers below are a **CPU-JS-backend measured baseline**, not a
browser measurement — this spike did not actually run Basic Pitch through
a browser's WebGL or WASM backend (that would need a real or headless
browser, which the bandwidth constraint above also ruled out), so it
cannot verify the common assumption that WebGL/WASM would be faster. tfjs's
CPU backend is generally the slowest of its three backends, which makes
this baseline *directionally likely* to be pessimistic relative to a real
browser — but that is an expectation carried over from tfjs's general
architecture, not something measured in this spike, and it should be
treated as an assumption to verify, not a proven bound. Audio decode used
a from-scratch 16-bit PCM WAV reader + linear resampler to 22050Hz mono (no
Web Audio API / native decode dependency needed, since
`BasicPitch.evaluateModel()` accepts a plain `Float32Array` directly).

Two threshold profiles were run, because this materially changes the
result and the basic-pitch-ts README's usage example does **not** use the
same defaults as the upstream Python CLI:

| Profile | onset_threshold | frame_threshold | minimum_note_length |
| --- | --- | --- | --- |
| `ts-readme-example` (illustrative values from the JS README's usage snippet) | 0.25 | 0.25 | 5 frames (~58ms) |
| `upstream-python-defaults` (spotify/basic-pitch `predict.py` argparse defaults) | 0.5 | 0.3 | 11 frames (127.70ms) |

**Results — `upstream-python-defaults` (representative; primary numbers):**

| Track | Style | RTF | Onset F1@50ms | Onset+Offset F1 | GT notes | Pred notes | FP | FN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `00_SS1-68-E_comp` | comp | 0.602 | 0.638 | 0.319 | 189 | 306 | 148 | 31 |
| `00_BN1-129-Eb_solo` | solo | 0.607 | 0.747 | 0.578 | 71 | 95 | 33 | 9 |
| `01_BN2-166-Ab_comp` | comp | 0.626 | 0.730 | 0.430 | 260 | 233 | 53 | 80 |
| `01_Jazz1-130-D_solo` | solo | 0.616 | 0.873 | 0.718 | 68 | 74 | 12 | 6 |
| `02_Rock3-148-C_comp` | comp | 0.594 | 0.649 | 0.358 | 435 | 302 | 63 | 196 |
| `02_SS1-100-C#_solo` | solo | 0.603 | 0.871 | 0.774 | 59 | 65 | 11 | 5 |
| `03_Jazz1-200-B_comp` | comp | 0.602 | 0.647 | 0.559 | 82 | 54 | 10 | 38 |
| `03_Jazz2-110-Bb_solo` | solo | 0.613 | 0.894 | 0.854 | 99 | 100 | 11 | 10 |
| `04_SS3-98-C_comp` | comp | 0.597 | 0.619 | 0.241 | 268 | 320 | 138 | 86 |
| `04_Jazz1-200-B_solo` | solo | 0.605 | 0.769 | 0.598 | 65 | 52 | 7 | 20 |
| `05_SS1-68-E_comp` | comp | 0.594 | 0.651 | 0.261 | 143 | 293 | 151 | 1 |
| `05_Rock2-85-F_solo` | solo | 0.602 | 0.913 | 0.825 | 125 | 127 | 12 | 10 |

| Metric | Value |
| --- | --- |
| Mean onset F1 @ 50ms | **0.750** |
| Mean onset+offset F1 | **0.543** |
| Mean real-time factor | **0.605** (CPU JS backend, measured baseline — not a browser measurement; see note above) |
| Total false positives (onset-only) | 649 |
| Total false negatives (onset-only) | 492 |
| Peak process RSS (whole 12-track run) | ~452 MB (`452448` KB, Node v25.9.0, darwin/arm64) |

Solo tracks consistently score higher (mean onset F1 ≈ 0.84) than comp
tracks (mean onset F1 ≈ 0.66) — expected, since comping involves denser
chord voicings (more simultaneous onsets, more octave/unison collisions)
that are harder for any polyphonic transcription model, guitar-specialized
or not. The onset+offset F1 gap below onset-only F1 on every track
confirms sustained-note duration is the weaker link, not onset detection.

**Results — `ts-readme-example` (for comparison; over-permissive onsets):**

| Metric | Value |
| --- | --- |
| Mean onset F1 @ 50ms | 0.527 |
| Mean onset+offset F1 | 0.283 |
| Mean real-time factor | 0.609 |
| Total false positives (onset-only) | 3,370 |
| Total false negatives (onset-only) | 249 |

The large gap between the two profiles (mean onset F1 0.527 vs. the
upstream-defaults number above) is driven almost entirely by false
positives — the illustrative TS-README thresholds are far more permissive
than what Spotify's own Python CLI ships as default, and over-predict notes
by roughly 2-3x on these guitar excerpts. **Any future integration should
use the upstream Python defaults (or better, guitar-specific tuning) as the
starting point, not the JS README's example values.**

- **Memory:** peak process RSS (`process.resourceUsage().maxRSS`, whole
  Node process, cumulative across all 12 tracks run sequentially in one
  process) was **~452 MB** on this machine (Node v25.9.0, darwin/arm64;
  443 MB on the separate `ts-readme-example` run) — this includes tfjs's
  CPU backend + graph model + all 12 audio buffers held in the harness at
  various points, so it is an upper bound, not a steady-state
  per-inference number.
- **Package/model bytes:** model 916,929 bytes; JS bundle 1,031,668 bytes
  raw / 256,590 bytes gzip (browser build, includes tfjs).
- **Browser/Pi packaging:** Browser — confirmed buildable (see above), with
  the asset-copy caveat noted. Pi — not evaluated in this spike (Basic
  Pitch is a browser/Node package; the existing Midee Pi pipeline already
  runs "Onsets & Velocities" for piano server-side under PipeWire, and a
  guitar equivalent would follow the same server-side pattern rather than
  running in a Pi browser — genuinely untested here, flagged as future
  work, not claimed).

---

## Model 2: GAPS / High-Resolution Guitar Transcription (Xavier Riley et al.) — **usable; installed, weights loaded, license provenance unresolved**

> **This section replaces M1's "blocked, no artifact exists" finding,
> which was wrong.** M1 checked the paper companion site, the GAPS
> dataset homepage, the author's GitHub repo list, Hugging Face Papers,
> and Papers-with-Code — and at that time none of them surfaced a working
> package. What M1 missed: the author moved the runnable artifact to a
> **separate Hugging Face *model* repo** (`xavriley/midi-transcription-models`,
> distinct from the paper's companion site and from the GAPS *dataset*
> repo), and updated the `hf_midi_transcription` GitHub repo (which M1's
> search *did* find, but only recognized as a saxophone-only tool — its
> GitHub API `description` field still literally reads "Audio-to-MIDI for
> solo saxophone" even though its README now documents guitar support) to
> add multi-instrument support including guitar. Lesson: a repo's stale
> metadata description is not proof its content is stale — M1 should have
> opened the README.

### What exists (verified primary sources, 2026-07-21)

- **Code:** [`xavriley/hf_midi_transcription`](https://github.com/xavriley/hf_midi_transcription), commit `96f6797881e9497cbfc8f8e5deccea9c1f2f7adc` (`main`, pushed 2026-01-27). `pyproject.toml`: `hf-midi-transcription` v0.1.1, `requires-python = ">=3.9"`, classifier `License :: OSI Approved :: MIT License`. README states MIT and instructs "see the LICENSE file for details" — **but there is no `LICENSE` file in the repo** (confirmed via GitHub Contents API listing; also why the GitHub API's own `license` field reports `null`/unrecognized despite the human-readable claim). Treat as MIT-*intended*, not MIT-*instantiated*; a real integration should ask the author to add the missing file rather than resting on the README/classifier text alone.
- **Weights:** [`xavriley/midi-transcription-models`](https://huggingface.co/xavriley/midi-transcription-models) on Hugging Face, repo commit `689e773723bcafd8c81015b10c03f12675ce16ec` (`lastModified` 2026-03-13), model card `license: mit`. Confirmed present via the HF API tree listing and downloaded in this spike:

  | File | Bytes (HF API `size`) | `x-linked-etag` (xet content hash, from `resolve` redirect headers) |
  | --- | --- | --- |
  | `guitar-gaps.pth` | 99,178,877 | `65483e7c0e340a90415b15b520687587698c8c728f5fa470a205f13ee45c6513` |
  | `guitar-fl.pth` | 98,916,957 | `50d93dba89bdd3401849bc735614478e83d9f46d21fa3f71d8aca5acc0a52028` |
  | `guitar_kroma.safetensors` | 49,360,574 | `26919a2fa15652f3a63255ea413a64ffbbeba99efa0a2a2dab425d13f57f2de0` |

  `guitar-gaps.pth` is trained on the GAPS dataset (below); `guitar-fl.pth` is trained on a separate "Francois Leduc dataset" per `instruments.json` in the code repo — not otherwise documented in this spike, flagged for follow-up if pursued further. `guitar_kroma.safetensors` is present but undocumented and not wired into `instruments.json`'s instrument map as of this commit; with no supported selection/loading path found, it is not directly usable and was not evaluated.
- **CLI/API surface (confirmed real, from the current README):** `midi_transcription input.wav output.mid --instrument guitar` (CLI, maps to `guitar-gaps.pth` as the default guitar checkpoint per `instruments.json`), or `MidiTranscriptionModel.from_pretrained("xavriley/midi-transcription-models", instrument="guitar_gaps")` (Python API, `PyTorchModelHubMixin`-based).
- **Architecture:** CRNN with onset/offset/frame/velocity regression, built on a fork of `piano_transcription_inference` (`xavriley/piano_transcription_inference`, resolved commit `7568dc7f78b625e40cf9776e2806d164006610e3` when installed in this spike) — the same Kong-et-al.-derived piano-transcription lineage Midee's *existing* piano pipeline uses ("Onsets & Velocities"), now retrained/adapted per-instrument. 16kHz input, 10-second windows with overlap, note range reuses piano's 88-key/`begin_note=21` (MIDI 21-108) window (guitar's range is a subset, so no remapping needed). **Documented by the authors as optimized/trained/validated for monophonic
performance** ("Optimized for monophonic performance (single notes, not
chords) across all instruments" — explicit in the current README, not an
inference from our testing). This is a training/validated-scope claim,
not a proven hard architectural ceiling: the underlying model is an
88-class CRNN emitting independent onset/offset/frame/velocity
predictions per pitch class, and nothing in its output layer structurally
prevents multiple classes being simultaneously active — so it is not
guaranteed to fail outright on chords by construction. What this spike
actually measured is consistent with the documented monophonic *scope*:
elevated false-negative rates on GuitarSet's `comp` (chord-heavy) tracks
(see results below) — an empirical finding about this checkpoint's
trained/validated scope, not proof the architecture cannot represent
overlapping notes.

### Real install attempt (this spike, isolated `uv` environment)

Per instructions, nothing here touches Midee's own Python/Node toolchain: a
throwaway `uv venv` was created at `tools/guitar-model-spike/python/.venv`
(Python 3.11.15, gitignored) with `HF_HOME` pointed at
`tools/guitar-model-spike/.cache/huggingface` (also gitignored — model
weights are cached locally, never committed, matching the same policy as
GuitarSet audio).

1. `pip install hf-midi-transcription` (the README's **recommended**
   install path) **fails** — the package is **not published on PyPI**
   under that name (`pypi.org/pypi/hf-midi-transcription/json` → 404, both
   hyphen and underscore spellings checked). This is a real, currently-true
   README defect worth reporting upstream, not something this spike
   invented.
2. `uv pip install "git+https://github.com/xavriley/hf_midi_transcription.git@96f6797881e9497cbfc8f8e5deccea9c1f2f7adc"`
   (the README's documented fallback, "Option 2: Install from source")
   **succeeds**: resolves 59 packages, builds `hf-midi-transcription` and
   its git dependency `piano-transcription-inference` (also from source),
   pulls `torch==2.13.0` (CPU wheel) and the rest of the dependency tree
   cleanly. `python -c "import hf_midi_transcription"` succeeds.
3. `MidiTranscriptionModel.from_pretrained(...)` **fails on first try** with
   the environment's default (latest) `huggingface-hub==1.24.0`:
   ```
   TypeError: MidiTranscriptionModel._from_pretrained() missing 2 required
   keyword-only arguments: 'proxies' and 'resume_download'
   ```
   This is a **real version-skew bug**: the package's own `pyproject.toml`
   declares only `huggingface-hub>=0.16.0` (no upper bound), but its
   `_from_pretrained()` override (`hf_midi_transcription/model.py`) still
   requires `proxies`/`resume_download` keyword arguments that newer
   `huggingface_hub` `ModelHubMixin` internals (as of `huggingface-hub` 1.x)
   no longer pass through. **Working fix found and verified in this
   spike:** pin `huggingface-hub==0.25.2` (downgrade from 1.24.0) — with
   that pin, `from_pretrained(..., revision="689e773723bcafd8c81015b10c03f12675ce16ec")`
   succeeds.
4. **Inefficiency finding:** `MidiTranscriptionModel.from_pretrained(...)`
   (the class method — `PyTorchModelHubMixin`'s generic HF integration)
   does a full **repo snapshot download**: this spike observed **~672MB**
   fetched across the shared `xavriley/midi-transcription-models` repo's
   other files (saxophone, bass, piano checkpoints, both `.safetensors`
   files) before a transient network error interrupted the one file this
   spike didn't need (`filobass_20000_iterations.pth`) — none of that
   ~672MB was the ~99MB `guitar-gaps.pth` actually wanted. **Real fix used
   in this spike:** call the plain `MidiTranscriptionModel(instrument=...)`
   **constructor** instead of `.from_pretrained(...)` — its internal
   `_download_model_if_needed()` calls `hf_hub_download()` for exactly the
   one checkpoint file the requested instrument needs. In this spike,
   `guitar-gaps.pth` (99,178,877 bytes) had already been fully downloaded
   to the local HF cache by the earlier interrupted `.from_pretrained()`
   snapshot attempt (step 4 below), so the plain constructor's first
   successful call found it already cached and completed in 4.66s of
   **model initialization only** — that number demonstrates the constructor
   path *works* and is fast once cached, not that a fresh ~99MB download
   completes in 4.66s (a cold download at this spike's measured ~70-85KB/s
   bandwidth would take roughly 20 minutes; see `run_gaps_eval.py`'s later
   `resolve_checkpoint()` for the version of this flow that explicitly
   fetches-then-loads and times each step separately). This also sidesteps
   the `huggingface-hub` version-skew bug in step 3 entirely, since the
   plain constructor never calls
   `PyTorchModelHubMixin.from_pretrained()`'s internal machinery — **so the
   practical recommendation is: don't use `.from_pretrained()` with this
   package at all, use the constructor.**
5. **Packaging bug found:** the plain constructor path above initially
   failed with `ValueError: Unsupported instrument 'guitar_gaps'.
   Available: ['saxophone', 'bass', 'guitar', 'piano']` — the repo's
   `instruments.json` (which maps `guitar_gaps`/`guitar_fl` to their
   checkpoint filenames) is **not included in the installed package**
   (confirmed: absent from `site-packages/hf_midi_transcription/` after
   both the git-source and editable installs; `pyproject.toml` doesn't
   declare it as package data). The code falls back to a hardcoded
   4-instrument dict lacking the `guitar_gaps`/`guitar_fl` split. **Working
   fix used in this spike:** copy `instruments.json` from the repo into the
   working directory (`tools/guitar-model-spike/python/instruments.json`,
   committed here since it's the actual config needed to reproduce this
   run) — the code's config loader also checks `Path("instruments.json")`
   relative to the current working directory as a fallback, which picks it
   up. Plain `--instrument guitar` (using the fallback dict, which does
   include a `guitar` → `guitar-gaps.pth` mapping) would have worked
   without this file; only the `guitar_gaps`/`guitar_fl` naming used by
   this spike (to unambiguously log which checkpoint was tested) needed
   the workaround.

### Inference results

Real inference was run against the **same 12-track deterministic GuitarSet
subset and same real `.jams` ground truth** used for Basic Pitch (see
Methodology above), via `tools/guitar-model-spike/python/run_gaps_eval.py`
— a from-scratch script using the package's documented API
(`MidiTranscriptionModel(instrument=...)` → `model.transcribe(wav, mid,
activations=True)` → the returned `est_note_events` dict, which already
has `{onset_time, offset_time, midi_note, velocity}` per note, no MIDI
re-parsing needed) and the exact same greedy nearest-onset F1 methodology
as the Node/Basic Pitch harness (re-implemented in Python for a
self-contained script; same 50ms onset tolerance, same
`max(50ms, 0.2×duration)` offset tolerance), using the package's own
default thresholds (`onset_threshold=0.3`, `offset_threshold=0.3`,
`frame_threshold=0.1`, no tuning applied).

**Each checkpoint was run twice — once with `--device cpu` forced
explicitly, and once letting the package auto-select (Apple Silicon
**MPS** GPU on this machine).** The coordinator correctly flagged that an
MPS-only RTF is not comparable to Basic Pitch's CPU-JS-backend RTF; the
CPU-forced runs below *are* apples-to-apples with Basic Pitch's CPU
measurements. Both device runs used the same cached weights and produced
**identical F1/precision/recall/FP/FN per track** (verified against both
regenerated result JSONs below) — device only changes speed and memory,
not model output, which is a useful correctness sanity check in itself.
Every `results/results.gaps-*.json` file now records both `"device"` (what
actually ran) and `"requestedDevice"` (what was asked for, `null` when
auto-selected) so this is self-evident from the artifact, not just this
prose.

**A critical caveat that applies to every number in this subsection: this
machine is an Apple Silicon Mac, not a Raspberry Pi.** Apple's M-series
CPU cores are architecturally a different performance class from a
Raspberry Pi's Cortex-A76-family ARM cores — commonly several times faster
per core on this kind of workload — and this spike has no Pi hardware to
measure against (see Model 3's GuitarMidi-LV2 discussion for the same
caveat applied there). **A good CPU real-time factor on an M-series Mac
does not imply a good real-time factor on a Pi, and it does not overcome
the memory finding below.** Treat every RTF number in this section as an
Apple-Silicon-CPU baseline, and every memory number as a hard floor that a
resource-constrained device would also have to clear — Pi CPU/RTF and Pi
memory availability both remain **unverified** in this spike.

**Memory unit note:** Python's `resource.getrusage(...).ru_maxrss` reports
in **bytes on macOS** but in **kilobytes on Linux** — a well-known
cross-platform gotcha in the stdlib `resource` module. `run_gaps_eval.py`
now divides by 1024 only on Darwin and preserves Linux/Pi values as KiB.
Each result records `platform`, `peakRssRaw`, `peakRssRawUnit`, and the
normalized `peakRssKb`, making the conversion auditable and preventing a
Linux/Pi rerun from under-reporting memory by 1024x. This is the same unit
(KB) the Node/Basic Pitch harness reports via
`process.resourceUsage().maxRSS`, which Node documents as always KB
regardless of platform — so the KB figures in this document are
consistent between the two toolchains.

**`guitar-gaps.pth` (the default `--instrument guitar` checkpoint) — CPU-forced (`results.gaps-guitar_gaps-cpu.json`, comparable to Basic Pitch):**

Checkpoint pinned and verified: `hf_hub_download(repo_id="xavriley/midi-transcription-models", filename="guitar-gaps.pth", revision="689e773723bcafd8c81015b10c03f12675ce16ec")`
→ resolved file sha256 `65483e7c0e340a90415b15b520687587698c8c728f5fa470a205f13ee45c6513` (matches the HF API's `x-linked-etag` recorded in the "What exists" table above — the same file, independently re-verified) — recorded automatically in every `results/results.gaps-*.json`'s `checkpointSha256` field, not just narrated here. Resolved dependency versions (also recorded per-run in `dependencyVersions`): `hf-midi-transcription==0.1.1`, `piano-transcription-inference==0.1.0`, `torch==2.13.0`, `huggingface-hub==0.25.2`; the exact transitive dependency tree (including the unpinned-upstream `piano-transcription-inference` git commit) is pinned in the committed lock file `tools/guitar-model-spike/python/requirements-lock.txt` (`uv pip freeze` output), not left to whatever `main` resolves to on a fresh install.

| Track | Style | RTF (CPU) | RTF (MPS) | Onset F1@50ms | Onset+Offset F1 | GT notes | Pred notes | FP | FN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `00_SS1-68-E_comp` [^warmup] | comp | 0.323 | 0.085 | 0.863 | 0.241 | 189 | 168 | 14 | 35 |
| `00_BN1-129-Eb_solo` | solo | 0.136 | 0.058 | 0.942 | 0.609 | 71 | 67 | 2 | 6 |
| `01_BN2-166-Ab_comp` | comp | 0.086 | 0.054 | 0.749 | 0.292 | 260 | 274 | 74 | 60 |
| `01_Jazz1-130-D_solo` | solo | 0.080 | 0.057 | 0.940 | 0.597 | 68 | 66 | 3 | 5 |
| `02_Rock3-148-C_comp` | comp | 0.067 | 0.048 | 0.691 | 0.366 | 435 | 329 | 65 | 171 |
| `02_SS1-100-C#_solo` | solo | 0.061 | 0.043 | 0.957 | 0.615 | 59 | 58 | 2 | 3 |
| `03_Jazz1-200-B_comp` | comp | 0.085 | 0.085 | 0.921 | 0.121 | 82 | 83 | 7 | 6 |
| `03_Jazz2-110-Bb_solo` | solo | 0.225 | 0.046 | 0.934 | 0.599 | 99 | 98 | 6 | 7 |
| `04_SS3-98-C_comp` | comp | 0.170 | 0.041 | 0.776 | 0.311 | 268 | 188 | 11 | 91 |
| `04_Jazz1-200-B_solo` | solo | 0.116 | 0.081 | 0.884 | 0.543 | 65 | 64 | 7 | 8 |
| `05_SS1-68-E_comp` | comp | 0.260 | 0.072 | 0.973 | 0.226 | 143 | 149 | 7 | 1 |
| `05_Rock2-85-F_solo` | solo | 0.203 | 0.066 | 0.940 | 0.691 | 125 | 124 | 7 | 8 |

[^warmup]: **The first track processed after model construction pays a
one-time device/backend warm-up cost** (first-call kernel dispatch,
lazy initialization) not present on later tracks — visible here as
`00_SS1-68-E_comp`'s CPU RTF (0.323) being roughly 2-4x every other CPU
track's RTF despite being a mid-sized file. `run_gaps_eval.py` now flags
this explicitly per-track (`isFirstInference: true`) and reports
`meanRealTimeFactorExcludingFirstInference` in `summary` alongside the
plain mean, so this doesn't have to be caught by eyeballing the table.
CPU/MPS RTFs also vary noticeably run-to-run on shared hardware (compare
this table's numbers to the mean below) — read individual-track RTFs as
illustrative, and the *excluding-first-inference* mean as the more
representative steady-state figure.

| Metric | CPU (comparable to Basic Pitch) | MPS (Apple GPU, reference only) |
| --- | --- | --- |
| Mean onset F1 @ 50ms | **0.881** — higher than Basic Pitch's 0.750 | 0.881 (identical — device doesn't change output) |
| Mean onset+offset F1 | **0.434** — lower than Basic Pitch's 0.543 | 0.434 |
| Mean real-time factor (all 12 tracks) | 0.151 | 0.061 |
| **Mean real-time factor (excluding warm-up track)** | **0.135** — still faster-than-real-time, and faster than Basic Pitch's 0.605 CPU-JS number, *on this Apple Silicon Mac; not a Pi measurement* | 0.059 |
| Total false positives (onset-only) | 205 (vs. Basic Pitch's 649) | 205 |
| Total false negatives (onset-only) | 401 (vs. Basic Pitch's 492) | 401 |
| Model load time (checkpoint pre-cached) | 0.35s | 0.48s |
| **Peak process RSS (whole 12-track run)** | **~7.35 GB** (`7528192` KB) | ~1.0 GB (`1022416` KB) |

**The memory gap between CPU and MPS is the single most important number
in this section.** ~7.35GB peak RSS on CPU is roughly **7x** the ~1.0GB
MPS figure, and roughly **16x** Basic Pitch's ~452MB — this spike does not
have a verified explanation for the gap (plausible unverified hypotheses:
CPU-path intermediate tensor/activation buffers not needed when compute is
offloaded to the GPU, or Apple's unified-memory MPS allocator not
attributing all GPU-resident memory to process RSS the way CPU heap
allocations are attributed — neither confirmed here). **This is the number
that should drive any Pi-feasibility judgment, not the RTF**: typical
deployed Pi 4/5 variants have 4-8GB RAM shared with the OS and everything
else running on them, so a ~7.35GB peak footprint for guitar transcription
alone would be a real, likely-blocking constraint on an 8GB shared-memory
configuration. A 16GB Raspberry Pi 5 has been available since January
2025, so 8GB is not a universal Pi ceiling; CPU throughput and the actual
Pi memory footprint remain unmeasured even on that higher-memory variant.
(Note: re-running this same CPU benchmark produces peak-RSS figures in the
~7.3-7.7GB range rather than one exact fixed number — see the committed
`results.gaps-guitar_gaps-cpu.json` for this document revision's exact
run; the conclusion is unaffected by which exact figure in that range you
cite.)

**Reading the accuracy numbers honestly:** onset F1 is genuinely better
than Basic Pitch's on this subset, *including* on chord-heavy `comp`
tracks outside this checkpoint's documented training scope (e.g.
`05_SS1-68-E_comp` scored 0.973) — evidently the model still captures a
useful subset of onsets on comp tracks (likely the most prominent/salient
note per chord) rather than failing outright on polyphonic input. But
**onset+offset F1 is worse than Basic Pitch's**, and false negatives
dominate the error breakdown on the densest comp tracks
(`02_Rock3-148-C_comp`: 171 FN out of 435 ground-truth notes;
`04_SS3-98-C_comp`: 91 FN out of 268) — consistent with a model that
predicts one note where GuitarSet's ground truth has several simultaneous
ones. **Solo tracks are where this model is strongest** (mean onset F1
≈0.93, mean onset+offset F1 ≈0.61 across the 6 solo tracks above), which
lines up exactly with its documented monophonic training/validation scope.

**`guitar-fl.pth` (trained on the separate "Francois Leduc dataset," per
`instruments.json`) — run because it was practical (already cached from
the interrupted snapshot download discussed above), and the result was
surprising enough to be worth reporting prominently. CPU-forced
(`results.gaps-guitar_fl-cpu.json`) and MPS (`results.gaps-guitar_fl.json`);
checkpoint pinned and verified the same way as above, resolved sha256
`50d93dba89bdd3401849bc735614478e83d9f46d21fa3f71d8aca5acc0a52028`,
matching the earlier HF API record:**

| Track | Style | RTF (CPU) | RTF (MPS) | Onset F1@50ms | Onset+Offset F1 | GT notes | Pred notes | FP | FN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `00_SS1-68-E_comp` [^warmup] | comp | 0.146 | 0.079 | 0.864 | 0.453 | 189 | 186 | 24 | 27 |
| `00_BN1-129-Eb_solo` | solo | 0.102 | 0.058 | 0.921 | 0.633 | 71 | 68 | 4 | 7 |
| `01_BN2-166-Ab_comp` | comp | 0.101 | 0.054 | 0.842 | 0.623 | 260 | 279 | 52 | 33 |
| `01_Jazz1-130-D_solo` | solo | 0.148 | 0.056 | 0.978 | 0.847 | 68 | 69 | 2 | 1 |
| `02_Rock3-148-C_comp` | comp | 0.110 | 0.048 | 0.797 | 0.539 | 435 | 388 | 60 | 107 |
| `02_SS1-100-C#_solo` | solo | 0.079 | 0.043 | 0.917 | 0.833 | 59 | 61 | 6 | 4 |
| `03_Jazz1-200-B_comp` | comp | 0.128 | 0.085 | 0.945 | 0.479 | 82 | 81 | 4 | 5 |
| `03_Jazz2-110-Bb_solo` | solo | 0.094 | 0.047 | 0.954 | 0.913 | 99 | 96 | 3 | 6 |
| `04_SS3-98-C_comp` | comp | 0.069 | 0.040 | 0.785 | 0.522 | 268 | 226 | 32 | 74 |
| `04_Jazz1-200-B_solo` | solo | 0.121 | 0.082 | 0.908 | 0.769 | 65 | 65 | 6 | 6 |
| `05_SS1-68-E_comp` | comp | 0.124 | 0.071 | 0.976 | 0.602 | 143 | 146 | 5 | 2 |
| `05_Rock2-85-F_solo` | solo | 0.198 | 0.066 | 0.948 | 0.869 | 125 | 126 | 7 | 6 |

| Metric | CPU (comparable to Basic Pitch) | MPS (Apple GPU, reference only) |
| --- | --- | --- |
| Mean onset F1 @ 50ms | **0.903** — best of all three models tested, on both devices | 0.903 (identical) |
| Mean onset+offset F1 | **0.674** — best of all three models tested, and well above Basic Pitch's 0.543 | 0.674 |
| Mean real-time factor (all 12 tracks) | 0.118 | 0.061 |
| **Mean real-time factor (excluding warm-up track)** | **0.116** — still faster-than-real-time on this Apple Silicon Mac; not a Pi measurement | 0.059 |
| Total false positives (onset-only) | 205 | 205 |
| Total false negatives (onset-only) | 278 | 278 |
| Model load time (checkpoint pre-cached) | 0.32s | 0.45s |
| **Peak process RSS** | **~7.60 GB** (`7786448` KB) | ~1.0 GB (`1023600` KB) |

Same pattern as `guitar-gaps.pth`: strong accuracy and acceptable RTF on
this machine's CPU, but a **~7.6GB peak memory footprint that is the real
constraint for any resource-limited deployment target**, not the speed.

**This is a genuinely surprising accuracy result worth stating plainly:
`guitar-fl.pth` outperformed `guitar-gaps.pth` on both metrics on this
GuitarSet subset**, despite `guitar-gaps` being the package's *documented
default* for `--instrument guitar` and the one named in this task's
correction. This spike does not have an explanation for why (jazz-specific
training data generalizing better to GuitarSet's jazz-heavy style mix is
one plausible hypothesis, given 2 of the 5 GuitarSet styles are
Jazz-labeled — but that's speculation, not a verified finding). **Practical
implication: if this model family is pursued further, benchmark both
checkpoints before picking one as default — do not assume the package's
default instrument mapping is the better-performing choice.**

**A second, separate license caution applies specifically to
`guitar-fl.pth`:** its training data (the "François Leduc Dataset") is
**239 jazz guitar performances paired with commercial transcriptions
originally sold by François Leduc's online transcription library**
([restricted-access Zenodo record 10984521](https://zenodo.org/records/10984521),
`access_right: restricted`, no open license — "the original scores may be
purchased from François Leduc at his online library"). A newer mirror,
[`xavriley/FrancoisLeducGuitarDataset`](https://huggingface.co/datasets/xavriley/FrancoisLeducGuitarDataset)
on Hugging Face, tags itself MIT — **the same discrepancy pattern as
GAPS**, and arguably a sharper one here, since the underlying content is
explicitly described as derived from a third party's commercial,
purchasable transcription product, not just performances by ~200
uncredited contributors. The same caution applies: **do not treat
`guitar-fl.pth` as commercially cleared without written confirmation from
the rights holders (both Xavier Riley and François Leduc).**

### GAPS dataset license discrepancy — **do not treat as commercially cleared**

The task that produced `guitar-gaps.pth`'s *training data* is the GAPS
dataset, and its licensing is genuinely inconsistent across the two places
it's published, which M1 did not have visibility into (M1 only found the
older Zenodo record):

| Source | Version | License stated | Audio included |
| --- | --- | --- | --- |
| [Zenodo record 13962272](https://zenodo.org/records/13962272) | v1 (per filename `gaps_v1_no_audio.zip`) | **CC BY-NC-SA 4.0** (non-commercial) | No — `gaps_v1_no_audio.zip` (7,022,261 bytes), score/alignment metadata only |
| [Hugging Face `xavriley/GAPS`](https://huggingface.co/datasets/xavriley/GAPS) | v1.1 ("audio now included" per the dataset card's own changelog) | **MIT** (`license: mit` in the card's YAML front matter) | **Yes** — `audio/` directory present in the repo tree |

This is a real discrepancy in what the *same author* has published for
what is presented as *the same dataset*, one version apart. It is not this
spike's place to decide which license controls, and **this document
explicitly does not assert that GAPS-trained weights are commercially
clear to use in Midee.** Plausible (unverified) explanations include: the
v1.1 HF release is a deliberate re-license by the rights-holder now that
audio clearance was sorted out; or the MIT tag on the HF card is a
copy-paste default that doesn't reflect actual rights over ~200
contributed performers' recordings. Before using `guitar-gaps.pth` (or any
GAPS-derived weights) in a commercial product, get explicit written
confirmation from the author about which license governs the training
data the checkpoint was fit on — a model card's license tag is a claim,
not a guarantee, especially when it contradicts an earlier release by the
same author under a stricter, non-commercial license for what's described
as the same content.

---

## Model 3: GuitarMidi-LV2 (Gerald Mwangi) — **research/hobbyist; Pi/ARM unverified**

- **Primary source:** [`geraldmwangi/GuitarMidi-LV2`](https://github.com/geraldmwangi/GuitarMidi-LV2), commit `153327048989bffd3b623572eb5ddd0bc261b526`, latest tagged release "Expressivity" (v2.2, 2026-06-19).
- **License:** LGPL-2.0-or-later (per `LICENSE` file header: "version 2 of the License, or (at your option) any later version").
- **Architecture (per README):** a bank of Butterworth bandpass filters (148 filtered signals: 13 frets × 6 strings + 4 harmonics/note) feeding a custom CNN + transformer model (TensorFlow/Keras-trained), producing per-string fret-probability outputs combined into a 37-note polyphonic multi-label output, mapped to MIDI note-on/off (no string/fret metadata in the output — plain MIDI, directly compatible with Midee's existing note-driven pipeline).
- **Self-reported latency (author's own measurements, hardware unspecified in the README — not independently reproduced in this spike):** "4ms for the high open e (330Hz) and 16ms for the low E (82Hz)."
- **Documented limitations (from the README, not from our testing):**
  - Velocity is not extracted from audio — all MIDI notes fire at fixed velocity 127.
  - Only notes up to E5 (12th fret, high E string) are detected — author cites training-data/storage constraints ("current nvme shortage").
  - Chord detection is biased toward major/minor chords (the dominant chord types in its training data).
  - No MIDI panic control (host-dependent).
  - Harmonic bleed can trigger 2-3 spurious harmonic notes per played note.
- **Build:** requires `git`, `cmake`, `build-essential`, `libzita-resampler-dev`, `lv2-dev` — a Linux LV2 host toolchain. **Not attempted in this spike**: this sandbox is macOS/Darwin (arm64), not Linux, and has no LV2 host or Raspberry Pi hardware to validate against. Per this spike's scope, Pi/ARM latency claims for this plugin remain **UNVERIFIED / research-only** — the only latency numbers available are the author's own, on unknown hardware, and are reported here as such rather than re-stated as fact.
- **Zynthian community context:** a Raspberry Pi 5 discussion thread exists, but it discusses a *different* plugin ("PiPitch"), not GuitarMidi-LV2 — conflating the two would misrepresent GuitarMidi-LV2's Pi readiness, so it is called out explicitly here as a non-finding.

---

## Model 4: FretNet (Cwitkowitz et al.) — **research-only, no released weights**

- **Primary source:** [`cwitkowitz/guitar-transcription-continuous`](https://github.com/cwitkowitz/guitar-transcription-continuous), commit `d481054f54184374c04b1cc27a487dc35c87f353`.
- **Paper:** "FretNet: Continuous-Valued Pitch Contour Streaming for Polyphonic Guitar Tablature Transcription," Cwitkowitz, Hirvonen, Klapuri; ICASSP 2023.
- **License:** MIT (repo metadata + `LICENSE.txt`).
- **Dependencies:** Python/PyTorch, plus the author's own `amt-tools` (MIT) and `guitar-transcription-with-inhibition` (MIT) libraries, both real, maintained, MIT-licensed repos — but **no pretrained checkpoint is published in any of the three repos** (no GitHub Releases, no linked model host). The README's own "Six-Fold Cross-Validation on GuitarSet" scripts (`experiment.py`, `evaluation.py`) require training a model from scratch to obtain any usable weights.
- **Output features:** continuous-valued pitch contours grouped by string/fret of origin — the only one of the four candidates that natively outputs guitar-specific tablature-level structure, *if* a trained checkpoint existed.
- **Status: UNVERIFIED / research-only**, per this spike's scope — no attempt was made to train a model from scratch (out of scope for a feasibility spike; GuitarSet six-fold cross-validation training is a multi-hour-to-multi-day GPU undertaking, not a local verification step).

---

## Comparison table

| | Basic Pitch (TS) | GAPS / high-res guitar | GuitarMidi-LV2 | FretNet |
| --- | --- | --- | --- | --- |
| Direct-use status | **Usable, validated — browser-direct** (npm-installable, builds under Vite 8, Apache-2.0) | **Usable, validated — Python/offline only** (`uv`/pip-installable, no browser path found; trained and validated for monophonic performance; license provenance unresolved) | Usable (Linux/LV2 host), Pi unverified | Research-only, no weights |
| License | Apache-2.0 (npm package + repo) | Code: MIT-intended (README + classifier; **no LICENSE file present**). Weights repo: MIT (HF model card). Training-data (GAPS dataset) license: **discrepant** — CC BY-NC-SA 4.0 on Zenodo v1 vs. MIT on HF v1.1, see below. François Leduc dataset (used by `guitar-fl.pth`) has its own separate, sharper discrepancy — see Model 2. | LGPL-2.0-or-later | MIT (code); no weights to license |
| Output | Pitch-only note events (+ optional pitch bend) | Pitch-only note events (onset/offset/velocity); checkpoints were **trained and validated for monophonic performance**, not proven architecturally incapable of overlaps | Pitch-only MIDI note on/off, fixed velocity | Pitch + string/fret (architecture only) |
| Onset F1 @ 50ms (this spike, 12-track subset) | **0.750 mean** (upstream thresholds) | **0.881 mean** (`guitar-gaps.pth`) / **0.903 mean** (`guitar-fl.pth`, best of all three) | not measured (no Pi/Linux host here) | not run (no weights) |
| Onset+offset F1 (this spike) | **0.543 mean** (upstream thresholds) | **0.434 mean** (`guitar-gaps.pth`) / **0.674 mean** (`guitar-fl.pth`, best of all three) | not measured | not run |
| Real-time factor (CPU, apples-to-apples, excludes first-inference warm-up) | **0.605 mean** (CPU JS backend, Node/tfjs, Apple Silicon Mac) | **0.135 mean** (`guitar-gaps.pth`) / **0.116 mean** (`guitar-fl.pth`), CPU-forced, same Apple Silicon Mac — faster than Basic Pitch here, but **not a Raspberry Pi measurement for either model**, and CPU RTF varied noticeably run-to-run (see Model 2) | author-reported 4-16ms latency, unverified hardware | n/a |
| Real-time factor (GPU/accelerated, not comparable across rows) | Not measured (no browser WebGL/WASM run in this spike) | 0.059 mean (`guitar-gaps.pth`) / 0.059 mean (`guitar-fl.pth`), Apple **MPS** GPU, excludes warm-up | n/a | n/a |
| **Peak process memory (this spike's measurements)** | **~452 MB** (Node/tfjs CPU backend) | **~7.3-7.7 GB on CPU** (torch CPU) / **~1.0 GB on MPS** (torch MPS) — the CPU figure is the real constraint for any memory-limited target, roughly 16-17x Basic Pitch's footprint | Not measured | n/a |
| Browser packaging | **Confirmed** (Vite 8 build succeeds; asset-copy caveat noted) | Not evaluated — PyTorch/CRNN, Python-only today; no JS/WASM/ONNX export found in either repo. Would need a server-side (Pi-style) deployment like Midee's existing piano pipeline, not a browser one. | n/a (native LV2 plugin, not browser) | n/a |
| Pi packaging | Not evaluated (would mirror existing PipeWire server-side pattern) | **Unverified**, and the CPU memory figure above is a specific, concrete reason for caution: ~7.3-7.7GB peak RSS would be a tight-to-blocking fit on typical 4-8GB Pi RAM even before accounting for OS/other-process overhead, independent of whatever the (unmeasured) Pi CPU's real-time factor turns out to be. | **Unverified** on this spike's hardware | n/a |

## Conclusion

**No candidate here is definitively "same-level" as Midee's existing piano
approach, but the `xavriley/hf_midi_transcription` guitar checkpoints are
architecturally the closest relative and, on this spike's measurements,
the most accurate for onset detection** — both are direct descendants of
the same `piano_transcription_inference` (Kong-et-al.-style Onsets &
Velocities) lineage Midee already runs server-side for piano, retrained
per-instrument. That kinship is promising for a future integration path
(same model family, same general deployment shape). **Measured onset F1 on
this spike's 12-track subset ranks `guitar-fl.pth` (0.903) >
`guitar-gaps.pth` (0.881) > Basic Pitch (0.750)**, and `guitar-fl.pth` also
wins on onset+offset F1 (0.674 vs. Basic Pitch's 0.543). That is a real,
measured accuracy edge, not a marginal one.

It does not, however, make either checkpoint a drop-in replacement for
Midee's piano model, for three independent reasons, none of which are true
of Midee's current piano model:

1. **Documented and measured as optimized for monophonic performance,
   not chords** — GuitarSet's `comp` tracks, which are chord-heavy, are
   outside both checkpoints' documented training/validation scope, and
   this spike's own false-negative-heavy error pattern on `comp` tracks
   (above) is empirically consistent with that. This is a trained-scope
   finding, not proof of a hard architectural ceiling — the underlying
   88-class CRNN's output layer is not structurally incapable of
   representing simultaneous active pitches, it simply wasn't optimized
   or validated for that case.
2. **Both checkpoints' training data has an unresolved license
   discrepancy** (GAPS: CC BY-NC-SA 4.0 on Zenodo vs. MIT on HF for what's
   described as the same dataset; François Leduc dataset: restricted/
   no-license on Zenodo, described as derived from a third party's
   *commercial, purchasable* transcription product, vs. MIT on a newer HF
   mirror).
3. **No browser path today, and a CPU memory floor that would need
   confirming on real target hardware before any deployment claim.** This
   is a PyTorch/CRNN model with no found JS/WASM/ONNX export — it would
   need a server-side deployment (like Midee's existing Pi piano pipeline)
   rather than running in the browser the way Basic Pitch does, and its
   measured **~7.3-7.7GB CPU peak RSS on this Apple Silicon Mac** is a
   concrete, specific reason for caution about resource-constrained
   targets like a Raspberry Pi — a good CPU real-time factor on this
   machine does not overcome that memory footprint, and neither the RTF
   nor the memory footprint have been measured on Pi hardware.

**Practical recommendation:** if this model family is pursued for a real
guitar-mode spike, (1) get written license confirmation from Xavier Riley
(and, for `guitar-fl.pth`, from François Leduc) before using either
checkpoint's output in a shipped feature, (2) **evaluate `guitar-gaps.pth`
and `guitar-fl.pth` side by side on a larger, more representative track
set before choosing either as a default** — this spike's 12-track subset
showed `guitar-fl.pth` ahead on both F1 metrics, which is a real,
reproducible result on that subset (see Model 2's "surprising result"
discussion), but 12 tracks is not enough evidence to lock in a default
over the package's own documented choice (`guitar-gaps.pth`), especially
given this spike has no verified explanation for the gap, (3) treat both
as solo/monophonic-trained — pair with a separate polyphonic fallback for
comped/strummed content, (4) don't use `.from_pretrained()`, use the
plain constructor with an explicit `hf_hub_download(..., revision=...)`
call feeding `checkpoint_path=` (see install notes and
`run_gaps_eval.py`'s `resolve_checkpoint()`), and (5) measure real Pi CPU
RTF and peak RSS before treating a Pi deployment as feasible — this
spike's ~7.3-7.7GB figure is an Apple Silicon number, not a Pi one, and
Pi ARM cores are a meaningfully slower class of hardware than this
spike's measurements reflect.

Of the two *directly usable* candidates, they're not really substitutes
for each other: **Basic Pitch is the clearer choice specifically for a
browser-embedded, license-simple first experiment** — the distributed
TypeScript code/model artifact is Apache-2.0. This spike did not audit the
rights or provenance of Basic Pitch's training data, so that artifact
license is not legal clearance for the training-data question.
**GAPS's checkpoints are the clearer choice if the
target is Python/server-side and the measured accuracy edge matters more
than immediate browser-readiness** — but only once the license and
Pi-hardware questions above are actually resolved, not assumed.

**Every candidate that actually produces output today produces pitch/
note-level output, not string/fret/tablature** — Basic Pitch, both GAPS
checkpoints, and GuitarMidi-LV2 are all pitch-only. That's exactly what
Midee's ergonomic mapper already consumes for piano (`MIDI note → mapper →
LED index`, per `README.md`'s data-flow diagram), so none of the three
runnable candidates requires Midee to build new string/fret-aware mapping
logic. **FretNet is the one architectural exception, not a fourth
pitch-only data point**: its published *architecture* is specifically
designed to output continuous pitch contours grouped by string/fret of
origin, which none of the other three even attempt — but with no
published pretrained checkpoint, that architecture produces no output at
all today. If FretNet is ever trained, it would be the only candidate
requiring (and rewarding) string/fret-aware integration work; until then
it's a paper, not a data point in the pitch-only comparison above.
GuitarMidi-LV2 still needs real Pi/ARM validation before any latency claim
can be trusted — M1's findings on both GuitarMidi-LV2 and FretNet are
otherwise unchanged by this correction.

## Risks

- **GAPS training-data license risk (new in this revision):** the GAPS
  dataset backing `guitar-gaps.pth` is published under **two different,
  conflicting licenses** by the same author (CC BY-NC-SA 4.0 on the
  original Zenodo record vs. MIT on the newer Hugging Face mirror) for
  what is described as the same underlying content. **Do not treat
  `guitar-gaps.pth` as commercially cleared until this is resolved in
  writing with the author** — see the dedicated subsection above.
- **François Leduc dataset license risk (new in this revision, arguably
  sharper than the GAPS one):** `guitar-fl.pth` — the *better-performing*
  checkpoint in this spike's measurements — is trained on 239 jazz guitar
  performances paired with transcriptions from a third party's commercial,
  purchasable transcription library. The dataset's original Zenodo record
  is access-restricted with no open license; a newer HF mirror tags MIT.
  **This is not just an author-relicensing question like GAPS — it
  potentially involves a second rights holder (François Leduc) whose
  commercial transcriptions the dataset is built from.** Do not use
  `guitar-fl.pth` commercially without confirming both Riley's and
  Leduc's positions in writing.
- **Surprising-result risk:** `guitar-fl.pth` beat the package's own
  documented default (`guitar-gaps.pth`) on both F1 metrics in this
  spike's measurements. This spike does not have a verified explanation
  (see Model 2 above) — treat it as a real, reproducible measurement on
  this specific 12-track subset, not as a general claim that
  `guitar-fl.pth` is "better" in all contexts. Re-verify on a larger
  sample before making it a default in any future work.
- **Code-license hygiene risk (new in this revision):** `hf_midi_transcription`'s
  README and `pyproject.toml` both assert MIT, but the repo ships no
  `LICENSE` file. Low risk of the intent being anything other than MIT,
  but "the README says so" is not the same as an actual license grant —
  flag for the author or wait for the file before relying on it formally.
- **Monophonic-scope risk (new in this revision):** `guitar-gaps.pth` and
  `guitar-fl.pth` are documented by their authors as optimized/trained/
  validated for monophonic performance, and this spike's own measurements
  (elevated false negatives on `comp` tracks) are empirically consistent
  with that. Any integration plan that assumes these checkpoints handle
  strummed/comped guitar well (the majority of real guitar playing, per
  GuitarSet's own 50/50 comp/solo split) should not rely on that
  assumption without its own testing — this is a measured training/
  validation-scope limitation, not a proven hard architectural ceiling on
  the underlying 88-class CRNN's ability to represent overlapping notes.
- **CPU memory / Pi-feasibility risk (new in this revision):** both GAPS
  checkpoints measured **~7.3-7.7GB peak process RSS** on CPU on this
  spike's Apple Silicon Mac — roughly 7-8x their own MPS-GPU footprint and
  roughly 16-17x Basic Pitch's ~452MB. This is a specific, measured number,
  not a guess, and it is a plausible hard blocker for Raspberry Pi-class
  hardware (typical deployed variants have 4-8GB total RAM) independent
  of CPU speed, especially on an 8GB shared-memory configuration. A 16GB
  Pi 5 exists, so this is not a universal Pi capacity ceiling. **Neither
  the memory footprint nor the real-time factor have been measured on
  actual Pi hardware in this spike** — an Apple M-series CPU core is not
  representative of a Pi's ARM Cortex-A-class core, so do not extrapolate
  this spike's good CPU real-time factors to a Pi without separately
  measuring both RTF and peak RSS there.
- **Accuracy risk:** Basic Pitch's measured onset+offset F1 is
  substantially lower than onset-only F1 across every profile tested here
  — sustained-note timing (not just onset detection) is the weaker link,
  which matters for Midee's key-down/key-up LED timing model.
- **License risk (Basic Pitch / GuitarMidi-LV2 / FretNet, unchanged from
  M1):** GuitarMidi-LV2's LGPL-2.0-or-later has copyleft implications for a
  statically-linked native integration (dynamic linking / plugin-boundary
  use is the safer LGPL pattern). Basic Pitch (Apache-2.0) and FretNet
  (MIT) remain commercially unencumbered on the code side.
- **Unverified-claims risk:** GuitarMidi-LV2's latency numbers are the
  author's own, on unspecified hardware — do not cite them as Midee-Pi
  numbers without independent Pi measurement.
- **Threshold-sensitivity risk:** as shown above, Basic Pitch's headline
  accuracy swings by roughly 2x in F1 depending on undocumented threshold
  choice — any future integration must pin and justify its thresholds
  explicitly rather than copying an illustrative README snippet. The same
  caution applies to GAPS: this spike used the package's own documented
  defaults (`onset_threshold=0.3`, `offset_threshold=0.3`,
  `frame_threshold=0.1`) without additional tuning.
- **Process risk (why M1 got this wrong):** M1's GAPS conclusion was
  reached by exhausting a fixed list of sources (paper site, dataset
  homepage, author's repo list, HF Papers, Papers-with-Code) at a single
  point in time, without re-opening a repo whose one-line GitHub
  description ("Audio-to-MIDI for solo saxophone") looked unrelated to
  guitar. **A repo's short metadata description is not a substitute for
  reading its current README** before concluding an artifact doesn't
  exist — this spike's correction process is itself evidence of that.

## Reproducibility

All findings with a checkmark above were produced by the code in
`tools/guitar-model-spike/` against real, checksummed GuitarSet v1.1 data
(see `results/fetch-report.json` for per-file SHA-256s) and a real,
pinned-version npm install (`@spotify/basic-pitch@1.0.1`,
`@tensorflow/tfjs@^3.21.0`, exact resolved versions in
`tools/guitar-model-spike/package-lock.json`) for Basic Pitch, and a real,
isolated `uv`-managed Python 3.11 virtualenv
(`tools/guitar-model-spike/python/.venv`, gitignored) for the GAPS/FL
checkpoints, with `hf-midi-transcription` installed from the pinned git
commit above and `huggingface-hub` pinned to `0.25.2` (see the version-skew
note in Model 2). The exact resolved transitive dependency tree —
including `piano-transcription-inference`'s git commit, which is
*unpinned* in `hf-midi-transcription`'s own `pyproject.toml` — is captured
in the committed lock file
`tools/guitar-model-spike/python/requirements-lock.txt` (raw `uv pip
freeze` output from the environment that actually produced this
revision's numbers), so reproduction doesn't depend on whatever `main`
resolves to on a fresh install. `run_gaps_eval.py` also explicitly
resolves and downloads each checkpoint via `hf_hub_download(...,
revision=...)` before constructing the model (see `resolve_checkpoint()`),
and records the resulting portable repo/requested-ref/resolved-commit/
file/snapshot metadata
and `checkpointSha256` in every output JSON,
independently re-verified in this revision against the `x-linked-etag`
values recorded in Model 2's "What exists" table — same file, two
independent checksum sources, matching. See
`tools/guitar-model-spike/README.md` for exact reproduction steps for
both toolchains, including the CPU-forced commands used for the
memory/RTF numbers in this revision:

```bash
python run_gaps_eval.py --instrument guitar_gaps --device cpu --suffix=-cpu
python run_gaps_eval.py --instrument guitar_fl --device cpu --suffix=-cpu
```

(Omit `--device` to let the package auto-select MPS on Apple Silicon, as
the non-`-cpu`-suffixed `results/results.gaps-*.json` files did.) Every
`results/results.gaps-*.json` file records the actual `device` used, the
`requestedDevice` argument, the resolved checkpoint source and hash,
`dependencyVersions`, installed VCS revisions
(`hf-midi-transcription` at
`96f6797881e9497cbfc8f8e5deccea9c1f2f7adc` and
`piano-transcription-inference` at
`7568dc7f78b625e40cf9776e2806d164006610e3`), and the committed lock's
SHA-256 (`e7e6cfcc9ba678b2f5012730189e6160cb0fb1d846eda51cfd38ff24d854af42`).
Thus which run produced which numbers — and against which exact
checkpoint and dependency set — is verifiable from the artifact itself,
not just this document's prose.

Pinned upstream revisions:

| Project | Commit / revision |
| --- | --- |
| spotify/basic-pitch-ts | `2d498f82b61c71898edf0e8dd661b99076676c8b` |
| spotify/basic-pitch (Python, reference only) | `fa5997af0a8210982619003269994a1be25eddf3` |
| xavriley/hf_midi_transcription | `96f6797881e9497cbfc8f8e5deccea9c1f2f7adc` (`main`) |
| xavriley/piano_transcription_inference (fork, git dependency) | `7568dc7f78b625e40cf9776e2806d164006610e3` |
| xavriley/midi-transcription-models (HF model repo) | `689e773723bcafd8c81015b10c03f12675ce16ec` |
| xavriley/GAPS (HF dataset repo, referenced not downloaded) | `b4c89a33a639c7ae903e74102dfbb3e147e1417f` |
| xavriley/FrancoisLeducGuitarDataset (HF dataset repo, referenced not downloaded) | `a38306c244b3ea81496ad58b4514622185e58211` |
| xavriley/HighResolutionGuitarTranscription (paper companion site only, superseded as "the" GAPS pointer by the above) | `c82d461c38ae951840c97095b2b47d21ba5f12e9` |
| geraldmwangi/GuitarMidi-LV2 | `153327048989bffd3b623572eb5ddd0bc261b526` |
| cwitkowitz/guitar-transcription-continuous (FretNet) | `d481054f54184374c04b1cc27a487dc35c87f353` |
| GuitarSet v1.1 (Zenodo, evaluation benchmark — unchanged from M1) | record 3371780, `annotation.zip` sha256 `8daa02e6417ccca1685feb44b135e95928ad7037e5032ecb326b5791856fda99` |
| GAPS dataset (Zenodo, training data for guitar-gaps.pth, license reference only) | record 13962272, CC BY-NC-SA 4.0, `gaps_v1_no_audio.zip` |
| François Leduc Dataset (Zenodo, training data for guitar-fl.pth, license reference only) | record 10984521, access-restricted, no open license |
