/**
 * Ramp-up (warm-up) loads for loaded lifts.
 *
 * Rules:
 * - Every warm-up load is strictly lighter than the working load. When no lighter feasible load
 *   exists (e.g. a barbell working load at or below the empty bar), fewer or no loaded warm-ups are made.
 * - Barbell warm-ups are feasible bar settings: bar + whole increments (bar 20 kg / 45 lb unless the user
 *   set another bar), rounded DOWN so they never exceed the target percentage.
 * - Loads are computed on the user's display-unit grid and stored as exact kg plus the entered value,
 *   so the physical load is preserved when the display unit later changes (lb ↔ kg).
 */
import type { EnteredValue, Exercise, Settings, WeightUnit } from './types';
import { fromKg, round, toKg } from './units';

export interface WarmupSet {
  weightKg: number;
  entered: EnteredValue;
  reps: number;
}

export const DEFAULT_BAR = { kg: 20, lb: 45 } as const;

export function isBarbell(ex: Pick<Exercise, 'equipment'>): boolean {
  return ex.equipment.includes('barbell');
}

/** Empty-bar weight in the display unit (0 for non-barbell exercises). */
export function barWeight(ex: Pick<Exercise, 'equipment'>, unit: WeightUnit, settings?: Pick<Settings, 'workout'>): number {
  if (!isBarbell(ex)) return 0;
  const custom = unit === 'kg' ? settings?.workout?.barKg : settings?.workout?.barLb;
  return typeof custom === 'number' && Number.isFinite(custom) && custom >= 0 ? custom : DEFAULT_BAR[unit];
}

const EPS = 1e-6;

/**
 * Warm-up sets before a working load.
 * @param workingKg working load in kg
 * @param count     number of warm-up sets wanted (1 or 2)
 * @param inc       smallest load step in the display unit (e.g. 2.5 kg / 5 lb)
 */
export function warmupSets(workingKg: number, ex: Pick<Exercise, 'equipment'>, count: number, unit: WeightUnit, inc: number, settings?: Pick<Settings, 'workout'>): WarmupSet[] {
  if (!(workingKg > 0) || !Number.isFinite(workingKg) || count <= 0) return [];
  const step = inc > 0 ? inc : unit === 'kg' ? 2.5 : 5;
  const W = round(fromKg(workingKg, unit), 3);
  const bar = barWeight(ex, unit, settings);
  const pcts = count >= 2 ? [0.5, 0.75] : [0.5];
  const reps = count >= 2 ? [8, 4] : [8];
  const out: WarmupSet[] = [];
  pcts.forEach((p, i) => {
    const target = W * p;
    let v: number;
    if (bar > 0) v = target <= bar ? bar : bar + Math.floor((target - bar) / step + EPS) * step;
    else v = Math.floor(target / step + EPS) * step;
    v = round(v, 3);
    if (!(v > 0) || v >= W - EPS) return; // never at or above the working load
    if (out.some((o) => Math.abs(o.entered.value - v) < EPS)) return;
    out.push({ weightKg: toKg(v, unit), entered: { value: v, unit }, reps: reps[i] });
  });
  return out;
}
