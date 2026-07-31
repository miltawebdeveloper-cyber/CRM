import { getUserLanguage, type Language } from './display-settings';
import en from '../locales/en.json';

/**
 * Interface translation.
 *
 * Hand-rolled rather than pulling in i18next, for the same reason the OpenPhone
 * and Groq clients use plain `fetch`: this needs lookup, interpolation and
 * plurals, and that is about sixty lines. The locale files are flat key/value
 * JSON — the exact shape i18next consumes — so if this ever needs namespaces,
 * lazy loading or a translation-management integration, the files move across
 * untouched and only this module is replaced.
 *
 * ── Adding a language ──
 *  1. Copy `locales/en.json` to `locales/<code>.json` and translate the VALUES.
 *     Leave the keys alone; they are what the code looks up.
 *  2. Register it in `LANGUAGES` (lib/display-settings.ts) with `ready: true`.
 *  3. Import it into `BUNDLES` below.
 *
 * A key with no translation falls back to English rather than rendering the raw
 * key. A half-translated language should look unfinished, not broken — and an
 * `app.nav.leads` leaking into the sidebar is broken.
 */

export type Messages = Record<string, string>;

/**
 * English is the source of truth: every key exists here, and `t()` falls back to
 * it. The other locales are absent until their files exist — see `LANGUAGES`,
 * where they stay unselectable until then.
 */
const BUNDLES: Partial<Record<Language, Messages>> = {
  en: en as Messages,
};

/** Keys in English, for the coverage check below and for tooling. */
export const messageKeys = Object.keys(en as Messages);

/**
 * Translate a key, with optional `{placeholder}` interpolation.
 *
 *   t('settings.timezone.saved', { zone: 'US — Eastern' })
 *
 * Deliberately takes the default text from the English bundle rather than a
 * second argument. One place holds the English wording, so a string cannot be
 * changed in the UI and silently left stale in the locale files.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const lang = getUserLanguage();
  const bundle = BUNDLES[lang];
  const template = bundle?.[key] ?? BUNDLES.en?.[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * Plural-aware lookup. Expects sibling keys suffixed with a CLDR plural
 * category — `.one`, `.other`, and whichever else the language needs:
 *
 *   "leads.count.one":   "{count} lead"
 *   "leads.count.other": "{count} leads"
 *
 * `Intl.PluralRules` picks the category, so a language with more than two forms
 * (Tamil, Arabic, Polish) is handled by adding keys, not by changing code. An
 * `n === 1 ? x : y` at each call site cannot express that.
 */
export function tPlural(baseKey: string, count: number, vars?: Record<string, string | number>): string {
  const lang = getUserLanguage();
  let category = 'other';
  try {
    category = new Intl.PluralRules(lang).select(count);
  } catch {
    category = count === 1 ? 'one' : 'other';
  }
  const bundle = BUNDLES[lang] ?? BUNDLES.en ?? {};
  const key = bundle[`${baseKey}.${category}`] ? `${baseKey}.${category}` : `${baseKey}.other`;
  return t(key, { count, ...vars });
}

/**
 * Which keys a locale is missing, against English.
 *
 * Exported so a translation can be checked before it is marked `ready`, rather
 * than the gap being discovered by a user meeting an English string in the
 * middle of their own language.
 */
export function missingKeys(lang: Language): string[] {
  const bundle = BUNDLES[lang];
  if (!bundle) return messageKeys;
  return messageKeys.filter((k) => !bundle[k]);
}

/** Translation completeness, 0–100. Shown beside each language in Settings. */
export function coverage(lang: Language): number {
  if (!messageKeys.length) return 100;
  return Math.round(((messageKeys.length - missingKeys(lang).length) / messageKeys.length) * 100);
}
