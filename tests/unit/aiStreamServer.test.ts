/**
 * Roadmap item 10, server side (MOCKED provider, in-memory reservation-aware database):
 *  - SSE and JSON give the same final result (one execution path); deltas are chunks of the STORED answer only;
 *  - text the postchecks replace never appears in any event; a failed store exposes no answer or card;
 *  - phases only for work that actually happens (never "training"/"nutrition" for unshared data); heartbeats;
 *  - a broken writer (client gone) doesn't affect the work; a lost completion is recovered without another charge;
 *  - acknowledged cancellation: before send, during the model wait, both orders with success, repeated, lost
 *    acknowledgement, stale worker success, worker death (expiry), late usage, midnight refund;
 *  - sharing narrowed while the reply was written → sharing_changed, nothing published, refunded.
 */
import { describe, expect, it } from 'vitest';
import { handleAiCoach, startAiCoach, type CoachDeps } from '../../supabase/functions/_shared/ai/coach';
import { chunkAnswer, HEARTBEAT_FRAME, streamCoachRun } from '../../supabase/functions/_shared/ai/sse';
import type { AiSettingsRow, FetchLike, StoredMessage } from '../../supabase/functions/_shared/ai/types';
import { createMemoryDb } from '../evals/memoryDb';

const U = '11111111-1111-4111-8111-111111111111';
const mid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-26T12:00:00Z');
const settings = (o: Partial<AiSettingsRow> = {}): AiSettingsRow => ({
  enabled: true, paused: false, consentAt: '2026-11-01T00:00:00Z', consentVersion: '2026-10-29:anthropic',
  scopes: { profile: true, training: false, measurements: false, nutrition: false }, profileNotes: '', ...o,
});
const env = (o: Record<string, string> = {}) => (k: string) => ({ ANTHROPIC_API_KEY: 'sk', AI_CANCEL_POLL_MS: '200', ...o } as Record<string, string | undefined>)[k];
const answer = (a: string, why: string | null = null, usage = { input_tokens: 100, output_tokens: 20 }) =>
  ({ id: 'm', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify({ answer: a, why }) }], stop_reason: 'end_turn', usage });
const toolRound = (name: string, input: unknown) => ({ id: 'm', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 't1', name, input }], stop_reason: 'tool_use', usage: { input_tokens: 60, output_tokens: 6 } });

type Step = unknown | 'hang' | ((signal?: AbortSignal) => Promise<unknown>);
function provider(steps: Step[]) {
  const requests: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_u, init) => {
    requests.push(JSON.parse(init.body));
    const step = steps.shift() ?? answer('…');
    if (step === 'hang') {
      return new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    const body = typeof step === 'function' ? await (step as (s?: AbortSignal) => Promise<unknown>)(init.signal) : step;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, requests };
}
function setup(steps: Step[], s = settings(), o: { clock?: () => number; day?: () => string } = {}) {
  const mem = createMemoryDb({ uid: U, settings: s, clock: o.clock ?? (() => Date.now()), day: o.day ?? (() => '2026-11-26') });
  const p = provider(steps);
  const deps: CoachDeps = { db: mem.db, fetch: p.fetch, env: env(), now: () => NOW, sleep: async () => undefined, random: () => 0.5 };
  return { mem, deps, ...p };
}
const send = (text: string, n = 1, extra: Record<string, unknown> = {}) => ({ action: 'send', id: mid(n), text, mode: 'chat', ...extra });

