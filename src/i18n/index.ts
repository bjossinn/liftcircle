/**
 * App localization (roadmap item 8). English and Icelandic dictionaries with identical keys; the Icelandic copy is
 * the approved translation package, wired verbatim.
 *
 * - The current language comes from the account's `Settings.language` (AppProvider calls setLanguage before its
 *   children render). Before an account has loaded (error boundary, first paint) the last used language on this
 *   device is used, then English.
 * - React components call `useT()` so they re-render when the language changes. Non-React modules (domain
 *   formatters, toasts, error mapping) call `t()` / `tp()`, which read the current language.
 * - Missing keys: a test/development failure (throws); production falls back to English, never a blank or the key.
 * - Format numbers/dates before interpolating (number params are formatted automatically). Never parse a localized
 *   string back into a value, and never store translated display text as canonical data.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';
import {
  countCategory as coreCountCategory,
  effectiveLanguage,
  interpolate as coreInterpolate,
  isLanguage,
  listText as coreListText,
  localeFor,
  makeTranslator,
  numberText as coreNumberText,
  SHARED_EN,
  SHARED_IS,
  type Dict,
  type Language,
  type Params,
  type Translator,
} from '../../supabase/functions/_shared/i18n/core';
import { CLIENT_EN } from './locales/en';
import { CLIENT_IS } from './locales/is';

export type { Language, Params };
export { effectiveLanguage, isLanguage, localeFor };

export const EN = { ...SHARED_EN, ...CLIENT_EN } as const;
export type MessageKey = keyof typeof EN;
export const IS: { readonly [K in MessageKey]: string } = { ...SHARED_IS, ...CLIENT_IS };

/** Plural families: the base of every `<base>.one` / `<base>.other` pair. */
type PluralBase<K> = K extends `${infer B}.other` ? B : never;
export type PluralKey = PluralBase<MessageKey>;

const STRICT = (() => {
  try {
    return import.meta.env?.MODE === 'test' || Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
})();
const onMissing = (key: string) => {
  if (STRICT) throw new Error(`Missing translation key: ${key}`);
};

const LANG_KEY = 'lc-lang';
function readDeviceLanguage(): Language {
  try {
    return effectiveLanguage(localStorage.getItem(LANG_KEY));
  } catch {
    return 'en';
  }
}

let current: Language = readDeviceLanguage();
const translators: Record<Language, Translator<MessageKey>> = {
  en: makeTranslator<MessageKey>('en', EN as Dict, IS as Dict, onMissing),
  is: makeTranslator<MessageKey>('is', EN as Dict, IS as Dict, onMissing),
};

/** The language used by `t()` and the formatters. */
export function getLanguage(): Language {
  return current;
}
/** Sets the current language (AppProvider, from the account's settings) and remembers it on this device. */
export function setLanguage(language: unknown): void {
  const next = effectiveLanguage(language);
  if (typeof document !== 'undefined' && document.documentElement.lang !== next) document.documentElement.lang = next;
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    /* ignore */
  }
}

/** Message for `key` in the current (or given) language. */
export function t(key: MessageKey, params?: Params, language: Language = current): string {
  return translators[language].t(key, params);
}
/** Count variant (`.one` / `.other` by Intl.PluralRules) of `base`; `count` is available as {{count}}. */
export function tp(base: PluralKey, count: number, params?: Params, language: Language = current): string {
  return translators[language].tp(base, count, params);
}
/** For keys built from enum values (`program.activity.${kind}`): true when it exists. */
export function hasKey(key: string): key is MessageKey {
  return key in EN;
}
/** Looks up a dynamic key; falls back to `fallback` (e.g. stored text) when no such key exists. */
export function tKey(key: string, fallback: string, params?: Params, language: Language = current): string {
  return hasKey(key) ? t(key, params, language) : fallback;
}

/* ------------------------------------------------------------ formatting */
export const locale = (language: Language = current) => localeFor(language);
export const numberText = (value: number, maxDecimals = 2, grouping = false, language: Language = current) =>
  coreNumberText(value, language, maxDecimals, grouping);
/** "61,25 kg" / "135 lb". The value is already in the display unit; language never converts units. */
export function loadText(valueInDisplayUnit: number | null | undefined, unit: string, language: Language = current): string {
  return valueInDisplayUnit == null ? '–' : `${coreNumberText(valueInDisplayUnit, language, 2)} ${unit}`;
}
export const countCategory = (count: number, language: Language = current) => coreCountCategory(count, language);
export const listText = (items: readonly string[], language: Language = current, type: 'conjunction' | 'disjunction' = 'conjunction') =>
  coreListText(items, language, type);
export const interpolate = (template: string, values?: Params, language: Language = current) => coreInterpolate(template, values, language);

/** Numeric input (ungrouped): accepts "62,5" and "62.5" and a sign; rejects grouped/mixed "1.234,5". */
export function decimalInput(text: string): { kind: 'empty' } | { kind: 'invalid' } | { kind: 'valid'; value: number } {
  const s = text.trim();
  if (!s) return { kind: 'empty' };
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(s)) return { kind: 'invalid' };
  const value = Number(s.replace(',', '.'));
  return Number.isFinite(value) ? { kind: 'valid', value } : { kind: 'invalid' };
}

/** Calendar date (YYYY-MM-DD) → Date at UTC midnight; throws on an invalid date. */
export function dateOnly(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new RangeError('Invalid ISO calendar date');
  const d = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new RangeError('Invalid ISO calendar date');
  return d;
}
/** A calendar date stays that date in every device time zone: "26. nóvember 2026" / "26 November 2026". */
export function calendarDateText(
  iso: string,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' },
  language: Language = current,
): string {
  return new Intl.DateTimeFormat(localeFor(language), { ...options, timeZone: 'UTC' }).format(dateOnly(iso));
}
/** 24-hour clock time of an instant in the account's time zone: "00:05". */
export function clockText(epochMs: number, timeZone?: string, language: Language = current): string {
  return new Intl.DateTimeFormat(localeFor(language), { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(epochMs);
}
/** Date and time of an instant in the account's time zone (24-hour clock). */
export function dateTimeText(
  epochMs: number,
  timeZone?: string,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' },
  language: Language = current,
): string {
  return new Intl.DateTimeFormat(localeFor(language), { ...options, timeZone, hourCycle: 'h23' }).format(epochMs);
}

/* ----------------------------------------------------------------- React */
const LangCtx = createContext<Language | null>(null);

/** Provides the language to `useT()`; AppProvider renders it with the account's language. */
export function LanguageProvider({ language, children }: { language: Language; children: ReactNode }) {
  setLanguage(language);
  return createElement(LangCtx.Provider, { value: language }, children);
}

export interface UseT {
  language: Language;
  locale: string;
  t: (key: MessageKey, params?: Params) => string;
  tp: (base: PluralKey, count: number, params?: Params) => string;
}

/** Translator bound to the current language; components re-render when it changes. */
export function useT(): UseT {
  const language = useContext(LangCtx) ?? current;
  const tr = translators[language];
  return { language, locale: localeFor(language), t: tr.t, tp: tr.tp as UseT['tp'] };
}
