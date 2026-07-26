#!/usr/bin/env node
/**
 * End-to-end measurement run: for each of the 12 tracks in
 * data/selected-subset.json (that have both cached audio and cached
 * annotations -- see scripts/fetch-subset.mjs), decode the real GuitarSet
 * mic recording, run real @spotify/basic-pitch inference (Node/tfjs CPU
 * backend), parse the real ground-truth notes from the .jams annotation,
 * and compute onset F1 @ 50ms / onset+offset F1 / FP / FN / real-time
 * factor. Writes results/results.json and results/RESULTS.md.
 *
 * Any track missing cached audio is skipped and reported as such -- this
 * script never fabricates a result for a track it didn't actually run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWavPcm, toMonoResampled } from './wav.mjs';
import { parseGroundTruthNotes } from './parse-jams.mjs';
import { evaluateNotes } from './metrics.mjs';
import { runBasicPitch } from './basic-pitch-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODEL_DIR = path.join(ROOT, 'node_modules', '@spotify', 'basic-pitch', 'model');

const THRESHOLD_PROFILES = {
  'upstream-python-defaults': { onsetThresh: 0.5, frameThresh: 0.3, minNoteLenFrames: 11 },
  'ts-readme-example': { onsetThresh: 0.25, frameThresh: 0.25, minNoteLenFrames: 5 },
};

async function main() {
  const profileName = process.argv[2] || 'upstream-python-defaults';
  const thresholds = THRESHOLD_PROFILES[profileName];
  if (!thresholds) {
    throw new Error(
      `Unknown threshold profile "${profileName}". Choices: ${Object.keys(THRESHOLD_PROFILES).join(', ')}`,
    );
  }
  console.log(`Using threshold profile "${profileName}":`, thresholds);
  const subset = JSON.parse(
    readFileSync(path.join(ROOT, 'data', 'selected-subset.json'), 'utf8'),
  );

  const perTrack = [];
  const rssBefore = process.memoryUsage().rss;

  for (const t of subset.tracks) {
    const wavPath = path.join(ROOT, '.cache', 'audio', `${t.trackId}_mic.wav`);
    const jamsPath = path.join(ROOT, '.cache', 'annotations', `${t.trackId}.jams`);

    if (!existsSync(wavPath) || !existsSync(jamsPath)) {
      perTrack.push({
        trackId: t.trackId,
        player: t.player,
        part: t.part,
        status: 'UNVERIFIED_MISSING_INPUT',
        reason: !existsSync(wavPath) ? 'audio not cached' : 'annotation not cached',
      });
      console.log(`SKIP ${t.trackId}: missing cached input`);
      continue;
    }

    const wavReadStart = performance.now();
    const wav = readWavPcm(wavPath);
    const mono = toMonoResampled(wav, 22050);
    const wavDecodeMs = performance.now() - wavReadStart;

    const gtNotes = parseGroundTruthNotes(jamsPath);

    const result = await runBasicPitch(mono, MODEL_DIR, thresholds);
    const metrics = evaluateNotes(gtNotes, result.notes);
    const realTimeFactor = result.inferenceMs / 1000 / result.audioDurationSec;

    perTrack.push({
      trackId: t.trackId,
      player: t.player,
      part: t.part,
      status: 'MEASURED',
      audioDurationSec: result.audioDurationSec,
      wavDecodeMs,
      modelLoadMs: result.modelLoadMs,
      inferenceMs: result.inferenceMs,
      realTimeFactor,
      backend: result.backend,
      predictedNoteCount: result.notes.length,
      groundTruthNoteCount: gtNotes.length,
      metrics,
    });
    console.log(
      `MEASURED ${t.trackId}: RTF=${realTimeFactor.toFixed(3)} ` +
        `onsetF1=${metrics.onsetOnly.f1.toFixed(3)} ` +
        `onsetOffsetF1=${metrics.onsetAndOffset.f1.toFixed(3)} ` +
        `(gt=${gtNotes.length} pred=${result.notes.length})`,
    );
  }

  const rssAfter = process.memoryUsage().rss;
  const peakRssRes = process.resourceUsage();

  const measured = perTrack.filter(r => r.status === 'MEASURED');
  const summary = measured.length
    ? {
        tracksMeasured: measured.length,
        tracksTotal: perTrack.length,
        meanOnsetF1: mean(measured.map(r => r.metrics.onsetOnly.f1)),
        meanOnsetOffsetF1: mean(measured.map(r => r.metrics.onsetAndOffset.f1)),
        meanRealTimeFactor: mean(measured.map(r => r.realTimeFactor)),
        totalFalsePositives: sum(measured.map(r => r.metrics.onsetOnly.falsePositives)),
        totalFalseNegatives: sum(measured.map(r => r.metrics.onsetOnly.falseNegatives)),
      }
    : { tracksMeasured: 0, tracksTotal: perTrack.length, note: 'No tracks were measured.' };

  const out = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    thresholdProfile: profileName,
    thresholds,
    processRssBeforeBytes: rssBefore,
    processRssAfterBytes: rssAfter,
    // On POSIX, resourceUsage().maxRSS is the whole process's peak resident
    // set size in KB (cumulative across the run, not per-track).
    peakRssKb: peakRssRes.maxRSS,
    modelBytes: { modelJson: 174537, weightShard: 742392, total: 174537 + 742392 },
    summary,
    perTrack,
  };

  mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  const outPath = path.join(ROOT, 'results', `results.${profileName}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
