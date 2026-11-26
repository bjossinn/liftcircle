/**
 * Structured Outputs for the final conversational envelope (roadmap item 10), MOCKED providers.
 *  - explicit capability configuration (provider / model / endpoint / AI_STRUCTURED_OUTPUT), text path otherwise;
 *  - the schema on every round, for Anthropic (output_config.format) and OpenAI (response_format json_schema, strict);
 *    tool schemas are NOT made strict;
 *  - refusal, truncation and malformed JSON: never shown, usage booked before parsing, deterministic action summary
 *    when a valid server action exists, otherwise invalid_reply through the normal failure settlement;
 *  - link markers inside `answer` still go through link filtering; `why` is a short user-facing explanation.
 */
import { describe, expect, it } from 'vitest';
import { handleAiCoach, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { outputFormatFor, parseEnvelope, REPLY_SCHEMA } from '../../supabase/functions/_shared/ai/structured';
import { fromOpenAiResponse } from '../../supabase/functions/_shared/ai/openai';
import { createMessage, fromAnthropicResponse, AiCancelledError } from '../../supabase/functions/_shared/ai/provider';
import type { AiSettingsRow, FetchLike, StoredMessage } from '../../supabase/functions/_shared/ai/types';
import { createMemoryDb } from '../evals/memoryDb';

const U = '11111111-1111-4111-8111-111111111111';
const mid = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-26T12:00:00Z');
const settings = (provider = 'anthropic'): AiSettingsRow => ({
  enabled: true, paused: false, consentAt: '2026-11-01T00:00:00Z', consentVersion: `2026-10-29:${provider}`,
  scopes: { profile: true, training: true, measurements: false, nutrition: false }, profileNotes: '',
});
const anthropicText = (t: string, extra: Record<string, unknown> = {}) => ({ id: 'm', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 }, ...extra });
const env = (o: Record<string, string> = {}) => (k: string) => ({ ANTHROPIC_API_KEY: 'sk-test', ...o } as Record<string, string | undefined>)[k];

function provider(replies: unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    headers.push(init.headers);
    const body = replies.shift() ?? anthropicText('{"answer":"…","why":null}');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, requests, headers };
}
function setup(replies: unknown[], e = env(), s = settings()) {
  const mem = createMemoryDb({ uid: U, settings: s, clock: () => NOW.getTime() });
  const p = provider(replies);
  const logs: { event: string; [k: string]: unknown }[] = [];
  const deps: CoachDeps = { db: mem.db, fetch: p.fetch, env: e, now: () => NOW, sleep: async () => undefined, random: () => 0.5, log: (event, f) => logs.push({ event, ...f }) };
  return { mem, deps, ...p, logs };
}
const send = (text: string, n = 1) => ({ action: 'send', id: mid(n), text, mode: 'chat' });

