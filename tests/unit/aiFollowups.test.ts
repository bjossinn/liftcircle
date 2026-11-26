/**
 * PR 1b (1.0.3) training assistant follow-ups:
 *  1. a replay of a message that is still being answered never starts a second generation;
 *  2. tokens from rounds of a FAILED request are booked as failed usage, never as a successful exchange;
 *  3. a failed request gives its daily allowance back;
 *  5. sync barrier: the app syncs (bounded) before sending, and tells the server what is still unsynced;
 *  6. Icelandic summaries and dates;
 *  7. "too tired" is detected (EN + IS) without catching "tired of chicken";
 *  8. "pancakes without blueberries" → pancakes, with the optional blueberries left out (and swaps carried to the card).
 * (4, the refreshed "Training setup" note, and the style rules for 7 are in aiCoachV2.test.ts; 9 is aiAllergenFixture.test.ts.)
 */
import { describe, expect, it, vi } from 'vitest';
import { handleAiCoach, thanksLine, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { runTool, type ToolState } from '../../supabase/functions/_shared/ai/tools';
import { mentionsTiredness } from '../../supabase/functions/_shared/ai/conversation';
import { detectLang, replyLang } from '../../supabase/functions/_shared/ai/lang';
import { humanDate, humanizeDates, shortDate } from '../../supabase/functions/_shared/ai/humanDates';
import { summarizeMealPlan, summarizeProposal, summarizeRecipes, summarizeWeekPlan } from '../../supabase/functions/_shared/ai/postcheck';
import type {
  AccountStatePayload, AiDb, AiScopes, AiSettingsRow, BeginRequestResult, FetchLike, MealPlanAction, RecipeSuggestionsAction, RecordExchangeInput,
  RefIngredient, RefRecipe, StoredExchange, StoredMessage, UserFacts, WeekAdjustmentAction,
} from '../../supabase/functions/_shared/ai/types';
import { syncBeforeAi } from '@/features/coaching/ai/syncBarrier';
import { sendWhileInProgress } from '@/features/coaching/ai/inProgress';
import { toRecipeSuggestions } from '@/domain/nutrition/aiActions';
import { changesText, recipeHref } from '@/features/coaching/ai/RecipeCards';
import { linkSwaps } from '@/features/nutrition/RecipeDetailPage';
import { RECIPES, RECIPES_BY_ID } from '@/data/recipes';
import { INGREDIENTS } from '@/data/ingredients';

const U = '11111111-1111-4111-8111-111111111111';
const mid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-10-29T10:00:00Z'); // Thursday
const ALL: AiScopes = { profile: true, training: true, measurements: false, nutrition: true };
const ING = new Map(INGREDIENTS.map((i) => [i.id, i]));

function account(): AccountStatePayload {
  return {
    settings: { units: { weight: 'kg' }, timeZone: 'UTC', weekStart: 1, nutritionEnabled: true },
    profile: { goal: 'build_muscle', diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, mealsPerDay: 3, budget: 'any' } as never },
    nutrition: { mode: 'protein_only', proteinG: 180, proteinPerKg: 2 },
  };
}

