"""Live Bluetooth audio -> O&V ONNX -> LED WebSocket bridge.

The bridge consumes signed 16-bit mono 16 kHz PCM from capture-pcm.sh,
runs rolling Onsets & Velocities inference, and exposes the midee LED protocol.
"""
from __future__ import annotations

import argparse
import asyncio
import heapq
import json
import math
import os
import socket
import subprocess
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any

# Two persistent ORT pools share this four-core target with NumPy feature
# extraction.  Unbounded BLAS workers oversubscribe the Pi and turn a passing
# 448 ms median pipeline into a 602 ms one.  Set these before importing NumPy;
# an explicit operator-provided value still wins.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import onnxruntime as ort
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

import mel_np
from mel_np import HOP, N_FFT, logmel

SAMPLE_RATE = 16_000
MIDI_MIN = 21
OUTPUT_COUNT = 100
THRESHOLD = 0.74
SILENCE_DBFS = -60.0  # below this the A2DP stream is treated as silent
PEDAL_HOP = 160
PEDAL_DELAY_FRAMES = 43


def _subframe_offset(curve: np.ndarray, frame: int) -> float:
    """Parabolic peak interpolation, in frames, clamped to the half-frame either side.

    The activation grid is HOP/SAMPLE_RATE = 24 ms, so a raw integer frame index
    quantizes every onset to a 24 ms lattice. That is invisible to onset F1 at the
    usual 50 ms tolerance but audible as mechanical timing. Fitting a parabola
    through the peak and its two neighbours recovers a fractional index.
    """
    if not 1 <= frame < len(curve) - 1:
        return 0.0
    left = float(curve[frame - 1])
    center = float(curve[frame])
    right = float(curve[frame + 1])
    denominator = left - 2.0 * center + right
    if denominator >= -1e-9:  # flat or non-concave: no usable peak shape
        return 0.0
    return max(-0.5, min(0.5, 0.5 * (left - right) / denominator))


def decode_window(
    session: ort.InferenceSession,
    audio: np.ndarray,
    window_start_sample: int,
    target_start_sample: int,
    target_end_sample: int,
    subframe: bool = True,
    threshold: float = THRESHOLD,
) -> tuple[list[tuple[int, int, int]], np.ndarray, int, bool]:
    """Return target-range onsets plus learned per-pitch key activity.

    Onsets are ``(absolute sample, MIDI pitch, velocity)``. The envelope is a
    ``(88, n_target_frames)`` learned held-key probability for the finalized
    target frames, with ``env_start_sample`` the absolute sample of its first
    column. Frame f and onset-grid frame f both sit at
    ``env_start_sample + f * HOP`` samples.
    """
    mel = logmel(audio)
    outputs = session.run(
        None, {"logmel": mel[None, :, :].astype(np.float32)})
    if len(outputs) != 3:
        raise RuntimeError(
            f"Key-up deployment requires onset, velocity, and frame outputs; "
            f"received {len(outputs)}")
    # The deployed three-head ONNX contract already left-pads each T-1 raw
    # activation map with one zero frame. Padding again here shifts every
    # decoded event by another 24 ms and changes target-window membership.
    onset, velocity, frame_activity = (
        output[0] for output in outputs
    )

    kernel = np.exp(-0.5 * ((np.arange(11) - 5) / 1.0) ** 2)
    kernel /= kernel.sum()
    blurred = np.empty_like(onset)
    for pitch_index in range(88):
        blurred[pitch_index] = np.convolve(onset[pitch_index], kernel, mode="same")
    left = np.pad(blurred, ((0, 0), (1, 0)))[:, :-1]
    right = np.pad(blurred, ((0, 0), (0, 1)))[:, 1:]
    peaks = (blurred >= np.maximum(np.maximum(left, blurred), right)) & (blurred > threshold)

    pitch_indexes, frames = np.nonzero(peaks)
    padded_velocity = np.pad(velocity, ((0, 0), (1, 1)), mode="reflect")
    events: list[tuple[int, int, int]] = []
    for pitch_index, frame in zip(pitch_indexes, frames):
        absolute_sample = window_start_sample + int(frame) * HOP
        # Batch membership stays on the integer lattice so target spans keep tiling
        # exactly: every onset belongs to one batch, never zero or two. The
        # sub-frame refinement below only moves the emitted timestamp.
        if not target_start_sample <= absolute_sample < target_end_sample:
            continue
        if subframe:
            absolute_sample += round(_subframe_offset(blurred[pitch_index], int(frame)) * HOP)
        value = float(
            (
                padded_velocity[pitch_index, frame]
                + padded_velocity[pitch_index, frame + 1]
                + padded_velocity[pitch_index, frame + 2]
            )
            / 3.0
        )
        events.append((absolute_sample, int(pitch_index) + MIDI_MIN, max(1, min(127, round(value * 127)))))
    events.sort()

    first_frame = max(0, math.ceil((target_start_sample - window_start_sample) / HOP))
    last_frame = min(
        frame_activity.shape[1] - 1,
        (target_end_sample - 1 - window_start_sample) // HOP
    )
    if last_frame < first_frame:
        return (events, np.empty((88, 0), dtype=np.float32),
                target_start_sample, True)
    env_slice = frame_activity[:, first_frame : last_frame + 1].astype(np.float32)
    env_start_sample = window_start_sample + first_frame * HOP
    return events, env_slice, env_start_sample, True


