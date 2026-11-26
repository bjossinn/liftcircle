/**
 * Localization core shared by the app (src/i18n) and the Edge Functions (pure, dependency-free, Deno-safe).
 *
 * - Languages: 'en' | 'is'. Anything else normalizes to 'en' (old accounts, unknown future values).
 * - Messages are flat keys with {{placeholders}}. Number placeholders are formatted with the language's locale
 *   before interpolation (62.5 → "62,5" in Icelandic); strings are inserted unchanged (names, notes, catalog data).
 * - Count variants are `<key>.one` / `<key>.other`, chosen with Intl.PluralRules for the locale (Icelandic: 1, 21,
 *   31, 101 → one; 0, 2, 11, 111 → other), never `count === 1`.
 * - Display only: never parse a formatted value back, and never persist it as a canonical record.
 */
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { SHARED_EN } from './messages.en.ts';
// @ts-ignore see above
import { SHARED_IS } from './messages.is.ts';

export type Language = 'en' | 'is';
export type Params = Record<string, string | number>;
export type SharedKey = keyof typeof SHARED_EN;

export const LANGUAGES: readonly Language[] = ['en', 'is'];
export const localeFor = (language: Language): string => (language === 'is' ? 'is-IS' : 'en-GB');
/** Validated language: only 'is' selects Icelandic; missing/unknown values fall back to English. */
export const effectiveLanguage = (value: unknown): Language => (value === 'is' ? 'is' : 'en');
export const isLanguage = (value: unknown): value is Language => value === 'en' || value === 'is';

const nfCache = new Map<string, Intl.NumberFormat>();
/** 62.5 → "62,5" (is) / "62.5" (en). Up to `maxDecimals` (default 2) and no grouping unless asked. */
export function numberText(value: number, language: Language, maxDecimals = 2, grouping = false): string {
  if (!Number.isFinite(value)) return '–';
  const k = `${language}|${maxDecimals}|${grouping}`;
  let nf = nfCache.get(k);
  if (!nf) {
    nf = new Intl.NumberFormat(localeFor(language), { maximumFractionDigits: maxDecimals, useGrouping: grouping });
    nfCache.set(k, nf);
  }
  return nf.format(Object.is(value, -0) ? 0 : value);
}

const prCache = new Map<Language, Intl.PluralRules>();
export function countCategory(count: number, language: Language): Intl.LDMLPluralRule {
  let pr = prCache.get(language);
  if (!pr) {
    pr = new Intl.PluralRules(localeFor(language));
    prCache.set(language, pr);
  }
  return pr.select(count);
}

/** "A og B" / "A, B and C" (Intl.ListFormat; never a spliced English "and"). */
export function listText(items: readonly string[], language: Language, type: 'conjunction' | 'disjunction' = 'conjunction'): string {
  return new Intl.ListFormat(localeFor(language), { style: 'long', type }).format(items);
}

const PH = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
/** Fills {{name}} placeholders. Numbers are locale-formatted; a missing value throws (a bug, not user data). */
export function interpolate(template: string, values: Params = {}, language: Language = 'en'): string {
  return template.replace(PH, (_, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`Missing interpolation value: ${key}`);
    const v = values[key];
    return typeof v === 'number' ? numberText(v, language) : String(v);
  });
}

export type Dict = Readonly<Record<string, string>>;
export interface Translator<K extends string> {
  language: Language;
  /** The message for `key`, with placeholders filled. */
  t: (key: K, params?: Params) => string;
  /** The `.one`/`.other` variant of `base` for `count` (count is also available as {{count}}). */
  tp: (base: string, count: number, params?: Params) => string;
  /** True when the key exists (for dynamic keys built from enum values). */
  has: (key: string) => boolean;
}

/**
 * Builds a translator over a pair of dictionaries. A key missing from the chosen language falls back to English;
 * a key missing from both calls `onMissing` (tests/dev throw) and finally returns the English base text or '' —
 * never the key itself.
 */
export function makeTranslator<K extends string>(
  language: Language,
  en: Dict,
  is: Dict,
  onMissing?: (key: string) => void,
): Translator<K> {
  const dict = language === 'is' ? is : en;
  const lookup = (key: string): string => {
    const v = dict[key] ?? en[key];
    if (v === undefined || (language === 'is' && dict[key] === undefined)) onMissing?.(key);
    return v ?? '';
  };
  const t = (key: K, params?: Params) => interpolate(lookup(key), params, language);
  const tp = (base: string, count: number, params?: Params) => {
    const cat = countCategory(count, language);
    const key = `${base}.${cat}` in dict ? `${base}.${cat}` : `${base}.other`;
    return interpolate(lookup(key), { count, ...params }, language);
  };
  const has = (key: string) => key in dict || key in en;
  return { language, t, tp, has };
}

/** Translator for the server-shared namespaces (aiServer.*, progression.*, workout.validation.*, aiCard sides/meals). */
export function sharedT(language: Language, onMissing?: (key: string) => void): Translator<SharedKey> {
  return makeTranslator<SharedKey>(language, SHARED_EN as Dict, SHARED_IS as Dict, onMissing);
}

export { SHARED_EN, SHARED_IS };
