import { afterEach, describe, expect, it } from 'vitest'
import { watch } from '../store/watch'
import { formatNumber, locale, resolveLocale, setLocale, t, tn } from './index'
import { en } from './locales/en'
import ja from './locales/ja'
import pl from './locales/pl'
import zhCN from './locales/zh-CN'

// These tests cover the pure-function surface of i18n: `t`, `tn`, and the
// native-Intl helpers. They do not exercise `initI18n` / `setLocale` (which
// touch localStorage, navigator, dynamic imports) — that path needs a real
// browser environment and isn't worth mocking. The pure-function surface is
// where regressions actually slip through (typo'd keys, wrong plural form,
// botched interpolation).

const originalLocale = locale.value
afterEach(async () => {
  // Restore via setLocale (not a bare `locale.set`) so both the active
  // `messages()` and `locale.value` reset — otherwise a test that loaded a
  // non-en locale would leak its strings into later tests. en loads
  // synchronously, so this is cheap.
  await setLocale(originalLocale)
})

describe('t()', () => {
  it('returns the message for a known key', () => {
    expect(t('home.cta.openMidi')).toBe(en['home.cta.openMidi'])
  })

  it('substitutes {var} placeholders', () => {
    const out = t('toast.export.ready', { filename: 'midee.mp4' })
    expect(out).toBe('midee.mp4 ready')
  })

  it('leaves {var} placeholders intact when no value is supplied', () => {
    // Better than printing "undefined" — at least the next agent sees the
    // missing variable name in the wild.
    const out = t('toast.export.ready')
    expect(out).toBe('{filename} ready')
  })

  it('falls back to the key itself when neither current nor en have it', () => {
    // Force-cast through `unknown` to bypass the compile-time key check —
    // simulating what would happen at runtime if a stale string slipped in.
    const out = t('this.does.not.exist' as unknown as keyof typeof en)
    expect(out).toBe('this.does.not.exist')
  })
})

describe('tn()', () => {
  it('uses .one for count=1 in English', () => {
    expect(tn('tracks.notes', 1, { channel: 1 })).toBe('ch 1 · 1 note')
  })

  it('uses .other for count=0 and count>1 in English', () => {
    expect(tn('tracks.notes', 0, { channel: 1 })).toBe('ch 1 · 0 notes')
    expect(tn('tracks.notes', 2, { channel: 1 })).toBe('ch 1 · 2 notes')
    expect(tn('tracks.notes', 12, { channel: 4 })).toBe('ch 4 · 12 notes')
  })

  it('injects {count} automatically — caller does not have to pass it', () => {
    // Plural keys reference {count} but the call site only passes domain
    // params (e.g. `channel`). tn() merges count in.
    expect(tn('tracks.notes', 7, { channel: 9 })).toContain('7 notes')
  })

  it('postSession.stats interpolates both {count} and {duration}', () => {
    expect(tn('postSession.stats', 5, { duration: '0:30' })).toBe('0:30 · 5 notes')
    expect(tn('postSession.stats', 1, { duration: '0:30' })).toBe('0:30 · 1 note')
  })
})

describe('formatNumber()', () => {
  it('formats numbers using the current locale', () => {
    // English uses "." as decimal separator; testing in default (en) locale.
    expect(formatNumber(1234.5)).toBe('1,234.5')
  })
})

describe('reactivity', () => {
  it('t() re-runs inside a tracking scope when setLocale flips the messages', async () => {
    // Every JSX surface calling t() depends on this — without it, locale
    // changes would leave stale strings on screen until a remount.
    const seen: string[] = []
    const stop = watch(
      () => t('home.cta.openMidi'),
      (v) => seen.push(v),
    )
    await setLocale('fr')
    stop()
    // watch() defers the initial read — only the locale flip fires.
    expect(seen.length).toBe(1)
    expect(seen[0]).not.toBe(en['home.cta.openMidi'])
  })
})

