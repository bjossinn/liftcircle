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
import type { Exercise, ID, LoggedSet, WorkoutSession } from './types';
import {
  validateLoggedSet as validateLoggedSetShared,
  type SetValidationOptions,
  type SetValidationResult,
} from '../../supabase/functions/_shared/training/sets';
import { getLanguage, t } from '../i18n';

// The per-set rules live in the shared training module so the ai-coach function counts sets exactly like the app.
export * from '../../supabase/functions/_shared/training/sets';

/**
 * The shared set rules, with error messages in the app's current language (unless `opts.lang` is given). The result
 * (ok / which fields failed) never depends on the language.
 */
export function validateLoggedSet(set: LoggedSet, ex: Parameters<typeof validateLoggedSetShared>[1], opts: SetValidationOptions = {}): SetValidationResult {
  return validateLoggedSetShared(set, ex, { ...opts, lang: opts.lang ?? getLanguage() });
}

const present = (v: number | null | undefined): v is number => v != null;

/** Problems with a session record (empty array = fine). Used for import and historical edits. */
export function validateSessionRecord(session: WorkoutSession, exById: Map<ID, Exercise>): string[] {
  const issues: string[] = [];
  if (!session || typeof session !== 'object') return [t('workout.validation.notSession')];
  if (!Array.isArray(session.exercises)) return [t('workout.validation.noExerciseList')];
  session.exercises.forEach((se, i) => {
    if (!se || !Array.isArray(se.sets)) {
      issues.push(t('workout.validation.missingSets', { index: i + 1 }));
      return;
    }
    const ex = exById.get(se.exerciseId);
    const name = ex?.name ?? se.exerciseId ?? t('workout.validation.exerciseIndex', { index: i + 1 });
    se.sets.forEach((st, j) => {
      const r = validateLoggedSet(st, ex, { mode: 'record' });
      if (!r.ok) issues.push(t('workout.validation.setErrors', { exercise: name, index: j + 1, errors: r.errors.join(' ') }));
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
