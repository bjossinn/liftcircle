/**
 * Double progression and related adaptation rules. Pure functions: suggestions are computed from
 * completed, comparable history and are never written into logged results.
 *
 * Loaded lifts: when every prescribed working set reaches the top of the rep range at the intended
 * effort in two comparable sessions, suggest the smallest practical load increase and aim for the
 * bottom of the range. Otherwise hold the load and build reps / consistency.
 * Bodyweight → reps, then a harder variation or added load. Assisted → less assistance.
 * Timed holds → longer. Cardio-style distance/time → a little more time or distance.
 * Three comparable sessions trending down → suggest reviewing recovery. A discomfort flag in the
 * recent comparable sessions suppresses any increase and points at alternatives.
 */
import type { Exercise, ID, LoggedSet, SessionExercise, WeightUnit, WorkoutSession } from '@/domain/types';
import { formatWeight, fromKg, kgToLb, round, toKg } from '@/domain/units';
import { hasRecordedLoad, isCountableSet } from '@/domain/setValidation';

export type SuggestionAction =
  | 'increase_load' | 'hold' | 'add_reps' | 'calibrate' | 'reduce_assistance' | 'increase_duration' | 'increase_distance' | 'review_recovery'
  | 'discomfort_hold';

export interface Suggestion {
  action: SuggestionAction;
  loadKg?: number | null;
  repMin?: number;
  repMax?: number;
  durationSec?: number;
  reason: string;
  /** Reps to aim for on each working set next time. */
  targetReps?: number;
  /** Distance target per set for distance-based work (metres). */
  distanceM?: number;
  /** Exercises worth considering (discomfort, or a harder variation). */
  alternativeIds?: ID[];
  hint?: 'harder_variation' | 'alternatives' | 'unassisted' | 'reduce_workload';
  /**
   * What the effort judgement rests on. 'not_recorded' / 'partial' = RIR/RPE wasn't logged (for some sets),
   * so the suggestion is based on reps and load only and the UI asks for a quick effort confirmation.
   */
  effortBasis?: EffortBasis;
}

export interface ProgressionRx {
  sets: number;
  repMin: number;
  repMax: number;
  targetRir: number;
  durationSec?: number;
}

/** How many recent comparable sessions a discomfort flag keeps suppressing increases. */
export const DISCOMFORT_WINDOW = 2;
/** Consecutive declining comparable sessions before suggesting a recovery review. */
export const DECLINE_SESSIONS = 3;

/**
 * Completed, valid working sets (warm-ups and drop sets excluded). Invalid completed sets (0 reps, no
 * time, negative/non-finite numbers) are never treated as performed work. Pass the exercise when known.
 */
export function workingSets(se: SessionExercise, ex?: Exercise): LoggedSet[] {
  return se.sets.filter((s) => s.type !== 'drop' && isCountableSet(s, ex));
}

/** How the effort behind a suggestion is known. */
export type EffortBasis = 'recorded' | 'partial' | 'not_recorded';

function effortBasisOf(sessions: SessionExercise[], rx: ProgressionRx, ex: Exercise): EffortBasis {
  const sets = sessions.flatMap((se) => workingSets(se, ex).slice(0, rx.sets));
  const n = sets.filter((x) => setRir(x) != null).length;
  return n === 0 ? 'not_recorded' : n === sets.length ? 'recorded' : 'partial';
}

/** Smallest practical increment in the user's unit. */
export function incrementFor(ex: Exercise, unit: WeightUnit, incrementKg?: number): number {
  if (incrementKg && incrementKg > 0) return unit === 'kg' ? incrementKg : round(kgToLb(incrementKg), 1);
  if (ex.increment) return unit === 'kg' ? ex.increment.kg : ex.increment.lb;
  const eq = ex.equipment;
  if (ex.tracking === 'assisted') return unit === 'kg' ? 5 : 10;
  if (eq.includes('barbell') || eq.includes('smith') || eq.includes('ez_bar')) return unit === 'kg' ? 2.5 : 5;
  if (eq.includes('kettlebell')) return unit === 'kg' ? 4 : 9;
  if (eq.includes('dumbbell')) return unit === 'kg' ? 2 : 5;
  if (eq.includes('machine') || eq.includes('cable')) return unit === 'kg' ? 5 : 10;
  return unit === 'kg' ? 2.5 : 5;
}

