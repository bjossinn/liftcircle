/**
 * Roadmap item 2: progression.ts is the single source of truth for load progression.
 * - the beginner rule (one successful session instead of two, "successful" judged exactly like double progression),
 * - the workout summary's "Next:" line is the engine's output,
 * - the training assistant's grounding quotes the same engine (no server-side copy of the rule),
 * - the rule's wording comes from the engine everywhere it is described,
 * - follow-up: a meal-plan item's swaps travel with its recipe link.
 */
import { describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { RECIPES_BY_ID } from '@/data/recipes';
import {
  comparableHistory, isBeginner, isSuccessfulSession, nextTargetLabel, nextTargetText, progressionRuleText, suggestNext, type Suggestion,
} from '@/domain/progression';
import { nextTargetsFor } from '@/domain/nextTargets';
import { generateProgram } from '@/domain/program/generator';
import { defaultSettings } from '@/state/defaults';
import type { Exercise, LoggedSet, SessionExercise, WorkoutSession } from '@/domain/types';
import { progressionHint, trainingSessions } from '../../supabase/functions/_shared/ai/context';
import { normalizeProposedProgram } from '../../supabase/functions/_shared/ai/validate';
import { TOOL_DEFS } from '../../supabase/functions/_shared/ai/tools';
import { recipeLink } from '@/features/nutrition/recipeLink';
import { linkSwaps } from '@/features/nutrition/RecipeDetailPage';
import { LEFT_OUT } from '@/domain/nutrition/recipes';

const ex = (id: string) => {
  const e = EXERCISES.find((x) => x.id === id);
  if (!e) throw new Error(`missing ${id}`);
  return e as Exercise;
};
const squat = ex('barbell-back-squat');
const assisted = ex('assisted-pull-up');
const dip = ex('weighted-dip');
const plank = EXERCISES.find((e) => e.tracking === 'duration')!;
const rx = { sets: 3, repMin: 8, repMax: 12, targetRir: 2 };
const KG = { unit: 'kg' as const };
const BEGINNER = { unit: 'kg' as const, beginner: true };

let n = 0;
type S = { w?: number | null; r?: number | null; rir?: number | null; d?: number };
const sets = (k: number, s: S): LoggedSet[] =>
  Array.from({ length: k }, () => ({ id: `set${n++}`, type: 'normal', weightKg: s.w ?? null, reps: s.r ?? null, rir: s.rir ?? null, durationSec: s.d ?? null, completed: true }));
const se = (exerciseId: string, ss: LoggedSet[], extra: Partial<SessionExercise> = {}): SessionExercise => ({
  id: `se${n++}`, exerciseId, order: 0, prescription: { ...rx, restSec: 90 }, sets: ss, ...extra,
});
let day = 1;
const session = (exercises: SessionExercise[], over: Partial<WorkoutSession> = {}): WorkoutSession => {
  const d = day++;
  return {
    id: `w${d}`, createdAt: d, updatedAt: d, name: 'Lower', status: 'completed', date: `2026-11-${String(d).padStart(2, '0')}`, timeZone: 'UTC',
    startedAt: Date.parse(`2026-11-${String(d).padStart(2, '0')}T17:00:00Z`), pausedTotalMs: 0, exercises, ...over,
  };
};

describe('beginner rule (one successful session instead of two)', () => {
  const top = () => se(squat.id, sets(3, { w: 60, r: 12, rir: 2 }));

  it('isBeginner: new and returning lifters only (the same test program generation uses)', () => {
    expect(isBeginner('new')).toBe(true);
    expect(isBeginner('returning')).toBe(true);
    expect(isBeginner('intermediate')).toBe(false);
    expect(isBeginner('advanced')).toBe(false);
    expect(isBeginner(undefined)).toBe(false);
  });

  it('one successful session: beginners get the increase, everyone else is asked to repeat once', () => {
    const regular = suggestNext(squat, rx, [top()], KG);
    expect(regular.action).toBe('hold');
    const b = suggestNext(squat, rx, [top()], BEGINNER);
    expect(b).toMatchObject({ action: 'increase_load', loadKg: 62.5, targetReps: 8, effortBasis: 'recorded' });
    expect(b.reason).toMatch(/beginner rule/);
  });

  it('two successful sessions: both get the same increase (the beginner rule only shortens the wait)', () => {
    const h = [top(), top()];
    expect(suggestNext(squat, rx, h, KG)).toMatchObject({ action: 'increase_load', loadKg: 62.5 });
    expect(suggestNext(squat, rx, h, BEGINNER)).toMatchObject({ action: 'increase_load', loadKg: 62.5 });
  });

  it('"successful" is the double-progression test: every set at the load, top reps, intended effort, load recorded', () => {
    const cases: [string, SessionExercise][] = [
      ['one set short of the top', se(squat.id, [...sets(2, { w: 60, r: 12 }), ...sets(1, { w: 60, r: 11 })])],
      ['too few sets', se(squat.id, sets(2, { w: 60, r: 12 }))],
      ['grinding past the target effort (RIR 0 vs target 2)', se(squat.id, sets(3, { w: 60, r: 12, rir: 0 }))],
      ['a set lighter than the session load', se(squat.id, [...sets(2, { w: 60, r: 12 }), ...sets(1, { w: 50, r: 12 })])],
    ];
    for (const [why, h0] of cases) {
      expect(isSuccessfulSession(h0, rx, 60, squat), why).toBe(false);
      expect(suggestNext(squat, rx, [h0], BEGINNER).action, why).not.toBe('increase_load');
    }
    expect(isSuccessfulSession(top(), rx, 60, squat)).toBe(true);
  });

  it('the engine increases exactly when the latest session(s) are successful (1 for beginners, 2 otherwise)', () => {
    const variants = [top(), se(squat.id, sets(3, { w: 60, r: 10 })), se(squat.id, sets(3, { w: 60, r: 12, rir: 0 }))];
    for (const a of variants) for (const b of variants) {
      const ok = (x: SessionExercise) => isSuccessfulSession(x, rx, 60, squat);
      expect(suggestNext(squat, rx, [a, b], BEGINNER).action === 'increase_load').toBe(ok(a));
      expect(suggestNext(squat, rx, [a, b], KG).action === 'increase_load').toBe(ok(a) && ok(b));
    }
  });

  it('unlogged effort still asks for confirmation; discomfort still wins', () => {
    expect(suggestNext(squat, rx, [se(squat.id, sets(3, { w: 60, r: 12 }))], BEGINNER).effortBasis).toBe('not_recorded');
    expect(suggestNext(squat, rx, [se(squat.id, sets(3, { w: 60, r: 12 }), { discomfort: true })], BEGINNER).action).toBe('discomfort_hold');
  });

  it('assisted lifts: beginners use less assistance after one successful session', () => {
    const h = [se(assisted.id, sets(3, { w: 30, r: 12 }))];
    expect(suggestNext(assisted, rx, h, KG).action).toBe('add_reps'); // same assistance, build consistency
    expect(suggestNext(assisted, rx, h, BEGINNER)).toMatchObject({ action: 'reduce_assistance', loadKg: 25 });
  });

  it('the rule is described by the engine: generator rationale and wording follow the beginner flag', () => {
    expect(progressionRuleText(true)).toMatch(/one good session is enough/);
    expect(progressionRuleText(false)).toMatch(/in two sessions/);
    const base = { displayName: 'T', units: { weight: 'kg', length: 'cm', distance: 'km' }, goal: 'build_muscle', totalDaysPerWeek: 3, liftingDaysPerWeek: 3, availableWeekdays: [1, 3, 5], preferredLiftingWeekdays: [1, 3, 5], sessionMinutes: 60, location: 'full_gym', equipment: [], preferredActivities: [], enjoyedExerciseIds: [], excludedExerciseIds: [], limitations: [], activityLevel: 'moderate', wantsNutrition: false, diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 } } as const;
    const g = (experience: 'new' | 'advanced') => generateProgram({ ...base, experience } as never, EXERCISES, { startDate: '2026-11-30' }).rationale;
    expect(g('new')).toContain(progressionRuleText(true));
    expect(g('advanced')).toContain(progressionRuleText(false));
  });
});

