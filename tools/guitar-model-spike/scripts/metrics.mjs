/**
 * Note-level transcription metrics, following the conventions used by
 * mir_eval.transcription (the standard used in the Basic Pitch, GAPS and
 * FretNet papers):
 *
 *  - Onset-only match: predicted pitch === ground-truth pitch (exact MIDI
 *    number, i.e. 0 cents tolerance) AND |onset_pred - onset_gt| <= onsetTol.
 *  - Onset+offset match: onset-only match criteria AND
 *    |offset_pred - offset_gt| <= max(offsetTolMin, offsetTolRatio * gt_duration).
 *
 * Matching is a greedy nearest-onset assignment (each ground-truth note can
 * be matched at most once, each predicted note at most once). This is a
 * simplification of mir_eval's Hungarian-algorithm-based optimal matching --
 * documented here rather than silently presented as identical -- but gives
 * the same precision/recall/F1 in the overwhelming majority of cases
 * because collisions among simultaneous same-pitch notes are rare in solo
 * guitar recordings.
 */

const DEFAULT_ONSET_TOL_SEC = 0.05;
const DEFAULT_OFFSET_TOL_MIN_SEC = 0.05;
const DEFAULT_OFFSET_TOL_RATIO = 0.2;

function greedyMatch(gtNotes, predNotes, isMatch) {
  const gtUsed = new Array(gtNotes.length).fill(false);
  const predUsed = new Array(predNotes.length).fill(false);
  const candidates = [];
  for (let i = 0; i < gtNotes.length; i++) {
    for (let j = 0; j < predNotes.length; j++) {
      if (isMatch(gtNotes[i], predNotes[j])) {
        candidates.push({ i, j, diff: Math.abs(gtNotes[i].onsetSec - predNotes[j].onsetSec) });
      }
    }
  }
  candidates.sort((a, b) => a.diff - b.diff);
  let matched = 0;
  for (const c of candidates) {
    if (gtUsed[c.i] || predUsed[c.j]) continue;
    gtUsed[c.i] = true;
    predUsed[c.j] = true;
    matched++;
  }
  return { matched, gtUsed, predUsed };
}

function prf(matched, gtCount, predCount) {
  const precision = predCount > 0 ? matched / predCount : 0;
  const recall = gtCount > 0 ? matched / gtCount : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

/**
 * @param {{onsetSec:number, offsetSec:number, midi:number}[]} gtNotes
 * @param {{onsetSec:number, offsetSec:number, midi:number}[]} predNotes
 */
export function evaluateNotes(gtNotes, predNotes, opts = {}) {
  const onsetTol = opts.onsetTolSec ?? DEFAULT_ONSET_TOL_SEC;
  const offsetTolMin = opts.offsetTolMinSec ?? DEFAULT_OFFSET_TOL_MIN_SEC;
  const offsetTolRatio = opts.offsetTolRatio ?? DEFAULT_OFFSET_TOL_RATIO;

  const onsetOnly = greedyMatch(
    gtNotes,
    predNotes,
    (gt, pred) => gt.midi === pred.midi && Math.abs(gt.onsetSec - pred.onsetSec) <= onsetTol,
  );
  const onsetOffset = greedyMatch(gtNotes, predNotes, (gt, pred) => {
    if (gt.midi !== pred.midi) return false;
    if (Math.abs(gt.onsetSec - pred.onsetSec) > onsetTol) return false;
    const tol = Math.max(offsetTolMin, offsetTolRatio * (gt.offsetSec - gt.onsetSec));
    return Math.abs(gt.offsetSec - pred.offsetSec) <= tol;
  });

  return {
    groundTruthNoteCount: gtNotes.length,
    predictedNoteCount: predNotes.length,
    onsetOnly: {
      ...prf(onsetOnly.matched, gtNotes.length, predNotes.length),
      truePositives: onsetOnly.matched,
      falsePositives: predNotes.length - onsetOnly.matched,
      falseNegatives: gtNotes.length - onsetOnly.matched,
      onsetToleranceSec: onsetTol,
    },
    onsetAndOffset: {
      ...prf(onsetOffset.matched, gtNotes.length, predNotes.length),
      truePositives: onsetOffset.matched,
      falsePositives: predNotes.length - onsetOffset.matched,
      falseNegatives: gtNotes.length - onsetOffset.matched,
      onsetToleranceSec: onsetTol,
      offsetToleranceMinSec: offsetTolMin,
      offsetToleranceRatio: offsetTolRatio,
    },
  };
}
