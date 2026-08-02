# Live audio note + sustain bridge

This directory is the versioned deployment source for the Raspberry Pi live
audio bridge. It runs the existing note/key-up ONNX model and an independent
five-output sustain-pedal ONNX model, schedules both against audio time, and
publishes note plus pedal messages to Midee over WebSocket.

The model architecture, training protocol, validation gates, artifact hashes,
and Pi benchmarks live in the companion `iamusica_training` repository's
`PEDAL_RESEARCH_MASTER.md`.

## Verify

```bash
python -m pip install -r requirements.txt
python -m pytest test_keyup_bridge.py test_mel_np.py test_timing.py -q
python test_timing.py
```

The focused pytest suite contains 16 checks. The direct timing runner contains
eight assertions and is useful on the target Pi.

## Deploy

Copy `live_audio_bridge.py`, `mel_np.py`, the selected note model, and the
selected pedal model to `~/pi-a2m`. Install the service file as
`~/.config/systemd/user/live-audio-led-bridge.service`, adjusting paths and the
calibrated `--pedal-threshold` when necessary. Then run:

```bash
systemctl --user daemon-reload
systemctl --user restart live-audio-led-bridge.service
systemctl --user status live-audio-led-bridge.service
```

Do not promote a pedal model merely because it exports or meets the 500 ms Pi
deadline. Promotion additionally requires the full-validation state/down/
strict-interval gates recorded by the training repository.
