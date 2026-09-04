// Tiny i18n runtime. Public surface is three functions — `t`, `tn`, and
// `setLocale` — plus a reactive `locale` Signal for UI that needs to re-render
// on change. Everything else (number/date formatting) delegates to native
// `Intl` with the current locale.
//
// Shape:
//   · Source of truth is `locales/en.ts`. All keys must exist there.
//   · Other locales (`fr`, `es`, `pt-BR`, `zh-CN`, `ja`, `pl`) are lazy-loaded on demand so
//     the main bundle only ships English.
//   · `t(key, { var })` — straight string lookup with `{var}` interpolation.
//   · `tn(base, count, { var })` — plural via `Intl.PluralRules`. Looks up
//     `${base}.${category}` where category ∈ {zero|one|two|few|many|other}.
//   · On locale load, dev builds warn if the loaded locale is missing keys.
//   · Fallback chain: current → en → the key itself (so missing translations
//     never break the UI, they just show the key).

import { batch, createSignal } from 'solid-js'
import { createEventSignal } from '../store/eventSignal'
import { en, type MessageKey, type Messages } from './locales/en'

export type { MessageKey, Messages } from './locales/en'

// Add a new locale here, in `LOCALES`, and create the corresponding file
// under `locales/`. TypeScript will then enforce key parity via `Messages`.
export const SUPPORTED_LOCALES = ['en', 'fr', 'es', 'pt-BR', 'zh-CN', 'ja', 'pl'] as const
export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]

// Native-language label used in the locale picker — users recognise their
// own language written in it.
export const LOCALES: Array<{ code: LocaleCode; nativeName: string }> = [
  { code: 'en', nativeName: 'English' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'es', nativeName: 'Español' },
  { code: 'pt-BR', nativeName: 'Português (BR)' },
  { code: 'zh-CN', nativeName: '简体中文' },
  { code: 'ja', nativeName: '日本語' },
  { code: 'pl', nativeName: 'Polski' },
]

const SUPPORTED_SET = new Set<string>(SUPPORTED_LOCALES)
const STORAGE_KEY = 'midee.locale'

// Explicit loader map (not import.meta.glob) so Vite can code-split each
// locale into its own async chunk and the types remain concrete.
const LOADERS: Record<Exclude<LocaleCode, 'en'>, () => Promise<{ default: Messages }>> = {
  fr: () => import('./locales/fr'),
  es: () => import('./locales/es'),
  'pt-BR': () => import('./locales/pt-BR'),
  'zh-CN': () => import('./locales/zh-CN'),
  ja: () => import('./locales/ja'),
  pl: () => import('./locales/pl'),
}

// Messages are the reactive dependency for `t()`. Any JSX (or effect) that
// reads `t(...)` re-runs on locale flip because it reads `messages()`.
// `locale` is a plain event signal — its value is the *identity* of the locale,
// while `messages()` is what drives UI reactivity (flips after the async load
// resolves, so the whole app swaps to the new strings in one paint).
const [messages, setMessages] = createSignal<Messages>(en)
export const locale = createEventSignal<LocaleCode>('en')

// ── Core formatters ──────────────────────────────────────────────

function interpolate(raw: string, params?: Record<string, string | number>): string {
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, k) => {
    const v = params[k]
    return v === undefined ? `{${k}}` : String(v)
  })
}

// Type-safe lookup. Invalid keys are a compile error. Reactive: inside a
// tracking scope (JSX body, createEffect, createMemo) `t()` re-runs on
// locale flip because it reads the messages signal.
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const raw = messages()[key] ?? en[key] ?? key
  return interpolate(raw, params)
}

// Plural-aware lookup. Key pattern: `${base}.${plural-category}`.
//
// Usage:
//   tn('tracks.visible', 3)  // → "3 tracks visible"
//
// Requires at least `${base}.one` and `${base}.other` in every locale.
// Some languages need more forms (Polish has .few and .many; Arabic has .zero,
// .two, .few, .many, .other). Translators add the extras they need; English
// and Romance languages stay with one/other.
const pluralRuleCache = new Map<string, Intl.PluralRules>()
export function tn(base: string, count: number, params?: Record<string, string | number>): string {
  const loc = locale.value
  let rules = pluralRuleCache.get(loc)
  if (!rules) {
    rules = new Intl.PluralRules(loc)
    pluralRuleCache.set(loc, rules)
  }
  const category = rules.select(count)
  const key = `${base}.${category}` as MessageKey
  return t(key, { count, ...params })
}

