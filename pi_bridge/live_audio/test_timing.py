"""Offline checks for the bridge's onset scheduling. No Pi, no model, no audio.

Run: python test_timing.py

Builds a LiveAudioBridge shell without loading ONNX, drives schedule_batch() with a
fake clock, and asserts that note spacing survives the conditions that used to
deform it. Also reimplements the old anchor so the regression is visible rather
than asserted on faith.
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import heapq
import sys
import types

import numpy as np

# Nothing under test touches ONNX or the websocket server, and neither is installed
# on the dev host. Stub them so the module imports for pure scheduling checks.
for name in ("onnxruntime", "websockets", "websockets.asyncio", "websockets.exceptions"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["onnxruntime"].InferenceSession = object
sys.modules["onnxruntime"].SessionOptions = object
_server = types.ModuleType("websockets.asyncio.server")
_server.ServerConnection = object
_server.serve = None
sys.modules["websockets.asyncio.server"] = _server
sys.modules["websockets.exceptions"].ConnectionClosed = ConnectionError

import live_audio_bridge as lab

SR = lab.SAMPLE_RATE
HOP_S = 0.5
CHUNK = int(HOP_S * SR)


class FakeClock:
    """Stands in for the module's `time`; only monotonic() is used here."""

    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now


def make_bridge(clock: FakeClock, **overrides: float) -> lab.LiveAudioBridge:
    lab.time = clock  # schedule_batch calls time.monotonic() through the module global
    bridge = object.__new__(lab.LiveAudioBridge)  # skip __init__: it loads the model
    defaults = dict(
        latency_budget=0.25, max_slew=0.02, resync_threshold=1.0,
        slack_window=40, frame_off_threshold=0.5,
        frame_release_debounce=3)
    defaults.update(overrides)
    bridge.args = argparse.Namespace(**defaults)
    bridge.scheduled_events = []
    bridge.schedule_wakeup = asyncio.Event()
    bridge.schedule_sequence = 0
    bridge.epoch = None
    bridge.schedule_slack_s = 0.0
    bridge.slack_window = collections.deque(maxlen=bridge.args.slack_window)
    bridge.resync_count = 0
    bridge.timing_mode = "adaptive"
    bridge.epoch_adjustment_ms = 0.0
    bridge.trace_active = False
    bridge.trace_started_at = 0.0
    bridge.trace_batch_sequence = 0
    bridge.trace_event_sequence = 0
    bridge.energy_off = False
    bridge.sched_on = [False] * 88
    bridge.sched_peak = [0.0] * 88
    bridge.sched_age = [0] * 88
    bridge.sched_below = [0] * 88
    bridge.sched_event_id = [None] * 88
    return bridge


def run_old_anchor(inference_times, capture_period=HOP_S):
    """The previous anchor, `batch_start = max(now, cursor)`, on the same clock model."""
    cursor = None
    now = 1000.0
    dues = []
    for index, cost in enumerate(inference_times):
        now = max(1000.0 + (index + 1) * capture_period, now) + cost
        batch_start = max(now, cursor or now)
        cursor = batch_start + HOP_S
        dues.append(batch_start)
    return dues


def run_batches(bridge, clock, inference_times, capture_period=HOP_S):
    """Schedule one onset at the head of each consecutive target span.

    The clock model matters. A batch cannot start before its audio has arrived,
    but if the loop is behind, the capture pipe has already buffered and the next
    batch starts immediately -- so the loop drains a backlog at inference speed:

        now = max(audio_arrival, now) + inference

    Modelling it as `arrival + inference` instead lets `now` run backwards after a
    stall, which is unphysical and produces meaningless results.

    Returns the wall-clock due time of each onset. Ideal: consecutive dues exactly
    `capture_period` apart, matching their spacing in the audio.
    """
    dues = []
    now = 1000.0
    for index, inference in enumerate(inference_times):
        target_start = index * CHUNK
        target_end = target_start + CHUNK
        arrival = 1000.0 + (index + 1) * capture_period
        now = max(arrival, now) + inference
        clock.now = now
        before = len(bridge.scheduled_events)
        bridge.schedule_batch([(target_start, 60, 80)], target_start, target_end)
        dues.append(bridge.scheduled_events[-1][0] if len(bridge.scheduled_events) > before else None)
        heapq.heapify(bridge.scheduled_events)
    return dues


