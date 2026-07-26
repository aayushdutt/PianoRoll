#!/usr/bin/env python3
"""
Real (non-mocked) inference + evaluation of xavriley/midi-transcription-models'
guitar checkpoints (guitar-gaps.pth by default, guitar-fl.pth optionally)
against the same 12-track deterministic GuitarSet v1.1 subset used for the
Basic Pitch evaluation (see ../scripts/select-subset.mjs /
../data/selected-subset.json), reusing the same cached audio/annotations
under ../.cache/.

Ground truth is parsed directly from the real .jams files (same format the
Node harness uses) so both models are scored with an identical methodology.
Onset F1@50ms / onset+offset F1 / FP / FN are computed here in Python
(mirroring ../scripts/metrics.mjs's greedy nearest-onset matching) rather
than round-tripping through Node, to keep this script self-contained and
runnable independent of the npm install.

Usage:
    source .venv/bin/activate
    HF_HOME=$(cd .. && pwd)/.cache/huggingface python run_gaps_eval.py \
        --instrument guitar_gaps --revision 689e773723bcafd8c81015b10c03f12675ce16ec
"""
import argparse
import hashlib
import importlib.metadata
import json
import re
import resource
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # tools/guitar-model-spike/
ONSET_TOL_SEC = 0.05
OFFSET_TOL_MIN_SEC = 0.05
OFFSET_TOL_RATIO = 0.2
CHECKPOINT_REPO_ID = "xavriley/midi-transcription-models"
REQUIREMENTS_LOCK = ROOT / "python" / "requirements-lock.txt"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def dependency_metadata(package_names):
    """Read installed versions and immutable VCS revisions from PEP 610 metadata."""
    versions = {}
    vcs_revisions = {}
    for package_name in package_names:
        distribution = importlib.metadata.distribution(package_name)
        versions[package_name] = distribution.version
        direct_url_text = distribution.read_text("direct_url.json")
        if direct_url_text:
            direct_url = json.loads(direct_url_text)
            commit_id = direct_url.get("vcs_info", {}).get("commit_id")
            if commit_id:
                vcs_revisions[package_name] = commit_id
    return versions, vcs_revisions


def peak_rss_metadata(raw_peak_rss, platform=sys.platform):
    """Normalize ru_maxrss to KiB; Darwin reports bytes, Linux reports KiB."""
    raw_unit = "bytes" if platform == "darwin" else "KiB"
    peak_rss_kb = raw_peak_rss / 1024 if raw_unit == "bytes" else raw_peak_rss
    return {
        "platform": platform,
        "peakRssRaw": raw_peak_rss,
        "peakRssRawUnit": raw_unit,
        "peakRssKb": peak_rss_kb,
    }


def resolved_snapshot_revision(checkpoint_path: Path) -> str:
    """Extract the immutable commit directory returned by hf_hub_download."""
    parts = checkpoint_path.parts
    try:
        snapshots_index = parts.index("snapshots")
        resolved_revision = parts[snapshots_index + 1]
    except (ValueError, IndexError) as error:
        raise ValueError(
            f"checkpoint path does not identify a Hugging Face snapshot: {checkpoint_path}"
        ) from error
    if not re.fullmatch(r"[0-9a-fA-F]{40}", resolved_revision):
        raise ValueError(
            "checkpoint path does not identify an immutable 40-character "
            f"Hugging Face commit SHA: {checkpoint_path}"
        )
    return resolved_revision


def resolve_checkpoint(instrument: str, revision: str) -> Path:
    """Explicitly pin and download the checkpoint for `instrument` at
    `revision` via hf_hub_download, rather than relying on
    MidiTranscriptionModel's own constructor to resolve one implicitly.
    The constructor's internal _download_model_if_needed() never accepts a
    revision argument (it always resolves against the repo's default
    branch), so a fresh, uncached run of this script without this explicit
    step could silently fetch main instead of the pinned commit.
    """
    from huggingface_hub import hf_hub_download

    instruments_config = json.loads((ROOT / "python" / "instruments.json").read_text())
    checkpoint_file = instruments_config[instrument]["checkpoint_file"]
    local_path = hf_hub_download(
        repo_id=CHECKPOINT_REPO_ID,
        filename=checkpoint_file,
        revision=revision,
    )
    return Path(local_path)


