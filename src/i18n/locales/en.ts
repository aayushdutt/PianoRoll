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
  // Legacy aliases kept so older callers keep compiling — safe to remove
  // once nothing references them.
  'home.hero.title': 'Play notes, see them bloom',
  'home.hero.sub': 'Drop a MIDI, or play live with a keyboard or MIDI controller.',
  'home.drop.prompt': 'Drop a .mid file here',
  'home.drop.fileHint': 'or tap to choose',

  // ── Top strip (primary nav) ─────────────────────────────────
  'topStrip.home': 'Home',
  'topStrip.modePlay': 'Play a MIDI file',
  'topStrip.modeLive': 'Play live',
  'topStrip.modeLearn': 'Learn · exercises, ear training, sight reading',
  'topStrip.openMidi': 'Open MIDI file',
  'topStrip.tracks': 'Tracks',
  'topStrip.midi': 'MIDI device',
  'topStrip.particle': 'Particle style',
  'topStrip.theme': 'Theme',
  'topStrip.export': 'Export MP4',
  'topStrip.status.ready': 'Ready',
  'topStrip.status.openHint': 'Open MIDI or play live',

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

  // ── Errors ─────────────────────────────────────────────────
  'error.midi.parseFailed': "Could not read that file — make sure it's a valid MIDI.",
  'error.sample.fetchFailed': 'Could not load that sample — check your network and try again.',
  'error.audio.renderFailed': 'Audio render failed — MP4 will be silent.',
  'error.export.generic': 'Export failed — check console for details.',

  // ── Document title (browser tab) ───────────────────────────
  'doc.title.home': 'midee — drop a MIDI, watch it sing',
  'doc.title.live': 'midee · live',
  'doc.title.learn': 'midee · learn',

  // ── Learn hub ───────────────────────────────────────────────
  'learn.hub.title': 'Learn',
  'learn.hub.subtitle': 'Exercises, ear training, and sight reading',
  'learn.hub.placeholder': 'Hub coming soon — exercises land as the catalog fills in.',

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
