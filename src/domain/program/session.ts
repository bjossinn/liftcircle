/**
 * Turn a session template into an active workout: exercises in order with the prescription copied,
 * warm-up sets for main lifts and working sets pre-filled from progression suggestions and the
 * previous comparable performance. Suggestions only pre-fill; nothing is completed until the user logs it.
 */
import type { EnteredValue, Exercise, Experience, ID, ISODate, LoggedSet, Prescription, SessionExercise, SessionTemplate, Settings, WeightUnit, WorkoutSession } from '@/domain/types';
import { uuid } from '@/lib/id';
import { fromKg, round } from '@/domain/units';
import { comparableHistory, incrementFor, isBeginner, lastPerformed, plateIncrementKg, suggestNext, workingSets, type Suggestion } from '@/domain/progression';
import { warmupSetCount } from './generator';
import { warmupSets } from '@/domain/warmups';

export interface BuildCtx {
  catalog: Exercise[];
  history: WorkoutSession[];
  settings: Settings;
  programId?: ID;
  programVersion?: number;
  plannedDate?: ISODate;
  date: ISODate;
  timeZone: string;
  /** The user's experience level (account profile); 'new' / 'returning' turn on the beginner progression rule. */
  experience?: Experience;
}

function entered(kg: number | null | undefined, unit: WeightUnit): EnteredValue | undefined {
  if (kg == null) return undefined;
  return { value: round(fromKg(kg, unit), unit === 'kg' ? 2 : 1), unit };
}

/**
 * Progression suggestion for one prescription given the user's completed history (the engine in
 * src/domain/progression.ts; this only supplies the user's unit, plate increment and beginner flag).
 */
export function suggestionFor(
  rx: Pick<Prescription, 'exerciseId' | 'sets' | 'repMin' | 'repMax' | 'targetRir' | 'durationSec'>,
  ex: Exercise,
  history: WorkoutSession[],
  settings: Settings,
  experience?: Experience,
): { suggestion: Suggestion; last?: SessionExercise } {
  const comparable = comparableHistory(history, rx.exerciseId);
  const unit = settings.units.weight;
  const suggestion = suggestNext(ex, rx, comparable, { unit, incrementKg: plateIncrementKg(ex, unit, settings.workout), beginner: isBeginner(experience) });
  return { suggestion, last: lastPerformed(comparable, ex) };
}

export function buildSessionFromTemplate(t: SessionTemplate, ctx: BuildCtx): WorkoutSession {
  const byId = new Map(ctx.catalog.map((e) => [e.id, e]));
  const unit = ctx.settings.units.weight;
  const now = Date.now();
  const exercises: SessionExercise[] = t.exercises.map((rx, order) => {
    const ex = byId.get(rx.exerciseId);
    const prescription = { sets: rx.sets, repMin: rx.repMin, repMax: rx.repMax, targetRir: rx.targetRir, restSec: rx.restSec, durationSec: rx.durationSec, slotId: rx.id };
    if (prescription.durationSec === undefined) delete prescription.durationSec;
    if (!ex) {
      const sets: LoggedSet[] = Array.from({ length: rx.sets }, () => ({ id: uuid(), type: 'normal', weightKg: null, reps: null, completed: false }));
      return { id: uuid(), exerciseId: rx.exerciseId, order, prescription, sets };
    }
    const { suggestion, last } = suggestionFor(rx, ex, ctx.history, ctx.settings, ctx.experience);
    const lastSets = last ? workingSets(last) : [];
    const timed = ex.tracking === 'duration' || ex.tracking === 'distance_time';
    const usesLoad = ex.tracking === 'weight_reps' || ex.tracking === 'assisted' || ex.tracking === 'bodyweight_plus' || (ex.tracking === 'distance_time' && ex.load !== 'none');

    // Working load: suggestion → known starting load (first time) → null when calibrating.
    let load: number | null = null;
    if (usesLoad) {
      if (suggestion.loadKg != null) load = suggestion.loadKg;
      else if (suggestion.action === 'calibrate' && rx.startLoadKg != null) load = rx.startLoadKg;
      else if (ex.tracking === 'bodyweight_plus' && suggestion.action !== 'calibrate') load = 0;
    }

    const sets: LoggedSet[] = [];
    const nWarm = warmupSetCount(rx, ex);
    const inc = incrementFor(ex, unit);
    // Warm-ups: feasible bar settings strictly below the working load (see domain/warmups.ts).
    if (nWarm > 0 && load != null && load > 0) {
      for (const w of warmupSets(load, ex, nWarm, unit, inc, ctx.settings)) sets.push({ id: uuid(), type: 'warmup', weightKg: w.weightKg, entered: w.entered, reps: w.reps, completed: false });
    } else {
      const warmReps = nWarm === 2 ? [8, 4] : [8];
      for (let i = 0; i < nWarm; i++) sets.push({ id: uuid(), type: 'warmup', weightKg: null, reps: warmReps[i], completed: false });
    }
    for (let i = 0; i < rx.sets; i++) {
      const prev = lastSets[i];
      let reps: number | null = null;
      if (!timed) {
        if (suggestion.targetReps != null) reps = suggestion.targetReps;
        else if (suggestion.action !== 'calibrate' && prev?.reps != null) reps = prev.reps;
        else if (suggestion.action === 'calibrate' && rx.startLoadKg != null) reps = rx.repMin;
      }
      const set: LoggedSet = {
        id: uuid(),
        type: timed ? 'timed' : 'normal',
        weightKg: usesLoad ? load : null,
        reps,
        completed: false,
      };
      const e = usesLoad ? entered(load, unit) : undefined;
      if (e) set.entered = e;
      if (timed) {
        set.durationSec = suggestion.durationSec ?? rx.durationSec ?? prev?.durationSec ?? null;
        if (suggestion.distanceM != null) set.distanceM = suggestion.distanceM;
        else if (prev?.distanceM != null) set.distanceM = prev.distanceM;
      }
      sets.push(set);
    }
    return { id: uuid(), exerciseId: rx.exerciseId, order, prescription, sets };
  });

  const s: WorkoutSession = {
    id: uuid(),
    createdAt: now,
    updatedAt: now,
    name: t.name,
    status: 'active',
    templateId: t.id,
    date: ctx.date,
    timeZone: ctx.timeZone,
    startedAt: now,
    pausedTotalMs: 0,
    exercises,
  };
  if (t.nameEdited) s.nameEdited = true;
  if (ctx.programId) s.programId = ctx.programId;
  if (ctx.programVersion != null) s.programVersion = ctx.programVersion;
  if (ctx.plannedDate) s.plannedDate = ctx.plannedDate;
  return s;
}
