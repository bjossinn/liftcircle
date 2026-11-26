/**
 * PR #26 review, round 2 — server regressions (MOCKED provider, in-memory reservation-aware database):
 *  P1-2  a contextual workout request without Training sharing is refused before anything is reserved or sent, also
 *        on the streaming path (normal JSON refusal, no stream).
 *  P2-1  blank structured output (no content, whitespace, empty `answer`) is invalid: never a charged success.
 *  P2-2  the production adapter passes the database's `cancelled` admission result through.
 *  P2-3  "stopped" only after authoritative confirmation; otherwise `cancel_unconfirmed` and the app keeps checking.
 *  P2-4  dispatched attempts without known usage are booked as unknown, keeping the known tokens.
 *  P2-6  pregnancy / medication precautions are in the prompt.
 */
import { describe, expect, it } from 'vitest';
import { handleAiCoach, startAiCoach, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { streamCoachRun } from '../../supabase/functions/_shared/ai/sse';
import { createSupabaseAiDb, type SbClient } from '../../supabase/functions/_shared/ai/supabaseDb';
import { staticInstructions } from '../../supabase/functions/_shared/ai/prompts/index';
import type { AiSettingsRow, FetchLike } from '../../supabase/functions/_shared/ai/types';
import { createMemoryDb } from '../evals/memoryDb';
import { buildFixture, EVAL_CASES, FROZEN_NOW, UID } from '../evals/coach.fixtures';

const U = '11111111-1111-4111-8111-111111111111';
const mid = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-26T12:00:00Z');
const settings = (o: Partial<AiSettingsRow> = {}): AiSettingsRow => ({
  enabled: true, paused: false, consentAt: '2026-11-01T00:00:00Z', consentVersion: '2026-10-29:anthropic',
  scopes: { profile: true, training: true, measurements: false, nutrition: false }, profileNotes: '', ...o,
});
const env = (k: string) => ({ ANTHROPIC_API_KEY: 'sk', AI_CANCEL_POLL_MS: '200' } as Record<string, string | undefined>)[k];
const textRound = (text: string | null) => ({ id: 'm', model: 'claude-sonnet-5-5', content: text == null ? [] : [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } });
const toolRound = { id: 'm', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 't1', name: 'exercise_alternatives', input: { exercise_id: 'x' } }], stop_reason: 'tool_use', usage: { input_tokens: 60, output_tokens: 6 } };

function provider(steps: (unknown | 'hang' | 'throw')[]) {
  const requests: string[] = [];
  const fetch: FetchLike = async (_u, init) => {
    requests.push(init.body);
    const step = steps.length ? steps.shift() : textRound('{"answer":"…","why":null}');
    if (step === 'throw') throw new TypeError('network down');
    if (step === 'hang') return new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => step, text: async () => JSON.stringify(step) };
  };
  return { fetch, requests };
}
function setup(steps: (unknown | 'hang' | 'throw')[], s = settings()) {
  const mem = createMemoryDb({ uid: U, settings: s, day: () => '2026-11-26' });
  const p = provider(steps);
  const deps: CoachDeps = { db: mem.db, fetch: p.fetch, env, now: () => NOW, sleep: async () => undefined, random: () => 0.5 };
  return { mem, deps, ...p };
}
const send = (text: string, n = 1, extra: Record<string, unknown> = {}) => ({ action: 'send', id: mid(n), text, mode: 'chat', ...extra });

describe('P1-2: contextual workout requests need Training sharing', () => {
  it('refused as JSON before any stream, reservation, charge or provider request', async () => {
    const { deps, mem, requests } = setup([textRound('{"answer":"x","why":null}')], settings({ scopes: { profile: true, training: false, measurements: false, nutrition: false } }));
    const workout = { sessionId: 's1', intent: 'explain', exercises: [{ id: 'e1', exerciseId: 'barbell-bench-press', name: 'Barbell bench press', sets: [] }] };
    const s = await startAiCoach(deps, U, send('Explain this: why is my next target for Barbell bench press “62.5 kg × 8 reps”?', 1, { workout, stream: true }));
    expect(s).toMatchObject({ kind: 'done', result: { status: 409, body: { code: 'training_not_shared' } } });
    expect(requests).toHaveLength(0);
    expect(mem.state.requests.size).toBe(0);
    expect(mem.usageOf('2026-11-26').requests).toBe(0);
  });
});

describe('P2-1: blank structured output never becomes a charged success', () => {
  for (const [name, round] of [
    ['no content at all', textRound(null)],
    ['whitespace only', textRound('   \n ')],
    ['an empty answer', textRound('{"answer":"   ","why":null}')],
  ] as const) {
    it(`${name}: invalid_reply, refunded, failed usage booked`, async () => {
      const { deps, mem } = setup([round]);
      const r = await handleAiCoach(deps, U, send('hi'));
      expect(r).toMatchObject({ status: 502, body: { code: 'invalid_reply' } });
      expect(mem.state.exchanges.size).toBe(0);
      expect(mem.usageOf('2026-11-26')).toMatchObject({ requests: 0, failedRequests: 1, failedInputTokens: 100 });
    });
  }

  it('with a valid server action, its deterministic summary is used instead', async () => {
    const c = EVAL_CASES.find((x) => x.id === 'EN12')!;
    const f = buildFixture(c, 'anthropic');
    const mem = createMemoryDb(f.db);
    const p = provider([textRound('')]);
    const r = await handleAiCoach({ db: mem.db, fetch: p.fetch, env, now: () => FROZEN_NOW, sleep: async () => undefined }, UID, { action: 'send', id: mid(2), text: c.prompt, mode: 'chat', ...f.body });
    expect(r.status).toBe(200);
    const reply = r.body.reply as { content: string; action: { kind: string } };
    expect(reply.action.kind).toBe('meal_plan');
    expect(reply.content.trim().length).toBeGreaterThan(0);
  });
});

