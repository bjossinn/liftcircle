/**
 * Pure, immutable operations on a WorkoutSession used by the logger.
 * Timers are stored as wall-clock deadlines so remaining time is always recomputed
 * correctly after reloads, backgrounding or device sleep.
 */
import type { Exercise, LoggedSet, RestTimerState, SessionExercise, SetType, WorkoutSession } from './types';
import { uuid } from '@/lib/id';
import { isValidCompletedSet, validateLoggedSet } from './setValidation';
import { adaptSessionExercise, workingSetType } from './substitution';

type S = WorkoutSession;

const mapEx = (s: S, exId: string, fn: (e: SessionExercise) => SessionExercise): S => ({
  ...s,
  exercises: s.exercises.map((e) => (e.id === exId ? fn(e) : e)),
});
const mapSet = (s: S, exId: string, setId: string, fn: (st: LoggedSet) => LoggedSet): S =>
  mapEx(s, exId, (e) => ({ ...e, sets: e.sets.map((st) => (st.id === setId ? fn(st) : st)) }));

/* ------------------------------------------------------------ session time */
export function elapsedMs(s: S, now: number): number {
  const end = s.endedAt ?? s.pausedAt ?? now;
  return Math.max(0, end - s.startedAt - s.pausedTotalMs);
}
export function pauseSession(s: S, now: number): S {
  if (s.pausedAt) return s;
  const rest = s.rest?.endsAt ? pauseRestState(s.rest, now) : s.rest;
  return { ...s, pausedAt: now, rest };
}
export function resumeSession(s: S, now: number): S {
  if (!s.pausedAt) return s;
  return { ...s, pausedAt: undefined, pausedTotalMs: s.pausedTotalMs + (now - s.pausedAt) };
}

/* -------------------------------------------------------------- rest timer */
export function restRemainingMs(r: RestTimerState | undefined, now: number): number | null {
  if (!r) return null;
  if (r.pausedRemainingMs != null) return r.pausedRemainingMs;
  if (r.endsAt == null) return null;
  return Math.max(0, r.endsAt - now);
}
function pauseRestState(r: RestTimerState, now: number): RestTimerState {
  return { ...r, pausedRemainingMs: Math.max(0, (r.endsAt ?? now) - now), endsAt: undefined };
}
export function startRest(s: S, now: number, durationMs: number, forExerciseId?: string): S {
  return { ...s, rest: { endsAt: now + durationMs, durationMs, forExerciseId } };
}
export function pauseRest(s: S, now: number): S {
  return s.rest?.endsAt ? { ...s, rest: pauseRestState(s.rest, now) } : s;
}
export function resumeRest(s: S, now: number): S {
  const r = s.rest;
  if (!r || r.pausedRemainingMs == null) return s;
  return { ...s, rest: { durationMs: r.durationMs, forExerciseId: r.forExerciseId, endsAt: now + r.pausedRemainingMs } };
}
export function extendRest(s: S, now: number, deltaMs: number): S {
  const r = s.rest;
  if (!r) return s;
  if (r.pausedRemainingMs != null) return { ...s, rest: { ...r, pausedRemainingMs: Math.max(0, r.pausedRemainingMs + deltaMs) } };
  const base = Math.max(now, r.endsAt ?? now);
  return { ...s, rest: { ...r, endsAt: Math.max(now, base + deltaMs) } };
}
export function resetRest(s: S, now: number): S {
  const r = s.rest;
  if (!r) return s;
  return { ...s, rest: { durationMs: r.durationMs, forExerciseId: r.forExerciseId, endsAt: now + r.durationMs } };
}
export function skipRest(s: S): S {
  return { ...s, rest: undefined };
}

/* --------------------------------------------------------------------- sets */
export function updateSet(s: S, exId: string, setId: string, patch: Partial<LoggedSet>): S {
  return mapSet(s, exId, setId, (st) => ({ ...st, ...patch }));
}

