import type { DistanceUnit, LengthUnit } from './types';

// Weight conversion and display are shared with the ai-coach function (one implementation for both).
export { KG_PER_LB, lbToKg, kgToLb, round, toKg, fromKg, displayWeight, formatWeight, trimNum } from '../../supabase/functions/_shared/training/units';
import { round } from '../../supabase/functions/_shared/training/units';

/** Exact definitions (international inch and mile). */
export const CM_PER_IN = 2.54;
export const M_PER_MI = 1609.344;

export const inToCm = (inch: number) => inch * CM_PER_IN;
export const cmToIn = (cm: number) => cm / CM_PER_IN;
export const miToM = (mi: number) => mi * M_PER_MI;
export const mToMi = (m: number) => m / M_PER_MI;

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