/** Next achievable load strictly above the current one on the user's increment grid (kg out). */
export function nextLoadUp(currentKg: number, inc: number, unit: WeightUnit): number {
  const cur = round(fromKg(currentKg, unit), 3);
  let next = Math.ceil((cur + 1e-6) / inc) * inc;
  if (next <= cur) next += inc;
  return toKg(round(next, 3), unit);
}
/** Next achievable load strictly below the current one (never below zero). */
export function nextLoadDown(currentKg: number, inc: number, unit: WeightUnit): number {
  const cur = round(fromKg(currentKg, unit), 3);
  const next = Math.max(0, Math.floor((cur - 1e-6) / inc) * inc);
  return toKg(round(next, 3), unit);
}
/** Round a load to the nearest achievable value on the grid (kg in/out). */
export function roundToAchievable(kg: number, inc: number, unit: WeightUnit): number {
  const v = fromKg(kg, unit);
  return toKg(round(Math.max(0, Math.round(v / inc) * inc), 3), unit);
}

function setRir(s: LoggedSet): number | null {
  if (s.rir != null) return s.rir;
  if (s.rpe != null) return 10 - s.rpe;
  return null;
}
/** Reached reps without grinding past the intended effort (within 1 rep of target RIR). Unlogged effort counts as on target. */
function effortOk(s: LoggedSet, rx: ProgressionRx): boolean {
  const r = setRir(s);
  return r == null || r >= rx.targetRir - 1;
}

const maxWeight = (sets: LoggedSet[]): number | null => {
  const w = sets.map((s) => s.weightKg).filter((x): x is number => x != null && isFinite(x));
  return w.length ? Math.max(...w) : null;
};

/** The first `rx.sets` working sets all at ≥ load (or ≤ for assistance), ≥ repMax reps, at intended effort. */
function allTop(se: SessionExercise, rx: ProgressionRx, loadKg: number, ex: Exercise, assisted = false): boolean {
  const ws = workingSets(se, ex);
  if (ws.length < rx.sets) return false;
  const loaded = ex.tracking === 'weight_reps' || ex.tracking === 'bodyweight_plus' || ex.tracking === 'assisted';
  return ws.slice(0, rx.sets).every((s) => {
    // A load that wasn't recorded is unknown — never assumed to be 0 or "at the load".
    if (loaded && !hasRecordedLoad(s, ex)) return false;
    const w = s.weightKg ?? 0;
    const loadOk = assisted ? w <= loadKg + 0.01 : w >= loadKg - 0.01;
    return loadOk && (s.reps ?? 0) >= rx.repMax && effortOk(s, rx);
  });
}

function perfScore(se: SessionExercise, ex: Exercise): number | null {
  const loaded = ex.tracking === 'weight_reps' || ex.tracking === 'assisted';
  // Sets whose load wasn't recorded can't be compared on load; leave them out of the trend.
  const ws = workingSets(se, ex).filter((s) => !loaded || hasRecordedLoad(s, ex));
  if (!ws.length) return null;
  const avg = (f: (s: LoggedSet) => number) => ws.reduce((a, s) => a + f(s), 0) / ws.length;
  switch (ex.tracking) {
    case 'weight_reps':
    case 'bodyweight_plus':
      return avg((s) => {
        const w = s.weightKg ?? 0;
        const r = s.reps ?? 0;
        return w > 0 ? w * (1 + r / 30) : r;
      });
    case 'reps':
      return avg((s) => s.reps ?? 0);
    case 'assisted':
      return avg((s) => (s.reps ?? 0) - (s.weightKg ?? 0) / 2.5);
    case 'duration':
      return avg((s) => s.durationSec ?? 0);
    case 'distance_time':
      return avg((s) => s.distanceM ?? s.durationSec ?? 0);
  }
}

