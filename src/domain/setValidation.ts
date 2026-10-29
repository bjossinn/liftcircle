/**
 * Shared validation for logged sets — the single source of truth used by the logger (Done button),
 * historical edits, backup import and (mirrored in SQL) server writes.
 *
 * STABLE API (other slices import these names; keep them stable):
 *   validateLoggedSet(set, ex, opts?)   → { ok, errors, fieldErrors, loadRecorded }
 *   isValidCompletedSet(set, ex)         → completed AND valid (warm-ups included)
 *   isCountableSet(set, ex)              → completed AND valid AND not a warm-up (working-set counts, PRs,
 *                                          adherence, progression)
 *   hasRecordedLoad(set, ex)             → the load number is a real measurement usable for PRs/volume
 *   setFieldsFor(ex)                     → which fields a set of this exercise uses
 *   validateSessionRecord(session, byId) → human-readable problems (empty = OK) for import/edit checks
 *   sanitizeImportedSession(session, byId) → { session, issues } — repairs a session so invalid data can
 *                                          never count as completed work
 *
 * Rules by tracking type (completed sets):
 * - weight_reps: positive whole reps. Load: in 'log' mode a positive load is required for working sets.
 *   In 'record' mode (history/import) a missing or zero load is accepted as "load not recorded": the set is
 *   still a completed set, but it never contributes to volume, load PRs, e1RM or load progression.
 * - reps: positive whole reps (any stray load is ignored).
 * - bodyweight_plus: positive whole reps; added load ≥ 0 (0 = bodyweight only is valid).
 *   'log' mode requires the added load to be entered for working sets (0 is fine).
 * - assisted: positive whole reps; assistance ≥ 0 (0 = unassisted is valid). 'log' mode requires an entry.
 * - duration: positive duration.
 * - distance_time: a positive distance or a positive duration (or both). Carries with a load
 *   convention other than 'none' follow the same load rules as weight_reps.
 * Everywhere: numbers must be finite and non-negative; RIR 0–10, RPE 1–10 when present.
 * Incomplete (draft) sets are allowed to be empty/partial — they are never counted.
 */
import type { Exercise, ID, LoggedSet, TrackingType, WorkoutSession } from './types';

export type SetField = 'weight' | 'reps' | 'duration' | 'distance' | 'rir' | 'rpe';
export type SetValidationMode = 'log' | 'record';

export interface SetValidationOptions {
  /** 'log' = strict check before the user marks a set done; 'record' = history/import (default). */
  mode?: SetValidationMode;
  /** Validate as if completed (used before completing a set). Defaults to set.completed. */
  asCompleted?: boolean;
}

export interface SetValidationResult {
  ok: boolean;
  errors: string[];
  fieldErrors: Partial<Record<SetField, string>>;
  /** True when the load is a real measurement (see hasRecordedLoad). */
  loadRecorded: boolean;
}

export const SET_LIMITS = {
  maxReps: 1000,
  maxWeightKg: 1000,
  maxDurationSec: 24 * 3600,
  maxDistanceM: 1_000_000,
} as const;

/** Loaded exercises: the load number is a meaningful, comparable measurement. */
export function usesLoad(ex: Pick<Exercise, 'tracking' | 'load'> | undefined): boolean {
  if (!ex) return false;
  if (ex.tracking === 'weight_reps' || ex.tracking === 'bodyweight_plus' || ex.tracking === 'assisted') return true;
  return ex.tracking === 'distance_time' && ex.load !== 'none';
}

/** Tracking types whose load may legitimately be 0 (bodyweight only / no assistance). */
const zeroLoadValid = (t: TrackingType) => t === 'bodyweight_plus' || t === 'assisted';

export function isRepTracking(t: TrackingType): boolean {
  return t === 'weight_reps' || t === 'reps' || t === 'bodyweight_plus' || t === 'assisted';
}

export function setFieldsFor(ex: Pick<Exercise, 'tracking' | 'load'> | undefined): SetField[] {
  if (!ex) return ['weight', 'reps'];
  switch (ex.tracking) {
    case 'weight_reps':
    case 'bodyweight_plus':
    case 'assisted':
      return ['weight', 'reps', 'rir'];
    case 'reps':
      return ['reps', 'rir'];
    case 'duration':
      return ['duration'];
    case 'distance_time':
      return ex.load !== 'none' ? ['weight', 'distance', 'duration'] : ['distance', 'duration'];
  }
}