describe('resolveLocale()', () => {
  // Negotiation logic behind language detection (URL ?lang=, localStorage,
  // navigator.language). Tested as a pure function instead of mocking the
  // browser env — same reasoning as the file header.
  it('returns an exactly-supported tag unchanged', () => {
    expect(resolveLocale('zh-CN')).toBe('zh-CN')
    expect(resolveLocale('fr')).toBe('fr')
  })

  it('maps every Chinese variant to zh-CN', () => {
    // We ship one Chinese locale; `zh`, `zh-TW`, `zh-Hant` all resolve to it
    // rather than falling through to en.
    expect(resolveLocale('zh')).toBe('zh-CN')
    expect(resolveLocale('zh-TW')).toBe('zh-CN')
    expect(resolveLocale('zh-Hant')).toBe('zh-CN')
  })

  it('falls back from a region tag to its supported base language', () => {
    expect(resolveLocale('fr-CA')).toBe('fr')
    expect(resolveLocale('es-MX')).toBe('es')
  })

  it('returns null for unsupported or empty tags', () => {
    expect(resolveLocale('de')).toBeNull()
    // Only the exact "pt-BR" tag is supported — base "pt" is not, so a
    // different Portuguese region does not silently map to Brazilian.
    expect(resolveLocale('pt-PT')).toBeNull()
    expect(resolveLocale('')).toBeNull()
    expect(resolveLocale(null)).toBeNull()
    expect(resolveLocale(undefined)).toBeNull()
  })
})

describe('zh-CN locale', () => {
  it('dynamically loads the chunk and serves translated strings', async () => {
    await setLocale('zh-CN')
    expect(locale.value).toBe('zh-CN')
    // Proves the lazy import + LOADERS registration actually wired up — the
    // string comes from the zh-CN file, not an en fallback.
    expect(t('home.cta.openMidi')).toBe(zhCN['home.cta.openMidi'])
    expect(t('home.cta.openMidi')).not.toBe(en['home.cta.openMidi'])
  })

  it('uses the .other plural form for every count (Chinese has no singular)', async () => {
    // Intl.PluralRules('zh-CN') only ever returns "other", so count=1 must
    // still resolve — a regression here would throw on a missing .one key.
    await setLocale('zh-CN')
    expect(tn('tracks.notes', 1, { channel: 3 })).toBe(
      zhCN['tracks.notes.other'].replace('{channel}', '3').replace('{count}', '1'),
    )
  })
})

describe('ja locale', () => {
  it('dynamically loads the chunk and serves translated strings', async () => {
    await setLocale('ja')
    expect(locale.value).toBe('ja')
    expect(t('home.cta.openMidi')).toBe(ja['home.cta.openMidi'])
    expect(t('home.cta.openMidi')).not.toBe(en['home.cta.openMidi'])
  })

  it('uses the .other plural form for every count (Japanese has no singular)', async () => {
    // Intl.PluralRules('ja') only ever returns "other" — same shape as zh-CN.
    await setLocale('ja')
    expect(tn('tracks.notes', 1, { channel: 3 })).toBe(
      ja['tracks.notes.other'].replace('{channel}', '3').replace('{count}', '1'),
    )
  })
})

describe('pl locale (one/few/many plurals)', () => {
  // Polish needs four plural forms; en ships only one/other, so pl.ts carries
  // extra .few/.many keys. tn() must pick the right one per count — if a form
  // were dropped, t() would fall through to the literal key string.
  it('selects one / few / many by count', async () => {
    await setLocale('pl')
    // 1 → one, 2–4 → few, 5+ → many (Intl.PluralRules categories for pl).
    expect(tn('tracks.notes', 1, { channel: 2 })).toBe('kan. 2 · 1 nuta')
    expect(tn('tracks.notes', 3, { channel: 2 })).toBe('kan. 2 · 3 nuty')
    expect(tn('tracks.notes', 7, { channel: 2 })).toBe('kan. 2 · 7 nut')
    // Each resolved form is a real key, never the literal "tracks.notes.few".
    expect(tn('tracks.notes', 3, { channel: 2 })).not.toContain('tracks.notes')
  })

  it('ships every plural form the extra-key type promises', () => {
    expect(pl['tracks.notes.few']).toBeTruthy()
    expect(pl['tracks.notes.many']).toBeTruthy()
    expect(pl['postSession.stats.few']).toBeTruthy()
    expect(pl['postSession.stats.many']).toBeTruthy()
  })
})