interface Ev { event: string; data: Record<string, unknown> }
function collector(opts: { failAt?: number } = {}) {
  const frames: string[] = [];
  let writes = 0;
  let closed = false;
  const writer = {
    write(s: string) {
      writes += 1;
      if (opts.failAt && writes >= opts.failAt) throw new Error('client went away');
      frames.push(s);
    },
    close() {
      closed = true;
    },
  };
  const events = (): Ev[] =>
    frames.filter((f) => f.startsWith('event:')).map((f) => {
      const [e, d] = f.trim().split('\n');
      return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
    });
  return { writer, frames, events, isClosed: () => closed };
}
async function stream(deps: CoachDeps, body: unknown, opts: { failAt?: number; hb?: (fn: () => void) => void } = {}) {
  const start = await startAiCoach(deps, U, body);
  if (start.kind !== 'started') return { start, c: null, result: start.result };
  const c = collector(opts);
  const result = await streamCoachRun(start, c.writer, {
    setInterval: (fn) => {
      opts.hb?.(fn);
      return 1;
    },
    clearInterval: () => undefined,
  });
  return { start, c, result };
}

describe('SSE transport', () => {
  it('JSON and SSE return the same final exchange; deltas join to exactly the stored answer', async () => {
    const reply = 'Rest today, þú hefur unnið vel í vikunni. Á morgun: **hnébeygja** 3 × 8. '.repeat(4).trim();
    const a = setup([answer(reply, 'Svefninn var stuttur.')]);
    const json = await handleAiCoach(a.deps, U, send('Á ég að æfa?', 1));
    const b = setup([answer(reply, 'Svefninn var stuttur.')]);
    const { c, result } = await stream(b.deps, send('Á ég að æfa?', 1));
    expect(result?.status).toBe(200);
    const ev = c!.events();
    const complete = ev.find((e) => e.event === 'complete')!;
    const strip = (r: Record<string, unknown>) => ({ ...r, createdAt: undefined });
    expect(strip(complete.data.reply as Record<string, unknown>)).toEqual(strip(json.body.reply as Record<string, unknown>));
    expect(complete.data.duplicate).toBe(false);
    expect(complete.data.usage).toMatchObject({ requests: 1 });
    const deltas = ev.filter((e) => e.event === 'text_delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.data.text).join('')).toBe((json.body.reply as StoredMessage).content);
    expect(deltas.every((d) => d.data.replyId === (json.body.reply as StoredMessage).id)).toBe(true);
    // Envelope fields and ordering
    const seqs = ev.map((e) => e.data.seq as number);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const e of ev) expect(e.data).toMatchObject({ v: 1, requestId: mid(1) });
    expect(ev.at(-1)!.event).toBe('complete');
    expect(c!.isClosed()).toBe(true);
  });

  it('phases follow the work that happens, never unshared categories', async () => {
    const { deps } = setup([answer('Rest.')]);
    const { c } = await stream(deps, send('hi'));
    const phases = c!.events().filter((e) => e.event === 'status').map((e) => e.data.phase);
    expect(phases).toEqual(['preparing', 'writing', 'checking', 'saving']);
    const shared = setup([answer('Rest.')], settings({ scopes: { profile: true, training: true, measurements: false, nutrition: true } }));
    const { c: c2 } = await stream(shared.deps, send('hi'));
    const p2 = c2!.events().filter((e) => e.event === 'status').map((e) => e.data.phase);
    expect(p2.slice(0, 3)).toEqual(['preparing', 'training', 'nutrition']);
  });

  it('text that the postchecks rewrite or remove never appears in any event', async () => {
    // Raw model output: forbidden filler, an ISO date and an invented in-app link. The stored reply has none of them.
    const raw = 'Great question! On 2026-11-27 do your squats.\n[[open:/admin-secret|Open admin]]';
    const { deps } = setup([answer(raw)]);
    const { c } = await stream(deps, send('When do I squat?'));
    const complete = c!.events().find((e) => e.event === 'complete')!;
    const stored = String((complete.data.reply as StoredMessage).content);
    expect(stored).not.toMatch(/Great question|2026-11-27|admin-secret/);
    const all = c!.frames.join('');
    for (const bad of ['Great question', '2026-11-27', 'admin-secret']) expect(all).not.toContain(bad);
    // Nothing but status precedes the first chunk of the stored text.
    const ev = c!.events();
    const first = ev.findIndex((e) => e.event !== 'status');
    expect(ev[first].event).toBe('text_delta');
    expect(stored.startsWith(String(ev[first].data.text))).toBe(true);
  });

  it('a store failure exposes no answer and no card', async () => {
    const { deps, mem } = setup([answer('Here is your plan.')]);
    mem.db.recordExchange = async () => {
      throw Object.assign(new Error('db down'), { code: '57014' });
    };
    const { c, result } = await stream(deps, send('hi'));
    expect(result).toBeNull();
    const ev = c!.events();
    expect(ev.some((e) => e.event === 'text_delta' || e.event === 'complete')).toBe(false);
    expect(ev.at(-1)).toMatchObject({ event: 'error', data: { code: 'internal', retryable: true } });
    expect(c!.frames.join('')).not.toContain('Here is your plan');
    expect(mem.usageOf('2026-11-26').requests).toBe(0); // refunded
  });

  it('sends heartbeat comments; stable error codes, never provider text', async () => {
    let beat: (() => void) | null = null;
    const { deps } = setup([{ id: 'm', content: [{ type: 'text', text: 'not json' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }]);
    const { c } = await stream(deps, send('hi'), { hb: (fn) => (beat = fn) });
    beat!();
    expect(c!.frames).toContain(HEARTBEAT_FRAME);
    expect(c!.events().at(-1)).toMatchObject({ event: 'error', data: { code: 'invalid_reply', reason: 'invalid_reply', retryable: true } });
    expect(c!.frames.join('')).not.toContain('not json');
  });

  it('refusals before the stream stay normal JSON responses (consent, limits, validation)', async () => {
    const { deps } = setup([]);
    const s = await startAiCoach({ ...deps, db: { ...deps.db, getSettings: async () => settings({ consentVersion: '2026-10-29:openai' }) } }, U, send('hi'));
    expect(s).toMatchObject({ kind: 'done', result: { status: 409, body: { code: 'consent_required' } } });
    expect((await startAiCoach(deps, U, { action: 'send', id: 'nope', text: 'x' })).kind).toBe('done');
  });

  it('a client that goes away detaches: the work finishes and is stored; replay returns it without another charge', async () => {
    const { deps, mem } = setup([answer('Stored answer.')]);
    const { c, result } = await stream(deps, send('hi', 5), { failAt: 2 });
    expect(c!.frames).toHaveLength(1); // only the first status got out
    expect(result?.status).toBe(200);
    expect(mem.state.exchanges.size).toBe(1);
    const before = mem.usageOf('2026-11-26').requests;
    const again = await handleAiCoach(deps, U, send('hi', 5));
    expect(again.body).toMatchObject({ duplicate: true, reply: { content: 'Stored answer.' } });
    expect(mem.usageOf('2026-11-26').requests).toBe(before);
  });

  it('chunks never split a letter, and rejoin exactly', () => {
    const text = 'Þú átt að hvíla þig. 💪🏽 Æfðu á morgun: ð þ æ ö. '.repeat(30);
    const chunks = chunkAnswer(text, 50);
    expect(chunks.join('')).toBe(text);
    for (const ch of chunks) expect(Array.from(ch).every((cp) => cp.length === 1 || /\p{Extended_Pictographic}|\p{Emoji_Modifier}/u.test(cp))).toBe(true);
    expect(chunks.every((ch) => !/^[\uDC00-\uDFFF]/.test(ch) && !/[\uD800-\uDBFF]$/.test(ch))).toBe(true);
  });
});

describe('acknowledged cancellation (handler + memory db)', () => {
  it('status advertises streaming, and Stop only when the database supports it', async () => {
    const { deps } = setup([]);
    expect((await handleAiCoach(deps, U, { action: 'status' })).body.protocol).toEqual({ stream: 1, cancel: 1 });
    const old = createMemoryDb({ uid: U, settings: settings(), noCancellation: true });
    const d2 = { ...deps, db: old.db };
    expect((await handleAiCoach(d2, U, { action: 'status' })).body.protocol).toEqual({ stream: 1 });
    expect((await handleAiCoach(d2, U, { action: 'cancel', id: mid(1) })).status).toBe(501);
  });

  it('cancel before the send arrives: a tombstone, the send never starts or charges; a new id works', async () => {
    const { deps, mem, requests } = setup([answer('Hi.')]);
    expect((await handleAiCoach(deps, U, { action: 'cancel', id: mid(1) })).body).toMatchObject({ state: 'cancelled' });
    const r = await handleAiCoach(deps, U, send('hi', 1));
    expect(r).toMatchObject({ status: 409, body: { code: 'request_cancelled', error: 'The reply was stopped.' } });
    expect(requests).toHaveLength(0);
    expect(mem.usageOf('2026-11-26').requests).toBe(0);
    expect((await handleAiCoach(deps, U, send('hi', 2))).status).toBe(200);
  });

  it('cancel during the model wait: cancel_requested → the worker aborts and acknowledges; one refund; completed-round tokens booked', async () => {
    const { deps, mem } = setup([toolRound('exercise_alternatives', { exercise_id: 'x' }), 'hang']);
    const { c, result: pending } = await (async () => {
      const start = await startAiCoach(deps, U, send('hi', 3));
      if (start.kind !== 'started') throw new Error('not started');
      const col = collector();
      const p = streamCoachRun(start, col.writer, { setInterval: () => 1, clearInterval: () => undefined });
      return { c: col, result: p };
    })();
    await new Promise((r) => setTimeout(r, 30));
    expect((await handleAiCoach(deps, U, { action: 'cancel', id: mid(3) })).body).toMatchObject({ state: 'cancel_requested' });
    expect((await handleAiCoach(deps, U, { action: 'cancel', id: mid(3) })).body).toMatchObject({ state: 'cancel_requested' }); // repeated
    const result = await pending;
    expect(result).toMatchObject({ status: 409, body: { code: 'request_cancelled' } });
    expect(c.events().at(-1)).toMatchObject({ event: 'cancelled' });
    expect(c.events().some((e) => e.event === 'text_delta')).toBe(false);
    expect(mem.state.requests.get(mid(3))?.state).toBe('cancelled');
    expect(mem.usageOf('2026-11-26')).toMatchObject({ requests: 0, cancelledRequests: 1, failedInputTokens: 60, failedOutputTokens: 6 });
    expect((await handleAiCoach(deps, U, { action: 'request_status', id: mid(3) })).body).toMatchObject({ state: 'cancelled' }); // lost ack → check
    expect(mem.state.exchanges.size).toBe(0);
  }, 10_000);

  it('success first, then cancel: the completed exchange is returned, nothing refunded', async () => {
    const { deps, mem } = setup([answer('Done.')]);
    await handleAiCoach(deps, U, send('hi', 4));
    const r = await handleAiCoach(deps, U, { action: 'cancel', id: mid(4) });
    expect(r.body).toMatchObject({ state: 'succeeded', reply: { content: 'Done.' }, duplicate: true });
    expect(mem.usageOf('2026-11-26').requests).toBe(1);
  });

  it('cancel lands after the model finished but before saving: nothing is published, the worker settles cancelled', async () => {
    const { deps, mem } = setup([answer('Too late?')]);
    const getSettings = mem.db.getSettings;
    let calls = 0;
    mem.db.getSettings = async (uid) => {
      calls += 1;
      if (calls === 2) await mem.db.cancelRequest!(uid, mid(6)); // the pre-publication recheck is the second read
      return getSettings(uid);
    };
    const r = await handleAiCoach(deps, U, send('hi', 6));
    expect(r.body).toMatchObject({ code: 'request_cancelled' });
    expect(mem.state.exchanges.size).toBe(0);
    expect(mem.usageOf('2026-11-26').requests).toBe(0);
  });

  it('a stale worker that missed the cancel is refused by the database when it tries to publish', async () => {
    const { deps, mem } = setup([answer('Stale.')]);
    mem.db.requestState = async () => 'running'; // a stale read: the poll never sees the cancel
    const getSettings = mem.db.getSettings;
    let calls = 0;
    mem.db.getSettings = async (uid) => {
      calls += 1;
      if (calls === 2) await mem.db.cancelRequest!(uid, mid(7));
      return getSettings(uid);
    };
    const r = await handleAiCoach(deps, U, send('hi', 7));
    expect(r.body).toMatchObject({ code: 'request_cancelled' });
    expect(mem.state.exchanges.size).toBe(0);
    expect(mem.state.requests.get(mid(7))?.state).toBe('cancelled');
  });

  it('worker death: an unacknowledged cancel is finalized after the bounded expiry; a late report books once, no second refund', async () => {
    let t = Date.parse('2026-11-26T12:00:00Z');
    const { deps, mem } = setup([], settings(), { clock: () => t });
    const begun = await mem.db.beginRequest!(U, mid(8), 40);
    expect((await handleAiCoach(deps, U, { action: 'cancel', id: mid(8) })).body).toMatchObject({ state: 'cancel_requested' });
    t += 3 * 60_000;
    expect((await handleAiCoach(deps, U, { action: 'request_status', id: mid(8) })).body).toMatchObject({ state: 'cancelled' });
    expect(mem.usageOf('2026-11-26').requests).toBe(0);
    const attempt = (begun as { attempt: string }).attempt;
    await mem.db.settleCancelled!(U, mid(8), attempt, { inputTokens: 9, outputTokens: 1, costUsd: null });
    await mem.db.settleCancelled!(U, mid(8), attempt, { inputTokens: 9, outputTokens: 1, costUsd: null });
    await mem.db.failRequest!(U, mid(8), attempt, { inputTokens: 9, outputTokens: 1, costUsd: null });
    expect(mem.usageOf('2026-11-26')).toMatchObject({ requests: 0, failedInputTokens: 9, cancelledRequests: 1 });
  });

  it('midnight: refunded on the day it was charged; cancelled usage on the new day', async () => {
    let day = '2026-11-26';
    const { deps, mem } = setup([toolRound('exercise_alternatives', { exercise_id: 'x' }), 'hang'], settings(), { day: () => day });
    const start = await startAiCoach(deps, U, send('hi', 9));
    if (start.kind !== 'started') throw new Error('not started');
    const p = start.run();
    await new Promise((r) => setTimeout(r, 30));
    day = '2026-11-27';
    await handleAiCoach(deps, U, { action: 'cancel', id: mid(9) });
    await p;
    expect(mem.usageOf('2026-11-26').requests).toBe(0);
    expect(mem.usageOf('2026-11-27')).toMatchObject({ requests: 0, cancelledRequests: 1, failedInputTokens: 60 });
  }, 10_000);

  it('sharing narrowed while the reply was written: discarded (sharing_changed), nothing stored, refunded', async () => {
    const s = settings({ scopes: { profile: true, training: true, measurements: false, nutrition: false } });
    const { deps, mem } = setup([answer('Your squat went up.')], s);
    let calls = 0;
    mem.db.getSettings = async () => {
      calls += 1;
      return calls === 1 ? s : { ...s, scopes: { ...s.scopes, training: false } };
    };
    const r = await handleAiCoach(deps, U, { ...send('How is my squat?', 10), language: 'is' });
    expect(r).toMatchObject({ status: 409, body: { code: 'sharing_changed', error: 'Deilingarstillingarnar þínar breyttust, svo svarið var ekki birt. Farðu yfir stillingarnar áður en þú reynir aftur.' } });
    expect(mem.state.exchanges.size).toBe(0);
    expect(mem.usageOf('2026-11-26').requests).toBe(0);
  });
});
