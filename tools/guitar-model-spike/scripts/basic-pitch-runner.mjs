/**
 * Real (non-mocked) Basic Pitch inference runner for Node.
 *
 * Runs the actual `@spotify/basic-pitch` package -- the same code that
 * ships in a browser bundle -- against a mono Float32Array using the
 * pure-JS `@tensorflow/tfjs` CPU backend (no `@tensorflow/tfjs-node` native
 * binary; that package's postinstall pulls a ~100MB+ prebuilt TensorFlow C
 * library, which was not practical to fetch under this environment's
 * measured ~70-85 KB/s network throughput -- see docs report for details).
 * The CPU JS backend is also a reasonable proxy for a browser without
 * WebGL/WASM acceleration, i.e. a *conservative* real-time-factor bound for
 * in-browser use, not an optimistic one.
 *
 * Model weights are loaded directly from the installed npm package
 * (node_modules/@spotify/basic-pitch/model/) via a custom tf.io.IOHandler,
 * so no `@tensorflow/tfjs-node` filesystem I/O extension is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as tf from '@tensorflow/tfjs';
import { BasicPitch } from '@spotify/basic-pitch';

export function loadLocalGraphModel(modelDir) {
  const modelJsonPath = path.join(modelDir, 'model.json');
  const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf8'));
  const weightSpecs = [];
  const buffers = [];
  for (const group of modelJson.weightsManifest) {
    for (const w of group.weights) weightSpecs.push(w);
    for (const p of group.paths) {
      buffers.push(fs.readFileSync(path.join(modelDir, p)));
    }
  }
  const concatBuf = Buffer.concat(buffers);
  const weightData = concatBuf.buffer.slice(
    concatBuf.byteOffset,
    concatBuf.byteOffset + concatBuf.byteLength,
  );

  const handler = {
    load: async () => ({
      modelTopology: modelJson.modelTopology,
      weightSpecs,
      weightData,
      format: modelJson.format,
      generatedBy: modelJson.generatedBy,
      convertedBy: modelJson.convertedBy,
    }),
  };
  return tf.loadGraphModel(handler);
}

/**
 * @param {Float32Array} mono22050 mono audio at 22050 Hz
 * @param {string} modelDir path to node_modules/@spotify/basic-pitch/model
 */
// Upstream spotify/basic-pitch (Python) CLI defaults -- see predict.py
// argparse defaults: onset_threshold=0.5, frame_threshold=0.3,
// minimum_note_length=127.70ms (~11 frames @ 86.13fps for 22050Hz/hop256).
// The basic-pitch-ts README's usage snippet instead shows illustrative
// values (0.25, 0.25, 5); those are NOT the published production defaults,
// so this runner defaults to the upstream Python CLI's numbers to keep
// results representative of "real" basic-pitch usage.
const DEFAULT_ONSET_THRESH = 0.5;
const DEFAULT_FRAME_THRESH = 0.3;
const DEFAULT_MIN_NOTE_LEN_FRAMES = 11;

export async function runBasicPitch(
  mono22050,
  modelDir,
  {
    onsetThresh = DEFAULT_ONSET_THRESH,
    frameThresh = DEFAULT_FRAME_THRESH,
    minNoteLenFrames = DEFAULT_MIN_NOTE_LEN_FRAMES,
  } = {},
) {
  await tf.setBackend('cpu');
  await tf.ready();

  const modelLoadStart = performance.now();
  const model = loadLocalGraphModel(modelDir);
  const basicPitch = new BasicPitch(model);
  await basicPitch.model; // force resolution so load time is isolated from inference time
  const modelLoadMs = performance.now() - modelLoadStart;

  const frames = [];
  const onsets = [];
  const contours = [];

  const inferenceStart = performance.now();
  await basicPitch.evaluateModel(
    mono22050,
    (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    () => {},
  );
  const inferenceMs = performance.now() - inferenceStart;

  const { outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } = await import(
    '@spotify/basic-pitch'
  );
  const notes = noteFramesToTime(
    addPitchBendsToNoteEvents(
      contours,
      outputToNotesPoly(frames, onsets, onsetThresh, frameThresh, minNoteLenFrames),
    ),
  );

  return {
    notes: notes.map(n => ({
      onsetSec: n.startTimeSeconds,
      offsetSec: n.startTimeSeconds + n.durationSeconds,
      midi: Math.round(n.pitchMidi),
      amplitude: n.amplitude,
    })),
    modelLoadMs,
    inferenceMs,
    audioDurationSec: mono22050.length / 22050,
    backend: tf.getBackend(),
  };
}
