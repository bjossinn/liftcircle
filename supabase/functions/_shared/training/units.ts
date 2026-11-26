/**
 * SHARED by the app (src/domain/units.ts re-exports these) and the ai-coach function: weight conversion and display.
 * Pure; no Deno / npm imports.
 */
import type { EnteredValue, WeightUnit } from './types.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { numberText, type Language } from '../i18n/core.ts';

/** Exact definition (international avoirdupois pound). */
export const KG_PER_LB = 0.45359237;

export const lbToKg = (lb: number) => lb * KG_PER_LB;
export const kgToLb = (kg: number) => kg / KG_PER_LB;

/** Round to a fixed number of decimals without binary-float noise. */
export function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Convert a value the user typed into canonical kilograms (kept at full precision). */
export function toKg(value: number, unit: WeightUnit): number {
  return unit === 'kg' ? value : lbToKg(value);
}
export function fromKg(kg: number, unit: WeightUnit): number {
  return unit === 'kg' ? kg : kgToLb(kg);
}

/**
 * Display a load. If the user originally entered it in the display unit we show
 * exactly what they typed (preserves 45 lb plates, 2.5 kg jumps, etc.).
 */
export function displayWeight(kg: number | null | undefined, unit: WeightUnit, entered?: EnteredValue, decimals = 1): number | null {
  if (kg == null) return null;
  if (entered && entered.unit === unit) return entered.value;
  return round(fromKg(kg, unit), decimals);
}
/**
 * "62.5 kg" / "62,5 kg" (lang 'is'). Display only: the language changes the decimal separator, never the value, the
 * unit or the rounding. English (the default, and every server caller) is unchanged.
 */
export function formatWeight(kg: number | null | undefined, unit: WeightUnit, entered?: EnteredValue, lang: Language = 'en'): string {
  const v = displayWeight(kg, unit, entered);
  if (v == null) return '–';
  return lang === 'en' ? `${trimNum(v)} ${unit}` : `${numberText(round(v, 2), lang)} ${unit}`;
}
export function trimNum(n: number, decimals = 2): string {
  return String(round(n, decimals));
}
