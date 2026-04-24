import type { Messages } from './en'

// All keys from en.ts are required here — TypeScript will error if any are
// missing. Technical terms (MIDI, MP4, BPM) stay as-is.

const fr: Messages = {
  // ── Home / dropzone ─────────────────────────────────────────
  'home.kicker': 'midee · visualiseur MIDI',
  'home.title.html': 'Jouez des <em>notes</em>,<br/>voyez-les éclore.',
  'home.subtitle':
    'Ouvrez un fichier MIDI pour le visualiser, ou jouez en direct avec votre clavier, votre souris, ou un contrôleur MIDI.',
  'home.cta.openMidi': 'Ouvrir MIDI',
  'home.cta.playLive': 'Jouer en direct',
  'home.samples.label': 'ou explorez un exemple',
  'home.dropHint.html':
    "Déposez un <code>.mid</code> n'importe où · jouez avec <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>…",
  'home.midi.lookingFor': "Recherche d'un MIDI…",
  'home.midi.ready': 'Périphérique MIDI prêt',
  'home.midi.blocked': 'Activez MIDI depuis la barre du haut',
  'home.midi.unavailable': 'Web MIDI indisponible dans ce navigateur',
  'home.midi.disconnected': 'Aucun périphérique MIDI — clavier et souris fonctionnent aussi',
  'home.metaLink.blog': 'Lire le blog',
  'home.metaLink.github': 'Code source sur GitHub',
  'home.metaLink.discord': 'Rejoindre la communauté Discord',
  'home.hero.title': 'Jouez des notes, voyez-les éclore',
  'home.hero.sub': 'Déposez un MIDI, ou jouez en direct avec un clavier ou un contrôleur MIDI.',
  'home.drop.prompt': 'Déposez un fichier .mid ici',
  'home.drop.fileHint': 'ou touchez pour choisir',

  // ── Top strip (primary nav) ─────────────────────────────────
  'topStrip.home': 'Accueil',
  'topStrip.modePlay': 'Jouer un fichier MIDI',
  'topStrip.modeLive': 'Jouer en direct',
  'topStrip.modeLearn': 'Apprendre · exercices, oreille, lecture',
  'topStrip.openMidi': 'Ouvrir un fichier MIDI',
  'topStrip.tracks': 'Pistes',
  'topStrip.midi': 'Périphérique MIDI',
  'topStrip.particle': 'Style des particules',
  'topStrip.theme': 'Thème',
  'topStrip.export': 'Exporter en MP4',
  'topStrip.status.ready': 'Prêt',
  'topStrip.status.openHint': 'Ouvrez un MIDI ou jouez en direct',

  // ── Appearance / customize popover ──────────────────────────
  'customize.aria': 'Apparence',
  'customize.title': 'Apparence',
  'customize.theme': 'Thème',
  'customize.particles': 'Particules',
  'customize.chord': 'Affichage des accords',
  'customize.chord.sub': 'Nommer les accords joués · mode direct',
  'customize.language': 'Langue',

  // ── HUD — tooltips ──────────────────────────────────────────
  'hud.play': 'Lecture / Pause',
  'hud.skipBack': 'Reculer de 10 s',
  'hud.skipFwd': 'Avancer de 10 s',
  'hud.metronome': 'Métronome',
  'hud.bpm': 'Faites défiler pour changer le BPM',
  'hud.record': 'Enregistrer tout ce que vous jouez en MIDI',
  'hud.loop': 'Jouez une phrase puis bouclez-la',
  'hud.loopUndo': 'Annuler le dernier calque',
  'hud.loopSave': 'Télécharger la boucle en MIDI',
  'hud.loopClear': 'Effacer la boucle',
  'hud.drag': 'Glissez pour déplacer les commandes',
  'hud.pin': 'Épingler — empêche le masquage automatique',
  'hud.volume': 'Volume',
  'hud.speed': 'Vitesse de lecture',
  'hud.zoom': 'Zoom (hauteur des notes)',
  'hud.tip.kbdRefHide': 'Masquer',
  'hud.tip.kbdRefShow': 'Afficher la référence du clavier',
  'hud.tip.octaveDown': 'Octave −',
  'hud.tip.octaveUp': 'Octave +',

  // ── HUD — accessibility (aria-label) ────────────────────────
  'hud.aria.appMode': 'Mode',
  'hud.aria.drag': 'Déplacer les commandes',
  'hud.aria.pin': 'Épingler les commandes',
  'hud.aria.skipBack': 'Reculer de 10 secondes',
  'hud.aria.play': 'Lecture',
  'hud.aria.skipFwd': 'Avancer de 10 secondes',
  'hud.aria.seek': 'Position',
  'hud.aria.volume': 'Volume',
  'hud.aria.speed': 'Vitesse',
  'hud.aria.zoom': 'Zoom',
  'hud.aria.metronomeToggle': 'Activer/désactiver le métronome',
  'hud.aria.bpmDec': 'Diminuer le BPM',
  'hud.aria.bpmInc': 'Augmenter le BPM',
  'hud.aria.session': 'Enregistrer la session',
  'hud.aria.loop': 'Bouclage',
  'hud.aria.loopUndo': 'Annuler le dernier calque',
  'hud.aria.loopSave': 'Télécharger la boucle en MIDI',
  'hud.aria.loopClear': 'Effacer la boucle',
  'hud.aria.kbdRefHide': 'Masquer la référence du clavier',
  'hud.aria.kbdRefShow': 'Afficher la référence du clavier',
  'hud.aria.octaveDown': "Descendre d'une octave",
  'hud.aria.octaveUp': "Monter d'une octave",

  // ── Export modal ───────────────────────────────────────────
  'export.title': 'Exporter en MP4',
  'export.sub': 'Précision image · audio intégré · entièrement hors ligne',
  'export.outputLabel': 'Sortie',
  'export.output.av': 'Vidéo + audio',
  'export.output.video': 'Vidéo seule',
  'export.output.audio': 'Audio seul',
  'export.output.midi': 'MIDI',
  'export.output.midi.tip': 'Enregistrer le .mid source',
  'export.resolutionLabel': 'Résolution',
  'export.fpsLabel': "Fréquence d'images",
  'export.focusLabel': 'Cadrage',
  'export.focus.fit': 'Ajuster à la pièce',
  'export.focus.fit.tip': 'Zoomer sur la tessiture réelle du morceau',
  'export.focus.all': 'Les 88 touches',
  'export.focus.all.tip': 'Afficher les 88 touches complètes',
  'export.speedLabel': 'Vitesse',
  'export.speed.compact': 'Compact',
  'export.speed.compact.tip': "Serré — plus de notes à l'écran à la fois",
  'export.speed.standard': 'Standard',
  'export.speed.standard.tip': 'Cadence par défaut',
  'export.speed.drama': 'Cinématique',
  'export.speed.drama.tip': 'Chute lente — cinématographique',
  'export.start': "Lancer l'export",
  'export.action': 'Exporter',
  'export.cancel': 'Annuler',
  'export.preparing': 'Préparation…',

  // ── Errors ─────────────────────────────────────────────────
  'error.midi.parseFailed':
    "Impossible de lire ce fichier — assurez-vous qu'il s'agit d'un MIDI valide.",
  'error.sample.fetchFailed':
    'Impossible de charger cet exemple — vérifiez votre connexion et réessayez.',
  'error.audio.renderFailed': 'Échec du rendu audio — le MP4 sera silencieux.',
  'error.export.generic': "Échec de l'export — consultez la console pour plus de détails.",

  // ── Document title (browser tab) ───────────────────────────
  'doc.title.home': 'midee — déposez un MIDI, regardez-le chanter',
  'doc.title.live': 'midee · direct',
  'doc.title.learn': 'midee · apprendre',
  'learn.hub.title': 'Apprendre',
  'learn.hub.subtitle': 'Exercices, entraînement auditif et lecture',
  'learn.hub.placeholder':
    'Le hub arrive bientôt — les exercices apparaîtront au fil du catalogue.',

  // ── Track panel ────────────────────────────────────────────
  'tracks.title': 'Pistes',
  'tracks.loadNew': 'Charger un nouveau fichier',
  'tracks.notes.one': 'canal {channel} · {count} note',
  'tracks.notes.other': 'canal {channel} · {count} notes',

  // ── Post-session modal ─────────────────────────────────────
  'postSession.title': 'Session enregistrée',
  'postSession.openInFile.title': 'Ouvrir en mode fichier',
  'postSession.openInFile.sub':
    'Visualisez-la comme un piano roll défilant — prête à être exportée en MP4.',
  'postSession.download.title': 'Télécharger MIDI',
  'postSession.download.sub.html': 'Envoyez le <code>.mid</code> directement dans votre DAW.',
  'postSession.discard.title': 'Jeter',
  'postSession.discard.sub': 'Jetez-la et continuez à jouer.',
  'postSession.stats.one': '{duration} · {count} note',
  'postSession.stats.other': '{duration} · {count} notes',

  // ── Toasts / confirmations ─────────────────────────────────
  'toast.export.ready': '{filename} prêt',
  'toast.session.saved': 'midee-session.mid · {seconds} s',
  'toast.loop.saved': 'midee-loop.mid',
  'toast.recording.empty':
    "Rien d'enregistré — jouez quelques notes pendant que Record est activé.",

  'onboarding.localeDetected': 'Affichage en {language} · changez dans Apparence',
}

export default fr