def decode_pedal_outputs(
    outputs: list[np.ndarray],
    window_start_sample: int,
    target_start_sample: int,
    target_end_sample: int,
    threshold: float,
    nms_radius: int,
    delay_frames: int = PEDAL_DELAY_FRAMES,
) -> list[tuple[int, bool, float]]:
    """Align delayed regression heads and decode alternating CC64 events."""
    if len(outputs) != 5:
        raise RuntimeError(f"Pedal deployment requires five outputs; got {len(outputs)}")
    channels = [np.asarray(value)[0].reshape(-1) for value in outputs]
    frames = min(len(value) for value in channels) - delay_frames
    if frames <= 0:
        return []
    # Only output[d:d + frames] is supervised for the delayed event heads.
    # Make that validity interval explicit here so a future reduction of the
    # live window/lookahead cannot silently decode the zero-padded prefix or an
    # unavailable target tail.  The end is exclusive, matching target_end.
    valid_start_sample = window_start_sample
    valid_end_sample = window_start_sample + frames * PEDAL_HOP
    if not (valid_start_sample <= target_start_sample <= target_end_sample <=
            valid_end_sample):
        raise RuntimeError(
            "Pedal target range lies outside the delay-aligned valid output "
            f"window: target=[{target_start_sample}, {target_end_sample}), "
            f"valid=[{valid_start_sample}, {valid_end_sample}), "
            f"delay_frames={delay_frames}")
    state = channels[0][:frames]
    aligned = [
        state,
        channels[1][delay_frames:delay_frames + frames],
        channels[2][delay_frames:delay_frames + frames],
        channels[3][delay_frames:delay_frames + frames],
        channels[4][delay_frames:delay_frames + frames],
    ]
    candidates: list[tuple[float, bool, float]] = []
    for active, confidence_index, offset_index in (
        (True, 1, 2), (False, 3, 4)
    ):
        confidence = aligned[confidence_index]
        for frame, score in enumerate(confidence):
            left = max(0, frame - nms_radius)
            right = min(frames, frame + nms_radius + 1)
            if score < threshold or score < np.max(confidence[left:right]):
                continue
            refined = frame + float(np.clip(aligned[offset_index][frame], -1.0, 1.0))
            candidates.append((max(0.0, min(frames - 1.0, refined)),
                               active, float(score)))
    candidates.sort(key=lambda item: item[0])
    active = bool(state[0] >= 0.5)
    events: list[tuple[int, bool, float]] = []
    for frame, next_active, score in candidates:
        if next_active == active:
            continue
        active = next_active
        absolute_sample = window_start_sample + round(frame * PEDAL_HOP)
        if target_start_sample <= absolute_sample < target_end_sample:
            events.append((absolute_sample, active, score))
    return events


def decode_pedal_window(
    session: ort.InferenceSession,
    audio: np.ndarray,
    window_start_sample: int,
    target_start_sample: int,
    target_end_sample: int,
    threshold: float,
    nms_radius: int,
    delay_frames: int = PEDAL_DELAY_FRAMES,
) -> list[tuple[int, bool, float]]:
    mel = logmel(audio, hop=PEDAL_HOP)
    outputs = session.run(None, {"logmel": mel[None].astype(np.float32)})
    return decode_pedal_outputs(
        outputs, window_start_sample, target_start_sample, target_end_sample,
        threshold, nms_radius, delay_frames)


