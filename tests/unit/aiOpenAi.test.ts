/**
 * AI coach with OpenAI as the provider — MOCKED (injected fetch returning Chat Completions shapes, in-memory db).
 * No network and no live OpenAI API. Covers: provider selection from env, request/response translation
 * (incl. a tool-call round trip), per-provider consent, quota errors, and the client-side provider wording.
 */
import { describe, expect, it } from 'vitest';
import { handleAiCoach, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { createMessage, resolveProvider } from '../../supabase/functions/_shared/ai/provider';
import { fromOpenAiResponse, isOpenAiQuotaError, toOpenAiRequest } from '../../supabase/functions/_shared/ai/openai';
import type { AiDb, AiSettingsRow, FetchLike, RecordExchangeInput, StoredMessage } from '../../supabase/functions/_shared/ai/types';
import { classifyAiError, consentOutdated, providerLabel, settingsActive } from '@/features/coaching/ai/model';

const UID = '11111111-1111-4111-8111-111111111111';
const MSG = '00000000-0000-4000-8000-000000001000';

function db(settings: Partial<AiSettingsRow> = {}) {
  const recorded: RecordExchangeInput[] = [];
  const s: AiSettingsRow = {
    enabled: true,
    paused: false,
    consentAt: '2026-10-29T08:00:00Z',
    consentVersion: '2026-10-29:openai',
    scopes: { profile: true, training: true, measurements: false, nutrition: false },
    scopesChangedAt: null,
    profileNotes: '',
    ...settings,
  };
  const impl: AiDb = {
    getSettings: async () => s,
    getExchange: async () => null,
    checkAndCountUsage: async () => 10,
    getUsage: async (_u, day) => ({ day, requests: 1, inputTokens: 0, outputTokens: 0, costUsd: null }),
    getAccountState: async () => ({ settings: { units: { weight: 'kg' } }, profile: { goal: 'build_muscle', experience: 'beginner' } }),
    getActiveProgram: async () => null,
    getRecentSessions: async () => [],
    getGoals: async () => [],
    getBodyweight: async () => [],
    getFoodLogs: async () => [],
    getHistory: async () => [],
    recordExchange: async (_uid, input) => {
      recorded.push(input);
      const reply: StoredMessage = { id: 'r1', role: 'assistant', content: input.reply.content, createdAt: '2026-10-29T10:00:00Z' };
      return { reply, proposal: null, duplicate: false };
    },
    getExercises: async () => [
      { id: 'goblet-squat', name: 'Goblet squat', pattern: 'squat', equipment: ['dumbbell'], tracking: 'weight_reps', substitutions: [], stresses: [] },
    ],
    getRecipes: async () => [],
    getIngredients: async () => [],
  };
  return { db: impl, recorded };
}

type Reply = { status?: number; body: unknown };
function mockFetch(replies: Reply[]) {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = replies.shift() ?? { status: 500, body: {} };
    const status = r.status ?? 200;
    return { ok: status < 300, status, headers: { get: () => null }, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return { fetch, requests };
}

const deps = (d: AiDb, fetch: FetchLike, env: Record<string, string> = { OPENAI_API_KEY: 'sk-openai-test' }): CoachDeps => ({
  db: d,
  fetch,
  env: (k) => env[k],
  now: () => new Date('2026-10-29T10:00:00Z'),
  sleep: async () => {},
  random: () => 0.5,
});

const oaText = (text: string, usage = { prompt_tokens: 800, completion_tokens: 150 }) => ({
  body: { id: 'chatcmpl-1', model: 'gpt-5-mini-2025-08-07', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage },
});
const oaTool = (name: string, args: unknown) => ({
  body: {
    id: 'chatcmpl-0',
    model: 'gpt-5-mini-2025-08-07',
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 700, completion_tokens: 60 },
  },
});

describe('provider selection (MOCKED env)', () => {
  it('uses OpenAI when only OPENAI_API_KEY is set, with a reasoning-friendly default', () => {
    const p = resolveProvider((k) => ({ OPENAI_API_KEY: 'sk-x' })[k]);
    expect(p).toMatchObject({ provider: 'openai', model: 'gpt-5-mini', reasoningEffort: 'low', reasoningAllowance: 2000 });
  });
  it('AI_PROVIDER picks explicitly; a missing key for the chosen provider means not configured', () => {
    expect(resolveProvider((k) => ({ OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' })[k])?.provider).toBe('anthropic');
    expect(resolveProvider((k) => ({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' })[k])?.provider).toBe('openai');
    expect(resolveProvider((k) => ({ AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'b' })[k])).toBeNull();
    expect(resolveProvider(() => undefined)).toBeNull();
  });
  it('non-reasoning models get no reasoning_effort; it can also be switched off', () => {
    expect(resolveProvider((k) => ({ OPENAI_API_KEY: 'a', OPENAI_MODEL: 'gpt-4.1-mini' })[k])).toMatchObject({ reasoningEffort: undefined, reasoningAllowance: 0 });
    expect(resolveProvider((k) => ({ OPENAI_API_KEY: 'a', OPENAI_REASONING_EFFORT: 'off' })[k])?.reasoningEffort).toBeUndefined();
    expect(resolveProvider((k) => ({ OPENAI_API_KEY: 'a', OPENAI_REASONING_EFFORT: 'medium' })[k])?.reasoningEffort).toBe('medium');
  });
});

describe('OpenAI translation (pure)', () => {
  it('maps system, tool calls and tool results to Chat Completions messages and functions', () => {
    const req = toOpenAiRequest(
      {
        system: 'SYS',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'c1', name: 'find_recipes', input: { query: 'oats' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"ok":1}' }] },
        ],
        tools: [{ name: 'find_recipes', description: 'd', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'none' },
      },
      { model: 'gpt-5-mini', maxTokens: 3200, reasoningEffort: 'low' },
    );
    expect(req).toMatchObject({ model: 'gpt-5-mini', max_completion_tokens: 3200, reasoning_effort: 'low', tool_choice: 'none' });
    expect(req.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'checking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find_recipes', arguments: '{"query":"oats"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":1}' },
    ]);
    expect(req.tools).toEqual([{ type: 'function', function: { name: 'find_recipes', description: 'd', parameters: { type: 'object', properties: {} } } }]);
    expect(req).not.toHaveProperty('max_tokens');
    expect(req).not.toHaveProperty('temperature');
  });

  it('maps responses: tool calls, length cut-off, malformed arguments and usage', () => {
    const t = fromOpenAiResponse(oaTool('exercise_alternatives', { exercise_id: 'x' }).body)!;
    expect(t.stop_reason).toBe('tool_use');
    expect(t.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'exercise_alternatives', input: { exercise_id: 'x' } }]);
    expect(t.usage).toEqual({ input_tokens: 700, output_tokens: 60 });
    const cut = fromOpenAiResponse({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] })!;
    expect(cut.stop_reason).toBe('max_tokens');
    const bad = fromOpenAiResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'n', arguments: '{oops' } }] } }] })!;
    expect(bad.content[0]).toMatchObject({ type: 'tool_use', input: { _invalid_json: true } });
    expect(fromOpenAiResponse({ error: 'x' })).toBeNull();
    expect(isOpenAiQuotaError('{"error":{"code":"insufficient_quota"}}')).toBe(true);
    expect(isOpenAiQuotaError('{"error":{"code":"rate_limit_exceeded"}}')).toBe(false);
  });
});