const present = (v: number | null | undefined): v is number => v != null;
const badNumber = (v: number | null | undefined) => present(v) && (typeof v !== 'number' || !Number.isFinite(v) || v < 0);

/** The load is a real number we can compare (never a missing value treated as 0). */
export function hasRecordedLoad(set: Pick<LoggedSet, 'weightKg'>, ex: Pick<Exercise, 'tracking' | 'load'> | undefined): boolean {
  if (!ex || !usesLoad(ex)) return false;
  const w = set.weightKg;
  if (!present(w) || !Number.isFinite(w) || w < 0) return false;
  return zeroLoadValid(ex.tracking) ? true : w > 0;
}

export function validateLoggedSet(set: LoggedSet, ex: Exercise | undefined, opts: SetValidationOptions = {}): SetValidationResult {
  const mode = opts.mode ?? 'record';
  const completed = opts.asCompleted ?? !!set.completed;
  const fieldErrors: Partial<Record<SetField, string>> = {};
  const fail = (f: SetField, msg: string) => {
    if (!fieldErrors[f]) fieldErrors[f] = msg;
  };

  // Always: numbers must be finite and non-negative (drafts included).
  if (badNumber(set.weightKg)) fail('weight', 'Weight must be zero or more.');
  if (badNumber(set.reps)) fail('reps', 'Reps must be zero or more.');
  if (badNumber(set.durationSec)) fail('duration', 'Time must be zero or more.');
  if (badNumber(set.distanceM)) fail('distance', 'Distance must be zero or more.');
  if (present(set.rir) && (!Number.isFinite(set.rir) || set.rir < 0 || set.rir > 10)) fail('rir', 'RIR must be between 0 and 10.');
  if (present(set.rpe) && (!Number.isFinite(set.rpe) || set.rpe < 1 || set.rpe > 10)) fail('rpe', 'RPE must be between 1 and 10.');
  if (present(set.weightKg) && set.weightKg > SET_LIMITS.maxWeightKg) fail('weight', 'That weight looks too high.');
  if (present(set.reps) && set.reps > SET_LIMITS.maxReps) fail('reps', 'That rep count looks too high.');
  if (present(set.durationSec) && set.durationSec > SET_LIMITS.maxDurationSec) fail('duration', 'That time looks too long.');
  if (present(set.distanceM) && set.distanceM > SET_LIMITS.maxDistanceM) fail('distance', 'That distance looks too long.');

  if (completed) {
    const tracking: TrackingType | undefined = ex?.tracking;
    const working = set.type !== 'warmup';
    const posInt = (v: number | null | undefined) => present(v) && Number.isFinite(v) && Number.isInteger(v) && v > 0;
    const pos = (v: number | null | undefined) => present(v) && Number.isFinite(v) && v > 0;

    if (!tracking) {
      // Unknown exercise (e.g. deleted custom one): require at least one positive measure.
      if (!pos(set.reps) && !pos(set.durationSec) && !pos(set.distanceM)) fail('reps', 'Enter reps, time or distance.');
      else if (present(set.reps) && !fieldErrors.reps && set.reps > 0 && !Number.isInteger(set.reps)) fail('reps', 'Reps must be a whole number.');
    } else if (isRepTracking(tracking)) {
      if (!fieldErrors.reps && !posInt(set.reps)) {
        fail('reps', present(set.reps) && set.reps > 0 ? 'Reps must be a whole number.' : 'Enter at least 1 rep.');
      }
    } else if (tracking === 'duration') {
      if (!fieldErrors.duration && !pos(set.durationSec)) fail('duration', 'Enter a time above 0.');
    } else if (tracking === 'distance_time') {
      if (!fieldErrors.distance && !fieldErrors.duration && !pos(set.distanceM) && !pos(set.durationSec)) {
        fail('distance', 'Enter a distance or a time.');
      }
    }

    // Load requirement (strict logging only; history/import accept "load not recorded").
    if (ex && mode === 'log' && working && usesLoad(ex) && !fieldErrors.weight) {
      if (zeroLoadValid(ex.tracking)) {
        if (!present(set.weightKg)) fail('weight', ex.tracking === 'assisted' ? 'Enter the assistance (0 for none).' : 'Enter the added weight (0 for none).');
      } else if (!present(set.weightKg) || set.weightKg <= 0) {
        fail('weight', 'Enter the weight used.');
      }
    }
  }

  const errors = Object.values(fieldErrors).filter((x): x is string => !!x);
  return { ok: errors.length === 0, errors, fieldErrors, loadRecorded: hasRecordedLoad(set, ex) };
}

