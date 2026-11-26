import type { DistanceUnit, LengthUnit, UnitPrefs } from './types';

// Weight conversion and display are shared with the ai-coach function (one implementation for both).
export { KG_PER_LB, lbToKg, kgToLb, round, toKg, fromKg, displayWeight, formatWeight, trimNum } from '../../supabase/functions/_shared/training/units';
import { round } from '../../supabase/functions/_shared/training/units';
import { getLanguage, numberText, type Language } from '@/i18n';

/** Exact definitions (international inch and mile). */
export const CM_PER_IN = 2.54;
export const M_PER_MI = 1609.344;

export const inToCm = (inch: number) => inch * CM_PER_IN;
export const cmToIn = (cm: number) => cm / CM_PER_IN;
export const miToM = (mi: number) => mi * M_PER_MI;
export const mToMi = (m: number) => m / M_PER_MI;

/* -------------------------------------------------------------- locale */
/** Regions that use pounds, feet/inches and miles day to day (US, Liberia, Myanmar). Everywhere else: kg, cm, km. */
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

/** The region of a BCP 47 tag ("en-US" → "US"), via Intl.Locale when available. Undefined when there is none. */
export function localeRegion(locale: string | undefined | null): string | undefined {
  if (!locale || typeof locale !== 'string') return undefined;
  try {
    const r = new Intl.Locale(locale.replace(/_/g, '-')).region;
    if (r) return r.toUpperCase();
  } catch {
    /* fall back to parsing below */
  }
  const m = /^[a-z]{2,3}(?:[-_][A-Za-z]{4})?[-_]([A-Za-z]{2}|\d{3})\b/i.exec(locale);
  return m ? m[1].toUpperCase() : undefined;
}

/**
 * Default units for a device locale: en-US (and other imperial regions) → lb / ft-in / mi, everything else → kg / cm / km.
 * Only used as a starting point for new users; units can be changed any time in Settings.
 */
export function unitsForLocale(locale: string | undefined | null): UnitPrefs {
  const region = localeRegion(locale);
  return region && IMPERIAL_REGIONS.has(region) ? { weight: 'lb', length: 'ftin', distance: 'mi' } : { weight: 'kg', length: 'cm', distance: 'km' };
}

/** The device's preferred locale (navigator.language, then Intl), or undefined outside a browser. */
export function deviceLocale(): string | undefined {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    return nav?.languages?.[0] || nav?.language || Intl.DateTimeFormat().resolvedOptions().locale || undefined;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------- length */
export function cmToFtIn(cm: number): { ft: number; inch: number } {
  const totalIn = cmToIn(cm);
  let ft = Math.floor(totalIn / 12);
  let inch = round(totalIn - ft * 12, 1);
  if (inch >= 12) {
    ft += 1;
    inch = 0;
  }
  return { ft, inch };
}
export function ftInToCm(ft: number, inch: number): number {
  return inToCm(ft * 12 + inch);
}
export function formatLength(cm: number | undefined, unit: LengthUnit, language: Language = getLanguage()): string {
  if (cm == null) return '–';
  if (unit === 'cm') return `${numberText(round(cm, 1), 1, false, language)} cm`;
  const { ft, inch } = cmToFtIn(cm);
  return `${ft}′ ${numberText(inch, 1, false, language)}″`;
}
/** Circumference measurements in imperial are shown in inches. */
export function formatCircumference(cm: number, unit: LengthUnit, language: Language = getLanguage()): string {
  return unit === 'cm' ? `${numberText(round(cm, 1), 1, false, language)} cm` : `${numberText(round(cmToIn(cm), 1), 1, false, language)} in`;
}

/* ------------------------------------------------------------ distance */
export function toMeters(value: number, unit: DistanceUnit): number {
  return unit === 'km' ? value * 1000 : miToM(value);
}
export function fromMeters(m: number, unit: DistanceUnit): number {
  return unit === 'km' ? m / 1000 : mToMi(m);
}
/** "10.25 km" (en) / "10,25 km" (is): same rounding, unit unchanged; only the decimal separator follows the language. */
export function formatDistance(m: number | undefined, unit: DistanceUnit, decimals = 2, language: Language = getLanguage()): string {
  if (m == null) return '–';
  return `${numberText(round(fromMeters(m, unit), decimals), decimals, false, language)} ${unit}`;
}

/** Pace in seconds per km or per mile. Returns null when not computable. */
export function paceSecPer(distanceM: number | undefined, durationSec: number | undefined, unit: DistanceUnit): number | null {
  if (!distanceM || !durationSec || distanceM <= 0 || durationSec <= 0) return null;
  return durationSec / fromMeters(distanceM, unit);
}
export function formatPace(secPerUnit: number | null, unit: DistanceUnit): string {
  if (secPerUnit == null || !isFinite(secPerUnit)) return '–';
  let m = Math.floor(secPerUnit / 60);
  let s = Math.round(secPerUnit - m * 60);
  if (s === 60) {
    m += 1;
    s = 0;
  }
  return `${m}:${String(s).padStart(2, '0')} /${unit}`;
}
/** Speed in km/h or mph. */
export function speedPerHour(distanceM: number | undefined, durationSec: number | undefined, unit: DistanceUnit): number | null {
  if (!distanceM || !durationSec || durationSec <= 0) return null;
  return fromMeters(distanceM, unit) / (durationSec / 3600);
}
/** "20.5 km/h" (en) / "20,5 km/h" (is), one decimal; the unit (km/h, mph) is unchanged. */
export function formatSpeed(perHour: number | null | undefined, unit: DistanceUnit, language: Language = getLanguage()): string {
  if (perHour == null || !isFinite(perHour)) return '–';
  return `${numberText(round(perHour, 1), 1, false, language)} ${unit === 'km' ? 'km/h' : 'mph'}`;
}
