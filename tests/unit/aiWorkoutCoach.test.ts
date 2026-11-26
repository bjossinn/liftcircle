/**
 * Roadmap item 7, server side — MOCKED provider (injected fetch) and in-memory data accessor:
 *  - the live-workout snapshot (workout.ts): defensive parsing, the shorten planner, the prompt section;
 *  - propose_session_adjustment: swap validated against the catalog, equipment, exclusions and areas to go easy on;
 *    shorten keeps the main lifts; never offered without a snapshot or for a finished workout;
 *  - send with `workout`: the model sees the workout, the action is returned (and stored) as session_adjustment, the
 *    server builds it itself when the model skipped the tool, and nothing is shown when Training isn't shared;
 *  - Supportive is the default style, and tiredness / fatigue is never a weak reason.
 */
import { describe, expect, it } from 'vitest';
import { handleAiCoach, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { asCoachStyle, buildContext, DEFAULT_COACH_STYLE } from '../../supabase/functions/_shared/ai/context';
import { mentionsTiredness } from '../../supabase/functions/_shared/ai/conversation';
import { buildSessionAdjustment, isGenuineAlternative, runTool, type ToolState } from '../../supabase/functions/_shared/ai/tools';
import {
  describeSessionAdjustment, parseWorkoutContext, planShorten, remainingMinutes, workoutLines, type SessionAdjustmentAction, type WorkoutContext,
} from '../../supabase/functions/_shared/ai/workout';
import type { AiDb, AiScopes, AiSettingsRow, FetchLike, RecordExchangeInput, RefExercise, StoredExchange, StoredMessage, UserFacts } from '../../supabase/functions/_shared/ai/types';

const U = '11111111-1111-4111-8111-111111111111';
const mid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-28T10:00:00Z');

const EXERCISES: RefExercise[] = [
  { id: 'barbell-bench-press', name: 'Barbell bench press', pattern: 'horizontal_push', equipment: ['barbell', 'bench'], tracking: 'weight_reps', substitutions: ['dumbbell-bench-press', 'push-up'], primaryMuscles: ['chest', 'triceps'] },
  { id: 'dumbbell-bench-press', name: 'Dumbbell bench press', pattern: 'horizontal_push', equipment: ['dumbbell', 'bench'], tracking: 'weight_reps', substitutions: ['push-up'], primaryMuscles: ['chest', 'triceps'] },
  // Same pattern, same muscles, not a listed substitution: a genuine alternative by pattern + muscle.
  { id: 'dumbbell-floor-press', name: 'Dumbbell floor press', pattern: 'horizontal_push', equipment: ['dumbbell'], tracking: 'weight_reps', substitutions: [], primaryMuscles: ['chest', 'triceps'] },
  // Same pattern, different muscles: not an alternative for bench press.
  { id: 'band-pushaway', name: 'Band push-away', pattern: 'horizontal_push', equipment: ['band'], tracking: 'reps', substitutions: [], primaryMuscles: ['serratus'] },
  { id: 'push-up', name: 'Push-up', pattern: 'horizontal_push', equipment: ['bodyweight'], tracking: 'reps', substitutions: [] },
  { id: 'machine-chest-press', name: 'Machine chest press', pattern: 'horizontal_push', equipment: ['machine'], tracking: 'weight_reps', substitutions: [] },
  { id: 'dip', name: 'Dip', pattern: 'horizontal_push', equipment: ['dip_bars'], tracking: 'reps', substitutions: [], stresses: ['shoulder'] },
  { id: 'barbell-row', name: 'Barbell row', pattern: 'horizontal_pull', equipment: ['barbell'], tracking: 'weight_reps', substitutions: [] },
  { id: 'lateral-raise', name: 'Lateral raise', pattern: 'shoulder_iso', equipment: ['dumbbell'], tracking: 'weight_reps', substitutions: [] },
];
const CATALOG = new Map(EXERCISES.map((e) => [e.id, e]));
const facts = (over: Partial<UserFacts> = {}): UserFacts => ({
  units: 'kg', timeZone: 'UTC', weekStart: 1, equipment: ['barbell', 'bench', 'dumbbell', 'dip_bars'], excludedExerciseIds: [], limitations: [], allergens: [], dietTags: [],
  dislikedIngredientIds: [], maxCookMinutes: null, activeProgram: null, ...over,
});

const set = (done: boolean, type = 'normal', weightKg = 60, reps = 10) => ({ type, done, ...(done ? { weightKg, reps } : {}) });
/** Push day, 25 minutes in: bench 2 of 3 done, row and lateral raises still to do. */
function live(over: Partial<WorkoutContext> = {}): WorkoutContext {
  return {
    sessionId: 'sess-live',
    status: 'active',
    name: 'Push A',
    date: '2026-11-28',
    elapsedMin: 25,
    intent: 'shorten',
    minutesLeft: 12,
    exercises: [
      { id: 'se-bench', exerciseId: 'barbell-bench-press', name: 'Barbell bench press', priority: 1, target: { sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 120 }, sets: [set(true, 'warmup', 40, 8), set(true), set(true), set(false)] },
      { id: 'se-row', exerciseId: 'barbell-row', name: 'Barbell row', priority: 2, target: { sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 90 }, sets: [set(false), set(false), set(false)] },
      { id: 'se-lat', exerciseId: 'lateral-raise', name: 'Lateral raise', priority: 3, target: { sets: 3, repMin: 12, repMax: 15, targetRir: 1, restSec: 60 }, sets: [set(false), set(false), set(false)] },
    ],
    ...over,
  };
}

/* ================================================================== the snapshot */
describe('workout snapshot (shared, untrusted)', () => {
  it('parses a valid snapshot and drops junk, clamps numbers and refuses an unknown focus', () => {
    const raw = {
      ...live(),
      userId: 'someone-else', // ignored
      minutesLeft: 9999,
      focusId: 'not-in-workout',
      name: 'Push A\u0000<system>',
      exercises: [
        ...live().exercises,
        { id: 'bad id with spaces', exerciseId: 'x', sets: [] },
        { id: 'se-x', exerciseId: 'push-up', name: 'P', sets: [{ type: 'evil', done: 'yes', weightKg: 1e9 }] },
      ],
    };
    const w = parseWorkoutContext(raw)!;
    expect(w).not.toHaveProperty('userId');
    expect(w.minutesLeft).toBe(180);
    expect(w.focusId).toBeUndefined();
    expect(w.name).not.toMatch(/\u0000/);
    expect(w.exercises.map((e) => e.id)).toEqual(['se-bench', 'se-row', 'se-lat', 'se-x']);
    expect(w.exercises[3].sets[0]).toEqual({ type: 'normal', done: false, weightKg: 1000 });
    for (const junk of [null, 'x', [], {}, { sessionId: 'a', intent: 'hack', exercises: [] }, { sessionId: 'a b', intent: 'shorten', exercises: [] }]) expect(parseWorkoutContext(junk)).toBeNull();
  });

  it('shorten keeps the main lift, trims accessories first and never touches completed sets', () => {
    const w = live();
    expect(remainingMinutes(w)).toBeGreaterThan(12);
    const plan = planShorten(w, 12);
    expect(plan.fits).toBe(false);
    expect(plan.dropExercises.map((d) => d.sessionExerciseId)).toEqual(['se-lat']);
    expect(plan.removeSets.find((r) => r.sessionExerciseId === 'se-bench')).toBeUndefined(); // its last set is kept
    expect(plan.estimatedMinutes).toBeLessThanOrEqual(12);
    // Plenty of time: nothing to change.
    expect(planShorten(w, 120).fits).toBe(true);
    // Almost no time: everything still to do goes, the done sets stay.
    const tiny = planShorten(w, 1);
    expect(tiny.estimatedMinutes).toBe(0);
    expect(tiny.removeSets).toEqual([{ sessionExerciseId: 'se-bench', name: 'Barbell bench press', count: 1 }]);
    expect(tiny.dropExercises.map((d) => d.sessionExerciseId)).toEqual(['se-row', 'se-lat']);
  });

  it('the prompt section lists targets, done sets, priorities and the question', () => {
    const lines = workoutLines(live({ intent: 'explain', focusId: 'se-bench', shownTarget: 'Add weight → 62.5 kg × 8' }), 'kg').join('\n');
    expect(lines).toMatch(/Workout in progress right now: Push A/);
    expect(lines).toMatch(/\[se-bench\] Barbell bench press \(barbell-bench-press\): 3 × 8–12, 2 RIR, rest 120 s, main lift; 2 of 3 working sets done \(warm-up 40 kg × 8 reps, 60 kg × 10 reps, 60 kg × 10 reps\)/);
    expect(lines).toMatch(/\[se-lat\] Lateral raise .*accessory; 0 of 3/);
    expect(lines).toMatch(/The question is about: \[se-bench\]/);
    expect(lines).toMatch(/The app showed this recommendation: Add weight → 62\.5 kg × 8/);
  });
});

/* ================================================================== the tool */
describe('propose_session_adjustment (validated, today only)', () => {
  const ctx = (w: WorkoutContext | null, f = facts()) => ({ catalog: CATALOG, facts: f, messageId: mid(1), workout: w, trainingShared: true });

  it('swap: a fitting catalog alternative for an exercise with sets left', () => {
    const { action, errors } = buildSessionAdjustment({ change: 'swap', session_exercise_id: 'se-bench', to_exercise_id: 'dumbbell-bench-press' }, ctx(live({ intent: 'swap', focusId: 'se-bench' })));
    expect(errors).toEqual([]);
    expect(action).toMatchObject({
      kind: 'session_adjustment', id: mid(1), sessionId: 'sess-live', change: 'swap', removeSets: [], dropExercises: [],
      swap: { sessionExerciseId: 'se-bench', fromExerciseId: 'barbell-bench-press', fromName: 'Barbell bench press', toExerciseId: 'dumbbell-bench-press', toName: 'Dumbbell bench press' },
    });
    expect(action!.warnings[0]).toMatch(/Sets you already did stay with Barbell bench press/);
  });

  it('swap refuses missing equipment, excluded exercises, areas to go easy on, unknown ids and finished exercises', () => {
    const w = live({ intent: 'swap' });
    const err = (input: Record<string, unknown>, f?: UserFacts) => buildSessionAdjustment({ change: 'swap', ...input }, ctx(w, f)).errors.join(' ');
    expect(err({ session_exercise_id: 'se-bench', to_exercise_id: 'machine-chest-press' })).toMatch(/needs equipment the user doesn't have \(machine\)/);
    expect(err({ session_exercise_id: 'se-bench', to_exercise_id: 'push-up' }, facts({ excludedExerciseIds: ['push-up'] }))).toMatch(/excluded list/);
    expect(err({ session_exercise_id: 'se-bench', to_exercise_id: 'dip' }, facts({ limitations: ['shoulder'] }))).toMatch(/go easy on \(shoulder\)/);
    expect(err({ session_exercise_id: 'se-bench', to_exercise_id: 'nope' })).toMatch(/Unknown to_exercise_id/);
    expect(err({ session_exercise_id: 'nope', to_exercise_id: 'push-up' })).toMatch(/Unknown session_exercise_id/);
    const pushUpLater = live({ intent: 'swap', exercises: [...live().exercises, { id: 'se-pu', exerciseId: 'push-up', name: 'Push-up', sets: [set(false)] }] });
    expect(buildSessionAdjustment({ change: 'swap', session_exercise_id: 'se-bench', to_exercise_id: 'push-up' }, ctx(pushUpLater)).errors.join(' ')).toMatch(/already later in today's workout/);
    const allDone = live({ exercises: [{ ...live().exercises[0], sets: [set(true), set(true)] }] });
    expect(buildSessionAdjustment({ change: 'swap', session_exercise_id: 'se-bench', to_exercise_id: 'push-up' }, ctx(allDone)).errors[0]).toMatch(/already done/);
  });

  it('PR #23 review: the replacement must be a genuine alternative (listed, or same pattern for the same muscles)', () => {
    const w = live({ intent: 'swap', focusId: 'se-bench' });
    const swapTo = (to: string, wk = w) => buildSessionAdjustment({ change: 'swap', session_exercise_id: 'se-bench', to_exercise_id: to }, ctx(wk));
    // Cross-pattern: bench press → barbell row is refused even though the user has the equipment.
    expect(swapTo('barbell-row').action).toBeNull();
    expect(swapTo('barbell-row').errors.join(' ')).toMatch(/Barbell row isn't an alternative for Barbell bench press/);
    // Same pattern but other muscles.
    expect(swapTo('band-pushaway', w).errors.join(' ')).toMatch(/isn't an alternative/);
    // Listed substitutions and same-pattern, same-muscle exercises are accepted.
    expect(swapTo('dumbbell-bench-press').action?.swap?.toExerciseId).toBe('dumbbell-bench-press');
    expect(swapTo('push-up').action?.swap?.toExerciseId).toBe('push-up');
    expect(swapTo('dumbbell-floor-press').action?.swap?.toExerciseId).toBe('dumbbell-floor-press');
    expect(isGenuineAlternative(CATALOG.get('barbell-bench-press')!, CATALOG.get('barbell-row')!)).toBe(false);
    expect(isGenuineAlternative(CATALOG.get('push-up')!, CATALOG.get('barbell-bench-press')!)).toBe(true); // listed the other way round
    // A custom exercise (not in the catalog) can't be checked, so it isn't swapped this way.
    const custom = live({ intent: 'swap', exercises: [{ id: 'se-c', exerciseId: 'my-press', name: 'My press', sets: [set(false)] }] });
    expect(buildSessionAdjustment({ change: 'swap', session_exercise_id: 'se-c', to_exercise_id: 'push-up' }, ctx(custom)).errors[0]).toMatch(/custom exercise/);
  });

  it('exercise_alternatives only lists genuine alternatives (so the model is never offered a swap that would be refused)', async () => {
    const out = await runTool('exercise_alternatives', { exercise_id: 'barbell-bench-press' }, { db: {} as AiDb, facts: facts({ equipment: ['barbell', 'bench', 'dumbbell', 'band'] }), catalog: CATALOG, state: { proposal: null, proposalAttempts: 0 } });
    const ids = (JSON.parse(out.content).results as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['dumbbell-bench-press', 'push-up', 'dumbbell-floor-press']));
    expect(ids).not.toContain('band-pushaway');
    expect(ids).not.toContain('barbell-row');
  });

  it('never without a snapshot, for a finished workout, or without Training shared', () => {
    expect(buildSessionAdjustment({ change: 'shorten', minutes: 12 }, ctx(null)).errors[0]).toMatch(/only works from the workout screen/);
    expect(buildSessionAdjustment({ change: 'shorten', minutes: 12 }, ctx(live({ status: 'completed' }))).errors[0]).toMatch(/already finished/);
    expect(buildSessionAdjustment({ change: 'shorten', minutes: 12 }, { ...ctx(live()), trainingShared: false }).errors[0]).toMatch(/Training isn't shared/);
    expect(buildSessionAdjustment({ change: 'shorten', minutes: 120 }, ctx(live())).errors[0]).toMatch(/already fits in 120 minutes/);
  });

  it('runTool stores one action per reply and tells the model nothing changed yet', async () => {
    const state: ToolState = { proposal: null, proposalAttempts: 0 };
    const out = await runTool('propose_session_adjustment', { change: 'shorten', minutes: 12 }, { db: {} as AiDb, facts: facts(), catalog: CATALOG, state, messageId: mid(2), workout: live(), trainingShared: true });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ status: 'offered', change: 'shorten', dropped: ['Lateral raise'] });
    expect(JSON.parse(out.content).note).toMatch(/saved plan never changes/);
    expect(state.sessionAdjustment).toMatchObject({ change: 'shorten', minutes: 12, sessionId: 'sess-live' });
  });

  it('the one-line description says it is for today and the plan stays the same', () => {
    const a = buildSessionAdjustment({ change: 'shorten', minutes: 12 }, ctx(live())).action as SessionAdjustmentAction;
    expect(describeSessionAdjustment(a)).toMatch(/^A shorter workout for today: skip Lateral raise .*Your plan stays the same\.$/);
  });
});

/* ================================================================== send with a workout */
function makeDb(over: { scopes?: AiScopes; coachStyle?: string | null } = {}) {
  const recorded: RecordExchangeInput[] = [];
  const exchanges = new Map<string, StoredExchange>();
  const settings: AiSettingsRow = {
    enabled: true, paused: false, consentAt: '2026-11-01T08:00:00Z', scopes: over.scopes ?? { profile: true, training: true, measurements: false, nutrition: false },
    scopesChangedAt: null, profileNotes: '', coachStyle: over.coachStyle ?? null,
  };
  const db: AiDb = {
    getSettings: async () => settings,
    getExchange: async (_u, id) => exchanges.get(id) ?? null,
    checkAndCountUsage: async () => 10,
    getUsage: async (_u, day) => ({ day, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: null }),
    getAccountState: async () => ({ settings: { units: { weight: 'kg' }, timeZone: 'UTC' }, profile: { goal: 'build_muscle', experience: 'intermediate' } }),
    getActiveProgram: async () => ({ id: 'p1', payload: { id: 'p1', name: 'Push Pull', active: true, currentVersion: 1, versions: [], inputs: { equipment: ['barbell', 'bench', 'dumbbell'] } } }),
    getRecentSessions: async () => [],
    getGoals: async () => [],
    getBodyweight: async () => [],
    getFoodLogs: async () => [],
    getHistory: async () => [],
    recordExchange: async (_u, input) => {
      recorded.push(input);
      const reply: StoredMessage = { id: mid(700 + recorded.length), role: 'assistant', content: input.reply.content, createdAt: NOW.toISOString(), grounding: input.reply.grounding };
      const ex = { reply, proposal: null, duplicate: false };
      exchanges.set(input.message.id, ex);
      return ex;
    },
    getExercises: async () => EXERCISES,
    getRecipes: async () => [],
    getIngredients: async () => [],
  };
  return { db, recorded, settings };
}
const text = (t: string) => ({ id: 'm', model: 'claude-test', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
const toolUse = (name: string, input: unknown, id = 'toolu_1') => ({ id: 'mt', model: 'claude-test', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } });
function provider(replies: unknown[]) {
  const requests: { system: string; messages: unknown[] }[] = [];
  const fetch: FetchLike = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const body = replies.shift() ?? text('…');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, requests };
}
const deps = (db: AiDb, fetch: FetchLike): CoachDeps => ({ db, fetch, env: (k) => (k === 'ANTHROPIC_API_KEY' ? 'sk-test' : undefined), now: () => NOW, sleep: async () => undefined, random: () => 0.5 });
const sendW = (t: string, workout: unknown, n = 1) => ({ action: 'send', id: mid(n), text: t, mode: 'chat', workout });

describe('MOCKED ai-coach: contextual requests from the workout', () => {
  it('Short on time: the model sees the live workout and its shorten call becomes a stored session_adjustment', async () => {
    const m = makeDb();
    const { fetch, requests } = provider([toolUse('propose_session_adjustment', { change: 'shorten', minutes: 12 }), text('Main lift first, then rows. Tap Apply.')]);
    const r = await handleAiCoach(deps(m.db, fetch), U, sendW('Short on time: I have about 12 minutes left.', live()));
    expect(r.status).toBe(200);
    expect(requests[0].system).toMatch(/<user_data kind="workout">\nWorkout in progress right now: Push A/);
    expect(requests[0].system).toMatch(/The user is short on time \(about 12 minutes left\)\. Call propose_session_adjustment/);
    expect(requests[0].system).toMatch(/Short on time is a normal reason in every coach style: be practical, never guilt/);
    expect(requests[0].system).toMatch(/TODAY'S WORKOUT ONLY: the saved plan, its templates and future sessions never change/);
    const action = m.recorded[0].reply.action as SessionAdjustmentAction;
    expect(action).toMatchObject({ kind: 'session_adjustment', id: mid(1), sessionId: 'sess-live', change: 'shorten', minutes: 12 });
    expect((r.body.reply as StoredMessage).action).toEqual(action);
    expect(m.recorded[0].reply.grounding).toContain('Today’s workout so far');
  });

  it('Short on time without a tool call: the server builds the shorter workout itself', async () => {
    const m = makeDb();
    const { fetch } = provider([text('Keep the bench, then rows.')]);
    await handleAiCoach(deps(m.db, fetch), U, sendW('Short on time', live()));
    expect(m.recorded[0].reply.action).toMatchObject({ kind: 'session_adjustment', change: 'shorten', minutes: 12, dropExercises: [{ sessionExerciseId: 'se-lat' }] });
    expect(m.recorded[0].reply.content).toBe('Keep the bench, then rows.');
  });

  it('Equipment busy without a tool call: the first alternative that fits the user is offered', async () => {
    const m = makeDb();
    const { fetch } = provider([text('Try dumbbells instead.')]);
    await handleAiCoach(deps(m.db, fetch), U, sendW('Equipment busy', live({ intent: 'swap', focusId: 'se-bench', minutesLeft: undefined })));
    expect(m.recorded[0].reply.action).toMatchObject({ change: 'swap', swap: { sessionExerciseId: 'se-bench', toExerciseId: 'dumbbell-bench-press' } });
  });

  it('Explain this: the recommendation and workout are in the prompt; no workout change is offered', async () => {
    const m = makeDb();
    const { fetch, requests } = provider([text('You hit 10 reps at 2 RIR, so the app adds weight.')]);
    await handleAiCoach(deps(m.db, fetch), U, sendW('Explain this', live({ intent: 'explain', focusId: 'se-bench', shownTarget: 'Add weight → 62.5 kg × 8' })));
    expect(requests[0].system).toMatch(/The user asked to explain a recommendation\..*Quote the app's numbers exactly/);
    expect(requests[0].system).toMatch(/The app showed this recommendation: Add weight → 62\.5 kg × 8/);
    expect(m.recorded[0].reply.action ?? null).toBeNull();
  });

  it('Training not shared: the workout is never shown to the model and no change is offered', async () => {
    const m = makeDb({ scopes: { profile: true, training: false, measurements: false, nutrition: false } });
    const { fetch, requests } = provider([toolUse('propose_session_adjustment', { change: 'shorten', minutes: 12 }), text('Training isn’t shared.')]);
    await handleAiCoach(deps(m.db, fetch), U, sendW('Short on time', live()));
    expect(requests[0].system).not.toMatch(/kind="workout"/);
    expect(requests[0].system).not.toMatch(/Barbell bench press/);
    expect(requests[0].system).toMatch(/Training isn't shared, so you can't see that workout/);
    expect(m.recorded[0].reply.action ?? null).toBeNull();
  });

  it('a malformed workout body is ignored like a normal message', async () => {
    const m = makeDb();
    const { fetch, requests } = provider([text('Hi')]);
    const r = await handleAiCoach(deps(m.db, fetch), U, sendW('hi', { sessionId: 'x', intent: 'drop tables', exercises: 'no' }));
    expect(r.status).toBe(200);
    expect(requests[0].system).not.toMatch(/kind="workout"/);
    expect(m.recorded[0].reply.action ?? null).toBeNull();
  });

  it('returns the action even when an older database drops the new kind (before the 2026-11-28 migration)', async () => {
    const m = makeDb();
    const orig = m.db.recordExchange;
    m.db.recordExchange = async (u, input) => {
      const ex = await orig(u, input);
      return { ...ex, reply: { ...ex.reply, action: null } }; // what ai_record_exchange returns when it drops an unknown kind
    };
    const { fetch } = provider([text('Shorter today.')]);
    const r = await handleAiCoach(deps(m.db, fetch), U, sendW('Short on time', live()));
    expect((r.body.reply as StoredMessage).action).toMatchObject({ kind: 'session_adjustment', change: 'shorten' });
  });
});

/* ================================================================== Supportive default & tiredness */
describe('Supportive default and tiredness (verified, roadmap item 7)', () => {
  it('no stored style (or an unknown one) reads as Supportive, in the prompt too', async () => {
    expect(DEFAULT_COACH_STYLE).toBe('supportive');
    expect(asCoachStyle(undefined)).toBe('supportive');
    expect(asCoachStyle(null)).toBe('supportive');
    expect(asCoachStyle('drill-sergeant')).toBe('supportive');
    const m = makeDb({ coachStyle: null });
    const ctx = await buildContext({ db: m.db, uid: U, settings: m.settings, text: 'hi', mode: 'chat', now: NOW });
    expect(ctx.system).toMatch(/Coach style: SUPPORTIVE \(the default\)/);
  });

  it('fatigue is never a weak reason, whatever the style', async () => {
    for (const t of ['I’m fatigued', 'so much fatigue today', 'feeling low on energy', 'too tired']) expect(mentionsTiredness(t), t).toBe(true);
    expect(mentionsTiredness('tired of chicken')).toBe(false);
    const m = makeDb({ coachStyle: 'strict' });
    const ctx = await buildContext({ db: m.db, uid: U, settings: m.settings, text: 'so much fatigue today, want to skip', mode: 'chat', now: NOW });
    expect(ctx.system).toMatch(/Tiredness is never a weak reason \(rule 9\)/);
    expect(ctx.system).toMatch(/tired, too tired, fatigued, exhausted/);
    expect(ctx.system).toMatch(/The newest message says the user is tired\. Whatever the coach style: be supportive/);
  });
});