/** In-memory AiDb with the 1.0.3 reservation semantics (mirrors ai_begin_request / ai_fail_request). */
function fakeDb(opts: { limit?: number; reservation?: boolean; recordThrows?: boolean } = {}) {
  const settings: AiSettingsRow = { enabled: true, paused: false, consentAt: '2026-10-01T00:00:00Z', scopes: ALL, scopesChangedAt: null, profileNotes: '' };
  const exchanges = new Map<string, StoredExchange>();
  const inflight = new Set<string>();
  const usage = { requests: 0, failedRequests: 0, failedInput: 0, failedOutput: 0, failCalls: 0 };
  const recorded: RecordExchangeInput[] = [];
  const db: AiDb = {
    getSettings: async () => settings,
    getExchange: async (_u, id) => exchanges.get(id) ?? null,
    checkAndCountUsage: async (_u, limit) => {
      if (usage.requests >= limit) throw Object.assign(new Error('limit'), { code: 'PT429' });
      usage.requests++;
      return limit - usage.requests;
    },
    getUsage: async (_u, day) => ({ day, requests: usage.requests, inputTokens: 0, outputTokens: 0, costUsd: null }),
    getAccountState: async () => account(),
    getActiveProgram: async () => null,
    getRecentSessions: async () => [],
    getGoals: async () => [],
    getBodyweight: async () => [],
    getFoodLogs: async () => [],
    getHistory: async () => [],
    recordExchange: async (_u, input) => {
      if (opts.recordThrows) throw new Error('db down');
      recorded.push(input);
      inflight.delete(input.message.id);
      const reply: StoredMessage = { id: mid(900 + recorded.length), role: 'assistant', content: input.reply.content, createdAt: NOW.toISOString(), grounding: input.reply.grounding, proposalId: null, action: input.reply.action ?? null };
      const ex = { reply, proposal: null, duplicate: false };
      exchanges.set(input.message.id, ex);
      return ex;
    },
    getExercises: async () => [],
    getRecipes: async () => RECIPES as unknown as RefRecipe[],
    getIngredients: async () => INGREDIENTS as unknown as RefIngredient[],
  };
  if (opts.reservation !== false) {
    db.beginRequest = async (_u, id, limit): Promise<BeginRequestResult> => {
      if (exchanges.has(id)) return { status: 'duplicate' };
      if (inflight.has(id)) return { status: 'in_progress' };
      if (usage.requests >= limit) throw Object.assign(new Error('You’ve reached today’s limit.'), { code: 'PT429' });
      usage.requests++;
      inflight.add(id);
      return { status: 'started', remaining: limit - usage.requests };
    };
    db.failRequest = async (_u, id, u) => {
      usage.failCalls++;
      if (inflight.delete(id)) usage.requests = Math.max(0, usage.requests - 1);
      usage.failedRequests++;
      usage.failedInput += u.inputTokens;
      usage.failedOutput += u.outputTokens;
    };
  }
  return { db, usage, recorded, inflight, exchanges };
}

const reply = (t: string, inT = 10, outT = 10) => ({ id: 'm', model: 'claude-test', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: inT, output_tokens: outT } });
const toolUse = (name: string, input: unknown, id = 'toolu_1') => ({ id: 'mt', model: 'claude-test', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 400, output_tokens: 30 } });
/** Replies in order; `null` = the provider is down (HTTP 529) for that and every later call. */
function provider(replies: (unknown | null)[]) {
  const requests: { system: string; messages: unknown[] }[] = [];
  let down = false;
  const fetch: FetchLike = async (_url, init) => {
    requests.push(JSON.parse(String((init as { body?: string })?.body ?? '{}')));
    const body = down ? null : replies.length ? replies.shift() : reply('…');
    if (body === null) {
      down = true;
      return { ok: false, status: 529, headers: { get: () => null }, json: async () => ({ error: { type: 'overloaded_error' } }), text: async () => '{"error":{"type":"overloaded_error"}}' };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, requests };
}
function deps(db: AiDb, fetch: FetchLike, env: Record<string, string> = {}): CoachDeps {
  const e: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-test', AI_DAILY_REQUEST_LIMIT: '5', ...env };
  return { db, fetch, env: (k) => e[k], now: () => NOW, sleep: async () => undefined, random: () => 0.5, log: () => undefined };
}
const send = (t: string, n = 1, extra: Record<string, unknown> = {}) => ({ action: 'send', id: mid(n), text: t, mode: 'chat', ...extra });

/* ------------------------------------------------------------------ 1. replay */
describe('1. a replay of a message still being answered never starts a second generation', () => {
  it('second send while the first is running → 409 in_progress, no provider call, not counted', async () => {
    const f = fakeDb();
    await f.db.beginRequest!(U, mid(1), 5); // the first request is in flight
    const p = provider([reply('Hi!')]);
    const res = await handleAiCoach(deps(f.db, p.fetch), U, send('Hello', 1));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'in_progress', reason: 'in_progress' });
    expect(p.requests.length).toBe(0);
    expect(f.usage.requests).toBe(1);
  });

  it('once answered, a replay returns the stored reply (duplicate) without a new generation', async () => {
    const f = fakeDb();
    const p = provider([reply('First answer.')]);
    const first = await handleAiCoach(deps(f.db, p.fetch), U, send('Hello', 2));
    expect(first.status).toBe(200);
    const again = await handleAiCoach(deps(f.db, p.fetch), U, send('Hello', 2));
    expect(again.body).toMatchObject({ duplicate: true });
    expect((again.body.reply as StoredMessage).content).toBe('First answer.');
    expect(p.requests.length).toBe(1);
    expect(f.usage.requests).toBe(1);
  });

  it('concurrent double start: exactly one generation', async () => {
    const f = fakeDb();
    const p = provider([reply('Only once.'), reply('SECOND GENERATION')]);
    const [a, b] = await Promise.all([handleAiCoach(deps(f.db, p.fetch), U, send('Hello', 3)), handleAiCoach(deps(f.db, p.fetch), U, send('Hello', 3))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(f.recorded.length).toBe(1);
    expect(p.requests.length).toBe(1);
  });

  it('the app waits on in_progress and asks again with the same id; other errors are not retried', async () => {
    let calls = 0;
    const out = await sendWhileInProgress(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('Still answering'), { code: 'in_progress' });
      return 'reply';
    }, { sleep: async () => undefined });
    expect([out, calls]).toEqual(['reply', 3]);
    let other = 0;
    await expect(sendWhileInProgress(async () => { other++; throw Object.assign(new Error('x'), { code: 'rate_limited' }); }, { sleep: async () => undefined })).rejects.toThrow('x');
    expect(other).toBe(1);
    let n = 0;
    await expect(sendWhileInProgress(async () => { n++; throw Object.assign(new Error('busy'), { code: 'in_progress' }); }, { sleep: async () => undefined, attempts: 2 })).rejects.toThrow('busy');
    expect(n).toBe(3);
  });

  it('older database without the reservation RPC: falls back to counting (previous behaviour)', async () => {
    const f = fakeDb({ reservation: false });
    const p = provider([reply('Hi.')]);
    const res = await handleAiCoach(deps(f.db, p.fetch), U, send('Hello', 4));
    expect(res.status).toBe(200);
    expect(f.usage.requests).toBe(1);
  });
});