describe('capability configuration', () => {
  it('uses Structured Outputs only for known models on the official endpoint, unless explicitly configured', () => {
    expect(outputFormatFor({ provider: 'anthropic', model: 'claude-sonnet-5-5' }, env())).toBe('json_schema');
    expect(outputFormatFor({ provider: 'anthropic', model: 'claude-opus-5-5' }, env())).toBe('json_schema');
    expect(outputFormatFor({ provider: 'anthropic', model: 'claude-3-haiku-20240307' }, env())).toBe('text');
    expect(outputFormatFor({ provider: 'openai', model: 'gpt-5-mini' }, env())).toBe('json_schema');
    expect(outputFormatFor({ provider: 'openai', model: 'gpt-3.5-turbo' }, env())).toBe('text');
    // Custom endpoints are never assumed to support it…
    expect(outputFormatFor({ provider: 'openai', model: 'gpt-5-mini', baseUrl: 'https://proxy.example' }, env())).toBe('text');
    // …unless the operator says so; and it can always be switched off.
    expect(outputFormatFor({ provider: 'openai', model: 'my-model', baseUrl: 'https://proxy.example' }, env({ AI_STRUCTURED_OUTPUT: 'on' }))).toBe('json_schema');
    expect(outputFormatFor({ provider: 'anthropic', model: 'claude-sonnet-5-5' }, env({ AI_STRUCTURED_OUTPUT: 'off' }))).toBe('text');
  });

  it('parses only the exact envelope; refusal and truncation are explicit', () => {
    expect(parseEnvelope('{"answer":"Rest today.","why":"You slept badly."}', 'end_turn')).toEqual({ ok: true, answer: 'Rest today.', why: 'You slept badly.' });
    expect(parseEnvelope('{"answer":"Rest.","why":null}', 'end_turn')).toEqual({ ok: true, answer: 'Rest.', why: null });
    expect(parseEnvelope('{"answer":"Rest.","why":null,"safe":true}', 'end_turn')).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseEnvelope('{"answer":"Rest."}', 'end_turn')).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseEnvelope('Rest today.', 'end_turn')).toEqual({ ok: false, reason: 'invalid_json' });
    expect(parseEnvelope('{"answer":"Rest to', 'max_tokens')).toEqual({ ok: false, reason: 'truncated' });
    expect(parseEnvelope('I can’t help with that.', 'refusal', 'I can’t help with that.')).toEqual({ ok: false, reason: 'refusal' });
    expect(REPLY_SCHEMA).toEqual({ type: 'object', properties: { answer: { type: 'string' }, why: { type: ['string', 'null'] } }, required: ['answer', 'why'], additionalProperties: false });
  });

  it('normalizes refusals from both providers without losing them', () => {
    const oa = fromOpenAiResponse({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I can’t help with that.' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    expect(oa).toMatchObject({ stop_reason: 'refusal', refusal: 'I can’t help with that.' });
    const trunc = fromOpenAiResponse({ choices: [{ finish_reason: 'length', message: { content: '{"answer":"Re' } }] });
    expect(trunc?.stop_reason).toBe('max_tokens');
    expect(fromAnthropicResponse({ content: [], stop_reason: 'refusal' })).toMatchObject({ stop_reason: 'refusal', refusal: 'refusal' });
  });
});

describe('request shapes', () => {
  it('Anthropic: output_config.format json_schema on every round, no beta header, tools not strict', async () => {
    const { deps, requests, headers } = setup([
      { id: 'm', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 't1', name: 'exercise_alternatives', input: { exercise_id: 'x' } }], stop_reason: 'tool_use', usage: { input_tokens: 50, output_tokens: 10 } },
      anthropicText('{"answer":"Try **goblet squats** today.","why":"Your knee felt better with them."}'),
    ]);
    const res = await handleAiCoach(deps, U, send('What instead of squats?'));
    expect(res.status).toBe(200);
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(r.output_config).toEqual({ format: { type: 'json_schema', schema: REPLY_SCHEMA } });
      expect((r.tools as { strict?: boolean }[]).some((t) => t.strict)).toBe(false);
    }
    expect(headers.every((h) => !('anthropic-beta' in h))).toBe(true);
    const reply = res.body.reply as StoredMessage;
    expect(reply.content).toBe('Try **goblet squats** today.');
    expect(reply.why).toBe('Your knee felt better with them.');
    expect(String(requests[0].system)).toMatch(/"why" is null or 1–3 short sentences/);
    expect(String(requests[0].system)).not.toContain('[[why]]');
  });

  it('OpenAI: response_format json_schema (strict) on every round', async () => {
    const mem = createMemoryDb({ uid: U, settings: settings('openai'), clock: () => NOW.getTime() });
    const requests: Record<string, unknown>[] = [];
    const replies = [{ choices: [{ finish_reason: 'stop', message: { content: '{"answer":"Rest today.","why":null}' } }], usage: { prompt_tokens: 80, completion_tokens: 12 } }];
    const fetch: FetchLike = async (_u, init) => {
      requests.push(JSON.parse(init.body));
      const b = replies.shift();
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => b, text: async () => '' };
    };
    const res = await handleAiCoach({ db: mem.db, fetch, env: (k) => ({ OPENAI_API_KEY: 'sk' } as Record<string, string>)[k], now: () => NOW, sleep: async () => undefined }, U, send('I am wiped'));
    expect(res.status).toBe(200);
    expect(requests[0].response_format).toEqual({ type: 'json_schema', json_schema: { name: 'coach_reply', strict: true, schema: REPLY_SCHEMA } });
    expect((requests[0].tools as { function: { strict?: boolean } }[]).some((t) => t.function.strict)).toBe(false);
    expect((res.body.reply as StoredMessage).content).toBe('Rest today.');
  });

  it('text path (unsupported or switched off): no schema, the [[why]] split as before', async () => {
    const { deps, requests } = setup([anthropicText('Rest today.\n[[why]]\nYou slept four hours.')], env({ AI_STRUCTURED_OUTPUT: 'off' }));
    const res = await handleAiCoach(deps, U, send('Should I train?'));
    expect(requests[0].output_config).toBeUndefined();
    expect(String(requests[0].system)).toContain('[[why]]');
    expect(res.body.reply).toMatchObject({ content: 'Rest today.', why: 'You slept four hours.' });
  });

  it('keeps link markers in the answer and filters them afterwards', async () => {
    const { deps } = setup([anthropicText(JSON.stringify({ answer: 'Change it in Settings.\n[[open:/settings|Open Settings]]\n[[open:/made-up|Nope]]', why: null }))]);
    const res = await handleAiCoach(deps, U, send('Where do I change the language?'));
    const c = (res.body.reply as StoredMessage).content;
    expect(c).toContain('[[open:/settings|Open Settings]]');
    expect(c).not.toContain('/made-up');
  });
});