def parse_ground_truth_notes(jams_path: Path):
    doc = json.loads(jams_path.read_text())
    notes = []
    for ann in doc["annotations"]:
        if ann["namespace"] != "note_midi":
            continue
        for ev in ann["data"]:
            if ev.get("value") is None or ev.get("time") is None or ev.get("duration") is None:
                continue
            notes.append(
                {
                    "onsetSec": ev["time"],
                    "offsetSec": ev["time"] + ev["duration"],
                    "midi": round(ev["value"]),
                }
            )
    notes.sort(key=lambda n: n["onsetSec"])
    return notes


def greedy_match(gt_notes, pred_notes, is_match):
    candidates = []
    for i, gt in enumerate(gt_notes):
        for j, pred in enumerate(pred_notes):
            if is_match(gt, pred):
                candidates.append((abs(gt["onsetSec"] - pred["onsetSec"]), i, j))
    candidates.sort(key=lambda c: c[0])
    gt_used = [False] * len(gt_notes)
    pred_used = [False] * len(pred_notes)
    matched = 0
    for _, i, j in candidates:
        if gt_used[i] or pred_used[j]:
            continue
        gt_used[i] = True
        pred_used[j] = True
        matched += 1
    return matched


def prf(matched, gt_count, pred_count):
    precision = matched / pred_count if pred_count else 0.0
    recall = matched / gt_count if gt_count else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return precision, recall, f1


