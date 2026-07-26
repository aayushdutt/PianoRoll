/**
 * Browser-build smoke test entry point.
 *
 * Purpose: prove `@spotify/basic-pitch` bundles cleanly for a real browser
 * target under this repo's pinned Vite 8, and expose real, measured output
 * bundle bytes (see `npm run build:browser-smoke` then `results/`). This
 * file is intentionally not wired into Midee's app -- it exists only inside
 * tools/guitar-model-spike as a standalone research harness.
 *
 * It does not run inference itself (there is no audio input in a static
 * build smoke test); actual inference numbers in this spike were captured
 * via the Node harness (scripts/run-basic-pitch-node.mjs), which calls the
 * same `BasicPitch.evaluateModel()` API this module imports.
 */
import { BasicPitch } from '@spotify/basic-pitch';

const modelUrl = new URL(
  '../node_modules/@spotify/basic-pitch/model/model.json',
  import.meta.url,
).toString();

const basicPitch = new BasicPitch(modelUrl);

// Touch the export so bundlers can't tree-shake the import away, and so a
// human opening this page in a browser gets a visible signal of success.
document.body.textContent = `@spotify/basic-pitch loaded (BasicPitch instance: ${
  basicPitch instanceof BasicPitch
})`;
