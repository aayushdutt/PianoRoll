# Raspberry Pi MIDI/LED verification bridge

This minimal service decodes a MIDI file on the Pi, maps notes 21-108 to outputs 0-87, simulates 100 LED outputs, and streams state over WebSocket.

Commands are JSON messages such as `{"type":"command","command":"start"}`. Supported commands are `start`, `pause`, `resume`, and `stop`.

Run on the Pi:

```bash
cd ~/midee-pi-bridge
.venv/bin/python server.py --midi "Radiohead - Exit Music (For a Film).mid"
```

Open Midee with `?pi=1`. The page connects to
`ws://192.168.10.220:8765/leds` automatically and retries if the Pi or bridge
restarts. Expand **Pi connection** to change the URL or use the transport
buttons.

The same page also accepts the live audio-to-MIDI bridge used by the Raspberry
Pi Bluetooth receiver. A `set` message may include MIDI velocity from 0 through
127:

```json
{"type":"set","index":39,"on":true,"velocity":96}
```

Midee maps the output index back to piano pitch (`index + 21`) and normalizes
velocity to its internal 0-1 range before sending the note through the normal
input, visualization, and synthesizer path. A missing velocity uses `0.8` as a
backward-compatible fallback.

An optional sustain-pedal model uses a separate protocol message. Midee sends
it through the same live input/synthesizer path as hardware CC64 and suppresses
duplicate state:

```json
{"type":"pedal","down":true,"t":12.34,"confidence":0.91}
```

`clear_all` releases both monitored notes and the monitored pedal.

The live bridge also supports buffered evaluation traces:

```json
{"type":"evaluation","action":"start","timingMode":"adaptive"}
{"type":"evaluation","action":"start","timingMode":"fixed"}
{"type":"evaluation","action":"stop"}
{"type":"evaluation","action":"get"}
```

Trace retrieval is chunked and records the detected → scheduled → emitted or
suppressed lifecycle without streaming diagnostic traffic during inference.
The fixed mode holds additional delay at startup and keeps one immutable
presentation epoch for the phrase; adaptive mode retains the live slew/resync
behavior.
