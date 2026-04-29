// Source of truth for all UI strings. Add new strings here first, then
// mirror them in every other locale file. TypeScript structurally enforces
// that each locale has the same keys (see fr.ts / es.ts / pt-BR.ts, typed
// as `Messages`).
//
// Conventions:
//  · Flat dotted keys, grouped by screen/component (`home.*`, `hud.*`, etc.)
//  · `{var}` placeholder syntax for interpolation — see `toast.export.ready`
//  · Plural keys end in `.one` / `.other` (and `.zero`/`.few`/`.many` in
//    locales that need them). Use `tn(base, count)` at call sites.
//  · Technical terms (MIDI, MP4, BPM, MIDI) stay English across all locales.
//  · Never concatenate strings like `t('a') + ' ' + t('b')`; use a single
//    key with interpolation instead so word order is translator-controlled.

export const en = {
  // ── Home / dropzone ─────────────────────────────────────────
  // The title contains inline <em> markup — one of the rare keys allowed
  // to carry HTML (rendered via innerHTML). We do this so word order stays
  // translator-controlled (French/Spanish/Portuguese put the emphasised
  // noun in different positions). No user-controlled interpolation, so no
  // XSS risk.
  'home.kicker': 'midee · MIDI visualizer',
  'home.title.html': 'Play <em>notes</em>,<br/>see them bloom.',
  'home.subtitle':
    'Open a MIDI file to animate it, or go live and play with your keyboard, mouse, or a MIDI controller.',
  'home.cta.openMidi': 'Open MIDI',
  'home.cta.playLive': 'Play live',
  'home.cta.learn.title': 'Practice & learn',
  'home.cta.learn.sub': 'Guided exercises · play-along pieces',
  'home.samples.label': 'or explore a sample',
  'home.dropHint.html':
    'Drop <code>.mid</code> anywhere · play with <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>…',
  'home.midi.lookingFor': 'Looking for MIDI…',
  'home.midi.ready': 'MIDI device ready',
  'home.midi.blocked': 'Enable MIDI from the top bar',
  'home.midi.unavailable': 'Web MIDI unavailable in this browser',
  'home.midi.disconnected': 'No MIDI device — keyboard & mouse work too',
  'home.metaLink.blog': 'Read the blog',
  'home.metaLink.github': 'Source on GitHub',
  'home.metaLink.discord': 'Join the Discord community',
  'home.metaLinks.aria': 'midee links',
  'home.aria': 'midee home',

  // ── Top strip (primary nav) ─────────────────────────────────
  'topStrip.home': 'Home',
  'topStrip.modePlay': 'Play a MIDI file',
  'topStrip.modeLive': 'Play live',
  'topStrip.modeLearn': 'Learn · exercises, ear training, sight reading',
  'topStrip.openMidi': 'Open MIDI file',
  'topStrip.tracks': 'Tracks',
  'topStrip.midi': 'MIDI device',
  'topStrip.export': 'Export MP4',
  'topStrip.export.label': 'Export',
  // Mode-pill visible labels (the longer descriptors live in `topStrip.mode*`).
  'topStrip.mode.play.label': 'Play',
  'topStrip.mode.live.label': 'Live',
  'topStrip.mode.learn.label': 'Learn',
  // "Learn this MIDI" CTA (only visible when a piece is loaded in Play).
  'topStrip.learnThis.aria': 'Learn this piece',
  'topStrip.learnThis.tip': 'Practice this piece with wait-mode',
  'topStrip.learnThis.label': 'Learn this piece',
  // Topbar context strip — kicker (small label) + title (main).
  'topStrip.context.ready.kicker': 'Ready',
  'topStrip.context.ready.title': 'Open MIDI or play live',
  'topStrip.context.loading.kicker': 'Loading',
  'topStrip.context.loading.title': 'Opening MIDI',
  'topStrip.context.live.kicker': 'Live',
  'topStrip.context.live.midiSession': 'MIDI session',
  'topStrip.context.live.keyboard': 'Play with your keyboard',
  'topStrip.context.play.kicker': 'Now playing',
  'topStrip.context.play.fallback': 'Open MIDI',
  'topStrip.context.learnSoon.kicker': 'Coming soon',
  'topStrip.context.learnSoon.title': 'Learn mode is on the way',
  'topStrip.context.learning.kicker': 'Learning',
  'topStrip.context.learn.kicker': 'Learn',
  'topStrip.context.learn.title': 'Exercises, ear training, sight reading',
  // MIDI pill + menu labels (status-driven). `{name}` is the device name.
  'topStrip.midi.connectedMenu': 'MIDI: {name}',
  'topStrip.midi.connectedDefault': 'connected',
  'topStrip.midi.blockedMenu': 'Enable MIDI device',
  'topStrip.midi.unavailableMenu': 'MIDI unavailable in this browser',
  'topStrip.midi.disconnectedMenu': 'Connect a MIDI device',
  'topStrip.midi.blockedPill': 'Enable MIDI',
  'topStrip.midi.pillFallback': 'MIDI',

  // ── Appearance / customize popover ──────────────────────────
  'customize.aria': 'Appearance',
  'customize.title': 'Appearance',
  'customize.theme': 'Theme',
  'customize.particles': 'Particles',
  'customize.chord': 'Chord readout',
  'customize.chord.sub': "Name what's sounding · live mode",
  'customize.language': 'Language',

  // ── HUD — tooltips (data-tip) ───────────────────────────────
  'hud.play': 'Play / Pause',
  'hud.skipBack': 'Back 10s',
  'hud.skipFwd': 'Forward 10s',
  'hud.metronome': 'Metronome',
  'hud.bpm': 'Scroll to change BPM',
  'hud.record': 'Record everything you play to MIDI',
  'hud.loop': 'Play a phrase then loop it',
  'hud.loopUndo': 'Undo last layer',
  'hud.loopSave': 'Download loop as MIDI',
  'hud.loopClear': 'Clear loop',
  'hud.drag': 'Drag to move controls',
  'hud.pin': 'Pin — prevents auto-hide',
  'hud.volume': 'Volume',
  'hud.speed': 'Playback speed',
  'hud.zoom': 'Zoom (note height)',
  'hud.tip.kbdRefHide': 'Hide',
  'hud.tip.kbdRefShow': 'Show keyboard reference',
  'hud.tip.octaveDown': 'Octave −',
  'hud.tip.octaveUp': 'Octave +',

  // ── HUD — accessibility (aria-label) ────────────────────────
  // Often longer/more descriptive than the visible tip — a screen-reader
  // user gets a full sentence; a sighted user gets a glance.
  'hud.aria.appMode': 'App mode',
  'hud.aria.drag': 'Move controls',
  'hud.aria.pin': 'Pin controls',
  'hud.aria.skipBack': 'Back 10 seconds',
  'hud.aria.play': 'Play',
  'hud.aria.skipFwd': 'Forward 10 seconds',
  'hud.aria.seek': 'Seek',
  'hud.aria.volume': 'Volume',
  'hud.aria.speed': 'Speed',
  'hud.aria.zoom': 'Zoom',
  'hud.aria.metronomeToggle': 'Toggle metronome',
  'hud.aria.bpmDec': 'Decrease BPM',
  'hud.aria.bpmInc': 'Increase BPM',
  'hud.aria.session': 'Record session',
  'hud.aria.loop': 'Looper',
  'hud.aria.loopUndo': 'Undo last layer',
  'hud.aria.loopSave': 'Download loop as MIDI',
  'hud.aria.loopClear': 'Clear loop',
  'hud.aria.kbdRefHide': 'Hide keyboard reference',
  'hud.aria.kbdRefShow': 'Show keyboard reference',
  'hud.aria.octaveDown': 'Shift octave down',
  'hud.aria.octaveUp': 'Shift octave up',

  // ── Export modal ───────────────────────────────────────────
  'export.title': 'Export MP4',
  'export.sub': 'Frame-accurate · audio baked in · fully offline',
  'export.outputLabel': 'Output',
  'export.output.av': 'Video + audio',
  'export.output.video': 'Video only',
  'export.output.audio': 'Audio only',
  'export.output.midi': 'MIDI',
  'export.output.midi.tip': 'Save the source .mid',
  'export.resolutionLabel': 'Resolution',
  'export.fpsLabel': 'Frame rate',
  'export.focusLabel': 'Focus',
  'export.focus.fit': 'Fit to piece',
  'export.focus.fit.tip': "Zoom onto the piece's actual range",
  'export.focus.all': 'All 88 keys',
  'export.focus.all.tip': 'Show the full 88 keys',
  'export.speedLabel': 'Speed',
  'export.speed.compact': 'Compact',
  'export.speed.compact.tip': 'Tight — more notes on screen at once',
  'export.speed.standard': 'Standard',
  'export.speed.standard.tip': 'Default pace',
  'export.speed.drama': 'Drama',
  'export.speed.drama.tip': 'Slower fall — cinematic',
  'export.start': 'Start export',
  'export.action': 'Export',
  'export.cancel': 'Cancel',
  'export.preparing': 'Preparing…',
  // Resolution preset labels + hints (formerly hardcoded in PRESETS).
  'export.preset.match': 'Match',
  'export.preset.match.dim': 'Current size',
  'export.preset.vertical': 'Vertical',
  'export.preset.square': 'Square',
  'export.preset.2k.hint': 'YouTube QHD',
  'export.preset.4k.hint': 'slow · big file',
  'export.preset.vertical.hint': 'TikTok / Reels / Shorts',
  'export.preset.square.hint': 'Instagram feed',
  // FPS button label — `{fps}` is the numeric rate.
  'export.fps.unit': '{fps} fps',
  // Encoder pipeline stages — surfaced in the progress card.
  'export.stage.renderingAudio': 'Rendering audio',
  'export.stage.encodingAudio': 'Encoding audio',
  'export.stage.encoding': 'Encoding',
  'export.stage.finalizing': 'Finalizing',
  'export.stage.saving': 'Saving',
  'export.stage.done': 'Done',

  // ── Session / loop / metro labels (live HUD) ───────────────
  'hud.session.label.record': 'Record',
  'hud.loop.label.idle': 'Loop',
  'hud.loop.label.armed': 'Play now…',
  'hud.loop.label.recording': 'Stop',
  'hud.loop.label.playing': 'Tap to overdub',
  'hud.loop.label.playingMulti': 'Loop ×{count}',
  'hud.loop.label.overdub': 'Overdub {count}',

  // ── Keyboard reference card (live mode) ────────────────────
  'keyHint.play': 'Play',
  'keyHint.octave': 'Octave',
  'keyHint.shortcuts': 'Shortcuts',
  'keyHint.shortcut.record': 'Record',
  'keyHint.shortcut.loop': 'Loop',
  'keyHint.shortcut.undo': 'Undo',
  'keyHint.shortcut.clear': 'Clear',
  'keyHint.shortcut.metronome': 'Metronome',

  // ── ChordOverlay ───────────────────────────────────────────
  'chord.aria': 'Currently sounding chord',

  // ── Errors ─────────────────────────────────────────────────
  'error.midi.parseFailed': "Could not read that file — make sure it's a valid MIDI.",
  'error.midi.empty': 'That MIDI has no notes in it.',
  'error.midi.permissionBlocked':
    'MIDI is blocked. Click the 🔒 icon in your address bar → Site settings → allow MIDI, then reload.',
  'error.midi.permissionDenied':
    'MIDI permission denied. Click again, or enable it via the 🔒 icon in your address bar.',
  'error.sample.fetchFailed': 'Could not load that sample — check your network and try again.',
  'error.audio.renderFailed': 'Audio render failed — MP4 will be silent.',
  'error.export.generic': 'Export failed — check console for details.',

  // ── Mode error boundary ────────────────────────────────────
  'modeError.title': 'Something went wrong',
  'modeError.retry': 'Try again',

  // ── Document title (browser tab) ───────────────────────────
  'doc.title.home': 'midee — drop a MIDI, watch it sing',
  'doc.title.live': 'midee · live',
  'doc.title.learn': 'midee · learn',

  // ── Learn hub ───────────────────────────────────────────────
  'learn.hub.recommended': 'Recommended',
  'learn.hub.uploadMidi': 'Upload a MIDI',
  'learn.hub.startWith': 'Start · {name}',
  'learn.hub.explore': 'Explore',
  'learn.hub.comingSoon': 'Coming soon',

  // Catalog category labels.
  'learn.category.playAlong': 'Play along',
  'learn.category.sightReading': 'Sight reading',
  'learn.category.earTraining': 'Ear training',
  'learn.category.theory': 'Theory',
  'learn.category.technique': 'Technique',
  'learn.category.reflection': 'Reflect',

  // Exercise descriptors (title + blurb shown in catalog cards).
  'learn.exercise.intervals.title': 'Intervals',
  'learn.exercise.intervals.blurb':
    'Hear two notes and name the distance between them. Beginner set — M3, P4, P5, octave.',
  'learn.exercise.playAlong.title': 'Play along',
  'learn.exercise.playAlong.blurb':
    'Drop a MIDI and play along. Wait-mode pauses at each chord until you hit the right notes.',
  'learn.exercise.sightReading.title': 'Sight Reading',
  'learn.exercise.sightReading.blurb':
    'Notes scroll past the hit line — read the staff and press the right key in time.',

  // Sight-reading HUD.
  'learn.sr.pause': 'Pause',
  'learn.sr.resumeAria': 'Resume',
  'learn.sr.pauseTip': 'Pause (Esc)',
  'learn.sr.resumeTip': 'Resume (Esc)',
  'learn.sr.clefTreble': 'Treble',
  'learn.sr.clefBass': 'Bass',
  'learn.sr.clefBoth': 'Both',
  'learn.sr.clefAria': 'Clef: {clef}',
  'learn.sr.clefTip': '{clef} — click to change',
  'learn.sr.bpmDecAria': 'Decrease tempo',
  'learn.sr.bpmDecTip': 'Decrease tempo: scroll down or click',
  'learn.sr.bpmIncAria': 'Increase tempo',
  'learn.sr.bpmIncTip': 'Increase tempo: scroll up or click',
  'learn.sr.bpmTip': 'BPM: scroll to adjust',
  'learn.sr.gapAria': 'Note gap',
  'learn.sr.gapTip': 'Note gap: spacing between notes',
  'learn.sr.rampAria': 'Tempo ramp',
  'learn.sr.rampOnTip': 'Ramp on — BPM increases',
  'learn.sr.rampOffTip': 'Ramp off — steady tempo',
  'learn.sr.rampLabel': 'Ramp',
  'learn.sr.accuracyTip': 'Accuracy',
  'learn.sr.restartAria': 'Restart session',
  'learn.sr.restartTip': 'Restart',
  'learn.sr.closeAria': 'Back to hub',
  'learn.sr.closeTip': 'Back to hub',

  // Sight-reading end panel.
  'learn.sr.end.knockedOut': 'Knocked out',
  'learn.sr.end.notEnough': 'Not enough notes',
  'learn.sr.end.complete': 'Session complete',
  'learn.sr.end.perfect': 'Perfect',
  'learn.sr.end.good': 'Good',
  'learn.sr.end.missed': 'Missed',
  'learn.sr.end.bestStreak': 'Best streak',
  'learn.sr.end.xp': '+{xp} XP',
  'learn.sr.end.troubleWith': 'Trouble with:',
  'learn.sr.end.playAgain': 'Play Again',
  'learn.sr.end.practiceWeak': 'Practice Weak Notes',
  'learn.sr.end.backToHub': 'Back to hub',

  // Intervals quiz UI.
  'learn.intervals.kicker': 'Ear training',
  'learn.intervals.title': 'Intervals',
  'learn.intervals.backTip': 'Back to hub (Esc)',
  'learn.intervals.backAria': 'Back to learn hub',
  'learn.intervals.questionOf': 'Question {n} of {total}',
  'learn.intervals.preparing': 'Preparing…',
  'learn.intervals.streakInRow': '🔥 {n} in a row',
  'learn.intervals.listen': 'Listen',
  'learn.intervals.listenHint': 'Press play to hear two notes — pick the interval you just heard.',
  'learn.intervals.playAria': 'Play interval',
  'learn.intervals.playTip': 'Play again (Space)',
  'learn.intervals.playLabel': 'Play interval',
  'learn.intervals.choose': 'Choose an interval',
  'learn.intervals.answerTip': '{full} · press {n}',
  'learn.intervals.correct': 'Correct',
  'learn.intervals.miss': 'Miss',
  'learn.intervals.correctMsg': '{name} — nice ear.',
  'learn.intervals.missMsg': 'It was {name}.',
  'learn.intervals.replayAria': 'Hear the interval again',
  'learn.intervals.replayTip': 'Hear again',
  'learn.intervals.replayLabel': 'Replay',
  'learn.intervals.finish': 'Finish',
  'learn.intervals.next': 'Next',
  'learn.intervals.shortcutReplay': 'replay',
  'learn.intervals.shortcutPick': 'pick answer',

  // Interval names. Translators: `short` codes (P5, m3) stay universal — only
  // the `full` names below get localised.
  'learn.interval.P1': 'Unison',
  'learn.interval.m2': 'Minor 2nd',
  'learn.interval.M2': 'Major 2nd',
  'learn.interval.m3': 'Minor 3rd',
  'learn.interval.M3': 'Major 3rd',
  'learn.interval.P4': 'Perfect 4th',
  'learn.interval.TT': 'Tritone',
  'learn.interval.P5': 'Perfect 5th',
  'learn.interval.m6': 'Minor 6th',
  'learn.interval.M6': 'Major 6th',
  'learn.interval.m7': 'Minor 7th',
  'learn.interval.M7': 'Major 7th',
  'learn.interval.P8': 'Octave',

  // Play-along HUD.
  'learn.pa.score': 'Session score',
  'learn.pa.streak.tip': 'Consecutive cleared chords',
  'learn.pa.accuracy.tip': 'Hits / (hits + errors)',
  'learn.pa.perfect.tip': 'Perfect chord articulation (≤80 ms)',
  'learn.pa.good.tip': 'Cleared chord (slower articulation)',
  'learn.pa.error.tip': 'Wrong-pitch press while waiting',
  'learn.pa.drag': 'Drag to move',
  'learn.pa.pinAria': 'Pin in place',
  'learn.pa.pinTip': 'Pin · keep from auto-hiding',
  'learn.pa.playAria': 'Play',
  'learn.pa.pauseAria': 'Pause',
  'learn.pa.playTip': 'Play / pause (Space)',
  'learn.pa.scrubAria': 'Scrubber',
  'learn.pa.scrubTip': 'Drag to seek',
  'learn.pa.backAria': 'Back to learn hub',
  'learn.pa.backTip': 'Back to hub (Esc)',
  'learn.pa.speedAria': 'Speed',
  'learn.pa.speedLabel': 'Speed',
  'learn.pa.speedSlowTip': 'Slow · 60% ([)',
  'learn.pa.speedMedTip': 'Medium · 80%',
  'learn.pa.speedFullTip': 'Full · 100% (])',
  'learn.pa.speedPctAria': '{pct}% speed',
  'learn.pa.handsAria': 'Hands',
  'learn.pa.handsLabel': 'Hands',
  'learn.pa.handLeftTip': 'Left hand only',
  'learn.pa.handRightTip': 'Right hand only',
  'learn.pa.handBothTip': 'Both hands',
  'learn.pa.handLeftAria': 'Left hand',
  'learn.pa.handRightAria': 'Right hand',
  'learn.pa.handBothAria': 'Both hands',
  'learn.pa.handLeftLabel': 'L',
  'learn.pa.handRightLabel': 'R',
  'learn.pa.handBothLabel': 'Both',
  'learn.pa.loopClearTip': 'Clear loop (L)',
  'learn.pa.loopMarkBTip': 'Mark loop end (L)',
  'learn.pa.loopMarkATip': 'Mark loop start (L)',
  'learn.pa.loopClearAria': 'Clear loop',
  'learn.pa.loopMarkBAria': 'Mark loop end',
  'learn.pa.loopMarkAAria': 'Mark loop start',
  'learn.pa.loopMarkBLabel': 'Mark B',
  'learn.pa.loopLabel': 'Loop',
  'learn.pa.loopXClear': 'Clear loop',
  'learn.pa.waitTip': 'Wait mode · pauses at each chord',
  'learn.pa.waitAria': 'Toggle wait mode',
  'learn.pa.waitLabel': 'Wait',
  'learn.pa.rampTip': 'Auto-speed · ramps up on clean passes',
  'learn.pa.rampAria': 'Toggle tempo ramp',
  'learn.pa.rampLabel': 'Ramp',

  // Streak row (Learn hub topbar).
  'learn.streak.tip': 'Practice streak · last 14 days',
  'learn.streak.label': 'day streak',

  // End-of-session summary.
  'learn.summary.accuracy': 'accuracy',
  'learn.summary.xp': 'xp',
  'learn.summary.streakBump': 'streak +1',
  'learn.summary.again': 'Again',
  'learn.summary.next': 'Next',

  // Coming-soon surface (Learn mode disabled via feature flag).
  'learn.soon.docTitle': 'Learn · midee',
  'learn.soon.badge': 'Coming soon',
  'learn.soon.title.html': 'Practice, <em>gamified</em>.',
  'learn.soon.body': "Streaks, levels, and a piano roll that knows when you're guessing.",

  // First-encounter coachmark for the topbar's "Learn this MIDI" pill.
  'coachmark.learn.title': 'Practice this piece',
  'coachmark.learn.body': 'Step through note-by-note with wait-mode.',
  'coachmark.drag.title': 'Move this anywhere',
  'coachmark.drag.body': 'Drag this handle to reposition the controls.',
  'coachmark.dismiss': 'Dismiss',

  // ── MidiPickerModal ─────────────────────────────────────────
  'midiPicker.aria': 'Open a MIDI',
  'midiPicker.title': 'Open a MIDI',
  'midiPicker.sub': 'Drop a file, choose one from disk, or jump in with a sample.',
  'midiPicker.close': 'Close',
  'midiPicker.dropTitle': 'Drop a MIDI file here',
  'midiPicker.dropSub': 'or click to choose from your computer',
  'midiPicker.samplesLabel': 'Or explore a sample',

  // ── Instrument menu ─────────────────────────────────────────
  'instrument.title': 'Instrument',
  'instrument.aria': 'Choose instrument',
  'instrument.panelLabel': 'Instrument',
  'instrument.fallback': 'Piano',

  // ── Track panel ────────────────────────────────────────────
  'tracks.title': 'Tracks',
  'tracks.loadNew': 'Load new file',
  // Plural — { channel, count }. Real translators may add .zero/.few/.many
  // for languages that need them; en just needs one/other.
  'tracks.notes.one': 'ch {channel} · {count} note',
  'tracks.notes.other': 'ch {channel} · {count} notes',

  // ── Post-session modal ─────────────────────────────────────
  'postSession.title': 'Session recorded',
  'postSession.openInFile.title': 'Open in file mode',
  'postSession.openInFile.sub': 'Visualize it as a rolling piano roll — ready to export as MP4.',
  'postSession.download.title': 'Download MIDI',
  'postSession.download.sub.html': 'Send <code>.mid</code> straight to your DAW.',
  'postSession.discard.title': 'Discard',
  'postSession.discard.sub': 'Throw it away and keep jamming.',
  // Stats line — `{duration} · {count} note(s)`. Plural via tn().
  'postSession.stats.one': '{duration} · {count} note',
  'postSession.stats.other': '{duration} · {count} notes',

  // ── Toasts / confirmations ─────────────────────────────────
  'toast.export.ready': '{filename} ready',
  'toast.session.saved': 'midee-session.mid · {seconds}s',
  'toast.loop.saved': 'midee-loop.mid',
  'toast.recording.empty': 'Nothing recorded — play a few notes while Record is on.',

  // ── Onboarding ─────────────────────────────────────────────
  // Shown once on first visit if a non-English locale was auto-detected,
  // so the user knows they CAN switch and where to do it.
  'onboarding.localeDetected': 'Showing in {language} · change in Appearance',
} as const

// Keys come from the English source; values are any string so translations
// don't have to match the English literal — TypeScript still enforces that
// every translation covers every key via `Record<MessageKey, string>`.
export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, string>

export default en