class LiveAudioBridge:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        options = ort.SessionOptions()
        options.intra_op_num_threads = args.threads
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(args.onnx), options, providers=["CPUExecutionProvider"]
        )
        output_names = [output.name for output in self.session.get_outputs()]
        if output_names != ["onset", "velocity", "frame"]:
            raise RuntimeError(
                f"Expected ONNX outputs onset/velocity/frame, got {output_names}")
        self.has_frame_output = True
        self.pedal_session: ort.InferenceSession | None = None
        if args.pedal_onnx is not None:
            self.pedal_session = ort.InferenceSession(
                str(args.pedal_onnx), options, providers=["CPUExecutionProvider"])
            pedal_outputs = [output.name for output in self.pedal_session.get_outputs()]
            expected = [
                "pedal_state", "pedal_down_confidence", "pedal_down_offset",
                "pedal_up_confidence", "pedal_up_offset",
            ]
            if pedal_outputs != expected:
                raise RuntimeError(
                    f"Expected pedal ONNX outputs {expected}, got {pedal_outputs}")
        self.clients: set[ServerConnection] = set()
        self.outputs = [False] * OUTPUT_COUNT
        self.off_deadlines: dict[int, float] = {}
        self.scheduled_events: list[tuple[float, int, str, int, int, float, int | None]] = []
        self.schedule_wakeup = asyncio.Event()
        self.schedule_sequence = 0
        # Implied monotonic time of stream sample 0. Derived once per stream and
        # thereafter only slewed, never re-derived; see schedule_batch().
        self.epoch: float | None = None
        self.audio = np.empty(0, dtype=np.float32)
        self.buffer_start_sample = 0
        self.total_samples = 0
        self.finalized_sample = 0
        self.stream_start_sample = 0
        self.schedule_slack_s = 0.0
        self.slack_window: deque[float] = deque(maxlen=args.slack_window)
        self.dropped_samples = 0
        self.resync_count = 0
        self.truncated_context = 0
        self.event_count = 0
        self.timing_mode = "adaptive"
        self.trace_active = False
        self.trace_session_id: str | None = None
        self.trace_started_at = 0.0
        self.trace_records: list[dict[str, Any]] = []
        self.trace_limit = 50_000
        self.trace_event_sequence = 0
        self.trace_batch_sequence = 0
        self.late_event_count = 0
        self.suppressed_onset_count = 0
        self.epoch_adjustment_ms = 0.0
        self.threshold = args.threshold
        self.max_hold_ms = args.max_hold_ms
        self.min_led_on_ms = args.min_led_on_ms
        # Scheduling-time note state is distinct from emitted LED state. It lets
        # the frame decoder carry held keys across inference target spans.
        self.sched_on = [False] * 88
        self.sched_age = [0] * 88  # frames since this pitch's current onset
        self.sched_below = [0] * 88
        self.sched_event_id: list[int | None] = [None] * 88
        self.output_event_id: list[int | None] = [None] * 88
        self.output_on_at = [0.0] * 88
        self.pedal_down = False
        self.agc_gain = 1.0
        self.agc_gain_db = 0.0
        self.state = "idle"
        self.song = "Bluetooth audio"
        self.position = 0.0
        self.audio_level_dbfs = -120.0
        # Silence guard: last time real audio was seen, and a latch so the release
        # to idle logs once per silent stretch rather than every chunk.
        self.last_audio_at = time.monotonic()
        self.silence_released = False
        self.last_inference_ms = 0.0
        self.capture: asyncio.subprocess.Process | None = None
        self.started_at = time.monotonic()
        self._last_status_at = 0.0

    def status_message(self) -> dict[str, Any]:
        return {
            "type": "status",
            "state": self.state,
            "song": self.song,
            "position": self.position,
            "duration": 0,
            "eventCount": self.event_count,
            "timingMode": self.timing_mode,
            "traceSessionId": self.trace_session_id,
            "traceActive": self.trace_active,
            "lookaheadS": self.args.lookahead,
            "threshold": round(self.threshold, 3),
            "minLedOnMs": round(self.min_led_on_ms),
            "releaseDecoder": "frame_key_up",
            "pedalDecoder": (
                "delayed_regression" if self.pedal_session is not None else "disabled"),
            "pedalThreshold": round(self.args.pedal_threshold, 3),
            "pedalDown": self.pedal_down,
            "pedalPastS": self.args.pedal_past,
            "frameOffThreshold": round(self.args.frame_off_threshold, 3),
            "frameReleaseDebounce": self.args.frame_release_debounce,
            "agcGainDb": round(self.agc_gain_db, 1),
            "computeMs": round(self.last_inference_ms, 1),
            "audioLevelDbfs": round(self.audio_level_dbfs, 1),
            "queuedEvents": len(self.scheduled_events),
            # Timing health. slackMs is the headroom left in the latency budget:
            # it should hover near latencyBudgetMs. Sagging toward 0 means the Pi
            # is falling behind; the other three counters should stay flat.
            "slackMs": round(self.schedule_slack_s * 1000.0),
            "latencyBudgetMs": round(self.args.latency_budget * 1000.0),
            "fixedExtraBufferMs": round(self.args.fixed_extra_buffer * 1000.0),
            "droppedAudioMs": round(self.dropped_samples * 1000.0 / SAMPLE_RATE),
            "resyncs": self.resync_count,
            "lateEvents": self.late_event_count,
            "suppressedOnsets": self.suppressed_onset_count,
            "epochAdjustmentMs": round(self.epoch_adjustment_ms, 1),
            "truncatedContext": self.truncated_context,
            "source": "bluetooth-onsets-and-velocities",
        }

    def trace(self, stage: str, **fields: Any) -> None:
        if not self.trace_active or len(self.trace_records) >= self.trace_limit:
            return
        self.trace_records.append(
            {
                "stage": stage,
                "serverTime": round(time.monotonic() - self.trace_started_at, 6),
                **fields,
            }
        )

    def start_trace(self, timing_mode: str) -> None:
        self.timing_mode = timing_mode
        self.trace_session_id = uuid.uuid4().hex
        self.trace_started_at = time.monotonic()
        self.trace_records = []
        self.trace_event_sequence = 0
        self.trace_batch_sequence = 0
        self.late_event_count = 0
        self.suppressed_onset_count = 0
        self.epoch_adjustment_ms = 0.0
        self.dropped_samples = 0
        self.resync_count = 0
        self.trace_active = True
        self.trace("session_start", timingMode=timing_mode)

    async def broadcast(self, message: dict[str, Any]) -> None:
        if not self.clients:
            return
        payload = json.dumps(message, separators=(",", ":"))
        await asyncio.gather(
            *(client.send(payload) for client in tuple(self.clients)),
            return_exceptions=True,
        )

    async def clear_outputs(self) -> None:
        self.outputs = [False] * OUTPUT_COUNT
        self.off_deadlines.clear()
        self.scheduled_events.clear()
        self.sched_on = [False] * 88
        self.sched_age = [0] * 88
        self.sched_below = [0] * 88
        self.sched_event_id = [None] * 88
        self.output_event_id = [None] * 88
        self.output_on_at = [0.0] * 88
        self.pedal_down = False
        # The epoch deliberately survives pause/stop: capture keeps running and
        # total_samples keeps counting, so the audio timeline stays continuous.
        # Only reset_inference() invalidates it.
        self.schedule_wakeup.set()
        await self.broadcast({"type": "clear_all"})

    async def emit_onset(
        self,
        pitch: int,
        velocity: int,
        audio_time: float,
        event_id: int | None = None,
        due: float | None = None,
    ) -> None:
        index = pitch - MIDI_MIN
        if not 0 <= index < 88:
            return
        self.event_count += 1
        now = time.monotonic()
        self.off_deadlines[index] = now + self.max_hold_ms / 1000.0
        if self.outputs[index]:
            # A same-pitch reattack must be visually observable even if the
            # learned key-up has not arrived yet: explicitly end the prior event
            # and start the replacement instead of suppressing it.
            self.trace(
                "off",
                eventId=self.output_event_id[index],
                pitch=pitch,
                audioTime=round(audio_time, 6),
                reason="reattack",
            )
            await self.broadcast(
                {"type": "set", "index": index, "on": False, "velocity": 0})
        self.outputs[index] = True
        self.output_event_id[index] = event_id
        self.output_on_at[index] = now
        lateness_ms = max(0.0, (time.monotonic() - due) * 1000.0) if due is not None else 0.0
        if lateness_ms > 1.0:
            self.late_event_count += 1
        self.trace(
            "emitted",
            eventId=event_id,
            pitch=pitch,
            velocity=velocity,
            audioTime=round(audio_time, 6),
            latenessMs=round(lateness_ms, 3),
        )
        # `t` is the onset's position in the audio stream, in seconds. Events are
        # already paced server-side, so no client needs it today; it exists so a
        # client *can* schedule against it (an ignored extra field otherwise).
        await self.broadcast(
            {
                "type": "set",
                "index": index,
                "on": True,
                "velocity": velocity,
                "t": round(audio_time, 4),
                "eventId": event_id,
                "sessionId": self.trace_session_id,
            }
        )

    async def emit_off(self, pitch: int, audio_time: float,
                       event_id: int | None = None,
                       reason: str | None = None) -> None:
        index = pitch - MIDI_MIN
        if not 0 <= index < 88:
            return
        if not self.outputs[index]:
            return
        if (
            event_id is not None and self.output_event_id[index] is not None
            and event_id != self.output_event_id[index]
        ):
            return
        visible_for = time.monotonic() - self.output_on_at[index]
        remaining = self.min_led_on_ms / 1000.0 - visible_for
        if remaining > 0 and reason != "reattack":
            asyncio.create_task(
                self._delayed_off(remaining, pitch, audio_time, event_id, reason))
            return
        self.off_deadlines.pop(index, None)
        self.outputs[index] = False
        self.output_event_id[index] = None
        self.trace("off", eventId=event_id, pitch=pitch,
                   audioTime=round(audio_time, 6), reason=reason)
        await self.broadcast({"type": "set", "index": index, "on": False, "velocity": 0})

    async def emit_pedal(self, down: bool, audio_time: float,
                         confidence: float) -> None:
        if down == self.pedal_down:
            return
        self.pedal_down = down
        self.trace("pedal", down=down, audioTime=round(audio_time, 6),
                   confidence=round(confidence, 4))
        await self.broadcast({
            "type": "pedal", "down": down, "t": round(audio_time, 4),
            "confidence": round(confidence, 4),
            "sessionId": self.trace_session_id,
        })

    async def _delayed_off(
            self, delay: float, pitch: int, audio_time: float,
            event_id: int | None, reason: str | None) -> None:
        await asyncio.sleep(delay)
        await self.emit_off(pitch, audio_time, event_id, reason)

    async def led_timer(self) -> None:
        while True:
            now = time.monotonic()
            for index, deadline in tuple(self.off_deadlines.items()):
                if deadline > now:
                    continue
                self.off_deadlines.pop(index, None)
                if self.outputs[index]:
                    await self.emit_off(
                        index + MIDI_MIN, self.position,
                        self.output_event_id[index], "max_duration")
            await asyncio.sleep(0.01)

    def schedule_batch(
        self,
        events: list[tuple[int, int, int]],
        envelope: np.ndarray | int,
        env_start_sample: int,
        target_start_sample: int | None = None,
        target_end_sample: int | None = None,
        frame_activity: bool = False,
        pedal_events: list[tuple[int, bool, float]] | None = None,
    ) -> None:
        """Map audio-domain onset positions onto the wall clock via one stream epoch.

        Every event in a session is derived from the same epoch, so inference
        jitter can only make output uniformly late (inaudible latency), never
        deform the spacing between notes (audible). The previous
        `max(now, cursor)` anchor re-derived the timeline on every stall, which
        made display latency ratchet upward in uneven steps and never come back.
        """
        if target_start_sample is None or target_end_sample is None:
            target_start_sample = int(envelope)
            target_end_sample = int(env_start_sample)
            envelope = np.empty((88, 0), dtype=np.float32)
            env_start_sample = target_start_sample
        now = time.monotonic()
        target_time = target_start_sample / SAMPLE_RATE
        batch_duration = (target_end_sample - target_start_sample) / SAMPLE_RATE
        self.trace_batch_sequence += 1
        batch_id = self.trace_batch_sequence

        if self.epoch is None:
            # The true wall time of sample 0 is unknowable -- BlueZ and PipeWire
            # buffering are opaque -- but it does not matter. A constant error is
            # just latency; only variance is audible. So derive it once here and
            # never recompute it.
            startup_budget = self.args.latency_budget
            if self.timing_mode == "fixed":
                # Fixed mode cannot repair an underestimated startup epoch later
                # without deforming tempo. Hold additional presentation delay up
                # front to absorb cold inference and A2DP activation variance.
                startup_budget += self.args.fixed_extra_buffer
            self.epoch = now + startup_budget - target_time

        # Headroom between the schedule and now. Should sit at latency_budget.
        slack = (self.epoch + target_time) - now
        self.schedule_slack_s = slack

        if (
            self.timing_mode == "adaptive"
            and slack - self.args.latency_budget < -self.args.resync_threshold
        ):
            # Late enough that queued events would fire as a burst. Only this
            # direction is an emergency, so only this direction steps; surplus
            # slack is merely surplus latency and is always slewed away instead.
            print(
                f"[timing] resync {(self.args.latency_budget - slack) * 1000.0:+.0f} ms "
                f"(slack was {slack * 1000.0:.0f} ms)",
                flush=True,
            )
            adjustment = self.args.latency_budget - slack
            self.epoch += adjustment
            self.epoch_adjustment_ms += adjustment * 1000.0
            self.resync_count += 1
            self.trace(
                "epoch_adjustment",
                kind="resync",
                batchId=batch_id,
                adjustmentMs=round(adjustment * 1000.0, 3),
            )
            slack = self.args.latency_budget
            self.slack_window.clear()

        # Correct drift continuously, NTP-style: capture runs on the phone's
        # crystal and this process on CLOCK_MONOTONIC, so they part by a few ppm
        # forever. Slew against the window MAXIMUM rather than the current sample:
        # inference jitter only ever subtracts slack, so the least-delayed batches
        # are the honest measurement of the clock relationship. Slewing on the raw
        # value lets a single slow batch shift the whole timeline.
        if self.timing_mode == "adaptive":
            self.slack_window.append(slack)
            error = max(self.slack_window) - self.args.latency_budget
            max_step = self.args.max_slew * batch_duration
            delta = max(-max_step, min(max_step, error))
            self.epoch -= delta
            if abs(delta) >= 0.000001:
                self.epoch_adjustment_ms -= delta * 1000.0
                self.trace(
                    "epoch_adjustment",
                    kind="slew",
                    batchId=batch_id,
                    adjustmentMs=round(-delta * 1000.0, 3),
                )
            # Moving the epoch invalidates every stored measurement by exactly delta.
            # Re-basing them keeps the window lag-free; leaving them stale would make
            # the controller overshoot and hunt after a large correction.
            for position, value in enumerate(self.slack_window):
                self.slack_window[position] = value - delta

        batch_start = self.epoch + target_time

        def push(
            kind: str,
            absolute_sample: int,
            pitch: int,
            velocity: int,
            event_id: int | None = None,
        ) -> None:
            offset = max(0.0, (absolute_sample - target_start_sample) / SAMPLE_RATE)
            self.schedule_sequence += 1
            due = batch_start + offset
            heapq.heappush(
                self.scheduled_events,
                (
                    due,
                    self.schedule_sequence,
                    kind,
                    pitch,
                    velocity,
                    absolute_sample / SAMPLE_RATE,
                    event_id,
                ),
            )
            if kind == "on":
                self.trace(
                    "scheduled",
                    eventId=event_id,
                    batchId=batch_id,
                    pitch=pitch,
                    velocity=velocity,
                    audioTime=round(absolute_sample / SAMPLE_RATE, 6),
                    dueTime=round(due - self.trace_started_at, 6),
                )

        identified_events = []
        for absolute_sample, pitch, velocity in events:
            self.trace_event_sequence += 1
            event_id = self.trace_event_sequence
            identified_events.append(
                (absolute_sample, pitch, velocity, event_id))
            self.trace(
                "detected",
                eventId=event_id,
                batchId=batch_id,
                pitch=pitch,
                velocity=velocity,
                audioTime=round(absolute_sample / SAMPLE_RATE, 6),
            )
            push("on", absolute_sample, pitch, velocity, event_id)

        for absolute_sample, down, confidence in pedal_events or ():
            push("pedal_down" if down else "pedal_up", absolute_sample,
                 -1, max(0, min(127, round(confidence * 127))))

        if not frame_activity and envelope.shape[1]:
            raise RuntimeError("Key-up model returned no frame activity")
        if frame_activity:
            self._schedule_activity_offs(
                identified_events, envelope, env_start_sample, push)

        self.schedule_wakeup.set()

    def _schedule_activity_offs(
            self, events, envelope, env_start_sample, push) -> None:
        """Decode learned key-up activity with state spanning target batches."""
        frame_count = envelope.shape[1]
        onsets_by_frame: dict[int, list[int]] = {}
        event_ids_by_frame: dict[int, dict[int, int]] = {}
        for absolute_sample, pitch, _velocity, event_id in events:
            frame = round((absolute_sample - env_start_sample) / HOP)
            frame = max(0, min(frame_count - 1, frame))
            onsets_by_frame.setdefault(frame, []).append(pitch - MIDI_MIN)
            event_ids_by_frame.setdefault(frame, {})[
                pitch - MIDI_MIN] = event_id
        for frame in range(frame_count):
            for index in onsets_by_frame.get(frame, ()):  # (re)arm this pitch
                if self.sched_on[index]:
                    push("off", max(env_start_sample,
                                   env_start_sample + frame * HOP - 1),
                         index + MIDI_MIN, 0, self.sched_event_id[index])
                self.sched_on[index] = True
                self.sched_age[index] = 0
                self.sched_below[index] = 0
                self.sched_event_id[index] = event_ids_by_frame[frame][index]
            column = envelope[:, frame]
            for index in range(88):
                if not self.sched_on[index]:
                    continue
                activity = float(column[index])
                age = self.sched_age[index]
                self.sched_age[index] = age + 1
                # Decoder minimum is two model frames (~48 ms). The independent
                # LED minimum is enforced at emit time for human visibility.
                below = activity < self.args.frame_off_threshold
                self.sched_below[index] = (
                    self.sched_below[index] + 1 if below else 0)
                debounce = self.args.frame_release_debounce
                if age >= 2 and self.sched_below[index] >= debounce:
                    self.sched_on[index] = False
                    release_frame = frame - debounce + 1
                    push("off", env_start_sample + release_frame * HOP,
                         index + MIDI_MIN, 0, self.sched_event_id[index])
                    self.sched_event_id[index] = None

    async def event_scheduler(self) -> None:
        while True:
            if not self.scheduled_events:
                self.schedule_wakeup.clear()
                await self.schedule_wakeup.wait()
                continue
            due, _, kind, pitch, velocity, audio_time, event_id = self.scheduled_events[0]
            remaining = due - time.monotonic()
            if remaining > 0:
                self.schedule_wakeup.clear()
                try:
                    await asyncio.wait_for(self.schedule_wakeup.wait(), timeout=remaining)
                    continue
                except TimeoutError:
                    pass
            if not self.scheduled_events:
                continue
            current = heapq.heappop(self.scheduled_events)
            if current[0] != due:
                heapq.heappush(self.scheduled_events, current)
                continue
            if self.state == "playing":
                if kind in {"pedal_down", "pedal_up"}:
                    await self.emit_pedal(
                        kind == "pedal_down", audio_time, velocity / 127.0)
                elif kind == "off":
                    await self.emit_off(
                        pitch, audio_time, event_id, "frame")
                else:
                    await self.emit_onset(pitch, velocity, audio_time, event_id, due)

    def reset_inference(self) -> None:
        self.audio = np.empty(0, dtype=np.float32)
        self.buffer_start_sample = self.total_samples
        self.finalized_sample = self.total_samples
        self.stream_start_sample = self.total_samples
        self.epoch = None
        for index in range(88):
            self.sched_on[index] = False
            self.sched_age[index] = 0

    async def avrcp(self, method: str) -> None:
        status = await asyncio.to_thread(self.read_avrcp_status)
        path = status.get("playerPath")
        if not path:
            return
        process = await asyncio.create_subprocess_exec(
            "busctl",
            "--system",
            "call",
            "org.bluez",
            str(path),
            "org.bluez.MediaPlayer1",
            method,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await process.wait()

    async def command(self, command: str) -> None:
        if command == "start":
            self.reset_inference()
            await self.clear_outputs()
            await self.avrcp("Play")
            self.state = "playing"
        elif command == "pause":
            await self.avrcp("Pause")
            self.state = "paused"
            await self.clear_outputs()
        elif command == "resume":
            self.reset_inference()
            await self.avrcp("Play")
            self.state = "playing"
        elif command == "stop":
            await self.avrcp("Stop")
            self.state = "stopped"
            self.reset_inference()
            await self.clear_outputs()
        else:
            await self.broadcast({"type": "error", "message": f"Unknown command: {command}"})
            return
        await self.broadcast(self.status_message())

    def read_avrcp_status(self) -> dict[str, Any]:
        try:
            result = subprocess.run(
                [str(self.args.avrcp_status)],
                check=False,
                capture_output=True,
                text=True,
                timeout=2,
            )
            return json.loads(result.stdout.strip() or "{}")
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            return {}

    async def status_loop(self) -> None:
        while True:
            status = await asyncio.to_thread(self.read_avrcp_status)
            remote_state = status.get("status")
            position_ms = int(status.get("positionMs", 0))
            # Windows exposes an AVRCP player for A2DP but reports a permanent
            # placeholder "stopped" state with UINT32_MAX position and no track
            # metadata. Do not let that sentinel suppress inference from live PCM.
            placeholder_state = (
                remote_state == "stopped"
                and position_ms == 0xFFFFFFFF
                and not str(status.get("rawTrack", "")).replace(
                    'a{sv} 5 "Duration" u 0 "Title" s "" "TrackNumber" u 0 '
                    '"Album" s "" "Artist" s ""',
                    "",
                ).strip()
            )
            if remote_state in {"playing", "paused", "stopped"} and not placeholder_state:
                if remote_state != self.state:
                    self.state = remote_state
                    if remote_state != "playing":
                        await self.clear_outputs()
                self.position = position_ms / 1000.0
            title = status.get("title")
            if isinstance(title, str) and title:
                self.song = title
            await self.broadcast(self.status_message())
            await asyncio.sleep(1)

    async def capture_stderr(self, stream: asyncio.StreamReader) -> None:
        while line := await stream.readline():
            print(f"[capture] {line.decode(errors='replace').rstrip()}", flush=True)

    async def inference_loop(self) -> None:
        environment = os.environ.copy()
        environment.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
        environment.setdefault(
            "DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{os.getuid()}/bus"
        )
        self.capture = await asyncio.create_subprocess_exec(
            str(self.args.capture),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
        )
        assert self.capture.stdout is not None
        assert self.capture.stderr is not None
        asyncio.create_task(self.capture_stderr(self.capture.stderr))

        self.epoch = None
        chunk_samples = round(self.args.hop * SAMPLE_RATE)
        chunk_bytes = chunk_samples * 2
        lookahead_samples = round(self.args.lookahead * SAMPLE_RATE)
        past_samples = round(self.args.past * SAMPLE_RATE)
        # A catch-up batch spans up to max_catchup chunks, and its window needs
        # past + span + lookahead. Keep enough that the ring buffer can never
        # silently truncate a window we are still allowed to ask for.
        max_target_samples = chunk_samples * self.args.max_catchup
        keep_samples = past_samples + lookahead_samples + max_target_samples + chunk_samples

        while True:
            try:
                raw = await self.capture.stdout.readexactly(chunk_bytes)
            except asyncio.IncompleteReadError:
                await self.clear_outputs()
                raise RuntimeError("Bluetooth PCM capture ended")
            samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
            self.audio_level_dbfs = 20.0 * math.log10(max(rms, 1e-6))
            if self.audio_level_dbfs > SILENCE_DBFS:
                desired_db = max(
                    -self.args.agc_max_gain_db,
                    min(
                        self.args.agc_max_gain_db,
                        self.args.agc_target_dbfs - self.audio_level_dbfs,
                    ),
                )
                desired_gain = 10.0 ** (desired_db / 20.0)
                # Slow gain tracking preserves musical dynamics within notes but
                # compensates persistent sender/OS volume differences.
                coefficient = (
                    self.args.agc_attack
                    if desired_gain < self.agc_gain else self.args.agc_release)
                self.agc_gain += coefficient * (desired_gain - self.agc_gain)
                self.agc_gain_db = 20.0 * math.log10(max(self.agc_gain, 1e-6))
            samples = np.clip(
                samples * self.agc_gain, -1.0, 1.0).astype(np.float32)
            self.audio = np.concatenate((self.audio, samples))
            self.total_samples += len(samples)
            if self.audio_level_dbfs > SILENCE_DBFS:
                self.last_audio_at = time.monotonic()
                self.silence_released = False
                if self.state in {"idle", "stopped"}:
                    self.state = "playing"
                    self.reset_inference()
            elif (
                self.state == "playing"
                and time.monotonic() - self.last_audio_at > self.args.silence_timeout
            ):
                # A2DP idle: the stream has gone silent (paused, or the phone/PC
                # disconnected with no AVRCP "stopped" to tell us). Release inference
                # so we stop churning the CPU on silence; real audio auto-resumes via
                # the branch above. Guards the signal-based play fallback from latching.
                self.state = "idle"
                if not self.silence_released:
                    print(
                        f"[state] A2DP idle: released inference after "
                        f"{self.args.silence_timeout:.0f}s of silence",
                        flush=True,
                    )
                    self.silence_released = True
                if any(self.outputs):
                    await self.clear_outputs()
                self.reset_inference()
            if len(self.audio) > keep_samples:
                trim = len(self.audio) - keep_samples
                self.audio = self.audio[trim:]
                self.buffer_start_sample += trim

            if self.state != "playing":
                self.finalized_sample = max(self.finalized_sample, self.total_samples - lookahead_samples)
                continue
            target_end = self.total_samples - lookahead_samples
            if target_end <= self.finalized_sample:
                continue
            # Consume everything finalized so far. The old
            # `max(finalized, target_end - chunk_samples)` clamp silently skipped
            # the audio in between whenever inference fell behind, losing notes and
            # compressing the timeline with nothing logged. Catching up is cheap:
            # one window amortizes its past+lookahead context over the whole span.
            target_start = self.finalized_sample
            if target_end - target_start > max_target_samples:
                target_start = target_end - max_target_samples
                dropped = target_start - self.finalized_sample
                self.dropped_samples += dropped
                self.trace(
                    "dropped_audio",
                    startAudioTime=round(self.finalized_sample / SAMPLE_RATE, 6),
                    endAudioTime=round(target_start / SAMPLE_RATE, 6),
                    durationMs=round(dropped * 1000.0 / SAMPLE_RATE, 3),
                )
                print(
                    f"[lag] dropped {dropped / SAMPLE_RATE:.2f}s of audio: backlog "
                    f"exceeded the {max_target_samples / SAMPLE_RATE:.1f}s catch-up limit",
                    flush=True,
                )
            wanted_window_start = target_start - past_samples
            window_start = max(self.buffer_start_sample, wanted_window_start)
            if window_start > wanted_window_start and wanted_window_start >= self.stream_start_sample:
                # Model is seeing less than `past` seconds of left context, so
                # accuracy quietly degrades. Expected only right after a reset,
                # which the stream_start_sample test excludes.
                self.truncated_context += 1
            local_start = window_start - self.buffer_start_sample
            window = self.audio[local_start:].copy()
            if len(window) < 2048:
                continue
            started = time.perf_counter()
            note_job = asyncio.to_thread(
                decode_window,
                self.session,
                window,
                window_start,
                target_start,
                target_end,
                self.args.subframe,
                self.threshold,
            )
            pedal_events: list[tuple[int, bool, float]] = []
            if self.pedal_session is not None:
                pedal_window_start = max(
                    window_start,
                    target_start - round(self.args.pedal_past * SAMPLE_RATE),
                )
                pedal_local_start = pedal_window_start - window_start
                pedal_job = asyncio.to_thread(
                    decode_pedal_window,
                    self.pedal_session,
                    window[pedal_local_start:],
                    pedal_window_start,
                    target_start,
                    target_end,
                    self.args.pedal_threshold,
                    self.args.pedal_nms_radius,
                    self.args.pedal_delay_frames,
                )
                note_result, pedal_events = await asyncio.gather(
                    note_job, pedal_job)
            else:
                note_result = await note_job
            events, envelope, env_start, frame_activity = note_result
            self.last_inference_ms = (time.perf_counter() - started) * 1000.0
            self.finalized_sample = target_end
            self.schedule_batch(
                events, envelope, env_start, target_start, target_end,
                frame_activity, pedal_events)

    async def handler(self, client: ServerConnection) -> None:
        self.clients.add(client)
        # Without this, Nagle can coalesce individually-paced onset messages into
        # one burst and undo the scheduling. Best-effort: the transport attribute
        # is not part of the websockets public API.
        try:
            raw_socket = client.transport.get_extra_info("socket")
            if raw_socket is not None:
                raw_socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except (AttributeError, OSError) as error:
            print(f"[net] could not set TCP_NODELAY: {error}", flush=True)
        print(f"client connected: {client.remote_address}", flush=True)
        try:
            await client.send(json.dumps({"type": "snapshot", "outputs": self.outputs}))
            await client.send(json.dumps({"type": "pedal", "down": self.pedal_down}))
            await client.send(json.dumps(self.status_message()))
            try:
                async for raw in client:
                    try:
                        message = json.loads(raw)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    if message.get("type") == "command" and isinstance(message.get("command"), str):
                        await self.command(message["command"])
                    elif message.get("type") == "evaluation":
                        action = message.get("action")
                        if action == "start":
                            timing_mode = message.get("timingMode", "adaptive")
                            if timing_mode not in {"adaptive", "fixed"}:
                                timing_mode = "adaptive"
                            self.start_trace(timing_mode)
                            await self.command("start")
                            await client.send(
                                json.dumps(
                                    {
                                        "type": "evaluation_started",
                                        "sessionId": self.trace_session_id,
                                        "timingMode": self.timing_mode,
                                    }
                                )
                            )
                        elif action == "stop":
                            self.trace("session_stop")
                            self.trace_active = False
                            await self.command("stop")
                            await client.send(
                                json.dumps(
                                    {
                                        "type": "evaluation_stopped",
                                        "sessionId": self.trace_session_id,
                                        "recordCount": len(self.trace_records),
                                    }
                                )
                            )
                        elif action == "get":
                            chunk_size = 500
                            chunks = max(1, math.ceil(len(self.trace_records) / chunk_size))
                            for chunk_index in range(chunks):
                                start = chunk_index * chunk_size
                                await client.send(
                                    json.dumps(
                                        {
                                            "type": "evaluation_trace",
                                            "sessionId": self.trace_session_id,
                                            "chunkIndex": chunk_index,
                                            "chunkCount": chunks,
                                            "records": self.trace_records[start : start + chunk_size],
                                        },
                                        separators=(",", ":"),
                                    )
                                )
            except ConnectionClosed:
                pass
        finally:
            self.clients.discard(client)
            print(f"client disconnected: {client.remote_address}", flush=True)

    async def run(self) -> None:
        tasks = [
            asyncio.create_task(self.led_timer()),
            asyncio.create_task(self.event_scheduler()),
            asyncio.create_task(self.status_loop()),
            asyncio.create_task(self.inference_loop()),
        ]
        try:
            async with serve(self.handler, self.args.host, self.args.port):
                print(
                    f"[live-bridge] listening on ws://{self.args.host}:{self.args.port}/leds; "
                    f"lookahead={self.args.lookahead}s hop={self.args.hop}s "
                    f"budget={self.args.latency_budget}s subframe={self.args.subframe}",
                    flush=True,
                )
                await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if self.capture and self.capture.returncode is None:
                self.capture.terminate()
                await self.capture.wait()
            await self.clear_outputs()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Live Bluetooth audio-to-LED bridge")
    here = Path(__file__).resolve().parent
    parser.add_argument("--onnx", type=Path, default=here / "ov.onnx")
    parser.add_argument(
        "--pedal-onnx", type=Path,
        help="Optional five-head 10 ms pedal ONNX; disabled when omitted.")
    parser.add_argument("--pedal-threshold", type=float, default=0.3)
    parser.add_argument("--pedal-nms-radius", type=int, default=3)
    parser.add_argument("--pedal-delay-frames", type=int, default=PEDAL_DELAY_FRAMES)
    parser.add_argument(
        "--pedal-past", type=float, default=1.0,
        help="Pedal left context in seconds; 1.0 matches half the eval overlap.")
    parser.add_argument("--capture", type=Path, default=Path.home() / "bluetooth_receiver/capture-pcm.sh")
    parser.add_argument("--avrcp-status", type=Path, default=Path.home() / "bluetooth_receiver/avrcp-status.sh")
    parser.add_argument("--lookahead", type=float, default=0.5)
    parser.add_argument("--hop", type=float, default=0.5)
    parser.add_argument("--past", type=float, default=1.5)
    parser.add_argument(
        "--min-led-on-ms", type=float, default=100.0,
        help="Cosmetic minimum visible LED-on duration; does not affect decoding.")
    parser.add_argument(
        "--silence-timeout",
        type=float,
        default=8.0,
        help="Seconds of sub-60dBFS audio after which inference is released to idle "
        "(stops CPU churn when A2DP goes silent or a device disconnects). Auto-resumes "
        "on real audio. Keep above the longest musical rest you expect.",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=THRESHOLD,
        help="Fixed onset confidence threshold (0-1).",
    )
    parser.add_argument(
        "--max-hold-ms",
        type=float,
        default=4000.0,
        help="Safety cap for a key-up prediction that never releases.",
    )
    parser.add_argument(
        "--frame-off-threshold",
        type=float,
        default=0.5,
        help="Frame probability below which an active note begins releasing.",
    )
    parser.add_argument(
        "--frame-release-debounce",
        type=int,
        default=3,
        help="Consecutive low frame-probability frames required for release.",
    )
    parser.add_argument(
        "--agc-target-dbfs", type=float, default=-20.0,
        help="Long-term live-input RMS target used to match sender volume levels.")
    parser.add_argument(
        "--agc-max-gain-db", type=float, default=18.0,
        help="Maximum live-input gain or attenuation.")
    parser.add_argument(
        "--agc-attack", type=float, default=0.25,
        help="Per-hop gain smoothing when reducing gain.")
    parser.add_argument(
        "--agc-release", type=float, default=0.05,
        help="Per-hop gain smoothing when increasing gain.")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument(
        "--latency-budget",
        type=float,
        default=0.25,
        help="Scheduling headroom in seconds. Slack a stall can spend and recover "
        "instead of pushing the timeline. Size it from p99 inference jitter.",
    )
    parser.add_argument(
        "--max-slew",
        type=float,
        default=0.02,
        help="Cap on epoch drift correction, in seconds per second of audio.",
    )
    parser.add_argument(
        "--fixed-extra-buffer",
        type=float,
        default=1.75,
        help="Additional startup presentation delay for fixed timing mode. "
        "Fixed mode never slews or resyncs mid-phrase, so this absorbs cold-start jitter.",
    )
    parser.add_argument(
        "--resync-threshold",
        type=float,
        default=1.0,
        help="Lateness in seconds beyond which the epoch steps instead of slewing. "
        "Only applies when running late; surplus slack is always slewed.",
    )
    parser.add_argument(
        "--slack-window",
        type=int,
        default=40,
        help="Batches of slack history used to pick the drift reference (its maximum).",
    )
    parser.add_argument(
        "--max-catchup",
        type=int,
        default=4,
        help="Largest catch-up batch, in --hop units, before audio is dropped and logged.",
    )
    parser.add_argument(
        "--no-subframe",
        dest="subframe",
        action="store_false",
        help="Disable parabolic sub-frame onset refinement (A/B against the 24 ms grid).",
    )
    args = parser.parse_args()
    if not args.onnx.is_file():
        parser.error(f"ONNX model not found: {args.onnx}")
    if args.pedal_onnx is not None and not args.pedal_onnx.is_file():
        parser.error(f"Pedal ONNX model not found: {args.pedal_onnx}")
    if not 0.0 <= args.pedal_threshold <= 1.0:
        parser.error("--pedal-threshold must be in [0, 1]")
    if (args.pedal_nms_radius < 0 or args.pedal_delay_frames < 0 or
            args.pedal_past < 0):
        parser.error("pedal NMS radius and delay must be nonnegative")
    required_pedal_future = (
        args.pedal_delay_frames * PEDAL_HOP + N_FFT // 2) / SAMPLE_RATE
    if args.pedal_onnx is not None and args.lookahead < required_pedal_future:
        parser.error(
            f"--lookahead must be at least {required_pedal_future:.3f}s for "
            "the configured pedal delay and centered STFT")
    if args.max_catchup < 1:
        parser.error("--max-catchup must be at least 1")
    return args


if __name__ == "__main__":
    asyncio.run(LiveAudioBridge(parse_args()).run())