function isDeclining(history: SessionExercise[], ex: Exercise): boolean {
  if (history.length < DECLINE_SESSIONS) return false;
  const scores = history.slice(0, DECLINE_SESSIONS).map((h) => perfScore(h, ex));
  if (scores.some((s) => s == null)) return false;
  const s = scores as number[];
  for (let i = 0; i < s.length - 1; i++) if (!(s[i] < s[i + 1])) return false;
  const oldest = s[s.length - 1];
  return oldest > 0 && (oldest - s[0]) / oldest > 0.02;
}

export function suggestNext(
  ex: Exercise,
  rx: ProgressionRx,
  history: SessionExercise[],
  opts: { unit: WeightUnit; incrementKg?: number },
): Suggestion {
  const unit = opts.unit;
  const fmt = (kg: number) => formatWeight(kg, unit);
  const range = { repMin: rx.repMin, repMax: rx.repMax };
  const h = history.filter((x) => workingSets(x, ex).length > 0);

  if (!h.length) {
    if (ex.tracking === 'duration' || ex.tracking === 'distance_time')
      return { action: 'calibrate', loadKg: null, ...range, durationSec: rx.durationSec, reason: 'First time: do what feels comfortable and log it — we’ll build from there.' };
    if (ex.tracking === 'reps')
      return { action: 'calibrate', loadKg: null, ...range, reason: `First time: stop each set with about ${rx.targetRir} reps left in the tank and log your reps — we’ll build from there.` };
    return {
      action: 'calibrate',
      loadKg: null,
      ...range,
      reason: `No known load yet: start light and add small jumps until a set of ${rx.repMin}–${rx.repMax} feels like about ${rx.targetRir} reps left in the tank. Log that as your starting load.`,
    };
  }

  const h0 = h[0];
  const ws0 = workingSets(h0, ex);
  const lastLoad = maxWeight(ws0.filter((s) => hasRecordedLoad(s, ex)));

  // Safety first: discomfort suppresses increases.
  if (h.slice(0, DISCOMFORT_WINDOW).some((x) => x.discomfort)) {
    return {
      action: 'discomfort_hold',
      loadKg: lastLoad,
      ...range,
      durationSec: rx.durationSec,
      alternativeIds: ex.substitutions.slice(0, 4),
      hint: 'alternatives',
      reason: 'You flagged discomfort recently, so we won’t suggest an increase. Keep it comfortable, use less load, or try an alternative exercise. If pain persists, consider a qualified professional.',
    };
  }

  if (isDeclining(h, ex)) {
    return {
      action: 'review_recovery',
      loadKg: lastLoad,
      ...range,
      durationSec: rx.durationSec,
      hint: 'reduce_workload',
      reason: `Performance has dipped over your last ${DECLINE_SESSIONS} sessions. Consider sleep, stress and food, or reduce workload for a week (for example one fewer set or a slightly lighter load).`,
    };
  }

  const minReps = Math.min(...ws0.slice(0, rx.sets).map((s) => s.reps ?? 0));
  const allSetsDone = ws0.length >= rx.sets;
  const inc = incrementFor(ex, unit, opts.incrementKg);

  switch (ex.tracking) {
    case 'weight_reps':
    case 'bodyweight_plus': {
      const weighted = ex.tracking === 'bodyweight_plus';
      if (!weighted && (lastLoad == null || lastLoad <= 0)) {
        return { action: 'calibrate', loadKg: null, ...range, reason: 'No load logged last time — pick a weight that leaves about 2–3 reps in the tank and log it.' };
      }
      const L = lastLoad ?? 0;
      const top0 = allTop(h0, rx, L, ex);
      const top1 = h[1] ? allTop(h[1], rx, L, ex) : false;
      if (top0 && top1) {
        const next = nextLoadUp(L, inc, unit);
        const effortBasis = effortBasisOf(h.slice(0, 2), rx, ex);
        return {
          action: 'increase_load',
          loadKg: next,
          ...range,
          targetReps: rx.repMin,
          effortBasis,
          reason: `You reached ${rx.repMax} reps on all ${rx.sets} sets${L > 0 ? ` at ${fmt(L)}` : ''} in two sessions${effortText(effortBasis, rx)}. Try ${weighted && L === 0 ? `adding ${fmt(next)}` : fmt(next)} and aim for ${rx.repMin} reps, then build back up.`,
        };
      }
      if (top0)
        return { action: 'hold', loadKg: L, ...range, targetReps: rx.repMax, reason: 'Top of the range on every set — repeat this load once more to confirm, then we’ll suggest an increase.' };
      if (allSetsDone && minReps >= rx.repMin)
        return {
          action: 'add_reps',
          loadKg: L,
          ...range,
          targetReps: Math.min(rx.repMax, minReps + 1),
          reason: `Same load${L > 0 ? ` (${fmt(L)})` : ''}; aim for one more rep on your lowest sets until every set reaches ${rx.repMax}.`,
        };
      return { action: 'hold', loadKg: L, ...range, targetReps: rx.repMin, reason: `Hold the load and aim for at least ${rx.repMin} reps on all ${rx.sets} sets.` };
    }

    case 'reps': {
      const top0 = allTop(h0, rx, 0, ex);
      const top1 = h[1] ? allTop(h[1], rx, 0, ex) : false;
      if (top0 && top1)
        return {
          action: 'add_reps',
          loadKg: null,
          ...range,
          targetReps: rx.repMax,
          hint: 'harder_variation',
          alternativeIds: ex.substitutions.slice(0, 4),
          reason: `You’ve reached ${rx.repMax} reps on every set twice. Ready for a harder variation or a little added load — or keep adding reps if you prefer.`,
        };
      return {
        action: 'add_reps',
        loadKg: null,
        ...range,
        targetReps: Math.min(rx.repMax, Math.max(rx.repMin, minReps + 1)),
        reason: `Aim for one more rep on your lowest sets until every set reaches ${rx.repMax}.`,
      };
    }

    case 'assisted': {
      if (lastLoad == null)
        return { action: 'calibrate', loadKg: null, ...range, reason: 'Log the assistance you use — enough that sets end with about 2–3 reps left in the tank.' };
      const L = lastLoad;
      const top0 = allTop(h0, rx, L, ex, true);
      const top1 = h[1] ? allTop(h[1], rx, L, ex, true) : false;
      if (top0 && top1) {
        const effortBasis = effortBasisOf(h.slice(0, 2), rx, ex);
        const next = nextLoadDown(L, inc, unit);
        if (next <= 0)
          return {
            action: 'reduce_assistance',
            loadKg: 0,
            ...range,
            targetReps: rx.repMin,
            hint: 'unassisted',
            effortBasis,
            alternativeIds: ex.substitutions.slice(0, 4),
            reason: 'You’ve outgrown the assistance — try the unassisted version (or the lightest band) and aim for the bottom of the range.',
          };
        return {
          action: 'reduce_assistance',
          loadKg: next,
          ...range,
          targetReps: rx.repMin,
          effortBasis,
          reason: `Top of the range twice with ${fmt(L)} assistance${effortText(effortBasis, rx)}. Use less assistance (${fmt(next)}) and aim for ${rx.repMin} reps — less help is progress.`,
        };
      }
      if (allSetsDone && minReps >= rx.repMin)
        return { action: 'add_reps', loadKg: L, ...range, targetReps: Math.min(rx.repMax, minReps + 1), reason: `Same assistance; aim for one more rep on your lowest sets until every set reaches ${rx.repMax}.` };
      return { action: 'hold', loadKg: L, ...range, targetReps: rx.repMin, reason: `Keep the same assistance and aim for ${rx.repMin} reps on every set.` };
    }

    case 'duration':
      return durationRule(h, rx, 'increase_duration', ex);

    case 'distance_time': {
      const dist = ws0.map((s) => s.distanceM).filter((d): d is number => d != null && d > 0);
      if (!dist.length) return durationRule(h, rx, 'increase_duration', ex);
      const avgDist = dist.reduce((a, b) => a + b, 0) / dist.length;
      const done1 = h[1] ? workingSets(h[1], ex).length >= rx.sets : false;
      if (allSetsDone && done1) {
        const next = Math.round((avgDist * 1.1) / 10) * 10;
        return { action: 'increase_distance', loadKg: lastLoad, ...range, distanceM: Math.max(next, avgDist + 10), reason: 'Completed twice — add about 10 % distance while keeping the same comfortable effort.' };
      }
      return { action: 'hold', loadKg: lastLoad, ...range, distanceM: Math.round(avgDist), reason: 'Keep the same distance until it feels comfortable on every set.' };
    }
  }
}

