# guitar-model-spike

Research spike (M1, corrected/extended in M1R and M1R2): feasibility
evaluation of open-source guitar transcription models for Midee. See
[`docs/GUITAR_TRANSCRIPTION_MODEL_EVALUATION.md`](../../docs/GUITAR_TRANSCRIPTION_MODEL_EVALUATION.md)
at the repo root for the full write-up, conclusions, and risk assessment.

**This directory is fully isolated from the root app**: its own
`package.json`, its own `node_modules`, its own Vite/TypeScript config. It
does not change any root dependency and is never imported by `src/`.
Nothing here ships in the Midee production build.

## What's in here

| Path | Purpose |
| --- | --- |
| `data/guitarset-track-list.json` | The real, verified 360-track GuitarSet v1.1 manifest (source: Zenodo record 3371780's `annotation.zip` listing). |
| `scripts/select-subset.mjs` | Deterministic selection of 12 tracks (1 comp + 1 solo × 6 players) by ascending SHA-256 hash of `track_id`. Re-running always produces the same 12 tracks. |
| `scripts/remote-zip.mjs` | Generic HTTP-Range-based partial ZIP reader (no deps) -- pulls only the needed member files out of Zenodo's multi-hundred-MB archives instead of downloading the whole thing. |
| `scripts/fetch-subset.mjs` | Uses `remote-zip.mjs` to cache just the 12 selected tracks' audio + annotations under `.cache/` (gitignored, never committed). |
| `scripts/wav.mjs` | Minimal 16-bit PCM WAV decoder + linear resampler to 22050 Hz mono (what Basic Pitch requires). |
| `scripts/parse-jams.mjs` | Parses GuitarSet's real `.jams` ground-truth annotation format into a flat polyphonic note list. |
| `scripts/basic-pitch-runner.mjs` | Runs real `@spotify/basic-pitch` inference in Node via the `@tensorflow/tfjs` CPU backend (see report for why not `tfjs-node`). |
| `scripts/metrics.mjs` | Onset F1 @ 50ms, onset+offset F1, FP/FN -- mir_eval-style note-transcription metrics. |
| `scripts/measure.mjs` | Orchestrates the full run: decode → infer → score → write `results/results.<profile>.json`. |
| `src/browserSmoke.ts` + `vite.config.ts` | Minimal real browser build (`npm run build:browser-smoke`) to measure actual bundled bytes under this repo's pinned Vite 8. |
| `python/gaps_probe_README.md` | **M1R:** corrected — documents the real, working install/probe of `xavriley/hf_midi_transcription` + `xavriley/midi-transcription-models`, including the bugs found and fixes used. M1's original conclusion (no code/weights exist) was wrong; see this file and the docs report's Model 2 section for the full correction. |
| `python/run_gaps_eval.py` | Real end-to-end evaluation script: loads a pinned guitar checkpoint (`guitar-gaps.pth` or `guitar-fl.pth`) via an isolated `uv` venv, runs it against the same 12-track subset/ground truth as Basic Pitch, scores with the same onset/onset+offset F1 methodology (reimplemented in Python so this script is self-contained). Supports `--device {cpu,mps,cuda}` to force a torch device and `--suffix` to avoid overwriting results across devices; each device produces materially different RTF/memory (not accuracy) numbers, see docs report. |
| `python/instruments.json` | Workaround copy of the upstream repo's instrument→checkpoint config, needed because it isn't packaged into the installed `hf-midi-transcription` distribution (see docs report Model 2, packaging bug #5); also used by `resolve_checkpoint()` to map instrument name → checkpoint filename for the pinned `hf_hub_download()` call. |
| `python/requirements-lock.txt` | Committed `uv pip freeze` output pinning every resolved dependency, including `piano-transcription-inference`'s git commit (unpinned upstream in `hf-midi-transcription`'s own `pyproject.toml` -- this file is what actually pins it). |
| `python/.venv/` | Isolated `uv`-managed Python 3.11 virtualenv. Gitignored, never committed. |
| `.cache/huggingface/` | Isolated `HF_HOME` for this spike's model-weight downloads. Gitignored, never committed — same policy as GuitarSet audio. |
| `results/` | Committed, small (<100KB) JSON/markdown outputs of runs actually executed in this spike. Raw audio/weights are never committed. |

## Reproducing

Basic Pitch (Node/TypeScript):

```bash
cd tools/guitar-model-spike
npm install
node scripts/select-subset.mjs        # writes data/selected-subset.json
node scripts/fetch-subset.mjs both     # caches audio + annotations under .cache/
node scripts/measure.mjs upstream-python-defaults   # or: ts-readme-example
npm run build:browser-smoke            # real Vite 8 browser build, see dist/
```

GAPS / François Leduc guitar checkpoints (Python, via `uv`, requires the
Basic Pitch steps above to have already populated `.cache/audio` and
`.cache/annotations`):

```bash
cd tools/guitar-model-spike/python
uv venv --python 3.11 .venv
source .venv/bin/activate

# Preferred: exact resolved versions, including the unpinned-upstream
# piano-transcription-inference git commit:
uv pip install -r requirements-lock.txt

# Equivalent from scratch (what generated the lock file above):
# uv pip install "git+https://github.com/xavriley/hf_midi_transcription.git@96f6797881e9497cbfc8f8e5deccea9c1f2f7adc"
# uv pip install "huggingface-hub==0.25.2"   # works around a version-skew bug, see docs report

export HF_HOME="$(cd .. && pwd)/.cache/huggingface"

# Auto-selected device (MPS on Apple Silicon) -> results/results.gaps-<instrument>.json
python run_gaps_eval.py --instrument guitar_gaps   # or: guitar_fl

# CPU-forced -> results/results.gaps-<instrument>-cpu.json (comparable to
# Basic Pitch's CPU-JS-backend RTF; also where the ~7.3-7.7GB peak RSS
# finding in the docs report comes from -- see --device/--suffix below)
python run_gaps_eval.py --instrument guitar_gaps --device cpu --suffix=-cpu
python run_gaps_eval.py --instrument guitar_fl --device cpu --suffix=-cpu
```

`--device {cpu,mps,cuda}` forces a torch device (omit to let the package
auto-select); `--suffix` is appended to the output filename so CPU and
auto-selected runs don't overwrite each other. `--revision` (defaults to
the pinned commit above) is *enforced*, not just recorded: the script
explicitly downloads the checkpoint at that exact revision via
`hf_hub_download()` before constructing the model, rather than relying on
the model constructor's own resolution (which never accepts a revision
and would otherwise silently follow the repo's default branch on an
uncached run). Every result JSON records `device` (what actually ran),
`requestedDevice` (what was asked for), `checkpointSha256` (the resolved
file's checksum), and `dependencyVersions`, so this is all verifiable from
the artifact itself, not just from how you invoked the script.

Both `fetch-subset.mjs` and the GAPS steps talk to the internet (Zenodo,
Hugging Face). Nothing either downloads is committed; `.cache/` and
`python/.venv/` are gitignored.

**A note on comparing devices:** this machine is an Apple Silicon Mac.
Its CPU-forced numbers are directly comparable to Basic Pitch's CPU-JS
numbers (both CPU, same machine), but **none of these numbers are
Raspberry Pi measurements** -- Apple M-series CPU cores are a different,
generally faster performance class than a Pi's ARM cores. Re-measure both
RTF and peak RSS on actual target hardware before drawing any Pi-feasibility
conclusion.