describe('workout summary: "Next:" is the engine’s target', () => {
  const settings = defaultSettings();
  const byId = new Map(EXERCISES.map((e) => [e.id, e]));

  it('shows the engine’s next load after two successful sessions (and for beginners after one)', () => {
    day = 1;
    const w1 = session([se(squat.id, sets(3, { w: 60, r: 12, rir: 2 }))]);
    const w2 = session([se(squat.id, sets(3, { w: 60, r: 12, rir: 2 }))]);
    const all = [w1, w2];
    expect(nextTargetsFor(w2, all, byId, settings).get(squat.id)).toMatchObject({ text: 'Next: 62.5 kg × 8 reps', label: 'Increase load' });
    // Re-opening the first workout's summary: the state after that workout (repeat once more)…
    expect(nextTargetsFor(w1, all, byId, settings).get(squat.id)).toMatchObject({ text: 'Next: 60 kg × 12 reps', label: 'Hold' });
    // …unless the user is a beginner.
    expect(nextTargetsFor(w1, all, byId, settings, 'new').get(squat.id)?.text).toBe('Next: 62.5 kg × 8 reps');
  });

  it('is exactly the suggestion the next workout pre-fills (same engine call)', () => {
    day = 1;
    const w1 = session([se(squat.id, sets(3, { w: 60, r: 10 }))]);
    const t = nextTargetsFor(w1, [w1], byId, settings)!.get(squat.id)!;
    const direct = suggestNext(squat, rx, comparableHistory([w1], squat.id), KG);
    expect(t.suggestion).toEqual(direct);
    expect(t.text).toBe(`Next: ${nextTargetLabel(direct, squat, 'kg')}`);
  });

  it('respects display units', () => {
    day = 1;
    const w = session([se(squat.id, sets(3, { w: 60, r: 12 }))]);
    const lb = { ...settings, units: { ...settings.units, weight: 'lb' as const } };
    expect(nextTargetsFor(w, [w], byId, lb, 'new').get(squat.id)?.text).toBe('Next: 135 lb × 8 reps'); // 132.3 lb → next 5 lb step
  });

  it('no line for exercises without a prescription or without counted work in this workout', () => {
    day = 1;
    const freestyle = se(squat.id, sets(3, { w: 60, r: 12 }), { prescription: undefined });
    const empty = se(dip.id, [{ id: 'x', type: 'normal', weightKg: 10, reps: 0, completed: true }]);
    const w = session([freestyle, empty]);
    expect(nextTargetsFor(w, [w], byId, settings).size).toBe(0);
  });

  it('formats every tracking type from the engine’s output', () => {
    const s = (p: Partial<Suggestion>): Suggestion => ({ action: 'hold', reason: '', ...p });
    expect(nextTargetText(s({ loadKg: 5, targetReps: 6 }), dip, 'kg')).toBe('Next: +5 kg × 6 reps');
    expect(nextTargetText(s({ loadKg: 0, targetReps: 10 }), dip, 'kg')).toBe('Next: bodyweight × 10 reps');
    expect(nextTargetText(s({ loadKg: 20, targetReps: 8 }), assisted, 'kg')).toBe('Next: 20 kg assistance × 8 reps');
    expect(nextTargetText(s({ durationSec: 45 }), plank, 'kg')).toBe('Next: 45 s');
    expect(nextTargetText(s({ action: 'calibrate', loadKg: null }), squat, 'kg')).toBe('Next: find your starting load');
  });
});

