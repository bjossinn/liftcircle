import type { DistanceUnit, EnteredValue, LengthUnit, WeightUnit } from './types';

/** Exact definitions (international avoirdupois pound / international inch and mile). */
export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;
export const M_PER_MI = 1609.344;

export const lbToKg = (lb: number) => lb * KG_PER_LB;
export const kgToLb = (kg: number) => kg / KG_PER_LB;
export const inToCm = (inch: number) => inch * CM_PER_IN;
export const cmToIn = (cm: number) => cm / CM_PER_IN;
export const miToM = (mi: number) => mi * M_PER_MI;
export const mToMi = (m: number) => m / M_PER_MI;

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
export function formatWeight(kg: number | null | undefined, unit: WeightUnit, entered?: EnteredValue): string {
  const v = displayWeight(kg, unit, entered);
  return v == null ? '–' : `${trimNum(v)} ${unit}`;
}
export function trimNum(n: number, decimals = 2): string {
  return String(round(n, decimals));
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
export function formatLength(cm: number | undefined, unit: LengthUnit): string {
  if (cm == null) return '–';
  if (unit === 'cm') return `${round(cm, 1)} cm`;
  const { ft, inch } = cmToFtIn(cm);
  return `${ft}′ ${inch}″`;
}
/** Circumference measurements in imperial are shown in inches. */
export function formatCircumference(cm: number, unit: LengthUnit): string {
  return unit === 'cm' ? `${round(cm, 1)} cm` : `${round(cmToIn(cm), 1)} in`;
}

/* ------------------------------------------------------------ distance */
export function toMeters(value: number, unit: DistanceUnit): number {
  return unit === 'km' ? value * 1000 : miToM(value);
}
export function fromMeters(m: number, unit: DistanceUnit): number {
  return unit === 'km' ? m / 1000 : mToMi(m);
}
export function formatDistance(m: number | undefined, unit: DistanceUnit, decimals = 2): string {
  if (m == null) return '–';
  return `${round(fromMeters(m, unit), decimals)} ${unit}`;
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
