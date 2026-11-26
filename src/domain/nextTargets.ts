/**
 * The workout summary's "Next:" line per exercise — the progression engine's output (src/domain/progression.ts) for
 * the next time this exercise comes up, given history up to and including the workout being shown. Pure.
 *
 * Exercises without a prescription (added freestyle), or without counted working sets and no discomfort flag in this
 * workout, get no line, the same as the in-workout progression card.
 *
 * Text is rendered in the display language from the engine's own result (never re-computed, never parsed).
 */
import type { Exercise, Experience, ID, Settings, WorkoutSession } from './types';
import { actionLabel, comparableHistory, effortCaveat, nextTargetText, suggestionReasonText, type Suggestion } from './progression';
import { suggestionFor } from './program/session';
import { getLanguage, type Language } from '@/i18n';

export interface NextTarget {
  exerciseId: ID;
  /** "Next: 62.5 kg × 8 reps" */
  text: string;
  /** Short action label ("Increase load", "Hold", …). */
  label: string;
  /** The engine's condition when effort wasn't logged ("…increase only if…"), or null. */
  caveat: string | null;
  /** The engine's reason in the display language (complete sentence; increases end with one effort sentence). */
  reason: string;
  suggestion: Suggestion;
}

/** One entry per exercise in the workout (first occurrence wins), keyed by exercise id. */
export function nextTargetsFor(
  session: WorkoutSession,
  history: WorkoutSession[],
  byId: Map<ID, Exercise>,
  settings: Settings,
  experience?: Experience,
  /** Display language for text/label/caveat/reason (default: the app's current language). Numbers never change. */
  lang: Language = getLanguage(),
): Map<ID, NextTarget> {
  const out = new Map<ID, NextTarget>();
  // History through this workout: re-opening an older summary shows the target as it stood after that workout.
  const through = [...history.filter((s) => s.id !== session.id && s.startedAt < session.startedAt), { ...session, status: 'completed' as const }];
  const unit = settings.units.weight;
  for (const se of session.exercises) {
    if (out.has(se.exerciseId) || !se.prescription) continue;
    const ex = byId.get(se.exerciseId);
    if (!ex) continue;
    // Only when this workout itself is the newest entry for the exercise: counted work, or a discomfort flag (otherwise
    // the "next" would be about an older workout).
    if (comparableHistory(through, se.exerciseId)[0]?.id !== se.id) continue;
    const { suggestion } = suggestionFor({ exerciseId: se.exerciseId, ...se.prescription }, ex, through, settings, experience);
    const text = nextTargetText(suggestion, ex, unit, lang);
    if (text)
      out.set(se.exerciseId, {
        exerciseId: se.exerciseId,
        text,
        label: actionLabel(suggestion.action, lang),
        caveat: effortCaveat(suggestion, se.prescription.targetRir, lang),
        reason: suggestionReasonText(suggestion, lang),
        suggestion,
      });
  }
  return out;
}
