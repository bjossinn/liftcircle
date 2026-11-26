/**
 * Training types used by the shared progression engine and set rules (pure; no Deno / npm imports).
 * Structural subsets of the app's definitions in src/domain/types.ts: the app passes its own Exercise / LoggedSet /
 * SessionExercise values straight in, and the ai-coach function maps its stored payload rows onto these shapes, so both
 * run ONE implementation (tests/unit/progressionSingleSource.test.ts checks the two agree).
 */
export type ID = string;
export type WeightUnit = 'kg' | 'lb';
export type TrackingType = 'weight_reps' | 'reps' | 'bodyweight_plus' | 'assisted' | 'duration' | 'distance_time';
export type LoadConvention = 'total' | 'per_hand' | 'stack' | 'added' | 'assistance' | 'none';
export type SetType = 'warmup' | 'normal' | 'drop' | 'timed';
export type Experience = 'new' | 'returning' | 'intermediate' | 'advanced';

/** The value exactly as the user typed it, so 45 lb is redisplayed as 45 lb, not 44.99. */
export interface EnteredValue {
  value: number;
  unit: WeightUnit;
}

/** What the engine needs to know about an exercise. */
export interface TrainingExercise {
  id: ID;
  name: string;
  tracking: TrackingType;
  load: LoadConvention;
  equipment: readonly string[];
  /** Smallest practical load increase in kg (and lb for imperial users). */
  increment?: { kg: number; lb: number };
  substitutions: readonly ID[];
}

export interface TrainingSet {
  type: SetType;
  weightKg?: number | null;
  entered?: EnteredValue;
  reps?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
  rpe?: number | null;
  rir?: number | null;
  completed: boolean;
}

/** One exercise as logged in one session. */
export interface TrainingSessionExercise {
  exerciseId: ID;
  sets: TrainingSet[];
  /** User flagged discomfort on this exercise during the session. */
  discomfort?: boolean;
}

/** One logged session (enough of it to order history). */
export interface TrainingSession<E extends TrainingSessionExercise = TrainingSessionExercise> {
  id: ID;
  status: string;
  date: string;
  startedAt: number;
  deletedAt?: number | null;
  exercises: E[];
}
