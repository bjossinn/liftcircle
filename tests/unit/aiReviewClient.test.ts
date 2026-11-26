// @vitest-environment node
/**
 * PR #26 review, round 2 — client regressions:
 *  P1-1  account-switch race: every message-bound request resolves the session and checks its user immediately before
 *        dispatch; a session that resolves to another account aborts with nothing sent (deferred-session test).
 *  P1-2  retries after Training sharing is revoked: `prepare` runs before EVERY attempt (in_progress retries, JSON
 *        recovery); once it says no, nothing more goes out.
 *  P2-5  an open but silent stream ends as interrupted (inactivity / overall deadline); control calls are bounded and
 *        follow the caller's abort; recovery ends as unconfirmed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ session: null as null | (() => Promise<unknown>) }));
vi.mock('@/backend/supabase', () => ({
  backendConfigured: true,
  functionsBaseUrl: () => 'https://example.test/functions/v1',
  publishableApiKey: () => 'pk',
  requireSupabase: () => ({ auth: { getSession: () => h.session!() } }),
  supabase: () => null,
}));

import { aiApi, consumeStreamResponse, StreamInterrupted, type RequestStatusResult, type SendResult } from '@/backend/ai';
import { pollUntilSettled, recoverReply, SharingBlocked, sendReply, stopReply, type ReplyApi } from '@/features/coaching/ai/replyFlow';

const ID = '66666666-6666-4666-8666-666666666666';
const sessionOf = (userId: string, token = `token-${userId}`) => ({ data: { session: { access_token: token, user: { id: userId } } } });
function deferredSession() {
  let resolve!: (v: unknown) => void;
  h.session = () => new Promise((r) => (resolve = r));
  return (userId: string) => resolve(sessionOf(userId));
}
const sse = (chunks: string[]) =>
  new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

beforeEach(() => {
  h.session = async () => sessionOf('user-A');
});

describe('P1-1: requests are bound to the account that wrote the message', () => {
  it('stream: the session resolves to account B after the send began → aborted, nothing dispatched', async () => {
    const fetchImpl = vi.fn(async () => sse([]));
    const switchTo = deferredSession();
    const p = aiApi.sendStream({ id: ID, text: 'A wrote this' }, {}, { expectedUserId: 'user-A', fetchImpl: fetchImpl as unknown as typeof fetch });
    switchTo('user-B'); // account switch lands while the session lookup is pending
    await expect(p).rejects.toMatchObject({ code: 'account_changed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('JSON send, cancel and request_status: same check, B’s token is never used', async () => {
    for (const call of [
      (f: typeof fetch) => aiApi.send({ id: ID, text: 'x' }, { expectedUserId: 'user-A', fetchImpl: f }),
      (f: typeof fetch) => aiApi.cancel(ID, { expectedUserId: 'user-A', fetchImpl: f }),
      (f: typeof fetch) => aiApi.requestStatus(ID, { expectedUserId: 'user-A', fetchImpl: f }),
    ]) {
      const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
      const switchTo = deferredSession();
      const p = call(fetchImpl as unknown as typeof fetch);
      switchTo('user-B');
      await expect(p).rejects.toMatchObject({ code: 'account_changed' });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('the matching account dispatches with its own token', async () => {
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-user-A');
      return new Response(JSON.stringify({ state: 'running' }), { headers: { 'content-type': 'application/json' } });
    });
    expect(await aiApi.requestStatus(ID, { expectedUserId: 'user-A', fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ state: 'running' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('the reply flow stops (no further polling) once the account changed', async () => {
    let calls = 0;
    const api: ReplyApi = {
      send: async () => ({ reply: {} as never }),
      requestStatus: async () => {
        calls += 1;
        throw Object.assign(new Error('switched'), { code: 'account_changed' });
      },
    };
    await expect(pollUntilSettled(api, ID, { expectedUserId: 'user-A', sleep: async () => undefined, attempts: 5 })).rejects.toMatchObject({ code: 'account_changed' });
    expect(calls).toBe(1);
  });
});

describe('P1-2: sharing is re-checked before every attempt', () => {
  const ok = (): SendResult => ({ reply: { id: 'r', role: 'assistant', content: 'x', createdAt: 'x', status: 'sent', proposalId: null, grounding: [] }, proposal: null, duplicate: false });

  it('an in_progress retry after Training was turned off never goes out', async () => {
    let trainingOn = true;
    const sent: unknown[] = [];
    const api: ReplyApi = {
      send: async () => ok(),
      sendStream: async (input) => {
        sent.push(input);
        trainingOn = false; // the user switches Training off while the first attempt waits
        throw Object.assign(new Error('busy'), { code: 'in_progress' });
      },
    };
    const prepare = async () => (trainingOn ? { id: ID, text: 'Explain this: Barbell bench press 62.5 kg × 8', workout: { sessionId: 's' } as never } : null);
    await expect(sendReply(api, { stream: true, cancel: true }, prepare, {}, new AbortController().signal, { sleep: async () => undefined })).rejects.toBeInstanceOf(SharingBlocked);
    expect(sent).toHaveLength(1);
  });

  it('JSON recovery (servers without request_status) is rebuilt too: blocked, nothing sent', async () => {
    const send = vi.fn(async () => ok());
    const r = await recoverReply({ send }, async () => null, ID, { statusSupported: false, sleep: async () => undefined });
    expect(r).toEqual({ kind: 'blocked' });
    expect(send).not.toHaveBeenCalled();
  });

  it('each attempt carries the rebuilt input (fresh workout snapshot)', async () => {
    let n = 0;
    const seen: number[] = [];
    const api: ReplyApi = {
      send: async (input) => {
        seen.push((input as { unsynced?: number }).unsynced ?? -1);
        if (seen.length === 1) throw Object.assign(new Error('busy'), { code: 'in_progress' });
        return ok();
      },
    };
    await sendReply(api, undefined, async () => ({ id: ID, text: 'x', unsynced: ++n }), {}, new AbortController().signal, { sleep: async () => undefined });
    expect(seen).toEqual([1, 2]);
  });
});

describe('review round 3 P2-1: deadlines cover headers AND bodies', () => {
  /** A response whose headers arrived but whose body never finishes. */
  const stalledBody = (status = 200, type = 'application/json') => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"state":')); } }), { status, headers: { 'content-type': type } });

  it('a JSON control call whose body stalls after the headers ends at its deadline', async () => {
    const t0 = Date.now();
    await expect(aiApi.requestStatus(ID, { fetchImpl: (async () => stalledBody()) as unknown as typeof fetch, timeoutMs: 60 })).rejects.toMatchObject({ code: 'control_timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a JSON error body that stalls is bounded too (no unbounded mapInvokeError read)', async () => {
    await expect(aiApi.cancel(ID, { fetchImpl: (async () => stalledBody(409)) as unknown as typeof fetch, timeoutMs: 60 })).rejects.toMatchObject({ code: 'control_timeout' });
  });

  it('the caller’s abort ends a stalled body read', async () => {
    const ctl = new AbortController();
    const p = aiApi.requestStatus(ID, { fetchImpl: (async () => stalledBody()) as unknown as typeof fetch, signal: ctl.signal, timeoutMs: 60_000 });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a streamed send that gets no headers ends as interrupted at the admission deadline (then checked by id)', async () => {
    const never = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('a'), { name: 'AbortError' })))));
    const t0 = Date.now();
    await expect(aiApi.sendStream({ id: ID, text: 'x' }, {}, { fetchImpl: never as unknown as typeof fetch, timeoutMs: 60 })).rejects.toBeInstanceOf(StreamInterrupted);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(never).toHaveBeenCalledTimes(1);
  });

  it('a streamed send answered with a JSON body that stalls ends as interrupted (inactivity)', async () => {
    await expect(consumeStreamResponse(stalledBody(200), ID, {}, { inactivityMs: 50 })).rejects.toBeInstanceOf(StreamInterrupted);
    await expect(consumeStreamResponse(stalledBody(409), ID, {}, { inactivityMs: 50 })).rejects.toBeInstanceOf(StreamInterrupted);
  });
});