describe('AI coach end to end with OpenAI (MOCKED provider)', () => {
  it('calls Chat Completions with a Bearer key, runs a tool round, records usage', async () => {
    const { db: d, recorded } = db();
    const { fetch, requests } = mockFetch([oaTool('exercise_alternatives', { exercise_id: 'goblet-squat' }), oaText('Try goblet squats.')]);
    const res = await handleAiCoach(deps(d, fetch), UID, { action: 'send', id: MSG, text: 'What can replace squats?' });
    expect(res.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(requests[0]!.headers.authorization).toBe('Bearer sk-openai-test');
    expect(requests[0]!.headers).not.toHaveProperty('x-api-key');
    expect(requests[0]!.body).toMatchObject({ model: 'gpt-5-mini', max_completion_tokens: 1200 + 2000, reasoning_effort: 'low', tool_choice: 'auto' });
    const second = requests[1]!.body.messages as { role: string; tool_call_id?: string }[];
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(second[0]).toMatchObject({ role: 'system' });
    expect(recorded[0]!.reply).toMatchObject({ content: 'Try goblet squats.', model: 'gpt-5-mini-2025-08-07', inputTokens: 1500, outputTokens: 210 });
  });

  it('status names the provider and says whether the stored consent covers it', async () => {
    const { fetch } = mockFetch([]);
    const ok = await handleAiCoach(deps(db().db, fetch), UID, { action: 'status' });
    expect(ok.body).toMatchObject({ available: true, provider: 'openai', providerName: 'OpenAI', consentCurrent: true });
    const old = await handleAiCoach(deps(db({ consentVersion: '2026-10-29' }).db, fetch), UID, { action: 'status' });
    expect(old.body).toMatchObject({ provider: 'openai', consentCurrent: false });
  });

  it('consent given for Anthropic does not cover OpenAI: 409 consent_required and nothing is sent', async () => {
    const { fetch, requests } = mockFetch([oaText('should not be called')]);
    const res = await handleAiCoach(deps(db({ consentVersion: '2026-10-29' }).db, fetch), UID, { action: 'send', id: MSG, text: 'hi' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'consent_required', reason: 'consent_required' });
    expect(requests).toHaveLength(0);
  });

  it('out of OpenAI credits is reported as unavailable without retrying', async () => {
    const { fetch, requests } = mockFetch([{ status: 429, body: { error: { code: 'insufficient_quota', message: 'secret details' } } }, oaText('x')]);
    const res = await handleAiCoach(deps(db().db, fetch), UID, { action: 'send', id: MSG, text: 'hi' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'ai_unavailable', reason: 'provider_down' });
    expect(JSON.stringify(res.body)).not.toContain('secret details');
    expect(requests).toHaveLength(1);
  });

  it('a bad OpenAI key is "not configured"; Anthropic still works when chosen', async () => {
    const { fetch } = mockFetch([{ status: 401, body: { error: { code: 'invalid_api_key' } } }]);
    const res = await handleAiCoach(deps(db().db, fetch), UID, { action: 'send', id: MSG, text: 'hi' });
    expect(res.body).toMatchObject({ reason: 'not_configured' });

    const a = mockFetch([{ body: { content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }]);
    const viaAnthropic = await createMessage({ provider: 'anthropic', apiKey: 'k', model: 'm', maxTokens: 10, fetch: a.fetch }, { system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(viaAnthropic.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(a.requests[0]!.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('client wording and consent state', () => {
  const s = { enabled: true, paused: false, consentAt: 'x', scopes: { profile: true, training: true, measurements: true, nutrition: true }, profileNotes: '' };
  it('names the provider the server reports, generic otherwise', () => {
    expect(providerLabel({ available: true, provider: 'openai', providerName: 'OpenAI' })).toBe('OpenAI');
    expect(providerLabel({ available: false, reason: 'offline' })).toBe('the AI provider');
  });
  it('an outdated consent turns the coach off until the user agrees again', () => {
    const a = { available: true as const, provider: 'openai' as const, providerName: 'OpenAI', consentCurrent: false };
    expect(consentOutdated(s, a)).toBe(true);
    expect(settingsActive(s, a)).toBe(false);
    expect(settingsActive(s, { ...a, consentCurrent: true })).toBe(true);
    expect(settingsActive(s, { available: false, reason: 'offline' })).toBe(true);
    expect(classifyAiError({ code: 'consent_required', message: 'The AI coach now uses OpenAI.' })).toMatchObject({ kind: 'disabled', message: 'The AI coach now uses OpenAI.' });
  });
});
