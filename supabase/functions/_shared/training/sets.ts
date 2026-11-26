/**
 * SHARED by the app (src/domain/setValidation.ts re-exports these) and the ai-coach function: which logged sets count
 * as performed work. The progression engine (./progression.ts) only ever looks at sets that pass these rules, so the
 * app and the server judge the same history the same way. Rules by tracking type: see src/domain/setValidation.ts.
 * Pure; no Deno / npm imports.
 */
import type { TrackingType, TrainingExercise, TrainingSet } from './types.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { sharedT, type Language, type SharedKey } from '../i18n/core.ts';

/** The two exercise fields the set rules look at. */
type ExLike = Pick<TrainingExercise, 'tracking' | 'load'>;

export type SetField = 'weight' | 'reps' | 'duration' | 'distance' | 'rir' | 'rpe';
export type SetValidationMode = 'log' | 'record';

export interface SetValidationOptions {
  /** 'log' = strict check before the user marks a set done; 'record' = history/import (default). */
  mode?: SetValidationMode;
  /** Validate as if completed (used before completing a set). Defaults to set.completed. */
  asCompleted?: boolean;
  /** Language of the error messages (default English, so server callers are unchanged). Never affects the result. */
  lang?: Language;
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
export function usesLoad(ex: ExLike | undefined): boolean {
  if (!ex) return false;
  if (ex.tracking === 'weight_reps' || ex.tracking === 'bodyweight_plus' || ex.tracking === 'assisted') return true;
  return ex.tracking === 'distance_time' && ex.load !== 'none';
}

/** Tracking types whose load may legitimately be 0 (bodyweight only / no assistance). */
const zeroLoadValid = (t: TrackingType) => t === 'bodyweight_plus' || t === 'assisted';

export function isRepTracking(t: TrackingType): boolean {
  return t === 'weight_reps' || t === 'reps' || t === 'bodyweight_plus' || t === 'assisted';
}

export function setFieldsFor(ex: ExLike | undefined): SetField[] {
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

const translators: Partial<Record<Language, ReturnType<typeof sharedT>>> = {};
const translator = (lang: Language) => (translators[lang] ??= sharedT(lang));

const present = (v: number | null | undefined): v is number => v != null;
const badNumber = (v: number | null | undefined) => present(v) && (typeof v !== 'number' || !Number.isFinite(v) || v < 0);

/** The load is a real number we can compare (never a missing value treated as 0). */
export function hasRecordedLoad(set: Pick<TrainingSet, 'weightKg'>, ex: ExLike | undefined): boolean {
  if (!ex || !usesLoad(ex)) return false;
  const w = set.weightKg;
  if (!present(w) || !Number.isFinite(w) || w < 0) return false;
  return zeroLoadValid(ex.tracking) ? true : w > 0;
}

export function validateLoggedSet(set: TrainingSet, ex: ExLike | undefined, opts: SetValidationOptions = {}): SetValidationResult {
  const mode = opts.mode ?? 'record';
  const completed = opts.asCompleted ?? !!set.completed;
  const fieldErrors: Partial<Record<SetField, string>> = {};
  const lang = opts.lang ?? 'en';
  const fail = (f: SetField, key: SharedKey) => {
    if (!fieldErrors[f]) fieldErrors[f] = translator(lang).t(key);
  };

  // Always: numbers must be finite and non-negative (drafts included).
  if (badNumber(set.weightKg)) fail('weight', 'workout.validation.weightNonnegative');
  if (badNumber(set.reps)) fail('reps', 'workout.validation.repsNonnegative');
  if (badNumber(set.durationSec)) fail('duration', 'workout.validation.timeNonnegative');
  if (badNumber(set.distanceM)) fail('distance', 'workout.validation.distanceNonnegative');
  if (present(set.rir) && (!Number.isFinite(set.rir) || set.rir < 0 || set.rir > 10)) fail('rir', 'workout.validation.rirRange');
  if (present(set.rpe) && (!Number.isFinite(set.rpe) || set.rpe < 1 || set.rpe > 10)) fail('rpe', 'workout.validation.rpeRange');
  if (present(set.weightKg) && set.weightKg > SET_LIMITS.maxWeightKg) fail('weight', 'workout.validation.weightHigh');
  if (present(set.reps) && set.reps > SET_LIMITS.maxReps) fail('reps', 'workout.validation.repsHigh');
  if (present(set.durationSec) && set.durationSec > SET_LIMITS.maxDurationSec) fail('duration', 'workout.validation.timeLong');
  if (present(set.distanceM) && set.distanceM > SET_LIMITS.maxDistanceM) fail('distance', 'workout.validation.distanceLong');

  if (completed) {
    const tracking: TrackingType | undefined = ex?.tracking;
    const working = set.type !== 'warmup';
    const posInt = (v: number | null | undefined) => present(v) && Number.isFinite(v) && Number.isInteger(v) && v > 0;
    const pos = (v: number | null | undefined) => present(v) && Number.isFinite(v) && v > 0;

    if (!tracking) {
      // Unknown exercise (e.g. deleted custom one): require at least one positive measure.
      if (!pos(set.reps) && !pos(set.durationSec) && !pos(set.distanceM)) fail('reps', 'workout.validation.enterPerformance');
      else if (present(set.reps) && !fieldErrors.reps && set.reps > 0 && !Number.isInteger(set.reps)) fail('reps', 'workout.validation.wholeReps');
    } else if (isRepTracking(tracking)) {
      if (!fieldErrors.reps && !posInt(set.reps)) {
        fail('reps', present(set.reps) && set.reps > 0 ? 'workout.validation.wholeReps' : 'workout.validation.oneRep');
      }
    } else if (tracking === 'duration') {
      if (!fieldErrors.duration && !pos(set.durationSec)) fail('duration', 'workout.validation.positiveTime');
    } else if (tracking === 'distance_time') {
      if (!fieldErrors.distance && !fieldErrors.duration && !pos(set.distanceM) && !pos(set.durationSec)) {
        fail('distance', 'workout.validation.distanceOrTime');
      }
    }

    // Load requirement (strict logging only; history/import accept "load not recorded").
    if (ex && mode === 'log' && working && usesLoad(ex) && !fieldErrors.weight) {
      if (zeroLoadValid(ex.tracking)) {
        if (!present(set.weightKg)) fail('weight', ex.tracking === 'assisted' ? 'workout.validation.enterAssistance' : 'workout.validation.enterAddedWeight');
      } else if (!present(set.weightKg) || set.weightKg <= 0) {
        fail('weight', 'workout.validation.enterWeight');
      }
    }
  }

  const errors = Object.values(fieldErrors).filter((x): x is string => !!x);
  return { ok: errors.length === 0, errors, fieldErrors, loadRecorded: hasRecordedLoad(set, ex) };
}

/** Completed and valid (record rules). Warm-ups included. */
export function isValidCompletedSet(set: TrainingSet, ex: ExLike | undefined): boolean {
  return !!set.completed && validateLoggedSet(set, ex, { mode: 'record' }).ok;
}

/** Counts as completed WORKING work: completed, valid and not a warm-up. */
export function isCountableSet(set: TrainingSet, ex: ExLike | undefined): boolean {
  return set.type !== 'warmup' && isValidCompletedSet(set, ex);
}