// ── Native Intl passthroughs ─────────────────────────────────────
// Re-exported so call sites don't have to read `locale.value` directly.

export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale.value, options).format(n)
}

export function formatDate(d: Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale.value, options).format(d)
}

// ── Lifecycle ────────────────────────────────────────────────────

// Exported for unit testing — the locale-negotiation logic (region → base
// language, `zh-*` → `zh-CN`) is pure and is where regressions slip in.
export function resolveLocale(tag: string | null | undefined): LocaleCode | null {
  if (!tag) return null
  if (SUPPORTED_SET.has(tag)) return tag as LocaleCode
  // Fall back from region-specific tag to base language (e.g. "fr-CA" → "fr")
  const base = tag.split('-')[0]
  if (base === 'zh') return 'zh-CN'
  if (base && SUPPORTED_SET.has(base)) return base as LocaleCode
  return null
}

// Priority: ?lang= URL param → localStorage → navigator.language → 'en'.
// The URL param wins so shareable locale-specific links work for testing
// and marketing without touching user preference.
function detectInitialLocale(): LocaleCode {
  if (typeof window === 'undefined') return 'en'
  try {
    const fromUrl = new URL(window.location.href).searchParams.get('lang')
    const resolved = resolveLocale(fromUrl)
    if (resolved) return resolved
  } catch {}
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    const resolved = resolveLocale(stored)
    if (resolved) return resolved
  } catch {}
  const browser = typeof navigator !== 'undefined' ? navigator.language : null
  const resolved = resolveLocale(browser)
  if (resolved) return resolved
  return 'en'
}

async function loadLocale(code: LocaleCode): Promise<void> {
  if (code === 'en') {
    batch(() => {
      setMessages(en)
      locale.set('en')
    })
    return
  }
  try {
    const mod = await LOADERS[code]()
    batch(() => {
      setMessages(mod.default)
      locale.set(code)
    })
    if (import.meta.env.DEV) {
      for (const k of Object.keys(en) as MessageKey[]) {
        if (!(k in mod.default)) console.warn(`[i18n] ${code} missing key: ${k}`)
      }
    }
  } catch (err) {
    console.warn(`[i18n] locale ${code} failed to load; staying on en`, err)
    batch(() => {
      setMessages(en)
      locale.set('en')
    })
  }
}

// Call once at boot, before constructing UI, so the first paint is already
// localised. Adds ~5–15ms for the dynamic locale-module fetch on non-English.
export async function initI18n(): Promise<void> {
  const code = detectInitialLocale()
  await loadLocale(code)
  if (typeof document !== 'undefined') {
    document.documentElement.lang = code
  }
}

// Explicit user choice — persists to localStorage and updates <html lang>
// for CSS `:lang()` / screen readers / SEO hreflang consistency.
export async function setLocale(code: LocaleCode): Promise<void> {
  if (code === locale.value) return
  await loadLocale(code)
  try {
    localStorage.setItem(STORAGE_KEY, code)
  } catch {}
  if (typeof document !== 'undefined') {
    document.documentElement.lang = code
  }
}

// Returns true exactly once — when (a) the user has never explicitly
// picked a locale (no localStorage entry) AND (b) the auto-detected
// locale is non-English. Caller uses this to show a subtle one-time
// onboarding hint pointing at the locale picker. Idempotent: marks the
// flag immediately so a refresh doesn't re-trigger.
const HINT_SHOWN_KEY = 'midee.localeHintShown'
export function shouldShowLocaleHint(): boolean {
  if (typeof window === 'undefined') return false
  if (locale.value === 'en') return false
  try {
    if (localStorage.getItem(STORAGE_KEY)) return false // user already picked
    if (localStorage.getItem(HINT_SHOWN_KEY)) return false // already shown once
    localStorage.setItem(HINT_SHOWN_KEY, '1')
    return true
  } catch {
    return false
  }
}

// Native-language label for the current locale — used in the hint copy.
export function currentLocaleNativeName(): string {
  return LOCALES.find((l) => l.code === locale.value)?.nativeName ?? locale.value
}
