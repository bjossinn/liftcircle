/**
 * Icelandic deterministic server copy for the training assistant (roadmap item 8, group g8a):
 * the request's `language` (Settings.language) picks the language of server-written text — summaries, warnings,
 * errors — together with the user's own message (explicit request > clear message language > setting > history).
 * Button names in Icelandic replies match the app's Icelandic labels. English stays unchanged by default, and invalid
 * language values are ignored.
 */
import { describe, expect, it } from 'vitest';
import { handleAiCoach, thanksLine, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { requestedReplyLang, resolveReplyLang } from '../../supabase/functions/_shared/ai/replyLanguage';
import { summarizeMealPlan, summarizeProposal, summarizeRecipes, summarizeWeekPlan } from '../../supabase/functions/_shared/ai/postcheck';
import { describeSessionAdjustment, type SessionAdjustmentAction, type WorkoutContext } from '../../supabase/functions/_shared/ai/workout';
import { buildSessionAdjustment, runTool, type ToolState } from '../../supabase/functions/_shared/ai/tools';
import { validateWeekAdjustment } from '../../supabase/functions/_shared/ai/week';
import { datePair } from '../../supabase/functions/_shared/ai/humanDates';
import { mealPlanBlocker } from '../../supabase/functions/_shared/ai/dataStatus';
import { describeConstraints, explainNoRecipes } from '../../supabase/functions/_shared/ai/meals';
import { allergenLabel, dietTagLabel, friendlyAmount, mealLabel } from '../../supabase/functions/_shared/nutrition/recipes';
import { proteinGroupLabel, proteinListText } from '../../supabase/functions/_shared/nutrition/proteins';
import { extraText, sideLabel } from '../../supabase/functions/_shared/nutrition/mealplan';
import type {
  AccountStatePayload, AiDb, AiScopes, AiSettingsRow, FetchLike, MealPlanAction, RecipeSuggestionsAction, RecordExchangeInput, RefExercise, RefIngredient, RefRecipe,
  StoredExchange, StoredMessage, UserFacts, WeekAdjustmentAction,
} from '../../supabase/functions/_shared/ai/types';
import { RECIPES } from '@/data/recipes';
import '@/domain/nutrition/recipes'; // registers the app catalog (piece labels) like the app does
import { INGREDIENTS } from '@/data/ingredients';
import { followSchema } from './helpers/schemaModel';

const U = '11111111-1111-4111-8111-111111111111';
const mid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-26T10:00:00Z'); // Thursday
const ING = new Map(INGREDIENTS.map((i) => [i.id, i]));

/* ------------------------------------------------------------------ harness */
const EXERCISES: RefExercise[] = [
  { id: 'barbell-bench-press', name: 'Barbell bench press', pattern: 'horizontal_push', equipment: ['barbell', 'bench'], tracking: 'weight_reps', substitutions: ['dumbbell-bench-press'], primaryMuscles: ['chest', 'triceps'] },
  { id: 'dumbbell-bench-press', name: 'Dumbbell bench press', pattern: 'horizontal_push', equipment: ['dumbbell', 'bench'], tracking: 'weight_reps', substitutions: [], primaryMuscles: ['chest', 'triceps'] },
  { id: 'barbell-row', name: 'Barbell row', pattern: 'horizontal_pull', equipment: ['barbell'], tracking: 'weight_reps', substitutions: [] },
  { id: 'lateral-raise', name: 'Lateral raise', pattern: 'shoulder_iso', equipment: ['dumbbell'], tracking: 'weight_reps', substitutions: [] },
];
const CATALOG = new Map(EXERCISES.map((e) => [e.id, e]));
const set = (done: boolean, type = 'normal') => ({ type, done, ...(done ? { weightKg: 60, reps: 10 } : {}) });
function live(over: Partial<WorkoutContext> = {}): WorkoutContext {
  return {
    sessionId: 'sess-live', status: 'active', name: 'Push A', date: '2026-11-26', elapsedMin: 25, intent: 'shorten', minutesLeft: 12,
    exercises: [
      { id: 'se-bench', exerciseId: 'barbell-bench-press', name: 'Barbell bench press', priority: 1, target: { sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 120 }, sets: [set(true, 'warmup'), set(true), set(true), set(false)] },
      { id: 'se-row', exerciseId: 'barbell-row', name: 'Barbell row', priority: 2, target: { sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 90 }, sets: [set(false), set(false), set(false)] },
      { id: 'se-lat', exerciseId: 'lateral-raise', name: 'Lateral raise', priority: 3, target: { sets: 3, repMin: 12, repMax: 15, targetRir: 1, restSec: 60 }, sets: [set(false), set(false), set(false)] },
    ],
    ...over,
  } as WorkoutContext;
}
const facts = (over: Partial<UserFacts> = {}): UserFacts => ({
  units: 'kg', timeZone: 'UTC', weekStart: 1, equipment: ['barbell', 'bench', 'dumbbell'], excludedExerciseIds: [], limitations: [], allergens: [], dietTags: [],
  dislikedIngredientIds: [], maxCookMinutes: 30, activeProgram: null, ...over,
});

function account(): AccountStatePayload {
  return {
    settings: { units: { weight: 'kg' }, timeZone: 'UTC', weekStart: 1, nutritionEnabled: true },
    profile: { goal: 'build_muscle', diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, mealsPerDay: 3, budget: 'any' } as never },
    nutrition: { mode: 'protein_only', proteinG: 180, proteinPerKg: 2 },
  };
}
function fakeDb(scopes: AiScopes = { profile: true, training: true, measurements: false, nutrition: true }) {
  const settings: AiSettingsRow = { enabled: true, paused: false, consentAt: '2026-10-01T00:00:00Z', scopes, scopesChangedAt: null, profileNotes: '' };
  const recorded: RecordExchangeInput[] = [];
  const exchanges = new Map<string, StoredExchange>();
  const db: AiDb = {
    getSettings: async () => settings,
    getExchange: async (_u, id) => exchanges.get(id) ?? null,
    checkAndCountUsage: async () => 10,
    getUsage: async (_u, day) => ({ day, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: null }),
    getAccountState: async () => account(),
    getActiveProgram: async () => null,
    getRecentSessions: async () => [],
    getGoals: async () => [],
    getBodyweight: async () => [],
    getFoodLogs: async () => [],
    getHistory: async () => [],
    recordExchange: async (_u, input) => {
      recorded.push(input);
      const reply: StoredMessage = { id: mid(900 + recorded.length), role: 'assistant', content: input.reply.content, createdAt: NOW.toISOString(), grounding: input.reply.grounding, proposalId: null, action: input.reply.action ?? null };
      const ex = { reply, proposal: null, duplicate: false };
      exchanges.set(input.message.id, ex);
      return ex;
    },
    getExercises: async () => EXERCISES,
    getRecipes: async () => RECIPES as unknown as RefRecipe[],
    getIngredients: async () => INGREDIENTS as unknown as RefIngredient[],
  };
  return { db, recorded, settings };
}
const text = (t: string) => ({ id: 'm', model: 'claude-test', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
const toolUse = (name: string, input: unknown) => ({ id: 'mt', model: 'claude-test', content: [{ type: 'tool_use', id: 'toolu_1', name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 } });
function provider(replies: unknown[]) {
  const requests: { system: string; messages: unknown[] }[] = [];
  const fetch: FetchLike = async (_url, init) => {
    requests.push(JSON.parse(String((init as { body?: string })?.body ?? '{}')));
    const body = replies.length ? replies.shift() : text('…');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => followSchema(init.body, body), text: async () => JSON.stringify(body) };
  };
  return { fetch, requests };
}
const deps = (db: AiDb, fetch: FetchLike, env: Record<string, string> = {}): CoachDeps => {
  const e: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-test', ...env };
  return { db, fetch, env: (k) => e[k], now: () => NOW, sleep: async () => undefined, random: () => 0.5 };
};
const send = (t: string, n: number, extra: Record<string, unknown> = {}) => ({ action: 'send', id: mid(n), text: t, mode: 'chat', ...extra });
const content = (r: { body: Record<string, unknown> }) => (r.body.reply as StoredMessage).content;

/* ------------------------------------------------------------------ reply language */
describe('reply language', () => {
  it('explicit request > clear message language > app language > history > English', () => {
    expect(resolveReplyLang({ text: 'Svaraðu á ensku', setting: 'is' })).toBe('en');
    expect(resolveReplyLang({ text: 'Please answer in Icelandic', setting: 'en' })).toBe('is');
    expect(resolveReplyLang({ text: 'Make me a meal plan', setting: 'is' })).toBe('en');
    expect(resolveReplyLang({ text: 'Búðu til matseðil', setting: 'en' })).toBe('is');
    expect(resolveReplyLang({ text: 'ok', setting: 'is', history: ['Make a meal plan'] })).toBe('is');
    expect(resolveReplyLang({ text: '👍', setting: 'is' })).toBe('is');
    expect(resolveReplyLang({ text: 'ok', history: ['Búðu til matseðil'] })).toBe('is');
    expect(resolveReplyLang({ text: 'ok' })).toBe('en');
    expect(resolveReplyLang({ text: 'ok', setting: 'de' as never, history: [] })).toBe('en');
    expect(requestedReplyLang('Hvað heitir þetta á ensku?')).toBeNull();
    expect(requestedReplyLang('reply in English please')).toBe('en');
  });
});

/* ------------------------------------------------------------------ errors */
describe('errors follow the request language; codes stay stable', () => {
  it('empty message, too long, bad id, unknown action, sign-in', async () => {
    const f = fakeDb();
    const p = provider([]);
    const is = { language: 'is' };
    expect((await handleAiCoach(deps(f.db, p.fetch), U, send('   ', 1, is))).body).toMatchObject({ code: 'bad_request', error: 'Skrifaðu skilaboð fyrst.' });
    expect((await handleAiCoach(deps(f.db, p.fetch), U, send('x'.repeat(2001), 2, is))).body).toMatchObject({ code: 'bad_request', error: 'Skilaboð mega vera að hámarki 2000 stafir.' });
    expect((await handleAiCoach(deps(f.db, p.fetch), U, { action: 'send', id: 'nope', text: 'hæ', language: 'is' })).body).toMatchObject({ code: 'bad_request', error: 'Ekki tókst að senda skilaboðin. Reyndu aftur.' });
    expect((await handleAiCoach(deps(f.db, p.fetch), U, { action: 'nope', language: 'is' })).body).toMatchObject({ code: 'bad_request', error: 'Óþekkt aðgerð.' });
    expect((await handleAiCoach(deps(f.db, p.fetch), 'not-a-uid', { action: 'send', language: 'is' })).body).toMatchObject({ code: 'auth', error: 'Þú þarft að skrá þig inn.' });
    // English by default, and anything but 'en' | 'is' is ignored.
    expect((await handleAiCoach(deps(f.db, p.fetch), U, send('', 3))).body).toMatchObject({ code: 'bad_request', error: 'Write a message first.' });
    expect((await handleAiCoach(deps(f.db, p.fetch), U, send('', 4, { language: 'IS' }))).body).toMatchObject({ error: 'Write a message first.' });
    expect((await handleAiCoach(deps(f.db, p.fetch), U, send('', 5, { language: { is: true } }))).body).toMatchObject({ error: 'Write a message first.' });
    expect((await handleAiCoach(deps(f.db, p.fetch), U, send('x'.repeat(2001), 6))).body).toMatchObject({ error: 'Messages can be at most 2000 characters.' });
    expect(p.requests.length).toBe(0);
  });
  it('turned off, paused and the daily limit (never the raw database text in Icelandic)', async () => {
    const f = fakeDb();
    f.settings.enabled = false;
    expect((await handleAiCoach(deps(f.db, provider([]).fetch), U, send('hæ', 1, { language: 'is' }))).body).toMatchObject({ code: 'ai_disabled', error: 'Slökkt er á Æfingaaðstoð. Kveiktu á henni í stillingum Æfingaaðstoðar.' });
    f.settings.enabled = true;
    f.settings.paused = true;
    expect((await handleAiCoach(deps(f.db, provider([]).fetch), U, send('hæ', 2, { language: 'is' }))).body).toMatchObject({ code: 'ai_paused', error: 'Æfingaaðstoð er í bið. Virkjaðu hana aftur í stillingum Æfingaaðstoðar.' });
    f.settings.paused = false;
    f.db.checkAndCountUsage = async () => {
      throw Object.assign(new Error('You’ve reached today’s limit.'), { code: 'PT429' });
    };
    expect((await handleAiCoach(deps(f.db, provider([]).fetch), U, send('hæ', 3, { language: 'is' }))).body).toMatchObject({ code: 'rate_limited', error: 'Þú hefur náð daglegu hámarki skilaboða í Æfingaaðstoð.' });
    expect((await handleAiCoach(deps(f.db, provider([]).fetch), U, send('hi', 4))).body).toMatchObject({ code: 'rate_limited', error: 'You’ve reached today’s limit.' });
  });
});

/* ------------------------------------------------------------------ handler: deterministic replies */
describe('handler: Icelandic deterministic replies', () => {
  it('meal plan fallback summary uses the Icelandic button label; "ok" with language is stays Icelandic', async () => {
    const f = fakeDb();
    const res = await handleAiCoach(deps(f.db, provider([text('Here: salmon Monday …')]).fetch), U, send('Make a meal plan for next week and add it', 1, { language: 'is' }));
    // The message is clearly English → English, even with the Icelandic app language.
    expect(content(res)).toMatch(/^Here's your meal plan for Mon 30 Nov to Sun 6 Dec \(7 days\) — tap \*\*Add to my meal plan\*\* to put it in the app\./);
    const is = await handleAiCoach(deps(f.db, provider([text('Hér er planið: lax á mánudag …')]).fetch), U, send('Búðu til matseðil fyrir næstu viku', 2, { language: 'is' }));
    expect(content(is)).toMatch(/^Hér er matseðill fyrir 7 daga \(mán\. 30\. nóv\. til sun\. 6\. des\.\)\. Ýttu á \*\*Bæta við matseðilinn minn\*\* til að vista hann í appinu\./);
    expect(content(is)).not.toMatch(/Add to my meal plan/);
    // An empty model reply to "ok" with the Icelandic app language: Icelandic, not English. Text path: the server's own
    // sentence; Structured Outputs: never a stored success (review P2-1), the error copy follows the language.
    const TEXT = { AI_STRUCTURED_OUTPUT: 'off' };
    const ok = await handleAiCoach(deps(f.db, provider([text('')]).fetch, TEXT), U, send('ok', 3, { language: 'is' }));
    expect(content(ok)).toBe('Því miður tókst mér ekki að svara. Prófaðu að spyrja aftur.');
    const okEn = await handleAiCoach(deps(f.db, provider([text('')]).fetch, TEXT), U, send('ok', 4));
    expect(content(okEn)).toBe('Sorry — I couldn’t put together a reply. Please try asking again.');
    const blank = await handleAiCoach(deps(f.db, provider([text('')]).fetch), U, send('ok', 5, { language: 'is' }));
    expect(blank).toMatchObject({ status: 502, body: { code: 'invalid_reply', error: 'Ekki tókst að yfirfara svarið. Reyndu aftur.' } });
  });

  it('the model is told the reply language when the app sends one (older apps: prompt unchanged)', async () => {
    const f = fakeDb();
    const p = provider([text('Allt í lagi.'), text('Sure.')]);
    await handleAiCoach(deps(f.db, p.fetch), U, send('ok', 1, { language: 'is' }));
    expect(p.requests[0].system).toMatch(/Reply language: Icelandic \(the user's app language\)/);
    await handleAiCoach(deps(f.db, p.fetch), U, send('ok', 2));
    expect(p.requests[1].system).not.toMatch(/Reply language:/);
  });

  it('a meal plan the server cannot build says why, in Icelandic', async () => {
    const f = fakeDb({ profile: true, training: true, measurements: false, nutrition: false });
    const res = await handleAiCoach(deps(f.db, provider([toolUse('propose_meal_plan', {}), text('')]).fetch, { AI_STRUCTURED_OUTPUT: 'off' }), U, send('Búðu til matseðil', 1, { language: 'is' }));
    expect(res.status).toBe(200);
    expect(mealPlanBlocker({ shared: false, enabled: true, autoDisabled: false, proteinG: 180, kcal: null, macros: false }, 'is'))
      .toBe('Þú deilir ekki næringargögnum með Æfingaaðstoð. Þú getur breytt því í stillingum Æfingaaðstoðar. [[open:/coaching/ai/settings|Opna stillingar]]');
    expect(mealPlanBlocker({ shared: true, enabled: true, autoDisabled: false, proteinG: null, kcal: null, macros: false }, 'is'))
      .toBe('Próteinmarkmið hefur ekki verið stillt. Stilltu markmiðin fyrst. [[open:/nutrition/targets|Stilla markmið]]');
    expect(mealPlanBlocker({ shared: false, enabled: true, autoDisabled: false, proteinG: 180, kcal: null, macros: false })).toMatch(/^Nutrition isn't shared/);
  });

  it('session adjustment summary from the workout screen, in Icelandic', async () => {
    const f = fakeDb();
    const res = await handleAiCoach(deps(f.db, provider([toolUse('propose_session_adjustment', { change: 'shorten', minutes: 12 }), text('')]).fetch), U, send('Lítill tími', 1, { language: 'is', workout: live() }));
    expect(content(res)).toMatch(/^Styttri æfing í dag: sleppa þessum æfingum: Lateral raise.*Ýttu á „Nota í æfingu dagsins“\. Æfingaáætlunin breytist ekki\.$/);
  });
});

/* ------------------------------------------------------------------ summaries */
describe('summaries and warnings', () => {
  const week = { kind: 'week_adjustment', sessions: [{ name: 'Full body A', date: '2026-11-28', plannedDate: '2026-11-27' }], skipped: [{ name: 'Full body B' }, { name: 'Full body C' }], warnings: [] } as unknown as WeekAdjustmentAction;
  it('week: Icelandic with the "Nota fyrir þessa viku" button; English unchanged', () => {
    expect(summarizeWeekPlan(week, '2026-11-26', 1, 'is')).toBe('Svona verður vikan: **Full body A** færist á laugardaginn, **Full body B** og **Full body C** falla niður þessa viku. Ýttu á **Nota fyrir þessa viku** til að nota breytingarnar.');
    expect(summarizeWeekPlan(week, '2026-11-26')).toBe("Here's this week: **Full body A** moves to Saturday, **Full body B** and **Full body C** are skipped this week. Tap **Apply to this week** to use it.");
    expect(summarizeWeekPlan({ ...week, sessions: [], skipped: [] }, '2026-11-26', 1, 'is')).toBe('Öllum fyrirhuguðum æfingum vikunnar er lokið. Ýttu á **Nota fyrir þessa viku** til að nota breytingarnar.');
  });
  it('meal plan, recipes, proposals and the sharing thanks line', () => {
    const meals = { kind: 'meal_plan', days: [{ date: '2026-11-27' }], warnings: [] } as unknown as MealPlanAction;
    expect(summarizeMealPlan(meals, '2026-11-26', 1, 'is')).toBe('Hér er matseðill fyrir 1 dag (á morgun). Ýttu á **Bæta við matseðilinn minn** til að vista hann í appinu.');
    expect(summarizeMealPlan({ ...meals, days: [] } as unknown as MealPlanAction, '2026-11-26', 1, 'is')).toBe('Hér er matseðill fyrir 0 daga (þessa viku). Ýttu á **Bæta við matseðilinn minn** til að vista hann í appinu.');
    expect(summarizeMealPlan(meals, '2026-11-26')).toBe("Here's your meal plan for tomorrow (1 day) — tap **Add to my meal plan** to put it in the app.");
    expect(summarizeRecipes({ recipes: [{}] } as unknown as RecipeSuggestionsAction, 'is')).toBe('Hér er uppskrift sem passar. Ýttu á hana til að opna hana.');
    expect(summarizeRecipes({ recipes: [{}, {}, {}] } as unknown as RecipeSuggestionsAction)).toBe('Here are 3 recipes that fit — tap one to open it.');
    expect(summarizeProposal({ name: 'Styrkur', sessionsPerWeek: 1, target: 'for_coach_review', schedule: [], invalid: false }, 'is')).toBe('Ég hef sett saman þessa tillögu fyrir þjálfarann þinn til yfirferðar: **Styrkur** (1 æfing á viku).');
    expect(summarizeProposal({ name: 'X', sessionsPerWeek: 3, target: 'apply', schedule: [], invalid: true }, 'is')).toBe('Ég náði ekki að búa til æfingaáætlun sem passar við búnaðinn þinn og stillingar. Segðu mér hverju má breyta og ég reyni aftur.');
    expect(thanksLine(['training', 'nutrition'], 'en')).toBe('Thanks — I can see your training and nutrition now.');
    expect(thanksLine(['profile'], 'is')).toBe('Takk, nú hef ég aðgang að þessum gögnum: prófíll og óskir.');
  });
  it('session adjustments: summaries, warnings and approved copy for the model', () => {
    const shorten = { change: 'shorten', removeSets: [{ count: 2 }], dropExercises: [{ name: 'Lateral raise' }], minutes: 12, estimatedMinutes: 11 } as unknown as SessionAdjustmentAction;
    expect(describeSessionAdjustment(shorten, 'is')).toBe('Styttri æfing í dag: sleppa þessum æfingum: Lateral raise og 2 færri sett (um 11 mín. eftir). Ýttu á „Nota í æfingu dagsins“. Æfingaáætlunin breytist ekki.');
    expect(describeSessionAdjustment({ ...shorten, removeSets: [{ count: 21 }], dropExercises: [], estimatedMinutes: null } as never, 'is')).toBe('Styttri æfing í dag: 21 færra sett. Ýttu á „Nota í æfingu dagsins“. Æfingaáætlunin breytist ekki.');
    expect(describeSessionAdjustment(shorten)).toBe('A shorter workout for today: skip Lateral raise and 2 fewer sets (about 11 min left). Tap Apply to today\'s workout to use it. Your plan stays the same.');
    const swap = { change: 'swap', swap: { fromName: 'Barbell bench press', toName: 'Dumbbell bench press' }, removeSets: [], dropExercises: [] } as unknown as SessionAdjustmentAction;
    expect(describeSessionAdjustment(swap, 'is')).toBe('Í dag: Barbell bench press → Dumbbell bench press. Ýttu á „Nota í æfingu dagsins“ til að skipta. Æfingaáætlunin breytist ekki.');

    const ctx = { catalog: CATALOG, facts: facts(), messageId: mid(1), trainingShared: true, lang: 'is' as const };
    const built = buildSessionAdjustment({ change: 'swap', session_exercise_id: 'se-bench', to_exercise_id: 'dumbbell-bench-press' }, { ...ctx, workout: live({ intent: 'swap' }) });
    expect(built.action!.warnings).toEqual(['Lokin sett haldast á fyrri æfingunni: Barbell bench press. Settið sem er eftir (1) færist á nýju æfinguna: Dumbbell bench press.']);
    const none = buildSessionAdjustment({ change: 'shorten', minutes: 12 }, { ...ctx, workout: null });
    expect(none.errors[0]).toMatch(/only works from the workout screen/); // the model's diagnostic stays English
    expect(none.say).toEqual(['Upplýsingar um æfinguna fylgdu ekki skilaboðunum. Opnaðu æfinguna og veldu „Lítill tími“ eða „Búnaður upptekinn“.']);
    expect(buildSessionAdjustment({ change: 'shorten', minutes: 12 }, { ...ctx, lang: 'en', workout: null }).say).toBeUndefined();
  });
  it('propose_session_adjustment gives the model the Icelandic summary to use', async () => {
    const state: ToolState = { proposal: null, proposalAttempts: 0, weekPlan: null, weekAttempts: 0, mealPlan: null, mealPlanAttempts: 0, recipes: null, sessionAdjustment: null };
    const out = JSON.parse((await runTool('propose_session_adjustment', { change: 'shorten', minutes: 12 }, { db: {} as AiDb, facts: facts(), catalog: CATALOG, state, messageId: mid(2), workout: live(), trainingShared: true, lang: 'is' })).content);
    expect(out.suggested_reply).toMatch(/^Styttri æfing í dag: .*„Nota í æfingu dagsins“/);
  });
  it('week validation: Icelandic warnings and user copy; English diagnostics unchanged', () => {
    const ap = { id: 'p1', currentVersion: 1, managedBy: null, availableWeekdays: [1, 3, 5], version: { schedule: [], templates: [] } } as unknown as UserFacts['activeProgram'];
    const w = {
      start: '2026-11-23', end: '2026-11-29', today: '2026-11-26', items: [], completed: [{ date: '2026-11-26', name: 'Push' }], freeDates: [],
      remaining: [{ date: '2026-11-27', templateId: 't1', name: 'Pull', kind: 'lifting', status: 'upcoming' }],
    } as never;
    const ok = validateWeekAdjustment({ total_sessions_this_week: 2, sessions: [{ template_id: 't1', date: '2026-11-28' }] }, { facts: facts({ activeProgram: ap }), week: w, trainingShared: true, messageId: mid(1), lang: 'is' });
    expect(ok.action!.warnings).toEqual(['lau. 28. nóv. er ekki einn af venjulegu æfingadögunum þínum.']);
    const ok2 = validateWeekAdjustment({ total_sessions_this_week: 2, sessions: [{ template_id: 't1', date: '2026-11-27' }] }, { facts: facts({ activeProgram: ap }), week: w, trainingShared: true, messageId: mid(1), lang: 'is' });
    expect(ok2.action!.warnings).toEqual(['Æfingar tvo daga í röð (fim. 26. og fös. 27. nóv.): hafðu álagið aðeins minna seinni daginn.']);
    const en = validateWeekAdjustment({ total_sessions_this_week: 2, sessions: [{ template_id: 't1', date: '2026-11-27' }] }, { facts: facts({ activeProgram: ap }), week: w, trainingShared: true, messageId: mid(1) });
    expect(en.action!.warnings).toEqual(['Back-to-back days (Thu 26 and Fri 27 Nov): keep the effort a little lower on the second.']);
    const bad = validateWeekAdjustment({ total_sessions_this_week: 0, sessions: [] }, { facts: facts({ activeProgram: ap }), week: w, trainingShared: true, messageId: mid(1), lang: 'is' });
    expect(bad.errors[0]).toMatch(/^The user already completed 1 workout this week/);
    expect(bad.say).toEqual(['Þú hefur þegar lokið 1 æfingu í vikunni. Heildarfjöldinn má ekki vera lægri en 1.']);
    expect(datePair('2026-11-30', '2026-12-01', 'is')).toBe('mán. 30. nóv. og þri. 1. des.');
  });
});

/* ------------------------------------------------------------------ nutrition labels */
describe('meal labels, constraints and sides', () => {
  it('labels for the app\'s meal cards', () => {
    expect(mealLabel('breakfast', 'is')).toBe('Morgunmatur');
    expect(mealLabel('snack')).toBe('Snack');
    expect(allergenLabel('tree_nuts', 'is')).toBe('Trjáhnetur');
    expect(dietTagLabel('dairy_free', 'is')).toBe('Án mjólkurvara');
    expect(proteinGroupLabel('oily_fish', 'is')).toBe('Lax og feitur fiskur');
    expect(proteinListText(['prawns', 'lamb'], 'is')).toBe('rækjur og lambakjöt');
    expect(proteinListText(['prawns', 'lamb'])).toBe('prawns and lamb');
    expect(sideLabel('egg', 'is', 2)).toBe('harðsoðin egg');
    expect(sideLabel('egg', 'is', 1)).toBe('harðsoðið egg');
    expect(sideLabel('tuna-canned', 'is')).toBe('túnfiskur í vatni');
  });
  it('protein sides put the food first ("Harðsoðin egg: 2 stk."); English unchanged', () => {
    const egg = ING.get('egg')!;
    const grams = (egg.units?.piece ?? 50) * 2;
    expect(extraText({ ingredientId: 'egg', grams } as never, ING as never, 'is')).toBe('Harðsoðin egg: 2 stk.');
    expect(extraText({ ingredientId: 'egg', grams } as never, ING as never)).toBe('2 eggs (hard-boiled)');
    expect(extraText({ ingredientId: 'chicken-breast-cooked', grams: 100 } as never, ING as never, 'is')).toBe('Steikt kjúklingabringa: 100 g');
    expect(extraText({ ingredientId: 'chicken-breast-cooked', grams: 100 } as never, ING as never)).toBe('100 g roast chicken breast');
    expect(friendlyAmount(egg as never, (egg.units?.piece ?? 50) * 2, 'is')).toBe('2 egg');
  });
  it('constraints: complete "án …" phrases and Icelandic causes', () => {
    const c = { allergens: ['milk', 'egg'], dietTags: ['vegan'], disliked: ['x'], maxMinutes: 15, meal: 'breakfast', proteinExcluded: ['prawns'] };
    expect(describeConstraints(c, 'is')).toBe('Vegan + án mjólkur + án eggja + 1 hráefni sleppt + þessir próteingjafar undanskildir: rækjur + ≤ 15 mín. + morgunmatur');
    expect(describeConstraints(c)).toBe('Vegan + no milk + no egg + 1 skipped ingredient + no prawns + ≤ 15 min + breakfast');
    expect(describeConstraints({ allergens: [], dietTags: [], disliked: [], maxMinutes: null, meal: null }, 'is')).toBe('engar takmarkanir');
    const why = explainNoRecipes({ allergens: [], dietTags: ['vegan'], disliked: [], maxMinutes: 1, meal: null }, RECIPES as unknown as RefRecipe[], ING as never, facts(), 'is');
    expect(why).toMatch(/^Engin uppskrift í safninu uppfyllir þessar kröfur: Vegan \+ ≤ 1 mín\.\. Það sem útilokar uppskriftirnar er: tímamörkin, 1 mínútur/);
  });
});