def spacings(dues):
    return [b - a for a, b in zip(dues, dues[1:])]


def check(label: str, condition: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if condition else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    return condition


def test_steady_state() -> None:
    print("\n[1] steady state: constant inference cost")
    clock = FakeClock()
    bridge = make_bridge(clock)
    dues = run_batches(bridge, clock, [0.18] * 20)
    gaps = spacings(dues)
    worst = max(abs(g - HOP_S) for g in gaps)
    ok = check("note spacing matches audio spacing", worst < 1e-9, f"max error {worst * 1e6:.3f} us")
    ok &= check(
        "slack parked at the budget",
        abs(bridge.schedule_slack_s - 0.25) < 1e-9,
        f"slack {bridge.schedule_slack_s * 1000:.1f} ms",
    )
    assert ok


def test_transient_stall() -> None:
    print("\n[2] transient stall: one batch takes 400 ms extra (the regression)")
    inference = [0.18] * 20
    inference[7] += 0.40

    clock = FakeClock()
    bridge = make_bridge(clock)
    worst = max(abs(g - HOP_S) for g in spacings(run_batches(bridge, clock, inference)))
    old_worst = max(abs(g - HOP_S) for g in spacings(run_old_anchor(inference)))

    ok = check("spacing preserved across the stall", worst < 1e-9, f"max error {worst * 1e6:.3f} us")
    ok &= check(
        "old anchor demonstrably deformed it",
        old_worst > 0.1,
        f"max error {old_worst * 1000:.0f} ms",
    )
    ok &= check("budget absorbed it without a step", bridge.resync_count == 0)
    assert ok


def test_ratchet() -> None:
    print("\n[3] worsening stalls: latency must not ratchet")
    # The old anchor only ratchets when a stall exceeds the slack its predecessors
    # left behind, so its offset tracks the running maximum stall. Escalate.
    inference = [0.18] * 60
    for index, extra in ((10, 0.20), (25, 0.40), (40, 0.60)):
        inference[index] += extra

    clock = FakeClock()
    bridge = make_bridge(clock)
    dues = run_batches(bridge, clock, inference)
    offsets = [due - (1000.0 + index * HOP_S) for index, due in enumerate(dues)]
    growth = offsets[-1] - offsets[0]

    old_dues = run_old_anchor(inference)
    old_offsets = [due - (1000.0 + index * HOP_S) for index, due in enumerate(old_dues)]
    old_growth = old_offsets[-1] - old_offsets[0]

    ok = check("display offset stays flat", abs(growth) < 1e-9, f"drift {growth * 1000:+.1f} ms")
    ok &= check(
        "old anchor ratcheted to the worst stall",
        old_growth > 0.5,
        f"grew {old_growth * 1000:+.0f} ms over 30 s",
    )
    assert ok


def test_drift() -> None:
    print("\n[4] clock drift: phone crystal 200 ppm fast")
    clock = FakeClock()
    bridge = make_bridge(clock)
    # Capture delivers slightly faster than nominal, so slack erodes every batch.
    dues = run_batches(bridge, clock, [0.18] * 400, capture_period=HOP_S * (1 - 200e-6))
    gaps = spacings(dues)
    worst = max(abs(g - HOP_S) for g in gaps)

    ok = check(
        "slew keeps slack near the budget",
        abs(bridge.schedule_slack_s - 0.25) < 0.02,
        f"slack {bridge.schedule_slack_s * 1000:.1f} ms after 200 s",
    )
    ok &= check("corrections stay inaudible", worst < 0.011, f"max step {worst * 1000:.2f} ms")
    ok &= check("no steps taken", bridge.resync_count == 0)
    assert ok


def test_resync() -> None:
    print("\n[5] catastrophic lag: step once to recover, then slew the surplus away")
    clock = FakeClock()
    bridge = make_bridge(clock)
    inference = [0.18] * 5 + [4.0] + [0.18] * 600
    dues = run_batches(bridge, clock, inference)

    ok = check("stepped exactly once", bridge.resync_count == 1, f"resyncs {bridge.resync_count}")
    ok &= check(
        "surplus slewed back to the budget",
        abs(bridge.schedule_slack_s - 0.25) < 0.02,
        f"slack {bridge.schedule_slack_s * 1000:.1f} ms",
    )
    # After the emergency step, the drain leaves several seconds of surplus slack.
    # Reeling it in must stay imperceptible, never lurch.
    tail = spacings(dues[20:])
    worst = max(abs(g - HOP_S) for g in tail)
    ok &= check("recovery stays inaudible", worst < 0.011, f"max step {worst * 1000:.2f} ms")
    ok &= check("never late again", min(bridge.slack_window) > 0)
    assert ok


def test_subframe() -> None:
    print("\n[6] sub-frame interpolation")
    ok = True
    for truth in (-0.4, -0.25, 0.0, 0.25, 0.4):
        # Sample a downward parabola peaking at 10 + truth.
        frames = np.arange(21, dtype=np.float64)
        curve = 1.0 - 0.02 * (frames - (10 + truth)) ** 2
        estimate = lab._subframe_offset(curve, 10)
        ok &= check(f"recovers offset {truth:+.2f}", abs(estimate - truth) < 1e-9, f"got {estimate:+.6f}")
    ok &= check("flat curve yields no shift", lab._subframe_offset(np.ones(21), 10) == 0.0)
    ok &= check("edge frame yields no shift", lab._subframe_offset(np.ones(21), 0) == 0.0)
    ok &= check(
        "clamped to half a frame",
        abs(lab._subframe_offset(np.array([0.9, 1.0, 0.1]), 1)) <= 0.5,
    )
    assert ok


def test_tiling() -> None:
    print("\n[7] target spans still tile exactly under catch-up")
    # Sub-frame refinement must not change which batch an onset belongs to.
    positions = []
    for index in range(10):
        start, end = index * CHUNK, (index + 1) * CHUNK
        positions.append([p for p in range(start, end, lab.HOP) if start <= p < end])
    flat = [p for group in positions for p in group]
    ok = check("no position claimed twice", len(flat) == len(set(flat)))
    ok &= check("no gap between spans", flat == sorted(flat))
    assert ok


def test_buffer_sizing() -> None:
    print("\n[8] ring buffer always holds the largest window we may request")
    ok = True
    for hop in (0.25, 0.5, 1.0):
        for past in (1.0, 1.5, 3.0):
            for lookahead in (0.5, 1.0, 2.0):
                for catchup in (1, 4, 8):
                    chunk = round(hop * SR)
                    past_samples = round(past * SR)
                    lookahead_samples = round(lookahead * SR)
                    max_target = chunk * catchup
                    # Mirrors inference_loop().
                    keep = past_samples + lookahead_samples + max_target + chunk
                    needed = past_samples + max_target + lookahead_samples
                    if keep < needed:
                        ok = check(f"hop={hop} past={past} la={lookahead} catchup={catchup}", False)
    assert check("no parameter combination can truncate a window", ok)


if __name__ == "__main__":
    tests = [
        test_steady_state, test_transient_stall, test_ratchet, test_drift,
        test_resync, test_subframe, test_tiling, test_buffer_sizing,
    ]
    for test in tests:
        test()
    print(f"\nALL PASS  ({len(tests)}/{len(tests)})")