/** Completed and valid (record rules). Warm-ups included. */
export function isValidCompletedSet(set: LoggedSet, ex: Exercise | undefined): boolean {
  return !!set.completed && validateLoggedSet(set, ex, { mode: 'record' }).ok;
}

/** Counts as completed WORKING work: completed, valid and not a warm-up. */
export function isCountableSet(set: LoggedSet, ex: Exercise | undefined): boolean {
  return set.type !== 'warmup' && isValidCompletedSet(set, ex);
}

/** Problems with a session record (empty array = fine). Used for import and historical edits. */
export function validateSessionRecord(session: WorkoutSession, exById: Map<ID, Exercise>): string[] {
  const issues: string[] = [];
  if (!session || typeof session !== 'object') return ['Not a workout session.'];
  if (!Array.isArray(session.exercises)) return ['Session has no exercise list.'];
  session.exercises.forEach((se, i) => {
    if (!se || !Array.isArray(se.sets)) {
      issues.push(`Exercise ${i + 1}: missing sets.`);
      return;
    }
    const ex = exById.get(se.exerciseId);
    const name = ex?.name ?? se.exerciseId ?? `Exercise ${i + 1}`;
    se.sets.forEach((st, j) => {
      const r = validateLoggedSet(st, ex, { mode: 'record' });
      if (!r.ok) issues.push(`${name}, set ${j + 1}: ${r.errors.join(' ')}`);
    });
  });
  return issues;
}

const cleanNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Repair a session for import: invalid numbers (negative, non-finite, non-numeric) become "not recorded",
 * and completed sets that are still invalid are marked not completed so they never count as work.
 * Valid data is returned unchanged (same object identity for untouched sets).
 */
export function sanitizeImportedSession<T extends WorkoutSession>(session: T, exById: Map<ID, Exercise>): { session: T; issues: string[] } {
  const issues = validateSessionRecord(session, exById);
  if (!issues.length || !Array.isArray(session?.exercises)) return { session, issues };
  const exercises = session.exercises.map((se) => {
    if (!se || !Array.isArray(se.sets)) return { ...se, sets: [] };
    const ex = exById.get(se.exerciseId);
    return {
      ...se,
      sets: se.sets.map((st) => {
        if (validateLoggedSet(st, ex, { mode: 'record' }).ok) return st;
        const fixed: LoggedSet = {
          ...st,
          weightKg: cleanNum(st.weightKg),
          reps: cleanNum(st.reps),
          durationSec: cleanNum(st.durationSec),
          distanceM: cleanNum(st.distanceM),
          rir: present(st.rir) && Number.isFinite(st.rir) && st.rir >= 0 && st.rir <= 10 ? st.rir : null,
          rpe: present(st.rpe) && Number.isFinite(st.rpe) && st.rpe >= 1 && st.rpe <= 10 ? st.rpe : null,
        };
        if (fixed.weightKg == null) fixed.entered = undefined;
        if (fixed.completed && !validateLoggedSet(fixed, ex, { mode: 'record' }).ok) {
          fixed.completed = false;
          fixed.completedAt = undefined;
        }
        return fixed;
      }),
    };
  });
  return { session: { ...session, exercises }, issues };
}

/**
 * Catalog-free check used where exercise definitions aren't at hand (schedule adherence, plan matching):
 * a finished session counts as training when it logged no sets at all (e.g. an activity-style session)
 * or when at least one completed set holds real work — positive whole reps, a positive duration or a
 * positive distance, with no negative/non-finite numbers. A session whose only "completed" sets are
 * empty or zero (e.g. 20 kg × 0 reps) does not count.
 */
export function hasCompletedWork(session: Pick<WorkoutSession, 'exercises'>): boolean {
  const all = (session.exercises ?? []).flatMap((se) => se?.sets ?? []);
  if (all.length === 0) return true;
  const ok = (v: unknown) => v == null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  return all.some(
    (s) =>
      !!s.completed &&
      ok(s.weightKg) && ok(s.reps) && ok(s.durationSec) && ok(s.distanceM) &&
      ((typeof s.reps === 'number' && Number.isInteger(s.reps) && s.reps > 0) ||
        (typeof s.durationSec === 'number' && s.durationSec > 0) ||
        (typeof s.distanceM === 'number' && s.distanceM > 0)),
  );
}
