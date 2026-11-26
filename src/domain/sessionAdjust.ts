/**
 * Apply / undo a training assistant `session_adjustment` (roadmap item 7) on the live workout. Pure: the caller reads the
 * stored session, applies, and saves it (the program, its templates and future sessions are never touched — only this
 * one WorkoutSession record changes).
 *
 *  - shorten: removes pending WORKING sets from the end of the listed exercises and removes listed exercises that have
 *    no completed set. Completed sets are never removed (an exercise that gained one since the suggestion keeps it, and
 *    only its pending sets go).
 *  - swap: an untouched exercise is swapped in place (prescription, set fields and warm-ups rebuilt for the new
 *    exercise, like the logger's own swap). One with completed sets or a "Felt discomfort" flag keeps its row (and the
 *    flag); what's still to do moves to a new row for the replacement, right after it.
 *  - A flagged exercise is never deleted by shorten either: its row stays (without pending sets), so the finished
 *    workout still records the discomfort and progression keeps holding that exercise.
 *
 * Every apply returns an undo record holding exactly what was removed or replaced, so Undo restores it even after more
 * sets were logged elsewhere in the workout. Undo refuses (with a reason) when a set was already logged on something it
 * would remove, when that row has since become another exercise, or when the replacement was flagged "Felt discomfort"
 * (a discomfort flag is never erased).
 */
import type { SessionAdjustmentAction } from '../../supabase/functions/_shared/ai/workout';
import type { Exercise, ID, LoggedSet, SessionExercise, WorkoutSession } from './types';
import * as ops from './sessionOps';
import { adaptPrescription } from './substitution';

export interface SessionAdjustmentUndo {
  actionId: string;
  sessionId: ID;
  change: SessionAdjustmentAction['change'];
  appliedAt: number;
  /**
   * Pending sets removed from exercises that stay (restored at the end of that exercise). `exerciseId` is the exercise
   * the row held when they were removed: Undo refuses if the row has since been swapped to another exercise, so a
   * barbell load is never put back onto its dumbbell replacement.
   */
  removedSets: { seId: ID; exerciseId: ID; sets: LoggedSet[] }[];
  /**
   * Whole exercises removed. `index` is the position in the workout BEFORE this change and `afterId` the exercise that
   * preceded it then (null = first), so Undo puts them back in their exact order.
   */
  removedExercises: { index: number; afterId: ID | null; se: SessionExercise }[];
  /** swap in place: the exercise as it was, and what it was swapped to. */
  replaced?: { seId: ID; before: SessionExercise; toExerciseId: ID };
  /** swap into a new row (completed sets or flagged discomfort on the original): the row added for the remaining sets. */
  addedSeId?: ID;
}

export type ApplyResult = { ok: true; session: WorkoutSession; undo: SessionAdjustmentUndo } | { ok: false; reason: string };
export type RevertResult = { ok: true; session: WorkoutSession } | { ok: false; reason: string };

const pendingWorking = (se: SessionExercise) => se.sets.filter((x) => !x.completed && x.type !== 'warmup');
const renumber = (s: WorkoutSession): WorkoutSession => ({ ...s, exercises: s.exercises.map((e, i) => (e.order === i ? e : { ...e, order: i })) });

/** Why this change can't be applied to `session` right now (null = it can). */
export function adjustmentBlocker(session: WorkoutSession | null | undefined, action: SessionAdjustmentAction): string | null {
  if (!session || session.deletedAt) return 'This workout is no longer on this device.';
  if (session.id !== action.sessionId) return 'This change is for a different workout.';
  if (session.status !== 'active') return 'This workout is already finished, so there’s nothing to change.';
  return null;
}