def evaluate_notes(gt_notes, pred_notes):
    onset_only_matched = greedy_match(
        gt_notes,
        pred_notes,
        lambda gt, pred: gt["midi"] == pred["midi"]
        and abs(gt["onsetSec"] - pred["onsetSec"]) <= ONSET_TOL_SEC,
    )

    def onset_offset_match(gt, pred):
        if gt["midi"] != pred["midi"]:
            return False
        if abs(gt["onsetSec"] - pred["onsetSec"]) > ONSET_TOL_SEC:
            return False
        tol = max(OFFSET_TOL_MIN_SEC, OFFSET_TOL_RATIO * (gt["offsetSec"] - gt["onsetSec"]))
        return abs(gt["offsetSec"] - pred["offsetSec"]) <= tol

    onset_offset_matched = greedy_match(gt_notes, pred_notes, onset_offset_match)

    p1, r1, f1_1 = prf(onset_only_matched, len(gt_notes), len(pred_notes))
    p2, r2, f1_2 = prf(onset_offset_matched, len(gt_notes), len(pred_notes))

    return {
        "groundTruthNoteCount": len(gt_notes),
        "predictedNoteCount": len(pred_notes),
        "onsetOnly": {
            "precision": p1,
            "recall": r1,
            "f1": f1_1,
            "truePositives": onset_only_matched,
            "falsePositives": len(pred_notes) - onset_only_matched,
            "falseNegatives": len(gt_notes) - onset_only_matched,
        },
        "onsetAndOffset": {
            "precision": p2,
            "recall": r2,
            "f1": f1_2,
            "truePositives": onset_offset_matched,
            "falsePositives": len(pred_notes) - onset_offset_matched,
            "falseNegatives": len(gt_notes) - onset_offset_matched,
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instrument", default="guitar_gaps", choices=["guitar_gaps", "guitar_fl"])
    ap.add_argument(
        "--revision",
        default="689e773723bcafd8c81015b10c03f12675ce16ec",
        help="pinned xavriley/midi-transcription-models commit",
    )
    ap.add_argument(
        "--device",
        default=None,
        choices=[None, "cpu", "mps", "cuda"],
        help="Force a torch device. Default (None) lets the package "
        "auto-select (MPS on Apple Silicon). Pass 'cpu' to get numbers "
        "comparable with the Basic Pitch CPU-JS-backend RTF measurements.",
    )
    ap.add_argument(
        "--suffix",
        default="",
        help="appended to the output results filename, e.g. '-cpu'",
    )
    args = ap.parse_args()

    from hf_midi_transcription import MidiTranscriptionModel

    # NOTE: deliberately using the plain constructor, not
    # MidiTranscriptionModel.from_pretrained(...). from_pretrained() goes
    # through PyTorchModelHubMixin, which (a) hit a real version-skew bug
    # against huggingface-hub>=1.0 in this spike (see docs report) and (b)
    # does a full *repo snapshot* download (~700MB, every instrument's
    # checkpoint) instead of just the one file needed.
    #
    # We ALSO don't rely on the constructor's own implicit checkpoint
    # resolution (MidiTranscriptionModel(instrument=...) with no
    # checkpoint_path) -- its _download_model_if_needed() calls
    # hf_hub_download() with no `revision` argument, which resolves against
    # the repo's default branch. That means an unpinned fresh run (empty
    # HF cache) could silently fetch whatever is on `main` at run time,
    # not the commit this script/report claims to be pinned to. Instead we
    # explicitly resolve+download via resolve_checkpoint(revision=...)
    # first, then hand the constructor that exact local path, so the
    # revision pin is enforced, not just narrated.
    checkpoint_path = resolve_checkpoint(args.instrument, args.revision)
    checkpoint_resolved_revision = resolved_snapshot_revision(checkpoint_path)
    checkpoint_sha256 = sha256_file(checkpoint_path)
    print(
        f"resolved checkpoint: {checkpoint_path.name} @ {checkpoint_resolved_revision} "
        f"(requested={args.revision}; sha256={checkpoint_sha256[:16]}...)",
        flush=True,
    )

    t0 = time.time()
    model = MidiTranscriptionModel(
        instrument=args.instrument, device=args.device, checkpoint_path=str(checkpoint_path)
    )
    model_load_s = time.time() - t0
    print(f"model load: {model_load_s:.2f}s (device={model.device})", flush=True)

    # Record the actually-resolved dependency versions, not just what this
    # script's --revision default claims -- e.g. piano-transcription-inference
    # is an unpinned git dependency of hf-midi-transcription's own
    # pyproject.toml, so what's actually installed can only be known by
    # asking the running interpreter, not by reading source.
    try:
        dependency_versions, dependency_vcs_revisions = dependency_metadata(
            [
                "hf-midi-transcription",
                "piano-transcription-inference",
                "torch",
                "huggingface-hub",
            ]
        )
    except Exception as e:  # pragma: no cover - diagnostic only
        dependency_versions = {"error": str(e)}
        dependency_vcs_revisions = {"error": str(e)}

    subset = json.loads((ROOT / "data" / "selected-subset.json").read_text())
    per_track = []
    tmp_midi = ROOT / "python" / "_tmp_pred.mid"

    for t in subset["tracks"]:
        track_id = t["trackId"]
        wav_path = ROOT / ".cache" / "audio" / f"{track_id}_mic.wav"
        jams_path = ROOT / ".cache" / "annotations" / f"{track_id}.jams"
        if not wav_path.exists() or not jams_path.exists():
            per_track.append({"trackId": track_id, "status": "UNVERIFIED_MISSING_INPUT"})
            print(f"SKIP {track_id}: missing cached input", flush=True)
            continue

        gt_notes = parse_ground_truth_notes(jams_path)

        import soundfile as sf

        info = sf.info(str(wav_path))
        audio_duration_sec = info.frames / info.samplerate

        t0 = time.time()
        _, result = model.transcribe(str(wav_path), str(tmp_midi), activations=True)
        inference_s = time.time() - t0

        pred_notes = [
            {
                "onsetSec": ev["onset_time"],
                "offsetSec": ev["offset_time"],
                "midi": ev["midi_note"],
            }
            for ev in result["est_note_events"]
        ]

        metrics = evaluate_notes(gt_notes, pred_notes)
        rtf = inference_s / audio_duration_sec

        per_track.append(
            {
                "trackId": track_id,
                "player": t["player"],
                "part": t["part"],
                "status": "MEASURED",
                "audioDurationSec": audio_duration_sec,
                "inferenceSec": inference_s,
                "realTimeFactor": rtf,
                # The first track processed by a freshly-constructed model
                # pays for lazy backend/kernel warm-up (device dispatch
                # setup, first-call JIT/graph tracing, etc.) that later
                # tracks don't -- its RTF is not representative of
                # steady-state throughput. Flagged explicitly here rather
                # than silently averaged in without comment.
                "isFirstInference": len(per_track) == 0,
                "predictedNoteCount": len(pred_notes),
                "groundTruthNoteCount": len(gt_notes),
                "metrics": metrics,
            }
        )
        print(
            f"MEASURED {track_id}: RTF={rtf:.3f} "
            f"onsetF1={metrics['onsetOnly']['f1']:.3f} "
            f"onsetOffsetF1={metrics['onsetAndOffset']['f1']:.3f} "
            f"(gt={len(gt_notes)} pred={len(pred_notes)})",
            flush=True,
        )

    if tmp_midi.exists():
        tmp_midi.unlink()

    measured = [r for r in per_track if r["status"] == "MEASURED"]
    rss_metadata = peak_rss_metadata(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)

    warmed = [r for r in measured if not r["isFirstInference"]]

    summary = (
        {
            "tracksMeasured": len(measured),
            "tracksTotal": len(per_track),
            "meanOnsetF1": sum(r["metrics"]["onsetOnly"]["f1"] for r in measured) / len(measured),
            "meanOnsetOffsetF1": sum(r["metrics"]["onsetAndOffset"]["f1"] for r in measured)
            / len(measured),
            "meanRealTimeFactor": sum(r["realTimeFactor"] for r in measured) / len(measured),
            # First-track RTF is inflated by device/backend warm-up (see
            # isFirstInference above); this excludes it so the "steady
            # state" number is available without recomputing from perTrack.
            "meanRealTimeFactorExcludingFirstInference": (
                sum(r["realTimeFactor"] for r in warmed) / len(warmed) if warmed else None
            ),
            "totalFalsePositives": sum(
                r["metrics"]["onsetOnly"]["falsePositives"] for r in measured
            ),
            "totalFalseNegatives": sum(
                r["metrics"]["onsetOnly"]["falseNegatives"] for r in measured
            ),
        }
        if measured
        else {"tracksMeasured": 0, "tracksTotal": len(per_track)}
    )

    out = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "instrument": args.instrument,
        "checkpointRepoId": CHECKPOINT_REPO_ID,
        "checkpointRequestedRevision": args.revision,
        "checkpointResolvedRevision": checkpoint_resolved_revision,
        "checkpointFile": checkpoint_path.name,
        "checkpointSnapshot": (
            f"snapshots/{checkpoint_resolved_revision}/{checkpoint_path.name}"
        ),
        "checkpointSha256": checkpoint_sha256,
        "dependencyVersions": dependency_versions,
        "dependencyVcsRevisions": dependency_vcs_revisions,
        "requirementsLock": {
            "path": "python/requirements-lock.txt",
            "sha256": sha256_file(REQUIREMENTS_LOCK),
        },
        "device": str(model.device),
        "requestedDevice": args.device,
        "modelLoadSec": model_load_s,
        **rss_metadata,
        "summary": summary,
        "perTrack": per_track,
    }

    out_path = ROOT / "results" / f"results.gaps-{args.instrument}{args.suffix}.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"\nWrote {out_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