/** Values worth carrying into another set: positive measures only (never 0/negative/non-finite reps etc.). */
const carryPos = (v: number | null | undefined): number | null => (v != null && Number.isFinite(v) && v > 0 ? v : null);
const carryLoad = (v: number | null | undefined): number | null => (v != null && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * One-tap completion. Toggling a completed set un-completes it (easy undo).
 * When `ex` is given, completing is validated with the shared logging rules (domain/setValidation):
 * an invalid set (e.g. 0 reps) is NOT completed and `errors` explains why.
 * Returns the new session and whether the set is now completed.
 */
export function toggleSetComplete(s: S, exId: string, setId: string, now: number, ex?: Exercise): { session: S; completed: boolean; errors: string[] } {
  const se = s.exercises.find((e) => e.id === exId);
  const set = se?.sets.find((x) => x.id === setId);
  if (!se || !set) return { session: s, completed: false, errors: [] };
  const completed = !set.completed;
  if (completed && ex) {
    const v = validateLoggedSet(set, ex, { mode: 'log', asCompleted: true });
    if (!v.ok) return { session: s, completed: false, errors: v.errors };
  }
  let next = updateSet(s, exId, setId, { completed, completedAt: completed ? now : undefined });
  // Carry values forward into the next empty set of the same type for fast entry (valid values only).
  if (completed) {
    const idx = se.sets.findIndex((x) => x.id === setId);
    const following = se.sets[idx + 1];
    if (following && !following.completed && following.type === set.type) {
      const patch: Partial<LoggedSet> = {};
      const w = carryLoad(set.weightKg);
      if (following.weightKg == null && w != null) {
        patch.weightKg = w;
        patch.entered = set.entered;
      }
      const r = carryPos(set.reps);
      if (following.reps == null && r != null) patch.reps = r;
      const d = carryPos(set.durationSec);
      if (following.durationSec == null && d != null) patch.durationSec = d;
      const m = carryPos(set.distanceM);
      if (following.distanceM == null && m != null) patch.distanceM = m;
      if (Object.keys(patch).length) next = updateSet(next, exId, following.id, patch);
    }
  }
  return { session: next, completed, errors: [] };
}

export function addSet(s: S, exId: string, type: SetType = 'normal'): S {
  return mapEx(s, exId, (e) => {
    const last = [...e.sets].reverse().find((x) => x.type === type) ?? e.sets[e.sets.length - 1];
    const set: LoggedSet = {
      id: uuid(),
      type,
      weightKg: carryLoad(last?.weightKg),
      reps: carryPos(last?.reps),
      durationSec: carryPos(last?.durationSec),
      distanceM: carryPos(last?.distanceM),
      completed: false,
    };
    if (set.weightKg != null && last?.entered) set.entered = last.entered;
    return { ...e, sets: [...e.sets, set] };
  });
}

/** Copy the previous set's values into this set. */
export function copyPreviousSet(s: S, exId: string, setId: string): S {
  const ex = s.exercises.find((e) => e.id === exId);
  if (!ex) return s;
  const i = ex.sets.findIndex((x) => x.id === setId);
  if (i <= 0) return s;
  const p = ex.sets[i - 1];
  const w = carryLoad(p.weightKg);
  return updateSet(s, exId, setId, { weightKg: w, entered: w == null ? undefined : p.entered, reps: carryPos(p.reps), durationSec: carryPos(p.durationSec), distanceM: carryPos(p.distanceM) });
}

export function removeSet(s: S, exId: string, setId: string): S {
  return mapEx(s, exId, (e) => ({ ...e, sets: e.sets.filter((x) => x.id !== setId) }));
}

/** Adjust the load of every not-yet-completed working set of an exercise. */
export function adjustPendingLoad(s: S, exId: string, deltaKg: number, entered?: (kg: number) => LoggedSet['entered']): S {
  return mapEx(s, exId, (e) => ({
    ...e,
    sets: e.sets.map((st) => {
      if (st.completed || st.type === 'warmup') return st;
      const kg = Math.max(0, (st.weightKg ?? 0) + deltaKg);
      return { ...st, weightKg: kg, entered: entered?.(kg) };
    }),
  }));
}

/* --------------------------------------------------------------- exercises */
export function addExercise(s: S, ex: Exercise, defaultSets: number, prescription?: SessionExercise['prescription']): S {
  const timed = ex.tracking === 'duration' || ex.tracking === 'distance_time';
  const n = prescription?.sets ?? (ex.tracking === 'duration' ? 3 : defaultSets);
  const sets: LoggedSet[] = Array.from({ length: Math.max(1, n) }, () => ({
    id: uuid(),
    type: workingSetType(ex),
    weightKg: ex.tracking === 'bodyweight_plus' ? 0 : null,
    reps: null,
    ...(timed ? { durationSec: prescription?.durationSec ?? null } : {}),
    completed: false,
  }));
  const se: SessionExercise = { id: uuid(), exerciseId: ex.id, order: s.exercises.length, sets };
  if (prescription) se.prescription = prescription;
  return { ...s, exercises: [...s.exercises, se] };
}

export function removeExercise(s: S, exId: string): S {
  return { ...s, exercises: s.exercises.filter((e) => e.id !== exId).map((e, i) => ({ ...e, order: i })) };
}

export function moveExercise(s: S, exId: string, dir: -1 | 1): S {
  const list = [...s.exercises];
  const i = list.findIndex((e) => e.id === exId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return s;
  [list[i], list[j]] = [list[j], list[i]];
  return { ...s, exercises: list.map((e, k) => ({ ...e, order: k })) };
}

/**
 * Swap an untouched exercise. With the new and old Exercise objects, the prescription, set fields, load
 * convention and warm-ups are rebuilt for the new tracking type (domain/substitution). Completed sets are
 * never reinterpreted: if any set is completed the session is returned unchanged (the caller adds the new
 * exercise below instead — see `addExercise` with `adaptPrescription`).
 * Back-compat: passing an id string keeps the old behaviour (prescription kept, loads cleared).
 */
export function swapExercise(s: S, exId: string, to: string | Exercise, from?: Exercise): S {
  return mapEx(s, exId, (e) => {
    if (e.sets.some((x) => x.completed)) return e;
    if (typeof to !== 'string') return adaptSessionExercise(e, from, to) ?? e;
    return {
      ...e,
      exerciseId: to,
      swappedFrom: e.swappedFrom ?? e.exerciseId,
      sets: e.sets.map((x) => ({ ...x, weightKg: null, entered: undefined })),
    };
  });
}

/** Link with the next exercise as a superset, or unlink. */
export function toggleSupersetWithNext(s: S, exId: string): S {
  const i = s.exercises.findIndex((e) => e.id === exId);
  const cur = s.exercises[i];
  const nxt = s.exercises[i + 1];
  if (!cur || !nxt) return s;
  if (cur.supersetGroup && cur.supersetGroup === nxt.supersetGroup) {
    return { ...s, exercises: s.exercises.map((e) => (e.id === nxt.id ? { ...e, supersetGroup: undefined } : e)) };
  }
  const g = cur.supersetGroup ?? uuid().slice(0, 8);
  return { ...s, exercises: s.exercises.map((e) => (e.id === cur.id || e.id === nxt.id ? { ...e, supersetGroup: g } : e)) };
}

export function setExerciseNotes(s: S, exId: string, notes: string): S {
  return mapEx(s, exId, (e) => ({ ...e, notes: notes || undefined }));
}
export function setDiscomfort(s: S, exId: string, discomfort: boolean): S {
  return mapEx(s, exId, (e) => ({ ...e, discomfort: discomfort || undefined }));
}

/* ------------------------------------------------------------------ finish */
export function incompleteSetCount(s: S): number {
  return s.exercises.reduce((n, e) => n + e.sets.filter((x) => !x.completed).length, 0);
}
export function completedSetCount(s: S): number {
  return s.exercises.reduce((n, e) => n + e.sets.filter((x) => x.completed).length, 0);
}

/**
 * Completed sets that are also valid (shared rules). Without `byId`, generic rules apply
 * (non-negative finite numbers and at least one positive measure).
 */
export function validCompletedSetCount(s: S, byId?: Map<string, Exercise>): number {
  return s.exercises.reduce((n, e) => n + e.sets.filter((x) => isValidCompletedSet(x, byId?.get(e.exerciseId))).length, 0);
}

/** Finalize: keep completed sets only, drop exercises with nothing completed, stop timers. */
export function finishSession(s: S, now: number): S {
  const resumed = s.pausedAt ? resumeSession(s, s.pausedAt) : s; // paused time doesn't count
  const endedAt = s.pausedAt ?? now;
  const exercises = resumed.exercises
    .map((e) => ({ ...e, sets: e.sets.filter((x) => x.completed) }))
    .filter((e) => e.sets.length > 0)
    .map((e, i) => ({ ...e, order: i }));
  return { ...resumed, status: 'completed', endedAt, pausedAt: undefined, rest: undefined, exercises };
}