describe('P2-5: nothing waits forever', () => {
  it('an OPEN stream that goes silent (no bytes, no heartbeats) ends as interrupted', async () => {
    const silent = new Response(new ReadableStream({ start() { /* never enqueues, never closes */ } }), { headers: { 'content-type': 'text/event-stream' } });
    await expect(consumeStreamResponse(silent, ID, {}, { inactivityMs: 50 })).rejects.toBeInstanceOf(StreamInterrupted);
  });

  it('heartbeats keep it alive, but the overall deadline still ends it', async () => {
    let timer: ReturnType<typeof setInterval>;
    const beating = new Response(new ReadableStream({ start(c) { timer = setInterval(() => c.enqueue(new TextEncoder().encode(': keep-alive\n\n')), 10); } }), { headers: { 'content-type': 'text/event-stream' } });
    const t0 = Date.now();
    await expect(consumeStreamResponse(beating, ID, {}, { inactivityMs: 40, overallMs: 150 })).rejects.toBeInstanceOf(StreamInterrupted);
    clearInterval(timer!);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('the caller’s abort ends a stalled read at once', async () => {
    const ctl = new AbortController();
    const silent = new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } });
    const p = consumeStreamResponse(silent, ID, {}, { inactivityMs: 60_000, signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('control calls time out and follow the abort signal', async () => {
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('a'), { name: 'AbortError' })))));
    await expect(aiApi.requestStatus(ID, { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 30 })).rejects.toMatchObject({ code: 'control_timeout' });
    const ctl = new AbortController();
    const p = aiApi.cancel(ID, { fetchImpl: hang as unknown as typeof fetch, signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('Stop and recovery check the abort before retrying and end bounded as unconfirmed', async () => {
    const statuses: RequestStatusResult[] = [];
    const api: ReplyApi = { send: async () => ({ reply: {} as never }), cancel: async () => ({ state: 'cancel_requested' }), requestStatus: async () => statuses.shift() ?? { state: 'running' } };
    expect(await stopReply(api, ID, { attempts: 3, sleep: async () => undefined })).toEqual({ kind: 'unconfirmed' });
    const ctl = new AbortController();
    ctl.abort();
    await expect(pollUntilSettled(api, ID, { signal: ctl.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });
});
