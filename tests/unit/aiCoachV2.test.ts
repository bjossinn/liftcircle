/**
 * AI coach v2 (repair brief 29 Oct, §3) — server logic with a MOCKED provider (injected fetch) and an in-memory
 * data accessor. No network and no live provider: every describe block is labelled MOCKED. The live check is the
 * opt-in script tests/live/ai-live.mjs.
 *
 * Covers: concise-style system instructions, "Why this?" split + reply tidy-up, the context builder's real plan /
 * this-week state, stale "Training setup:" notes vs typed settings, unshared/incomplete context, the
 * "I can only train twice this week" scenario (partly completed week, picks from the real plan, two different
 * plans), version/coach-managed rules, and idempotent replay of a stored week plan.
 */
import { describe, expect, it } from 'vitest';
import { handleAiCoach, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { buildContext, resolveSetupNote, SYSTEM_RULES } from '../../supabase/functions/_shared/ai/context';
import { splitWhy, tidyReply, wordCount } from '../../supabase/functions/_shared/ai/reply';
import { runTool, TOOL_DEFS, type ToolState } from '../../supabase/functions/_shared/ai/tools';
import { computeWeekState, weekBounds } from '../../supabase/functions/_shared/ai/week';
import type {
  AccountStatePayload, ActiveProgramRow, AiDb, AiSettingsRow, FetchLike, RecordExchangeInput, RefExercise, SessionPayload, StoredExchange, StoredMessage,
} from '../../supabase/functions/_shared/ai/types';

/* ================================================================== fixtures */
const U = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MSG = '00000000-0000-4000-8000-000000000101';
// 2026-10-26 is a Monday; "now" is Wednesday 2026-10-28 midday UTC.
const NOW = new Date('2026-10-28T12:00:00Z');

const EXERCISES: RefExercise[] = [
  { id: 'goblet-squat', name: 'Goblet squat', pattern: 'squat', equipment: ['dumbbell'], tracking: 'weight_reps' },
  { id: 'dumbbell-row', name: 'Dumbbell row', pattern: 'horizontal_pull', equipment: ['dumbbell', 'bench'], tracking: 'weight_reps' },
  { id: 'dumbbell-bench-press', name: 'Dumbbell bench press', pattern: 'horizontal_push', equipment: ['dumbbell', 'bench'], tracking: 'weight_reps' },
  { id: 'romanian-deadlift', name: 'Romanian deadlift', pattern: 'hinge', equipment: ['dumbbell'], tracking: 'weight_reps' },
];
const rx = (id: string, exerciseId: string) => ({ id, exerciseId, sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 90 });

/** Plan 1: Full body A/B/C on Mon/Wed/Fri. */
function fullBodyPlan(): ActiveProgramRow {
  return {
    id: P1,
    payload: {
      id: P1, name: 'Full body 3x', active: true, currentVersion: 2, startDate: '2026-10-05', managedBy: { kind: 'self' },
      versions: [{
        version: 2,
        templates: [
          { id: 'fb-a', name: 'Full body A', kind: 'lifting', estimatedMinutes: 45, exercises: [rx('s1', 'goblet-squat'), rx('s2', 'dumbbell-bench-press')] },
          { id: 'fb-b', name: 'Full body B', kind: 'lifting', estimatedMinutes: 45, exercises: [rx('s1', 'romanian-deadlift'), rx('s2', 'dumbbell-row')] },
          { id: 'fb-c', name: 'Full body C', kind: 'lifting', estimatedMinutes: 45, exercises: [rx('s1', 'goblet-squat'), rx('s2', 'dumbbell-row')] },
        ],
        schedule: [{ weekday: 1, templateId: 'fb-a' }, { weekday: 3, templateId: 'fb-b' }, { weekday: 5, templateId: 'fb-c' }],
        weeks: 8,
      }],
      overrides: [],
      inputs: { equipment: ['dumbbell', 'bench'], excludedExerciseIds: ['dumbbell-bench-press-incline'], sessionMinutes: 45, liftingDaysPerWeek: 3, availableWeekdays: [1, 2, 3, 4, 5] },
    },
  };
}
/** Plan 2: Upper / Lower / Full on Tue/Thu/Sat (different sessions and days). */
function upperLowerPlan(): ActiveProgramRow {
  return {
    id: P2,
    payload: {
      id: P2, name: 'Upper/Lower + Full', active: true, currentVersion: 5, startDate: '2026-09-01', managedBy: { kind: 'self' },
      versions: [{
        version: 5,
        templates: [
          { id: 'ul-up', name: 'Upper', kind: 'lifting', exercises: [rx('s1', 'dumbbell-bench-press'), rx('s2', 'dumbbell-row')] },
          { id: 'ul-lo', name: 'Lower', kind: 'lifting', exercises: [rx('s1', 'goblet-squat'), rx('s2', 'romanian-deadlift')] },
          { id: 'ul-fb', name: 'Full', kind: 'lifting', exercises: [rx('s1', 'goblet-squat'), rx('s2', 'dumbbell-row')] },
        ],
        schedule: [{ weekday: 2, templateId: 'ul-up' }, { weekday: 4, templateId: 'ul-lo' }, { weekday: 6, templateId: 'ul-fb' }],
        weeks: 6,
      }],
      overrides: [],
      inputs: { equipment: ['dumbbell', 'bench'], sessionMinutes: 60, liftingDaysPerWeek: 3, availableWeekdays: [2, 4, 6] },
    },
  };
}
const done = (name: string, templateId: string, date: string, programId: string): SessionPayload => ({
  id: `${templateId}-${date}`, name, status: 'completed', date, templateId, plannedDate: date, programId, startedAt: 0, endedAt: 2_700_000, exercises: [],
});

interface Data {
  settings: AiSettingsRow;
  account: AccountStatePayload;
  program: ActiveProgramRow | null;
  sessions: SessionPayload[];
  history: StoredMessage[];
}
const ALL = { profile: true, training: true, measurements: false, nutrition: false };
function data(over: Partial<Data> = {}): Data {
  return {
    settings: { enabled: true, paused: false, consentAt: '2026-10-20T08:00:00Z', scopes: { ...ALL }, scopesChangedAt: null, profileNotes: '' },
    account: {
      settings: { units: { weight: 'kg' }, timeZone: 'UTC', weekStart: 1 },
      profile: { goal: 'build_muscle', experience: 'intermediate', limitations: ['knee'],
        // @ts-expect-error free-text injury notes exist in real payloads and must never be sent
        injuryNotes: 'PRIVATE-INJURY-TEXT' },
    },
    program: fullBodyPlan(),
    sessions: [done('Full body A', 'fb-a', '2026-10-26', P1)],
    history: [],
    ...over,
  };
}

function makeDb(d: Data) {
  const exchanges = new Map<string, StoredExchange>();
  const recorded: RecordExchangeInput[] = [];
  let usage = 0;
  const db: AiDb = {
    getSettings: async () => d.settings,
    getExchange: async (_uid, id) => (exchanges.has(id) ? { ...exchanges.get(id)!, duplicate: true } : null),
    checkAndCountUsage: async () => ++usage,
    getUsage: async (_u, day) => ({ day, requests: usage, inputTokens: 0, outputTokens: 0, costUsd: null }),
    getAccountState: async () => d.account,
    getActiveProgram: async () => d.program,
    getRecentSessions: async () => d.sessions,
    getGoals: async () => [],
    getBodyweight: async () => [],
    getFoodLogs: async () => [],
    getHistory: async () => d.history,
    recordExchange: async (_uid, input) => {
      recorded.push(input);
      if (exchanges.has(input.message.id)) return { ...exchanges.get(input.message.id)!, duplicate: true };
      // Same shape the v2 SQL returns (ai_message_json incl. why + action).
      const reply: StoredMessage = { id: `reply-${recorded.length}`, role: 'assistant', content: input.reply.content, createdAt: NOW.toISOString(), grounding: input.reply.grounding, why: input.reply.why ?? null, action: input.reply.action ?? null };
      const ex = { reply, proposal: null };
      exchanges.set(input.message.id, ex);
      return { ...ex, duplicate: false };
    },
    getExercises: async () => EXERCISES,
    getRecipes: async () => [],
    getIngredients: async () => [],
  };
  return { db, recorded, exchanges, usage: () => usage };
}

type Body = { system: string; messages: { role: string; content: unknown }[]; tools?: { name: string }[] };
function provider(replies: ((body: Body) => unknown)[]) {
  const requests: Body[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as Body;
    requests.push(body);
    const next = replies.shift();
    const res = next ? next(body) : { content: [{ type: 'text', text: 'fallback' }], stop_reason: 'end_turn' };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'm', model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 }, ...(res as object) }), text: async () => '' };
  };
  return { fetch, requests };
}
const textReply = (t: string) => () => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });

