#!/usr/bin/env node
/**
 * Fetch the audio + annotation files for the 12 tracks in
 * data/selected-subset.json, using partial (Range-request) ZIP reads
 * against the canonical Zenodo GuitarSet record so we never have to
 * download the full multi-hundred-MB archives.
 *
 * Downloaded files are cached under .cache/ (gitignored) and are never
 * committed to the repository.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteZip } from './remote-zip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');

const ANNOTATION_ZIP_URL =
  'https://zenodo.org/api/records/3371780/files/annotation.zip/content';
const AUDIO_MIC_ZIP_URL =
  'https://zenodo.org/api/records/3371780/files/audio_mono-mic.zip/content';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function fetchMembers(zipUrl, memberNames, outDir, label) {
  mkdirSync(outDir, { recursive: true });
  const zip = new RemoteZip(zipUrl);
  const results = [];
  for (const name of memberNames) {
    const outPath = path.join(outDir, name);
    if (existsSync(outPath) && statSync(outPath).size > 0) {
      console.log(`[${label}] cached: ${name} (${statSync(outPath).size} bytes)`);
      results.push({ name, bytes: statSync(outPath).size, cached: true });
      continue;
    }
    const t0 = Date.now();
    const data = await zip.readMember(name);
    writeFileSync(outPath, data);
    const dt = Date.now() - t0;
    console.log(
      `[${label}] fetched: ${name} (${data.length} bytes, sha256=${sha256(data).slice(0, 16)}..., ${dt}ms)`,
    );
    results.push({ name, bytes: data.length, sha256: sha256(data), cached: false, ms: dt });
  }
  return { results, requestsMade: zip.requestCount, bytesOverWire: zip.bytesFetched };
}

async function main() {
  const subset = JSON.parse(
    readFileSync(path.join(ROOT, 'data', 'selected-subset.json'), 'utf8'),
  );
  const trackIds = subset.tracks.map(t => t.trackId);

  const which = process.argv[2] || 'both'; // 'annotations' | 'audio' | 'both'
  const report = { fetchedAt: new Date().toISOString(), trackIds };

  if (which === 'annotations' || which === 'both') {
    const names = trackIds.map(id => `${id}.jams`);
    report.annotations = await fetchMembers(
      ANNOTATION_ZIP_URL,
      names,
      path.join(CACHE_DIR, 'annotations'),
      'annotations',
    );
  }

  if (which === 'audio' || which === 'both') {
    const names = trackIds.map(id => `${id}_mic.wav`);
    report.audio = await fetchMembers(
      AUDIO_MIC_ZIP_URL,
      names,
      path.join(CACHE_DIR, 'audio'),
      'audio',
    );
  }

  mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  writeFileSync(
    path.join(ROOT, 'results', 'fetch-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log('\nWrote results/fetch-report.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