describe('training assistant: grounded in the same engine', () => {
  const toRows = (ws: WorkoutSession[]) => trainingSessions(ws as never);

  it('the server line carries the app’s target for the same history (loaded, bodyweight+, assisted; beginner or not)', () => {
    day = 1;
    const cases: [Exercise, LoggedSet[]][] = [
      [squat, sets(3, { w: 60, r: 12 })],
      [squat, sets(3, { w: 60, r: 9 })],
      [dip, sets(3, { w: 0, r: 12 })],
      [assisted, sets(3, { w: 30, r: 12 })],
    ];
    for (const [e, ss] of cases) for (const beginner of [false, true]) {
      const ws = [session([se(e.id, ss)]), session([se(e.id, ss.map((x) => ({ ...x, reps: (x.reps ?? 0) - 1 })))])];
      const app = suggestNext(e, rx, comparableHistory(ws, e.id), { unit: 'kg', beginner });
      const line = progressionHint(e as never, rx, toRows(ws), { unit: 'kg', beginner })!;
      expect(line, `${e.id} beginner=${beginner}`).toContain(`next: ${nextTargetLabel(app, e, 'kg')}`);
      expect(line).toContain(app.reason);
    }
  });

  it('uses the user’s plate increment like the app does (barbell lifts without their own increment, e.g. custom ones)', () => {
    day = 1;
    const custom: Exercise = { ...squat, id: 'my-barbell-lift', name: 'My barbell lift', increment: undefined, custom: true };
    const ws = [session([se(custom.id, sets(3, { w: 60, r: 12 }))])];
    const plates = { plateIncrementKg: 1, plateIncrementLb: 2.5 };
    expect(progressionHint(custom as never, rx, toRows(ws), { unit: 'kg', beginner: true, plates })).toContain('next: 61 kg × 8 reps');
    const app = nextTargetsFor(ws[0], ws, new Map([[custom.id, custom]]), { ...defaultSettings(), workout: { ...defaultSettings().workout, ...plates } }, 'new');
    expect(app.get(custom.id)?.text).toBe('Next: 61 kg × 8 reps');
  });

  it('AI proposals can’t carry their own progression scheme', () => {
    const tool = TOOL_DEFS.find((t) => t.name === 'propose_program_change')!;
    expect(JSON.stringify(tool.input_schema)).not.toContain('progressionNotes');
    const p = normalizeProposedProgram({ name: 'X', weeks: 4, templates: [], schedule: [], progressionNotes: 'Add 5 kg every session.' });
    expect((p as { progressionNotes?: string }).progressionNotes).toBeUndefined();
  });
});

describe('meal plan: opening a saved item keeps its swaps', () => {
  it('the plan item’s swaps travel in the recipe link and the recipe screen accepts them back unchanged', () => {
    const r = RECIPES_BY_ID.get('skyr-berry-oat-bowl')!;
    const swaps = [{ from: 'blueberries', to: 'strawberries' }, { from: 'honey', to: LEFT_OUT }];
    const href = recipeLink(r.id, swaps);
    expect(href).toBe('/nutrition/recipes/skyr-berry-oat-bowl?swap=blueberries:strawberries,honey:__left_out__');
    expect(linkSwaps(r, new URL(href, 'https://x').searchParams.get('swap'))).toEqual(swaps);
    expect(recipeLink(r.id, undefined)).toBe('/nutrition/recipes/skyr-berry-oat-bowl');
  });
});