describe('P2-2: the Supabase adapter passes `cancelled` through', () => {
  it('ai_begin_request → {status: "cancelled"} (the SQL response) is returned, not an error', async () => {
    const admin: SbClient = {
      from: () => ({}),
      rpc: (fn: string) => Promise.resolve(fn === 'ai_begin_request' ? { data: { status: 'cancelled' }, error: null } : { data: null, error: null }),
    };
    const db = createSupabaseAiDb(admin, admin);
    expect(await db.beginRequest!(U, mid(3), 40)).toEqual({ status: 'cancelled' });
  });
});

describe('P2-3: a cancel is acknowledged only when it is confirmed', () => {
  async function cancelMidRun(breakSettlement: (db: ReturnType<typeof createMemoryDb>) => void) {
    const ctx = setup([toolRound, 'hang']);
    breakSettlement(ctx.mem);
    const start = await startAiCoach(ctx.deps, U, send('hi', 4));
    if (start.kind !== 'started') throw new Error('not started');
    const frames: string[] = [];
    const p = streamCoachRun(start, { write: (s) => void frames.push(s), close: () => undefined }, { setInterval: () => 1, clearInterval: () => undefined });
    await new Promise((r) => setTimeout(r, 30));
    await handleAiCoach(ctx.deps, U, { action: 'cancel', id: mid(4) });
    const result = await p;
    return { ...ctx, result, frames: frames.join('') };
  }

  it('settlement fails and the request is still cancel_requested → cancel_unconfirmed (no "cancelled" event)', async () => {
    const { result, frames, mem } = await cancelMidRun((m) => {
      m.db.settleCancelled = async () => {
        throw Object.assign(new Error('db down'), { code: '57P01' });
      };
    });
    expect(result).toMatchObject({ status: 409, body: { code: 'cancel_unconfirmed' } });
    expect(frames).not.toMatch(/event: cancelled/);
    expect(frames).toMatch(/event: error\ndata: [^\n]*"code":"cancel_unconfirmed"[^\n]*"retryable":true/);
    expect(mem.state.requests.get(mid(4))?.state).toBe('cancel_requested');
  }, 10_000);

  it('settlement reports nothing settled, but the database says cancelled (finalizer won) → confirmed', async () => {
    const { result } = await cancelMidRun((m) => {
      const real = m.db.settleCancelled!;
      m.db.settleCancelled = async (...a) => {
        await real(...a);
        return { settled: false, refunded: false };
      };
    });
    expect(result).toMatchObject({ status: 409, body: { code: 'request_cancelled' } });
  }, 10_000);
});

describe('P2-4: interrupted attempts are unknown-billed, known tokens kept', () => {
  it('a completed round then network failures: failed usage keeps 60/6 tokens and is marked unknown', async () => {
    const logs: { event: string; [k: string]: unknown }[] = [];
    const { deps, mem } = setup([toolRound, 'throw', 'throw', 'throw']);
    const r = await handleAiCoach({ ...deps, log: (event, f) => logs.push({ event, ...f }) }, U, send('hi', 5));
    expect(r.status).toBe(503);
    expect(mem.usageOf('2026-11-26')).toMatchObject({ requests: 0, failedInputTokens: 60, failedOutputTokens: 6, unknownUsageAttempts: 1 });
    expect(logs.find((l) => l.event === 'ai_provider_error')).toMatchObject({ attempts: 4, unknown_usage: true });
  });

  it('a clean exchange records its attempt count and stays known', async () => {
    const logs: { event: string; [k: string]: unknown }[] = [];
    const { deps, mem } = setup([textRound('{"answer":"Rest.","why":null}')]);
    await handleAiCoach({ ...deps, log: (event, f) => logs.push({ event, ...f }) }, U, send('hi', 6));
    expect(logs.find((l) => l.event === 'ai_send')).toMatchObject({ attempts: 1, rounds: 1 });
    expect(mem.usageOf('2026-11-26').unknownUsageAttempts).toBe(0);
  });
});

describe('P2-6: pregnancy and medication precautions', () => {
  it('are in the safety module for every style', () => {
    for (const style of ['supportive', 'balanced', 'strict'] as const) {
      const text = staticInstructions({ style, output: 'structured' });
      expect(text).toContain('Pregnancy, medication or a medical condition');
      expect(text).toContain('medication or a medical condition: also say to check with their doctor or midwife');
    }
  });
});