export function applySessionAdjustment(session: WorkoutSession, action: SessionAdjustmentAction, byId: Map<ID, Exercise>, now = Date.now()): ApplyResult {
  const blocked = adjustmentBlocker(session, action);
  if (blocked) return { ok: false, reason: blocked };
  const undo: SessionAdjustmentUndo = { actionId: action.id, sessionId: session.id, change: action.change, appliedAt: now, removedSets: [], removedExercises: [] };

  if (action.change === 'swap') {
    const sw = action.swap;
    const se = sw ? session.exercises.find((e) => e.id === sw.sessionExerciseId) : undefined;
    if (!sw || !se) return { ok: false, reason: 'That exercise isn’t in this workout any more.' };
    if (se.exerciseId !== sw.fromExerciseId) return { ok: false, reason: `${sw.fromName} was already changed in this workout.` };
    const to = byId.get(sw.toExerciseId);
    if (!to) return { ok: false, reason: `${sw.toName} isn’t available in this app version.` };
    const from = byId.get(se.exerciseId);
    const left = pendingWorking(se);
    if (!left.length) return { ok: false, reason: `Every set of ${sw.fromName} is already done.` };
    // In place only for an untouched exercise with no safety flag. A "Felt discomfort" flag belongs to the original
    // exercise: it stays on its own row (kept in history, so progression keeps holding it) and never moves to the swap.
    if (!se.sets.some((x) => x.completed) && !se.discomfort) {
      const next = ops.swapExercise(session, se.id, to, from);
      if (next.exercises.find((e) => e.id === se.id)?.exerciseId !== to.id) return { ok: false, reason: `Couldn’t swap ${sw.fromName} for ${sw.toName} here. Use Swap exercise instead.` };
      undo.replaced = { seId: se.id, before: se, toExerciseId: to.id };
      return { ok: true, session: next, undo };
    }
    // The original row keeps its done sets (and its discomfort flag); what's still to do moves to a new row right after it.
    const drop = se.sets.filter((x) => !x.completed);
    const dropIds = new Set(drop.map((x) => x.id));
    const rx = adaptPrescription(se.prescription, from, to);
    let next = ops.addExercise(session, to, left.length, rx ? { ...rx, sets: left.length } : undefined);
    const added = next.exercises[next.exercises.length - 1];
    const idx = next.exercises.findIndex((e) => e.id === se.id);
    const others = next.exercises.filter((e) => e.id !== added.id).map((e) => (e.id === se.id ? { ...e, sets: e.sets.filter((x) => !dropIds.has(x.id)) } : e));
    others.splice(idx + 1, 0, added);
    next = renumber({ ...next, exercises: others });
    undo.removedSets.push({ seId: se.id, exerciseId: se.exerciseId, sets: drop });
    undo.addedSeId = added.id;
    return { ok: true, session: next, undo };
  }

  // shorten. Positions are taken from the workout as it was BEFORE this change.
  const original = session.exercises;
  let exercises = [...original];
  let changed = false;
  const removeSetsFrom = (se: SessionExercise, drop: LoggedSet[]) => {
    const ids = new Set(drop.map((x) => x.id));
    exercises = exercises.map((e) => (e.id === se.id ? { ...e, sets: e.sets.filter((x) => !ids.has(x.id)) } : e));
    undo.removedSets.push({ seId: se.id, exerciseId: se.exerciseId, sets: drop });
    changed = true;
  };
  for (const r of action.removeSets) {
    const se = exercises.find((e) => e.id === r.sessionExerciseId);
    if (!se) continue;
    const drop = pendingWorking(se).slice(-Math.max(0, r.count));
    if (drop.length) removeSetsFrom(se, drop);
  }
  for (const d of action.dropExercises) {
    const index = original.findIndex((e) => e.id === d.sessionExerciseId);
    const se = exercises.find((e) => e.id === d.sessionExerciseId);
    if (index < 0 || !se) continue;
    if (se.sets.some((x) => x.completed) || se.discomfort) {
      // Done sets (logged since the suggestion) or a discomfort flag: the row stays (finished workouts keep flagged rows
      // so progression keeps holding the exercise); only what's still to do goes.
      const drop = se.sets.filter((x) => !x.completed);
      if (drop.length) removeSetsFrom(se, drop);
      continue;
    }
    exercises = exercises.filter((e) => e.id !== se.id);
    undo.removedExercises.push({ index, afterId: index > 0 ? original[index - 1].id : null, se });
    if (session.rest?.forExerciseId === se.id) session = ops.skipRest(session);
    changed = true;
  }
  if (!changed) return { ok: false, reason: 'Your workout changed since this suggestion. Ask again for an updated one.' };
  return { ok: true, session: renumber({ ...session, exercises }), undo };
}