describe('invalid envelopes', () => {
  for (const [name, reply] of [
    ['refusal', anthropicText('', { content: [], stop_reason: 'refusal' })],
    ['truncation', anthropicText('{"answer":"Rest to', { stop_reason: 'max_tokens' })],
    ['malformed JSON', anthropicText('{answer: Rest today}')],
  ] as const) {
    it(`${name} without a server action: invalid_reply, refunded, completed-round tokens booked as failed, no raw JSON`, async () => {
      const { deps, mem, logs } = setup([reply]);
      const res = await handleAiCoach(deps, U, send('hi'));
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ code: 'invalid_reply', reason: 'invalid_reply', error: 'The reply could not be checked. Please try again.' });
      expect(JSON.stringify(res.body)).not.toContain('{answer');
      expect(mem.state.exchanges.size).toBe(0);
      const u = mem.usageOf('2026-11-26');
      expect(u.requests).toBe(0); // refunded once
      expect(u).toMatchObject({ failedRequests: 1, failedInputTokens: 100, failedOutputTokens: 20 });
      expect(logs.some((l) => l.event === 'ai_reply_invalid')).toBe(true);
    });
  }

  it('Icelandic invalid_reply copy comes from the approved dictionary', async () => {
    const { deps } = setup([anthropicText('not json')]);
    const res = await handleAiCoach(deps, U, { ...send('Hæ'), language: 'is' });
    expect(res.body.error).toBe('Ekki tókst að yfirfara svarið. Reyndu aftur.');
  });

  it('usage of a failed earlier round is booked even when the final round is malformed', async () => {
    const { deps, mem } = setup([
      { id: 'm', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 't1', name: 'exercise_alternatives', input: { exercise_id: 'x' } }], stop_reason: 'tool_use', usage: { input_tokens: 70, output_tokens: 7 } },
      anthropicText('oops', { usage: { input_tokens: 90, output_tokens: 9 } }),
    ]);
    await handleAiCoach(deps, U, send('hi'));
    expect(mem.usageOf('2026-11-26')).toMatchObject({ failedInputTokens: 160, failedOutputTokens: 16 });
  });

  it('missing provider usage is booked as unknown, not zero', async () => {
    const { deps, mem } = setup([{ id: 'm', model: 'x', content: [{ type: 'text', text: 'nope' }], stop_reason: 'end_turn' }]);
    await handleAiCoach(deps, U, send('hi'));
    expect(mem.usageOf('2026-11-26').unknownUsageAttempts).toBe(1);
  });
});

describe('cancellation in the provider client', () => {
  it('an attempt-owned signal aborts the fetch and the backoff; never retried, never a timeout', async () => {
    const ctl = new AbortController();
    let calls = 0;
    const fetch: FetchLike = async (_u, init) => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 529, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
      return new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    };
    let slept = 0;
    const p = createMessage(
      { apiKey: 'k', model: 'claude-sonnet-5-5', maxTokens: 10, fetch, maxRetries: 3, signal: ctl.signal, sleep: async () => { slept += 1; ctl.abort(); } },
      { system: 's', messages: [{ role: 'user', content: 'x' }] },
    );
    await expect(p).rejects.toBeInstanceOf(AiCancelledError);
    expect(calls).toBe(1);
    expect(slept).toBe(1);
  });
});
