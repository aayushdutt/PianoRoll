"""Deterministic checks for the learned key-up streaming bridge."""
from __future__ import annotations

import asyncio
import sys
import types
from types import SimpleNamespace

import numpy as np

for name in ("onnxruntime", "websockets", "websockets.asyncio",
             "websockets.exceptions"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["onnxruntime"].InferenceSession = object
sys.modules["onnxruntime"].SessionOptions = object
_server = types.ModuleType("websockets.asyncio.server")
_server.ServerConnection = object
_server.serve = None
sys.modules["websockets.asyncio.server"] = _server
sys.modules["websockets.exceptions"].ConnectionClosed = ConnectionError

from live_audio_bridge import (
    HOP, MIDI_MIN, PEDAL_HOP, LiveAudioBridge, decode_pedal_outputs)


def test_delayed_pedal_regression_alignment_and_alternation() -> None:
    frames = 14
    outputs = [np.zeros((1, frames), dtype=np.float32) for _ in range(5)]
    # With delay=2 these are aligned frames 3 (down), 4 (duplicate down), 7 (up).
    outputs[1][0, 5] = 0.9
    outputs[2][0, 5] = 0.25
    outputs[1][0, 6] = 0.8
    outputs[3][0, 9] = 0.85
    outputs[4][0, 9] = -0.5
    start = 10_000
    events = decode_pedal_outputs(
        outputs, start, start, start + 12 * PEDAL_HOP,
        threshold=0.3, nms_radius=0, delay_frames=2)
    assert events == [
        (start + round(3.25 * PEDAL_HOP), True, float(outputs[1][0, 5])),
        (start + round(6.5 * PEDAL_HOP), False, float(outputs[3][0, 9])),
    ]


def test_delayed_pedal_regression_rejects_uncovered_target_tail() -> None:
    outputs = [np.zeros((1, 14), dtype=np.float32) for _ in range(5)]
    start = 10_000
    try:
        decode_pedal_outputs(
            outputs, start, start, start + 12 * PEDAL_HOP + 1,
            threshold=0.3, nms_radius=0, delay_frames=2)
    except RuntimeError as error:
        assert "delay-aligned valid output window" in str(error)
    else:
        raise AssertionError("uncovered pedal target tail was accepted")


def scheduler_shell() -> LiveAudioBridge:
    bridge = object.__new__(LiveAudioBridge)
    bridge.args = SimpleNamespace(
        frame_off_threshold=0.5, frame_release_debounce=3)
    bridge.sched_on = [False] * 88
    bridge.sched_age = [0] * 88
    bridge.sched_below = [0] * 88
    bridge.sched_event_id = [None] * 88
    return bridge


def test_frame_release_crosses_batch_boundary() -> None:
    bridge = scheduler_shell()
    pushed = []

    def push(kind, sample, pitch, velocity, event_id=None):
        pushed.append((kind, sample, pitch, event_id))

    first = np.ones((88, 4), dtype=np.float32)
    bridge._schedule_activity_offs(
        [(0, MIDI_MIN, 100, 41)], first, 0, push)
    assert bridge.sched_on[0]
    assert not [item for item in pushed if item[0] == "off"]

    second = np.ones((88, 5), dtype=np.float32)
    second[0, 1:] = 0.1
    bridge._schedule_activity_offs([], second, 4 * HOP, push)
    offs = [item for item in pushed if item[0] == "off"]
    assert offs == [("off", 5 * HOP, MIDI_MIN, 41)]
    assert not bridge.sched_on[0]


def test_reattack_closes_old_event_before_rearming() -> None:
    bridge = scheduler_shell()
    bridge.sched_on[0] = True
    bridge.sched_event_id[0] = 7
    pushed = []

    def push(kind, sample, pitch, velocity, event_id=None):
        pushed.append((kind, sample, pitch, event_id))

    activity = np.ones((88, 4), dtype=np.float32)
    bridge._schedule_activity_offs(
        [(2 * HOP, MIDI_MIN, 100, 8)], activity, 0, push)
    assert pushed[0] == ("off", 2 * HOP - 1, MIDI_MIN, 7)
    assert bridge.sched_event_id[0] == 8
    assert bridge.sched_on[0]


def test_emitted_reattack_is_off_then_on() -> None:
    async def scenario() -> None:
        bridge = object.__new__(LiveAudioBridge)
        bridge.outputs = [False] * 100
        bridge.output_event_id = [None] * 88
        bridge.output_on_at = [0.0] * 88
        bridge.off_deadlines = {}
        bridge.max_hold_ms = 4000
        bridge.min_led_on_ms = 100
        bridge.event_count = 0
        bridge.late_event_count = 0
        bridge.trace_session_id = None
        sent = []
        traced = []

        async def broadcast(message):
            sent.append(message)

        def trace(stage, **fields):
            traced.append((stage, fields))

        bridge.broadcast = broadcast
        bridge.trace = trace
        await bridge.emit_onset(MIDI_MIN, 80, 1.0, 1)
        await bridge.emit_onset(MIDI_MIN, 90, 1.1, 2)
        states = [
            message["on"] for message in sent if message.get("type") == "set"]
        assert states == [True, False, True]
        assert any(
            stage == "off" and fields.get("reason") == "reattack"
            for stage, fields in traced)
        assert bridge.output_event_id[0] == 2

    asyncio.run(scenario())


def test_pedal_messages_alternate_and_suppress_duplicates() -> None:
    async def scenario() -> None:
        bridge = object.__new__(LiveAudioBridge)
        bridge.pedal_down = False
        bridge.trace_session_id = "session"
        sent = []
        async def broadcast(message):
            sent.append(message)
        bridge.broadcast = broadcast
        bridge.trace = lambda *_args, **_kwargs: None
        await bridge.emit_pedal(True, 1.0, 0.9)
        await bridge.emit_pedal(True, 1.1, 0.8)
        await bridge.emit_pedal(False, 1.2, 0.85)
        assert [message["down"] for message in sent] == [True, False]

    asyncio.run(scenario())


if __name__ == "__main__":
    test_frame_release_crosses_batch_boundary()
    test_reattack_closes_old_event_before_rearming()
    test_emitted_reattack_is_off_then_on()
    print("ALL PASS (3/3)")
