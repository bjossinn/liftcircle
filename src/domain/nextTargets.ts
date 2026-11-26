/**
 * The workout summary's "Next:" line per exercise — the progression engine's output (src/domain/progression.ts) for
 * the next time this exercise comes up, given history up to and including the workout being shown. Pure.
 *
 * Exercises without a prescription (added freestyle) or without counted working sets in this workout get no line,
 * the same as the in-workout progression card.
 */
import type { Exercise, Experience, ID, Settings, WorkoutSession } from './types';
import { ACTION_LABELS, nextTargetText, type Suggestion } from './progression';
import { suggestionFor } from './program/session';

export interface NextTarget {
  exerciseId: ID;
  /** "Next: 62.5 kg × 8 reps" */
  text: string;
  /** Short action label ("Increase load", "Hold", …). */
  label: string;
  suggestion: Suggestion;
}

/** One entry per exercise in the workout (first occurrence wins), keyed by exercise id. */
export function nextTargetsFor(
  session: WorkoutSession,
  history: WorkoutSession[],
  byId: Map<ID, Exercise>,
  settings: Settings,
  experience?: Experience,
): Map<ID, NextTarget> {
  const out = new Map<ID, NextTarget>();
  // History through this workout: re-opening an older summary shows the target as it stood after that workout.
  const through = [...history.filter((s) => s.id !== session.id && s.startedAt < session.startedAt), { ...session, status: 'completed' as const }];
  const unit = settings.units.weight;
  for (const se of session.exercises) {
    if (out.has(se.exerciseId) || !se.prescription) continue;
    const ex = byId.get(se.exerciseId);
    if (!ex) continue;
    const { suggestion, last } = suggestionFor({ exerciseId: se.exerciseId, ...se.prescription }, ex, through, settings, experience);
    // Only when this workout itself logged counted work for the exercise (otherwise the "next" is about an older one).
    if (last?.id !== se.id) continue;
    const text = nextTargetText(suggestion, ex, unit);
    if (text) out.set(se.exerciseId, { exerciseId: se.exerciseId, text, label: ACTION_LABELS[suggestion.action], suggestion });
  }
  return out;
}