/* ------------------------------------------------------------------ 2 + 3. failed requests */
describe('2–3. a failed request: tokens booked as failed, allowance given back', () => {
  it('provider fails after a completed tool round → 503, nothing recorded, round tokens booked as FAILED, request refunded', async () => {
    const f = fakeDb();
    const p = provider([toolUse('find_recipes', { query: 'pancakes' }), null]);
    const res = await handleAiCoach(deps(f.db, p.fetch), U, send('Pancake ideas?', 5));
    expect(res.status).toBe(503);
    expect(f.recorded).toEqual([]);
    expect(f.usage).toMatchObject({ requests: 0, failedRequests: 1, failedInput: 400, failedOutput: 30, failCalls: 1 });
  });

  it('a failed request does not use up the daily allowance (limit 1: fail, then succeed)', async () => {
    const f = fakeDb();
    const d = (fetch: FetchLike) => deps(f.db, fetch, { AI_DAILY_REQUEST_LIMIT: '1' });
    expect((await handleAiCoach(d(provider([null]).fetch), U, send('Hello', 6))).status).toBe(503);
    const ok = await handleAiCoach(d(provider([reply('Hi there.')]).fetch), U, send('Hello again', 7));
    expect(ok.status).toBe(200);
    expect(f.usage.requests).toBe(1);
    expect((await handleAiCoach(d(provider([reply('x')]).fetch), U, send('Third', 8))).status).toBe(429);
  });

  it('storing the answer fails → error, the request is refunded exactly once', async () => {
    const f = fakeDb({ recordThrows: true });
    const p = provider([reply('Answer.', 50, 20)]);
    await expect(handleAiCoach(deps(f.db, p.fetch), U, send('Hello', 9))).rejects.toThrow('db down');
    expect(f.usage).toMatchObject({ requests: 0, failCalls: 1, failedInput: 50, failedOutput: 20 });
  });

  it('a successful exchange is not touched by the failure path', async () => {
    const f = fakeDb();
    const p = provider([reply('Fine.', 70, 9)]);
    expect((await handleAiCoach(deps(f.db, p.fetch), U, send('Hello', 10))).status).toBe(200);
    expect(f.usage).toMatchObject({ requests: 1, failCalls: 0 });
    expect(f.recorded[0].reply).toMatchObject({ inputTokens: 70, outputTokens: 9 });
  });
});