/** Honest wording about the effort a suggestion rests on. */
function effortText(basis: EffortBasis, rx: ProgressionRx): string {
  if (basis === 'recorded') return ' at the target effort';
  if (basis === 'partial') return ` (effort was logged for only some sets — increase only if they felt like about ${rx.targetRir} reps left in the tank)`;
  return ` (effort wasn’t logged, so this is based on reps and load only — increase only if those sets felt like about ${rx.targetRir} reps left in the tank)`;
}

function durationRule(h: SessionExercise[], rx: ProgressionRx, action: 'increase_duration', ex?: Exercise): Suggestion {
  const ws0 = workingSets(h[0], ex);
  const best = Math.max(0, ...ws0.map((s) => s.durationSec ?? 0));
  const target = rx.durationSec ?? best;
  const reached = (se: SessionExercise) => {
    const ws = workingSets(se, ex);
    return ws.length >= rx.sets && ws.slice(0, rx.sets).every((s) => (s.durationSec ?? 0) >= target);
  };
  const range = { repMin: rx.repMin, repMax: rx.repMax };
  if (target > 0 && reached(h[0]) && h[1] && reached(h[1])) {
    const step = Math.max(5, Math.round((target * 0.1) / 5) * 5);
    return { action, loadKg: null, ...range, durationSec: target + step, reason: `You held ${target} s on every set twice. Try ${target + step} s.` };
  }
  return { action: 'hold', loadKg: null, ...range, durationSec: target || undefined, reason: target ? `Aim for ${target} s on every set with good form.` : 'Keep logging your times — we’ll build from there.' };
}

/** Comparable history for one exercise: completed sessions, newest first, one entry per session. */
export function comparableHistory(sessions: WorkoutSession[], exerciseId: ID, beforeSessionId?: ID): SessionExercise[] {
  let pool = sessions.filter((s) => !s.deletedAt && s.status === 'completed');
  if (beforeSessionId) {
    const ref = sessions.find((s) => s.id === beforeSessionId);
    pool = pool.filter((s) => s.id !== beforeSessionId && (!ref || s.startedAt < ref.startedAt));
  }
  pool.sort((a, b) => b.startedAt - a.startedAt || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const out: SessionExercise[] = [];
  for (const s of pool) {
    const se = s.exercises.find((e) => e.exerciseId === exerciseId && workingSets(e).length > 0);
    if (se) out.push(se);
  }
  return out;
}

/** Short label for UI chips. */
export const ACTION_LABELS: Record<SuggestionAction, string> = {
  increase_load: 'Increase load',
  hold: 'Hold',
  add_reps: 'Add reps',
  calibrate: 'Calibrate',
  reduce_assistance: 'Less assistance',
  increase_duration: 'Longer',
  increase_distance: 'Further',
  review_recovery: 'Review recovery',
  discomfort_hold: 'No increase',
};
