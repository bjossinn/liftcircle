/**
 * Exercise substitution: explicit mapping between tracking types so a swapped exercise gets a
 * prescription, set fields, load convention and warm-ups that make sense for the NEW exercise.
 * Only untouched (not completed) sets are rebuilt — completed records are never reinterpreted.
 *
 * Also: default substitution candidates limited to the user's available equipment, exclusions and
 * movement constraints (limitations), with the caller offering an explicit "show all" override.
 */
import type { Equipment, Exercise, ID, LimitationArea, LoggedSet, SessionExercise, SetType, TrackingType } from './types';
import { isRepTracking, usesLoad } from './setValidation';
import { uuid } from '@/lib/id';

export type TrackingFamily = 'reps' | 'duration' | 'distance_time';
export function trackingFamily(t: TrackingType): TrackingFamily {
  if (t === 'duration') return 'duration';
  if (t === 'distance_time') return 'distance_time';
  return 'reps';
}

type Rx = NonNullable<SessionExercise['prescription']>;

/** Default per-set seconds when moving to a timed exercise without a known target. */
export function defaultDurationSec(to: Exercise, _from?: Exercise): number {
  if (to.tracking === 'distance_time') return to.category === 'cardio' ? 60 : 40;
  if (to.category === 'mobility') return 30;
  return 30;
}

/** Default rep range when moving from a timed exercise to a rep-based one. */
export function defaultRepRange(to: Exercise): [number, number] {
  if (to.category === 'isolation' || to.category === 'core') return [10, 15];
  if (to.tracking === 'reps') return [8, 15];
  return [8, 12];
}

/**
 * Rebuild a prescription for a new exercise. Same tracking family → unchanged (sets, reps, rest, effort).
 * Rep ↔ time changes rebuild the target (seconds vs a rep range) while keeping set count and rest.
 */
export function adaptPrescription(rx: Rx | undefined, from: Exercise | undefined, to: Exercise): Rx | undefined {
  if (!rx) return undefined;
  const fromFam = from ? trackingFamily(from.tracking) : rx.durationSec ? 'duration' : 'reps';
  const toFam = trackingFamily(to.tracking);
  if (fromFam === toFam) {
    if (toFam !== 'reps' && !rx.durationSec) return { ...rx, durationSec: defaultDurationSec(to, from) };
    return { ...rx };
  }
  if (toFam === 'reps') {
    const [repMin, repMax] = defaultRepRange(to);
    const { durationSec: _drop, ...rest } = rx;
    void _drop;
    return { ...rest, repMin, repMax };
  }
  // reps → timed, or duration ↔ distance/time
  return { ...rx, repMin: 1, repMax: 1, durationSec: rx.durationSec ?? defaultDurationSec(to, from) };
}

/** The set type a fresh working set of this exercise uses. */
export function workingSetType(ex: Exercise): SetType {
  return ex.tracking === 'duration' || ex.tracking === 'distance_time' ? 'timed' : 'normal';
}

/** Whether this exercise gets loaded ramp-up (warm-up) sets. */
export function supportsWarmups(ex: Exercise): boolean {
  return ex.tracking === 'weight_reps';
}

/**
 * Rebuild one untouched set for the new exercise. Values that mean something different under the new
 * exercise (load convention, reps vs seconds, per-side reps) are cleared rather than reinterpreted.
 */
export function adaptUntouchedSet(set: LoggedSet, from: Exercise | undefined, to: Exercise, rx: Rx | undefined): LoggedSet {
  if (set.completed) return set;
  const fromFam = from ? trackingFamily(from.tracking) : 'reps';
  const toFam = trackingFamily(to.tracking);
  const sameFamily = fromFam === toFam;
  const keepReps = sameFamily && toFam === 'reps' && !!from && !!from.unilateral === !!to.unilateral;
  const next: LoggedSet = {
    id: set.id,
    type: set.type === 'warmup' ? 'warmup' : sameFamily && set.type === 'drop' ? 'drop' : workingSetType(to),
    weightKg: to.tracking === 'bodyweight_plus' && set.type !== 'warmup' ? 0 : null,
    reps: null,
    durationSec: null,
    distanceM: null,
    completed: false,
  };
  if (!usesLoad(to)) next.weightKg = null;
  if (isRepTracking(to.tracking)) {
    if (keepReps && set.reps != null && set.reps > 0) next.reps = set.reps;
  } else {
    next.durationSec = rx?.durationSec ?? (sameFamily && set.durationSec && set.durationSec > 0 ? set.durationSec : null);
    if (to.tracking === 'distance_time' && sameFamily && set.distanceM && set.distanceM > 0) next.distanceM = set.distanceM;
  }
  return next;
}

/** Swap an exercise's untouched sets and prescription to a new exercise. Returns null when sets are completed. */
export function adaptSessionExercise(se: SessionExercise, from: Exercise | undefined, to: Exercise): SessionExercise | null {
  if (se.sets.some((x) => x.completed)) return null;
  const prescription = adaptPrescription(se.prescription, from, to);
  let sets = se.sets.filter((x) => x.type !== 'warmup' || supportsWarmups(to)).map((x) => adaptUntouchedSet(x, from, to, prescription));
  if (!sets.length) sets = [{ id: se.sets[0]?.id ?? uuid(), type: workingSetType(to), weightKg: null, reps: null, completed: false }];
  const out: SessionExercise = { ...se, exerciseId: to.id, swappedFrom: se.swappedFrom ?? se.exerciseId, sets };
  if (prescription) out.prescription = prescription;
  else delete out.prescription;
  return out;
}

/* ------------------------------------------------------------ candidates */
export interface SubstitutionConstraints {
  /** Equipment the user has. Undefined = unknown (no equipment filter). 'bodyweight' is always available. */
  equipment?: Set<Equipment>;
  excluded?: Set<ID>;
  limitations?: Set<LimitationArea>;
}

export function hasConstraints(c: SubstitutionConstraints | undefined): boolean {
  return !!c && (!!c.equipment || !!c.excluded?.size || !!c.limitations?.size);
}

/** Does an exercise fit the user's equipment, exclusions and movement constraints? */
export function fitsConstraints(ex: Exercise, c: SubstitutionConstraints | undefined): boolean {
  if (!c) return true;
  if (c.excluded?.has(ex.id)) return false;
  if (c.equipment && !ex.equipment.every((e) => e === 'bodyweight' || c.equipment!.has(e))) return false;
  if (c.limitations && ex.stresses.some((s) => c.limitations!.has(s))) return false;
  return true;
}

/**
 * Default substitutions for an exercise: its curated list first, then same-pattern exercises that share a
 * primary muscle — all filtered by the user's constraints. Same tracking family is preferred.
 */
export function substitutionCandidates(from: Exercise, catalog: Exercise[], c?: SubstitutionConstraints, limit = 8): ID[] {
  const byId = new Map(catalog.map((e) => [e.id, e]));
  const fam = trackingFamily(from.tracking);
  const ok = (e: Exercise | undefined): e is Exercise => !!e && e.id !== from.id && fitsConstraints(e, c);
  const curated = from.substitutions.map((id) => byId.get(id)).filter(ok);
  const similar = catalog
    .filter((e) => ok(e) && !from.substitutions.includes(e.id) && e.pattern === from.pattern && e.primaryMuscles.some((m) => from.primaryMuscles.includes(m)))
    .sort((a, b) => Number(trackingFamily(b.tracking) === fam) - Number(trackingFamily(a.tracking) === fam) || a.difficulty - b.difficulty || a.name.localeCompare(b.name));
  return [...curated, ...similar].slice(0, limit).map((e) => e.id);
}