/* ------------------------------------------------------------------ 5. sync barrier */
describe('5. sync barrier', () => {
  const outbox = (counts: number[]) => ({ count: vi.fn(async () => (counts.length > 1 ? counts.shift()! : counts[0])) });
  it('nothing pending (or guest) → no sync, 0', async () => {
    const sync = vi.fn(async () => undefined);
    expect(await syncBeforeAi({ outbox: outbox([0]), isGuest: false } as never, { sync })).toBe(0);
    expect(await syncBeforeAi({ outbox: outbox([4]), isGuest: true } as never, { sync })).toBe(0);
    expect(sync).not.toHaveBeenCalled();
  });
  it('pending changes → waits for the sync, returns what is still unsynced', async () => {
    const sync = vi.fn(async () => undefined);
    expect(await syncBeforeAi({ outbox: outbox([3, 0]), isGuest: false } as never, { sync })).toBe(0);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(await syncBeforeAi({ outbox: outbox([3, 2]), isGuest: false } as never, { sync })).toBe(2);
  });
  it('a sync that hangs (offline) is cut off at the timeout; a failing sync never blocks the send', async () => {
    const t0 = Date.now();
    expect(await syncBeforeAi({ outbox: outbox([2]), isGuest: false } as never, { sync: () => new Promise(() => undefined), timeoutMs: 30 })).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await syncBeforeAi({ outbox: outbox([2]), isGuest: false } as never, { sync: async () => { throw new Error('offline'); } })).toBe(2);
  });
  it('the server tells the coach about unsynced changes (clamped); none → no line', async () => {
    const f = fakeDb();
    const p = provider([reply('a'), reply('b'), reply('c')]);
    await handleAiCoach(deps(f.db, p.fetch), U, send('How was my week?', 11, { unsynced: 2 }));
    await handleAiCoach(deps(f.db, p.fetch), U, send('How was my week?', 12));
    await handleAiCoach(deps(f.db, p.fetch), U, send('How was my week?', 13, { unsynced: 'lots' }));
    expect(p.requests[0].system).toMatch(/Not synced yet: 2 recent changes .*don't conclude they skipped/);
    expect(p.requests[1].system).not.toMatch(/Not synced yet/);
    expect(p.requests[2].system).not.toMatch(/Not synced yet/);
  });
});

