// Single source of truth for inline SVG icons used across the UI.
// Each icon is a function that returns an HTML string at the given pixel size.
// Call sites use template-literal interpolation: `<span>${icons.play(16)}</span>`.
//
// Design notes:
// - All icons use `currentColor`, so colour comes from CSS.
// - Stroke-based icons share a consistent stroke-width (~2) by default.
// - If you need a stylistic variant, prefer adding a new icon rather than
//   parameterising — keeps call sites readable and grep-able.

type Size = number

const svgStroke = (size: Size, body: string, strokeWidth = 2, extra = ''): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`

const svgFilled = (size: Size, body: string, extra = ''): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" ${extra}>${body}</svg>`

export const icons = {
  play: (size: Size = 16): string => svgFilled(size, `<polygon points="6 3 20 12 6 21 6 3"/>`),

  pause: (size: Size = 16): string =>
    svgFilled(
      size,
      `<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>`,
    ),

  skipBack: (size: Size = 15): string =>
    svgStroke(
      size,
      `<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>`,
    ),

  skipForward: (size: Size = 15): string =>
    svgStroke(size, `<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>`),

  volume: (size: Size = 13): string =>
    svgStroke(
      size,
      `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`,
    ),

  zoom: (size: Size = 13): string =>
    svgStroke(
      size,
      `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>`,
    ),

  metronome: (size: Size = 13): string =>
    svgStroke(
      size,
      `<path d="M6 22 L10 3 H14 L18 22 Z"/><line x1="5" y1="17" x2="19" y2="17"/><line x1="12" y1="17" x2="17" y2="6"/>`,
    ),

  loop: (size: Size = 13): string =>
    svgStroke(
      size,
      `<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>`,
    ),

  undo: (size: Size = 13): string =>
    svgStroke(size, `<polyline points="3 7 3 13 9 13"/><path d="M3 13a9 9 0 1 0 3-7l-3 4"/>`),

  download: (size: Size = 13): string =>
    svgStroke(
      size,
      `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`,
    ),

  upload: (size: Size = 14): string =>
    svgStroke(
      size,
      `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>`,
    ),

  close: (size: Size = 14): string =>
    svgStroke(size, `<line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>`),

  check: (size: Size = 12): string => svgStroke(size, `<polyline points="20 6 9 17 4 12"/>`, 2.5),

  chevronDown: (size: Size = 11): string =>
    svgStroke(size, `<polyline points="6 9 12 15 18 9"/>`, 2.2, 'aria-hidden="true"'),

  tracks: (size: Size = 14): string =>
    svgStroke(
      size,
      `<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>`,
    ),

  midi: (size: Size = 14): string =>
    svgStroke(
      size,
      `<rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="14" x2="22" y2="14"/><line x1="7" y1="4"  x2="7"  y2="14"/><line x1="12" y1="4" x2="12" y2="14"/><line x1="17" y1="4" x2="17" y2="14"/><rect x="5"  y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/><rect x="10" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/><rect x="15" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>`,
    ),

  film: (size: Size = 26): string =>
    svgStroke(
      size,
      `<rect x="2" y="4" width="20" height="16" rx="2.5"/><line x1="2" y1="9"  x2="22" y2="9"/><line x1="2" y1="15" x2="22" y2="15"/><line x1="7" y1="4"  x2="7"  y2="20"/><line x1="17" y1="4" x2="17" y2="20"/>`,
      1.5,
    ),

  exportArrow: (size: Size = 13): string =>
    svgStroke(
      size,
      `<path d="M12 3v12"/><polyline points="7 8 12 3 17 8"/><rect x="3" y="15" width="18" height="6" rx="1.5"/>`,
    ),

  waveform: (size: Size = 26): string =>
    svgStroke(
      size,
      `<line x1="3" y1="12" x2="3" y2="12"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="11" y1="4" x2="11" y2="20"/><line x1="15" y1="9" x2="15" y2="15"/><line x1="19" y1="6" x2="19" y2="18"/>`,
      1.8,
    ),

  timeline: (size: Size = 18): string =>
    svgStroke(
      size,
      `<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="10" x2="8" y2="20"/><line x1="14" y1="10" x2="14" y2="20"/>`,
    ),

  trash: (size: Size = 18): string =>
    svgStroke(
      size,
      `<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>`,
    ),

  pin: (size: Size = 12): string =>
    svgStroke(
      size,
      `<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-2V9a5.5 5.5 0 1 0-11 0v6L5 17z"/>`,
    ),

  grip: (size: Size = 10): string =>
    svgFilled(
      size,
      `<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>`,
      'aria-hidden="true"',
    ),

  instrument: (size: Size = 13): string =>
    svgFilled(
      size,
      `<path d="M9 3h6a1 1 0 0 1 1 1v14a3 3 0 1 1-2 0V9h-2v9a3 3 0 1 1-2 0V4a1 1 0 0 1 1-1z" opacity="0.9"/>`,
      'aria-hidden="true"',
    ),

  sparkles: (size: Size = 13): string =>
    svgFilled(
      size,
      `<path d="M12 3l1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3z"/><path d="M19 13l.7 2.2 2.3.8-2.3.8-.7 2.2-.7-2.2-2.3-.8 2.3-.8.7-2.2z" opacity="0.7"/><path d="M5 14l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9z" opacity="0.55"/>`,
      'aria-hidden="true"',
    ),

  modeFile: (size: Size = 12): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="3.5" width="7" height="2.2" rx="0.8"/><rect x="2" y="7" width="12" height="2.2" rx="0.8"/><rect x="2" y="10.5" width="5" height="2.2" rx="0.8"/></svg>`,

  modeLive: (size: Size = 13): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8h2l1.2-3.5L7 12l1.8-6 1.3 3 0.9-1.2H14"/></svg>`,

  wordmark: (): string =>
    `<svg class="ts-home-mark" width="22" height="18" viewBox="0 0 32 24" fill="currentColor" aria-hidden="true"><rect x="1" y="6" width="5" height="15" rx="1.5"/><rect x="9" y="1" width="5" height="20" rx="1.5"/><rect x="17" y="4" width="5" height="12" rx="1.5" opacity="0.55"/><rect x="25" y="8" width="5" height="9" rx="1.5" opacity="0.35"/></svg>`,

  blog: (size: Size = 15): string =>
    svgStroke(
      size,
      `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>`,
      1.7,
      'aria-hidden="true"',
    ),

  github: (size: Size = 16): string =>
    svgFilled(
      size,
      `<path d="M12 2C6.475 2 2 6.588 2 12.253c0 4.537 2.862 8.369 6.838 9.727.5.092.687-.222.687-.492 0-.245-.013-1.052-.013-1.912-2.512.475-3.162-.63-3.362-1.21-.113-.292-.6-1.21-1.025-1.455-.35-.192-.85-.665-.013-.677.788-.012 1.35.745 1.538 1.052.9 1.555 2.338 1.12 2.912.85.088-.665.35-1.12.638-1.376-2.225-.257-4.55-1.137-4.55-5.048 0-1.122.388-2.05 1.025-2.772-.1-.257-.45-1.31.1-2.723 0 0 .837-.272 2.75 1.06.8-.23 1.65-.345 2.5-.345s1.7.115 2.5.345c1.912-1.345 2.75-1.06 2.75-1.06.55 1.413.2 2.466.1 2.722.637.724 1.025 1.64 1.025 2.772 0 3.924-2.337 4.79-4.562 5.047.363.33.675.944.675 1.922 0 1.38-.012 2.49-.012 2.835 0 .27.188.59.688.491C19.14 20.622 22 16.777 22 12.252 22 6.588 17.525 2 12 2z"/>`,
      'aria-hidden="true"',
    ),

  discord: (size: Size = 17): string =>
    svgFilled(
      size,
      `<path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419-.0188 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/>`,
      'aria-hidden="true"',
    ),

  export: (size: Size = 12): string =>
    svgStroke(
      size,
      `<path d="M12 3v12"/><polyline points="7 8 12 3 17 8"/><rect x="3" y="15" width="18" height="6" rx="1.5"/>`,
    ),
}

export type IconName = keyof typeof icons