/** Undo would delete or overwrite the row holding a "Felt discomfort" flag; that safety signal is never erased. */
export const DISCOMFORT_KEEPS_SWAP = 'You flagged discomfort on the new exercise, so the swap stays (the flag is kept for your next sessions).';

export function revertSessionAdjustment(session: WorkoutSession, undo: SessionAdjustmentUndo): RevertResult {
  if (!session || session.deletedAt || session.id !== undo.sessionId) return { ok: false, reason: 'This workout is no longer on this device.' };
  if (session.status !== 'active') return { ok: false, reason: 'This workout is already finished, so it can’t be undone here. Edit it from your history instead.' };
  let exercises = [...session.exercises];

  // Check everything first, so Undo either restores all of it or nothing.
  for (const r of undo.removedSets) {
    const cur = exercises.find((e) => e.id === r.seId);
    if (cur && cur.exerciseId !== r.exerciseId) return { ok: false, reason: 'That exercise was swapped since, so this change can’t be undone. Adjust the sets yourself.' };
  }
  if (undo.replaced) {
    const cur = exercises.find((e) => e.id === undo.replaced!.seId);
    if (!cur) return { ok: false, reason: 'That exercise was removed from the workout since.' };
    if (cur.exerciseId !== undo.replaced.toExerciseId) return { ok: false, reason: 'That exercise was changed again since, so this swap can’t be undone.' };
    if (cur.sets.some((x) => x.completed)) return { ok: false, reason: 'You’ve logged sets on the new exercise, so the swap stays.' };
    if (cur.discomfort) return { ok: false, reason: DISCOMFORT_KEEPS_SWAP };
  }
  if (undo.addedSeId) {
    const added = exercises.find((e) => e.id === undo.addedSeId);
    if (added?.sets.some((x) => x.completed)) return { ok: false, reason: 'You’ve logged sets on the new exercise, so the swap stays.' };
    if (added?.discomfort) return { ok: false, reason: DISCOMFORT_KEEPS_SWAP };
  }

  if (undo.replaced) exercises = exercises.map((e) => (e.id === undo.replaced!.seId ? { ...undo.replaced!.before, order: e.order } : e));
  if (undo.addedSeId) exercises = exercises.filter((e) => e.id !== undo.addedSeId);
  for (const r of undo.removedSets) {
    exercises = exercises.map((e) => {
      if (e.id !== r.seId) return e;
      const have = new Set(e.sets.map((x) => x.id));
      return { ...e, sets: [...e.sets, ...r.sets.filter((x) => !have.has(x.id))] };
    });
  }
  // Ascending original position: each one's predecessor is already back, so the order is exact.
  for (const r of [...undo.removedExercises].sort((a, b) => a.index - b.index)) {
    if (exercises.some((e) => e.id === r.se.id)) continue;
    const after = r.afterId === null ? -1 : exercises.findIndex((e) => e.id === r.afterId);
    const at = r.afterId === null ? 0 : after >= 0 ? after + 1 : Math.min(r.index, exercises.length);
    exercises.splice(at, 0, r.se);
  }
  return { ok: true, session: renumber({ ...session, exercises }) };
}

/** Plain-language lines for the preview card ("What changes today"). */
export function adjustmentLines(action: SessionAdjustmentAction): string[] {
  if (action.change === 'swap' && action.swap) return [`${action.swap.fromName} → ${action.swap.toName}`];
  return [
    ...action.dropExercises.map((d) => `Skip ${d.name}`),
    ...action.removeSets.map((r) => `${r.name}: ${r.count} fewer set${r.count === 1 ? '' : 's'}`),
  ];
}