/* ------------------------------------------------------------------ 6. Icelandic */
describe('6. Icelandic summaries and dates', () => {
  it('detects the language (null when it can’t tell) and falls back through earlier text', () => {
    expect(detectLang('Búðu til matarplan fyrir vikuna')).toBe('is');
    expect(detectLang('get ég fengið uppskrift')).toBe('is');
    expect(detectLang('Make me a meal plan')).toBe('en');
    expect(detectLang('ok')).toBeNull();
    expect(replyLang('ok', 'Búðu til matarplan')).toBe('is');
    expect(detectLang('👍')).toBeNull();
    expect(replyLang('👍', 'Gerðu matarplan')).toBe('is');
    expect(replyLang(null, '')).toBe('en');
  });
  it('dates: "fim. 29. okt.", í dag / á morgun / á laugardaginn, always short in free text', () => {
    expect(shortDate('2026-10-31', 'is')).toBe('lau. 31. okt.');
    expect(shortDate('2026-10-31')).toBe('Sat 31 Oct');
    expect(humanDate('2026-10-29', '2026-10-29', 1, 'is')).toBe('í dag');
    expect(humanDate('2026-10-30', '2026-10-29', 1, 'is')).toBe('á morgun');
    expect(humanDate('2026-10-31', '2026-10-29', 1, 'is')).toBe('á laugardaginn');
    expect(humanDate('2026-11-03', '2026-10-29', 1, 'is')).toBe('á þri. 3. nóv.');
    expect(humanizeDates('Æfing 2026-10-31 og 2026-11-02.', '2026-10-29', 1, 'is')).toBe('Æfing lau. 31. okt. og mán. 2. nóv.');
    expect(humanizeDates('Train 2026-10-31.', '2026-10-29')).toBe('Train Saturday.');
    expect(humanizeDates('Æfing 2026-05-30.', '2026-05-01', 1, 'is')).toBe('Æfing lau. 30. maí.');
  });
  it('summaries in Icelandic', () => {
    const week = { kind: 'week_adjustment', sessions: [{ name: 'Full body A', date: '2026-10-31', plannedDate: '2026-10-30' }, { name: 'Full body B', date: '2026-11-01', plannedDate: '2026-11-01' }], skipped: [{ name: 'Full body C' }], warnings: [] } as unknown as WeekAdjustmentAction;
    expect(summarizeWeekPlan(week, '2026-10-29', 1, 'is')).toBe('Svona lítur vikan út: **Full body A** færist á laugardaginn, **Full body B** verður áfram á sunnudaginn, **Full body C** fellur niður þessa viku. Ýttu á **Apply to this week** til að nota það.');
    const meals = { kind: 'meal_plan', days: [{ date: '2026-11-02' }, { date: '2026-11-03' }, { date: '2026-11-04' }], warnings: [] } as unknown as MealPlanAction;
    expect(summarizeMealPlan(meals, '2026-10-29', 1, 'is')).toBe('Hér er matarplan fyrir 3 daga (frá mán. 2. nóv. til mið. 4. nóv.) — ýttu á **Add to my meal plan** til að setja það inn í appið.');
    expect(summarizeMealPlan({ ...meals, days: [{ date: '2026-10-30' }] } as unknown as MealPlanAction, '2026-10-29', 1, 'is')).toBe('Hér er matarplan fyrir 1 dag (á morgun) — ýttu á **Add to my meal plan** til að setja það inn í appið.');
    expect(summarizeMealPlan({ ...meals, days: [{ date: '2026-10-30' }, { date: '2026-10-31' }] } as unknown as MealPlanAction, '2026-10-29', 1, 'is')).toMatch(/\(frá fös\. 30\. okt\. til lau\. 31\. okt\.\)/);
    const recipes = { kind: 'recipe_suggestions', id: 'x', recipes: [{}, {}] } as unknown as RecipeSuggestionsAction;
    expect(summarizeRecipes(recipes, 'is')).toBe('Hér eru 2 uppskriftir sem passa — ýttu á eina til að opna hana.');
    expect(summarizeProposal({ name: 'Styrkur', sessionsPerWeek: 3, target: 'apply', schedule: [], invalid: false }, 'is')).toBe('Ég hef sett saman **Styrkur** (3 æfingar á viku) — ýttu á **Add to my program — review** til að skoða það og bæta því við.');
    expect(thanksLine(['training', 'nutrition'], 'is')).toBe('Takk — nú sé ég æfingarnar þínar og næringuna þína.');
    expect(thanksLine(['training'], 'en')).toBe('Thanks — I can see your training now.');
  });
  it('handler: an Icelandic meal-plan request whose reply is replaced gets the Icelandic summary', async () => {
    const f = fakeDb();
    const p = provider([reply('Hér er planið: lax á mánudag …')]);
    const res = await handleAiCoach(deps(f.db, p.fetch), U, send('Búðu til matarplan fyrir næstu viku, án fisks', 14));
    const content = (res.body.reply as StoredMessage).content;
    expect(content).toMatch(/^Hér er matarplan fyrir 7 daga \(frá mán\. 2\. nóv\. til sun\. 8\. nóv\.\)/);
    // English request → English summary (unchanged)
    const en = await handleAiCoach(deps(f.db, provider([reply('Here: salmon Monday …')]).fetch), U, send('Make a meal plan for next week, no fish', 15));
    expect((en.body.reply as StoredMessage).content).toMatch(/^Here's your meal plan for Mon 2 Nov to Sun 8 Nov/);
  });
  it('handler: ISO dates in an Icelandic reply are written the Icelandic way', async () => {
    const f = fakeDb();
    const res = await handleAiCoach(deps(f.db, provider([reply('Næsta æfing er 2026-10-31.')]).fetch), U, send('Hvenær er næsta æfing?', 16));
    expect((res.body.reply as StoredMessage).content).toBe('Næsta æfing er lau. 31. okt.');
  });
});

/* ------------------------------------------------------------------ 7. tiredness */
describe('7. "too tired" detection', () => {
  it.each([
    ['I’m too tired today', true], ['so exhausted, should I train?', true], ['feeling drained', true], ['completely wiped out', true],
    ['Ég er of þreytt í dag', true], ['ég er þreyttur', true], ['alveg búin á því', true], ['uppgefin eftir vinnuna', true],
    ['I’m tired of chicken', false], ['sick and tired of oats', false], ['ég er þreytt á kjúklingi', false], ['Make me a meal plan', false], ['retired athlete', false],
  ])('%s → %s', (t, expected) => {
    expect(mentionsTiredness(t)).toBe(expected);
  });
});

/* ------------------------------------------------------------------ 8. optional ingredients */
describe('8. "pancakes without blueberries"', () => {
  const facts: UserFacts = { units: 'kg', timeZone: 'UTC', weekStart: 1, equipment: null, excludedExerciseIds: [], limitations: [], allergens: [], dietTags: [], dislikedIngredientIds: [], maxCookMinutes: 30, activeProgram: null };
  const db = { getRecipes: async () => RECIPES, getIngredients: async () => INGREDIENTS } as unknown as AiDb;
  async function find(q: string, over: Partial<UserFacts> = {}) {
    const state: ToolState = { proposal: null, proposalAttempts: 0, weekPlan: null, weekAttempts: 0, mealPlan: null, mealPlanAttempts: 0, recipes: null };
    const out = JSON.parse((await runTool('find_recipes', { query: q, max_results: 5 }, { db, facts: { ...facts, ...over }, catalog: new Map(), state, messageId: 'm1', requestText: q } as never)).content);
    return { out, cards: state.recipes!.recipes };
  }
  /** The ingredient ids a suggested recipe is actually made with (optional ones left out, swaps applied). */
  const madeWith = (c: RecipeSuggestionsAction['recipes'][number]) =>
    RECIPES_BY_ID.get(c.id)!.ingredients.filter((i) => !c.omit?.includes(i.ingredientId)).map((i) => c.swaps?.find((s) => s.from === i.ingredientId)?.to ?? i.ingredientId);

  it.each(['Pancakes without blueberries', 'pönnukökur án bláberja'])('%s → pancakes only, blueberries left out where optional, none made with blueberries', async (q) => {
    const { out, cards } = await find(q);
    expect(out.fallback).toBeUndefined();
    expect(cards.length).toBeGreaterThan(1);
    expect(cards.every((c) => /pancake/i.test(c.name))).toBe(true);
    const skyr = cards.find((c) => c.id === 'skyr-oat-pancakes');
    expect(skyr).toMatchObject({ omit: ['blueberries'] });
    for (const c of cards) expect(madeWith(c)).not.toContain('blueberries');
  });

  it('a non-optional excluded ingredient is swapped for a substitute the recipe lists ("without raspberries")', async () => {
    const { cards } = await find('pancakes without raspberries');
    const ricotta = cards.find((c) => c.id === 'lemon-ricotta-pancakes')!;
    expect(ricotta.swaps?.[0]?.from).toBe('raspberries');
    for (const c of cards) expect(madeWith(c)).not.toContain('raspberries');
  });

  it('allergens, diet and proteins are never swapped: "pancakes without eggs" returns no egg recipe, "no meat" no meat swap', async () => {
    const { cards } = await find('pancakes without eggs');
    for (const c of cards) {
      expect(c.swaps ?? []).toEqual([]);
      for (const id of madeWith(c)) expect(ING.get(id)?.allergens ?? []).not.toContain('egg');
    }
    const meat = await find('dinner with no meat');
    for (const c of meat.cards) for (const s of c.swaps ?? []) expect(ING.get(s.from)?.proteinGroup).toBeUndefined();
  });

  it('the user’s own dislike is never swapped back in by a request swap', async () => {
    const { cards } = await find('pancakes without raspberries', { dislikedIngredientIds: ['blueberries'] });
    for (const c of cards) expect(madeWith(c)).not.toEqual(expect.arrayContaining(['blueberries']));
    for (const c of cards) expect(madeWith(c)).not.toContain('raspberries');
  });

  it('the card keeps valid omit/swaps, drops anything else, and says what changed; Open carries the swaps', () => {
    const parsed = toRecipeSuggestions({
      kind: 'recipe_suggestions', id: 'a',
      recipes: [
        { id: 'skyr-oat-pancakes', perServing: {}, omit: ['blueberries', 'egg'], swaps: [{ from: 'skyr-plain', to: 'cottage-cheese' }, { from: 'egg', to: 'tofu-firm' }, { from: 'skyr-plain', to: 'greek-yogurt-0' }] },
      ],
    })!;
    const c = parsed.recipes[0];
    expect(c.omit).toEqual(['blueberries']); // egg is not optional in this recipe
    expect(c.swaps).toEqual([{ from: 'skyr-plain', to: 'cottage-cheese' }]); // not a listed substitute / second swap for the same ingredient dropped
    expect(changesText(c)).toBe('Without blueberries · Cottage cheese, low-fat instead of skyr, plain');
    expect(recipeHref(c)).toBe('/nutrition/recipes/skyr-oat-pancakes?swap=skyr-plain:cottage-cheese');
    expect(recipeHref({ id: 'skyr-oat-pancakes' })).toBe('/nutrition/recipes/skyr-oat-pancakes');
    expect(linkSwaps(RECIPES_BY_ID.get('skyr-oat-pancakes')!, 'skyr-plain:cottage-cheese,egg:tofu-firm,x:y')).toEqual([{ from: 'skyr-plain', to: 'cottage-cheese' }]);
    expect(linkSwaps(RECIPES_BY_ID.get('skyr-oat-pancakes')!, null)).toEqual([]);
  });
});
