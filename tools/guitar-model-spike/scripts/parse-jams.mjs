/**
 * Minimal GuitarSet .jams (JSON Annotated Music Specification) ground-truth
 * note parser. GuitarSet stores one `note_midi` annotation per guitar
 * string (6 total); this merges them into a single polyphonic note list,
 * which is what any note-level transcription metric (onset F1, onset+offset
 * F1) needs to compare against.
 */
import { readFileSync } from 'node:fs';

/**
 * @param {string} jamsPath
 * @returns {{onsetSec:number, offsetSec:number, midi:number, string:number}[]}
 */
export function parseGroundTruthNotes(jamsPath) {
  const doc = JSON.parse(readFileSync(jamsPath, 'utf8'));
  const noteAnnotations = doc.annotations.filter(a => a.namespace === 'note_midi');
  if (noteAnnotations.length === 0) {
    throw new Error(`No note_midi annotations found in ${jamsPath}`);
  }

  const notes = [];
  for (const ann of noteAnnotations) {
    const stringIndex = ann.annotation_metadata?.data_source ?? null;
    for (const ev of ann.data) {
      if (ev.value == null || ev.time == null || ev.duration == null) continue;
      notes.push({
        onsetSec: ev.time,
        offsetSec: ev.time + ev.duration,
        midi: Math.round(ev.value),
        string: stringIndex,
      });
    }
  }
  notes.sort((a, b) => a.onsetSec - b.onsetSec);
  return notes;
}