/**
 * A deterministic stand-in for the model (MOCKED): reads ONLY what the server put in the prompt — the
 * "Planned sessions still left this week" and "Free dates left" lines plus the completed count — and picks
 * the first remaining sessions on the first free dates. Shows that the pipeline hands the model the real plan.
 */
function plannerFromPrompt(totalThisWeek: number) {
  return (body: Body) => {
    const sys = body.system;
    const left = /Planned sessions still left this week: (.*)\./.exec(sys)?.[1] ?? '';
    const ids = [...left.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
    const free = [...(/Free dates left this week[^:]*: (.*)\./.exec(sys)?.[1] ?? '').matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    const completed = Number(/Completed workouts this week[^:]*: (\d+)/.exec(sys)?.[1] ?? 0);
    const n = Math.max(0, totalThisWeek - completed);
    const sessions = ids.slice(0, n).map((template_id, i) => ({ template_id, date: free[i] }));
    return { content: [{ type: 'tool_use', id: 'tu1', name: 'propose_week_adjustment', input: { total_sessions_this_week: totalThisWeek, sessions } }], stop_reason: 'tool_use' };
  };
}

function deps(db: AiDb, fetch: FetchLike): CoachDeps {
  return { db, fetch, env: (k) => ({ ANTHROPIC_API_KEY: 'sk-test' } as Record<string, string | undefined>)[k], now: () => NOW, sleep: async () => undefined, random: () => 0.5 };
}
const send = (text: string, id = MSG) => ({ action: 'send', id, text, mode: 'chat' });
const ctxFor = (d: Data, text = 'I can only train twice this week') => buildContext({ db: makeDb(d).db, uid: U, settings: d.settings, text, mode: 'chat', now: NOW });

/* ================================================================== tests */
describe('MOCKED ai-coach v2: response style instructions', () => {
  it('system rules lead with the recommendation, keep routine answers short, limit questions, and keep temporary requests temporary', () => {
    expect(SYSTEM_RULES).toContain('Lead with the recommendation and the concrete next action');
    expect(SYSTEM_RULES).toMatch(/40–100 words/);
    expect(SYSTEM_RULES).toMatch(/don't repeat setup\/onboarding questions/);
    expect(SYSTEM_RULES).toMatch(/don't hand the decision back/);
    expect(SYSTEM_RULES).toMatch(/at most one focused question, and only when missing information blocks/);
    expect(SYSTEM_RULES).toMatch(/Don't end answers with a question/);
    expect(SYSTEM_RULES).toContain('[[why]]');
    expect(SYSTEM_RULES).toMatch(/newest message sets the time scope/);
    expect(SYSTEM_RULES).toMatch(/Count workouts already completed this week/);
    expect(SYSTEM_RULES).toMatch(/usual schedule resumes next week/);
    expect(SYSTEM_RULES).toMatch(/Don't ask which split or structure they want when the current plan already answers it/);
    expect(SYSTEM_RULES).toMatch(/Never say you reviewed or looked at workouts that are not listed/);
    expect(TOOL_DEFS.map((t) => t.name)).toContain('propose_week_adjustment');
  });

  it('splitWhy separates optional reasoning (marker, heading, closing tag) and is robust when the model omits it', () => {
    expect(splitWhy('Do Full body B on Thursday.\n[[why]]\nMonday already counts.')).toEqual({ answer: 'Do Full body B on Thursday.', why: 'Monday already counts.' });
    expect(splitWhy('Do B Thursday. [[why]] Monday counts. [[/why]]')).toEqual({ answer: 'Do B Thursday.', why: 'Monday counts.' });
    expect(splitWhy('Do B Thursday.\n\n**Why this?**\nMonday counts.')).toEqual({ answer: 'Do B Thursday.', why: 'Monday counts.' });
    expect(splitWhy('Do B Thursday.')).toEqual({ answer: 'Do B Thursday.', why: null });
    expect(splitWhy('Do B Thursday.\n[[why]]   ')).toEqual({ answer: 'Do B Thursday.', why: null });
    expect(splitWhy('[[why]] Everything after the marker')).toEqual({ answer: 'Everything after the marker', why: null });
    // A sentence that merely starts with "Why" is not a marker.
    expect(splitWhy('Why not rest? Do B Thursday.').why).toBeNull();
  });

  it('tidyReply removes forbidden filler but never changes the recommendation', () => {
    expect(tidyReply('Great question! Do Full body B on Thursday.\n\n\n\nLet me know if you have any other questions.')).toBe('Do Full body B on Thursday.');
    expect(tidyReply('Do B.\nHope this helps!')).toBe('Do B.');
    expect(tidyReply('Do B on Thursday. Want me to add rows?')).toBe('Do B on Thursday. Want me to add rows?');
    expect(wordCount('Do Full body B on Thursday, then rest.')).toBe(8);
  });

  it('handler stores the answer and the "Why this?" separately', async () => {
    const m = makeDb(data());
    const { fetch } = provider([textReply('Great question! Do Full body B tomorrow.\n[[why]]\nIt keeps a rest day after Monday.')]);
    const res = await handleAiCoach(deps(m.db, fetch), U, send('What next?'));
    expect(res.status).toBe(200);
    const reply = res.body.reply as StoredMessage;
    expect(reply.content).toBe('Do Full body B tomorrow.');
    expect(reply.why).toBe('It keeps a rest day after Monday.');
    expect(m.recorded[0].reply.why).toBe('It keeps a rest day after Monday.');
  });
});

describe('MOCKED ai-coach v2: context builder (real plan + this week)', () => {
  it('sends the actual program, schedule, frequency, session time, this week (done + remaining with dates), today, availability, equipment, exclusions and limitation names', async () => {
    const ctx = await ctxFor(data());
    const s = ctx.system;
    expect(s).toContain('Today is 2026-10-28 (Wed)');
    expect(s).toContain('Active plan: "Full body 3x" (program id aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa, current version 2, managed by: self)');
    expect(s).toContain('Schedule (baseline, every week): Mon Full body A, Wed Full body B, Fri Full body C');
    expect(s).toContain('Frequency: 3 planned sessions a week (3 lifting); 45 min per session (current setting).');
    expect(s).toContain('- Session "Full body B" [fb-b] (lifting, ~45 min): Romanian deadlift [romanian-deadlift]');
    expect(s).toContain('This week: Mon 2026-10-26 to Sun 2026-11-01; today is Wed 2026-10-28.');
    expect(s).toContain('Mon 2026-10-26 Full body A [fb-a] — done');
    expect(s).toContain('Completed workouts this week (these count toward any limit for this week): 1 — Mon 2026-10-26 "Full body A"');
    expect(s).toContain('Planned sessions still left this week: Full body B [fb-b] (planned Wed 2026-10-28); Full body C [fb-c] (planned Fri 2026-10-30).');
    expect(s).toContain('Free dates left this week (no workout done or planned): Thu 2026-10-29, Sat 2026-10-31, Sun 2026-11-01.');
    expect(s).toContain('Available training weekdays: Mon, Tue, Wed, Thu, Fri');
    expect(s).toContain('Equipment available: dumbbell, bench');
    expect(s).toContain('Excluded exercises: custom exercise [dumbbell-bench-press-incline]');
    expect(s).toContain('Areas to go easy on (body-area names only): knee');
    expect(s).not.toContain('PRIVATE-INJURY-TEXT');
  });

  it('uses the user’s time zone and week start for "today" and "this week"', async () => {
    const d = data();
    d.account.settings = { ...d.account.settings, timeZone: 'Pacific/Kiritimati', weekStart: 0 }; // UTC+14 → already Thursday
    const ctx = await ctxFor(d);
    expect(ctx.system).toContain('Today is 2026-10-29 (Thu)');
    expect(ctx.system).toContain('This week: Sun 2026-10-25 to Sat 2026-10-31');
    expect(weekBounds('2026-10-28', 1)).toEqual({ start: '2026-10-26', end: '2026-11-01' });
  });

  it('reflects existing skips/moves (date-specific overrides) in this week’s state', () => {
    const p = fullBodyPlan();
    p.payload.overrides = [{ date: '2026-10-30', templateId: 'fb-c', status: 'moved', movedTo: '2026-10-31' }];
    const facts = { id: p.id, name: 'x', currentVersion: 2, managedBy: 'self' as const, version: p.payload.versions![0], startDate: '2026-10-05', overrides: p.payload.overrides, availableWeekdays: [] };
    const w = computeWeekState(facts, [done('Full body A', 'fb-a', '2026-10-26', P1)], '2026-10-28', 1);
    expect(w.items.map((i) => [i.date, i.templateId, i.status])).toEqual([
      ['2026-10-26', 'fb-a', 'done'], ['2026-10-28', 'fb-b', 'today'], ['2026-10-30', 'fb-c', 'moved'], ['2026-10-31', 'fb-c', 'upcoming'],
    ]);
    expect(w.remaining.map((r) => r.date)).toEqual(['2026-10-28', '2026-10-31']);
  });

  it('stale "Training setup:" note vs typed inputs: typed settings win and the note is labelled stale', async () => {
    const d = data();
    d.settings.profileNotes = 'Training setup: 2 training days a week; 30-minute sessions; equipment: Barbell, Rack.\nPrefers mornings.';
    const s = (await ctxFor(d)).system;
    expect(s).toContain('STALE NOTE (ignore it)');
    expect(s).toContain('training days per week: note says 2, current setting 3');
    expect(s).toContain('session length: note says 30 min, current setting 45 min');
    expect(s).toContain('equipment: note says "Barbell, Rack", current setting dumbbell, bench');
    expect(s).toContain('Prefers mornings.');
    // The stale line is no longer presented as one of the user's notes.
    const notes = s.slice(s.indexOf('<user_data kind="user_notes">'));
    expect(notes.split('\n').filter((l) => l.startsWith('Training setup:'))).toHaveLength(0);
  });

  it('a matching "Training setup:" note stays as a normal note; with no typed plan it is kept too', () => {
    const typed = { days: 3, minutes: 45, equipment: ['dumbbell', 'bench', 'pullup_bar', 'smith'] };
    const line = 'Training setup: 3 training days a week; 45-minute sessions; equipment: Dumbbells, Bench, Pull-up bar, Smith machine.';
    expect(resolveSetupNote(line, typed)).toEqual({ notes: line, stale: null });
    expect(resolveSetupNote('Training setup: 2 training days a week.', null).stale).toBeNull();
    expect(resolveSetupNote('Training setup: equipment: bodyweight only.', { ...typed, equipment: [] }).stale).toBeNull();
  });

  it('stale note while profile + training are NOT shared: flagged without revealing the typed values', async () => {
    const d = data();
    d.settings.scopes = { profile: false, training: false, measurements: false, nutrition: false };
    d.settings.profileNotes = 'Training setup: 2 training days a week.';
    const s = (await ctxFor(d)).system;
    expect(s).toContain('differs from the user\'s current saved settings (not shared with you)');
    expect(s).not.toContain('current setting 3');
  });

  it('incomplete / unshared context: no plan, no week, no invented review; the week tool refuses', async () => {
    const d = data();
    d.settings.scopes = { profile: true, training: false, measurements: false, nutrition: false };
    const ctx = await ctxFor(d);
    expect(ctx.system).not.toContain('Full body');
    expect(ctx.system).not.toContain('This week:');
    expect(ctx.week).toBeNull();
    expect(ctx.system).toContain('Shared categories: profile.');
    const state: ToolState = { proposal: null, proposalAttempts: 0 };
    const out = await runTool('propose_week_adjustment', { total_sessions_this_week: 2, sessions: [{ template_id: 'fb-b', date: '2026-10-29' }] },
      { db: makeDb(d).db, facts: ctx.facts, catalog: ctx.catalog, state, week: ctx.week, trainingShared: false, messageId: MSG });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Training data is not shared/);
    expect(state.weekPlan ?? null).toBeNull();
  });

  it('training shared but nothing logged yet: says so instead of describing workouts', async () => {
    const ctx = await ctxFor(data({ sessions: [] }));
    expect(ctx.system).toContain('Completed workouts this week: none yet.');
    expect(ctx.system).toContain('Completed workouts: none recorded.');
  });
});

describe('MOCKED ai-coach v2: "I can only train twice this week" (saved 3-session plan)', () => {
  it('partly completed week: Monday counts, ONE more actual session is offered for this week only, version-aware', async () => {
    const m = makeDb(data());
    const { fetch, requests } = provider([
      plannerFromPrompt(2),
      textReply('Do Full body B on Thursday — Monday’s Full body A already counts, so that makes two. Skip Full body C this week; your usual 3-day schedule resumes next week.\n[[why]]\nThursday keeps a rest day after today and B covers the hinge and pull work you haven’t done yet.'),
    ]);
    const res = await handleAiCoach(deps(m.db, fetch), U, send('I can only train twice this week'));
    expect(res.status).toBe(200);
    // The prompt carried the real plan + this week's state, and the week tool was available.
    expect(requests[0].system).toContain('Planned sessions still left this week: Full body B [fb-b]');
    expect(requests[0].tools!.map((t) => t.name)).toContain('propose_week_adjustment');
    const reply = res.body.reply as StoredMessage;
    expect(reply.content).toMatch(/^Do Full body B on Thursday/);
    expect(reply.content).toMatch(/resumes next week/);
    expect(reply.content).not.toMatch(/upper\/lower|full-body or/i); // no split question
    expect(reply.why).toMatch(/rest day/);
    expect(reply.action).toMatchObject({
      kind: 'week_adjustment',
      id: MSG,
      baseProgramId: P1,
      baseVersion: 2,
      weekStart: '2026-10-26',
      weekEnd: '2026-11-01',
      targetSessions: 2,
      completed: [{ date: '2026-10-26', name: 'Full body A' }],
      sessions: [{ templateId: 'fb-b', name: 'Full body B', date: '2026-10-29', plannedDate: '2026-10-28' }],
      skipped: [{ templateId: 'fb-c', name: 'Full body C', plannedDate: '2026-10-30' }],
    });
    expect(m.recorded[0].reply.action?.sessions).toHaveLength(1);
  });

  it('picks from the REAL plan: a different saved plan yields different sessions and dates', async () => {
    const d2 = data({ program: upperLowerPlan(), sessions: [done('Upper', 'ul-up', '2026-10-27', P2)] });
    const m = makeDb(d2);
    const { fetch } = provider([plannerFromPrompt(2), textReply('Do Lower today; that makes two with Tuesday’s Upper. Back to three sessions next week.')]);
    const res = await handleAiCoach(deps(m.db, fetch), U, send('I can only train twice this week'));
    const action = (res.body.reply as StoredMessage).action!;
    expect(action.baseProgramId).toBe(P2);
    // The stand-in planner takes the first free date (today, Wed) for the plan's next remaining session (Thu's Lower).
    expect(action.sessions).toEqual([{ templateId: 'ul-lo', name: 'Lower', date: '2026-10-28', plannedDate: '2026-10-29' }]);
    expect(action.skipped.map((x) => x.templateId)).toEqual(['ul-fb']);

    const m1 = makeDb(data());
    const r1 = await handleAiCoach(deps(m1.db, provider([plannerFromPrompt(2), textReply('ok')]).fetch), U, send('I can only train twice this week'));
    expect((r1.body.reply as StoredMessage).action!.sessions.map((x) => x.templateId)).toEqual(['fb-b']);
  });

  it('no completed session yet: two actual sessions in order; already-trained days and invented sessions are refused', async () => {
    const d = data({ sessions: [] });
    const ctx = await ctxFor(d);
    const run = (input: unknown) => {
      const state: ToolState = { proposal: null, proposalAttempts: 0 };
      return runTool('propose_week_adjustment', input, { db: makeDb(d).db, facts: ctx.facts, catalog: ctx.catalog, state, week: ctx.week, trainingShared: true, messageId: MSG }).then((out) => ({ out, state }));
    };
    const ok = await run({ total_sessions_this_week: 2, sessions: [{ template_id: 'fb-c', date: '2026-10-31' }, { template_id: 'fb-b', date: '2026-10-29' }] });
    expect(ok.out.isError).toBeFalsy();
    expect(ok.state.weekPlan!.sessions.map((s) => [s.templateId, s.date])).toEqual([['fb-b', '2026-10-29'], ['fb-c', '2026-10-31']]); // ordered by date
    // Mon's A was missed (not done) and is dropped for this week.
    expect(ok.state.weekPlan!.skipped.map((s) => s.templateId)).toEqual(['fb-a']);
    const invented = await run({ total_sessions_this_week: 2, sessions: [{ template_id: 'upper-body', date: '2026-10-29' }, { template_id: 'fb-b', date: '2026-10-30' }] });
    expect(invented.out.isError).toBe(true);
    expect(invented.out.content).toMatch(/not a planned session left this week/);
    const past = await run({ total_sessions_this_week: 2, sessions: [{ template_id: 'fb-b', date: '2026-10-27' }, { template_id: 'fb-c', date: '2026-11-02' }] });
    expect(past.out.content).toMatch(/today or later, this week only/);
  });

  it('a session already done this week must be counted (total includes it)', async () => {
    const d = data();
    const ctx = await ctxFor(d);
    const state: ToolState = { proposal: null, proposalAttempts: 0 };
    const out = await runTool('propose_week_adjustment', { total_sessions_this_week: 2, sessions: [{ template_id: 'fb-b', date: '2026-10-29' }, { template_id: 'fb-c', date: '2026-10-31' }] },
      { db: makeDb(d).db, facts: ctx.facts, catalog: ctx.catalog, state, week: ctx.week, trainingShared: true, messageId: MSG });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/exactly 1 remaining session \(2 this week minus 1 already completed\)/);
    const done2 = await runTool('propose_week_adjustment', { total_sessions_this_week: 0, sessions: [] },
      { db: makeDb(d).db, facts: ctx.facts, catalog: ctx.catalog, state: { proposal: null, proposalAttempts: 0 }, week: ctx.week, trainingShared: true, messageId: MSG });
    expect(done2.content).toMatch(/must be at least 1/);
  });

  it('coach-managed plan: still a direct recommendation + schedule-only week plan; plan content still goes to coach review', async () => {
    const p = fullBodyPlan();
    p.payload.managedBy = { kind: 'coach', coachName: 'Sam' };
    const m = makeDb(data({ program: p }));
    const { fetch, requests } = provider([plannerFromPrompt(2), textReply('Do Full body B on Thursday; with Monday that’s two. Your coach’s plan resumes as usual next week.')]);
    const res = await handleAiCoach(deps(m.db, fetch), U, send('I can only train twice this week'));
    expect(requests[0].system).toMatch(/managed by a human coach, still give a direct recommendation/);
    expect(requests[0].system).toContain('managed by: coach');
    const action = (res.body.reply as StoredMessage).action!;
    expect(action.managedBy).toBe('coach');
    expect(action.sessions.map((s) => s.templateId)).toEqual(['fb-b']);
    // A content change would still be forced to coach review (unchanged rule).
    const ctx = await ctxFor(data({ program: p }));
    const st: ToolState = { proposal: null, proposalAttempts: 0 };
    await runTool('propose_program_change', { base_program_id: P1, base_version: 2, target: 'apply', change_summary: ['x'], program: { name: 'x', weeks: 4, templates: [{ id: 't', name: 'T', exercises: [rx('s1', 'goblet-squat')] }], schedule: [{ weekday: 1, templateId: 't' }] } },
      { db: m.db, facts: ctx.facts, catalog: ctx.catalog, state: st });
    expect(st.proposal!.target).toBe('for_coach_review');
  });

  it('idempotent: re-sending the same message id (refresh / second tab) replays the stored week plan without a provider call or charge', async () => {
    const m = makeDb(data());
    const p1 = provider([plannerFromPrompt(2), textReply('Do Full body B on Thursday.')]);
    const first = await handleAiCoach(deps(m.db, p1.fetch), U, send('I can only train twice this week'));
    const p2 = provider([]);
    const again = await handleAiCoach(deps(m.db, p2.fetch), U, send('I can only train twice this week'));
    expect(p2.requests).toHaveLength(0);
    expect(m.usage()).toBe(1);
    expect(again.body.duplicate).toBe(true);
    expect((again.body.reply as StoredMessage).action).toEqual((first.body.reply as StoredMessage).action);
  });

  it('the model omitting the tool still yields a normal reply (no action, nothing applicable)', async () => {
    const m = makeDb(data());
    const res = await handleAiCoach(deps(m.db, provider([textReply('Do Full body B on Thursday and skip C this week.')]).fetch), U, send('I can only train twice this week'));
    expect((res.body.reply as StoredMessage).action ?? null).toBeNull();
    expect((res.body.reply as StoredMessage).why ?? null).toBeNull();
  });
});
