#!/usr/bin/env node
/**
 * Deterministic 12-track GuitarSet v1.1 subset selector.
 *
 * Selects exactly one "comp" excerpt and one "solo" excerpt for each of the
 * six GuitarSet players (00-05), for a total of 12 tracks. Selection within
 * each (player, style) group of 30 candidates is by ascending SHA-256 hash
 * of the track_id string ("stable hash ordering") -- this is independent of
 * list order, download order, or wall-clock time, so re-running this script
 * against the same frozen data/guitarset-track-list.json always produces the
 * same 12 tracks.
 *
 * Input: data/guitarset-track-list.json (the real, verified 360-track list;
 *        see that file's "source" block for provenance).
 * Output: data/selected-subset.json
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function parseTrackId(trackId) {
  // e.g. "03_SS1-100-C#_comp" -> player "03", styleTag "SS1", tempo 100, key "C#", part "comp"
  const m = trackId.match(/^(\d{2})_([A-Za-z]+\d)-(\d+)-([A-G][b#]?)_(comp|solo)$/);
  if (!m) {
    throw new Error(`Unrecognized GuitarSet track_id format: ${trackId}`);
  }
  const [, player, styleTag, tempo, key, part] = m;
  return { player, styleTag, tempo: Number(tempo), key, part };
}

function selectSubset(manifest) {
  const byGroup = new Map(); // "player:part" -> [{trackId, hash}]
  for (const trackId of manifest.trackIds) {
    const { player, part } = parseTrackId(trackId);
    const key = `${player}:${part}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push({ trackId, hash: sha256(trackId) });
  }

  const players = [...new Set(manifest.trackIds.map(t => parseTrackId(t).player))].sort();
  const selection = [];
  for (const player of players) {
    for (const part of ['comp', 'solo']) {
      const group = byGroup.get(`${player}:${part}`);
      if (!group || group.length === 0) {
        throw new Error(`No candidates for player ${player} part ${part}`);
      }
      group.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
      const picked = group[0];
      selection.push({
        player,
        part,
        trackId: picked.trackId,
        selectionHash: picked.hash,
        candidatePoolSize: group.length,
        ...parseTrackId(picked.trackId),
      });
    }
  }
  return selection;
}

function main() {
  const manifestPath = path.join(ROOT, 'data', 'guitarset-track-list.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.trackIds) || manifest.trackIds.length !== 360) {
    throw new Error(
      `Expected 360 track ids in ${manifestPath}, found ${manifest.trackIds?.length}`,
    );
  }

  const selection = selectSubset(manifest);

  const out = {
    $comment:
      'Deterministic 12-track subset of GuitarSet v1.1: one comp + one solo excerpt per player (00-05), chosen by ascending SHA-256 hash of track_id within each (player, part) group of 30 candidates. Re-generate with `node scripts/select-subset.mjs`; output is identical every run given the frozen input list.',
    generatedFrom: 'data/guitarset-track-list.json',
    algorithm: 'stable-hash-ordering:sha256(track_id) ascending, take first per (player, part) group',
    trackCount: selection.length,
    tracks: selection,
  };

  const outPath = path.join(ROOT, 'data', 'selected-subset.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`Selected ${selection.length} tracks -> ${path.relative(ROOT, outPath)}`);
  for (const t of selection) {
    console.log(`  ${t.player} ${t.part.padEnd(4)} ${t.trackId}`);
  }
}

main();
