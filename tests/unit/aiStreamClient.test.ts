// @vitest-environment node
/**
 * Roadmap item 10, client side: the incremental SSE parser, the streamed send's response handling (JSON fallback,
 * terminal events, EOF = interrupted), and the Stop / recovery flow (acknowledged cancel, same message id, bounded).
 */
import { describe, expect, it } from 'vitest';
import { createSseParser, SseProtocolError, type SseRawEvent } from '@/backend/sseParser';
import { consumeStreamResponse, StreamInterrupted, type RequestStatusResult, type SendResult } from '@/backend/ai';
import { classifyAiError } from '@/features/coaching/ai/model';
import { canStop, canStream, pollUntilSettled, previewText, recoverReply, sendReply, stopReply, type ReplyApi } from '@/features/coaching/ai/replyFlow';

const enc = new TextEncoder();
const ID = '44444444-4444-4444-8444-444444444444';
const frame = (event: string, data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify({ v: 1, requestId: ID, ...data })}\n\n`;
const reply = (content: string) => ({ id: 'r1', role: 'assistant', content, createdAt: '2026-11-26T12:00:00Z', grounding: ['Profile & preferences'], action: null, why: null });

function parse(chunks: (string | Uint8Array)[], end = true) {
  const events: SseRawEvent[] = [];
  let beats = 0;
  const p = createSseParser({ onEvent: (e) => events.push(e), onHeartbeat: () => (beats += 1), maxFrameChars: 4096 });
  for (const c of chunks) p.push(c);
  if (end) p.end();
  return { events, beats };
}
function sseResponse(chunks: (string | Uint8Array)[], init: { status?: number; type?: string } = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch);
      c.close();
    },
  });
  return new Response(body, { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'text/event-stream; charset=utf-8' } });
}

describe('SSE parser', () => {
  it('joins a UTF-8 letter split across chunks (Icelandic ð, þ, æ, ö)', () => {
    const text = 'Þú átt að hvíla þig í dag — æfðu á morgun, ögn léttara.';
    const bytes = enc.encode(`event: text_delta\ndata: ${JSON.stringify({ text })}\n\n`);
    // Split inside every multi-byte sequence boundary we can find.
    const cuts = [] as number[];
    for (let i = 1; i < bytes.length; i++) if ((bytes[i] & 0xc0) === 0x80) cuts.push(i);
    const pieces: Uint8Array[] = [];
    let last = 0;
    for (const c of cuts) {
      pieces.push(bytes.slice(last, c));
      last = c;
    }
    pieces.push(bytes.slice(last));
    const { events } = parse(pieces);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].data).text).toBe(text);
  });

  it('handles CRLF, CR, several events per chunk, one event over several chunks, comments and multi-line data', () => {
    const { events, beats } = parse([
      ': keep-alive\r\n\r\nevent: status\r\ndata: {"phase":"writing"}\r\n\r\nevent: a\ndata: 1\n\n',
      'event: b\rdata: 2\r\r',
      'event: c\ndata: line1\ndata: line2\n',
      '\n',
      'event: d\r',
      '\ndata: x\r',
      '\n\r\n',
    ]);
    expect(beats).toBe(1);
    expect(events.map((e) => [e.event, e.data])).toEqual([
      ['status', '{"phase":"writing"}'],
      ['a', '1'],
      ['b', '2'],
      ['c', 'line1\nline2'],
      ['d', 'x'],
    ]);
  });

  it('drops an unfinished frame at EOF and rejects oversized frames', () => {
    expect(parse(['event: complete\ndata: {"partial":tr']).events).toHaveLength(0);
    expect(() => parse([`event: x\ndata: ${'a'.repeat(5000)}\n\n`])).toThrow(SseProtocolError);
    expect(() => parse(['a'.repeat(5000)], false)).toThrow(SseProtocolError);
  });
});

describe('streamed send: response handling', () => {
  it('completes with the authoritative exchange; previews only the stored text; phases are typed', async () => {
    const phases: string[] = [];
    let text = '';
    let activity = 0;
    const res = sseResponse([
      frame('status', { seq: 1, phase: 'preparing' }),
      ': keep-alive\n\n',
      frame('status', { seq: 2, phase: 'invented_phase' }),
      frame('text_delta', { seq: 3, replyId: 'r1', text: 'Hvíldu ' }),
      frame('text_delta', { seq: 4, replyId: 'r1', text: 'þig.' }),
      frame('complete', { seq: 5, reply: reply('Hvíldu þig.'), proposal: null, duplicate: false, usage: { requests: 3, limitRequests: 40 } }),
    ]);
    const r = await consumeStreamResponse(res, ID, { onPhase: (p) => phases.push(p), onText: (t) => (text += t), onActivity: () => (activity += 1) });
    expect(phases).toEqual(['preparing']);
    expect(text).toBe('Hvíldu þig.');
    expect(activity).toBeGreaterThanOrEqual(5);
    expect(r).toMatchObject({ duplicate: false, usage: { requests: 3 }, reply: { id: 'r1', content: 'Hvíldu þig.', role: 'assistant' } });
  });

  it('EOF without a terminal event is interrupted/unconfirmed (also a heartbeat-only stall)', async () => {
    await expect(consumeStreamResponse(sseResponse([frame('status', { seq: 1, phase: 'writing' })]), ID, {})).rejects.toBeInstanceOf(StreamInterrupted);
    let beats = 0;
    await expect(consumeStreamResponse(sseResponse([': keep-alive\n\n', ': keep-alive\n\n']), ID, { onActivity: () => (beats += 1) })).rejects.toBeInstanceOf(StreamInterrupted);
    expect(beats).toBe(2);
    expect(classifyAiError(new StreamInterrupted()).key).toBe('ai.chat.replyInterrupted');
  });

  it('malformed, mismatched or out-of-order frames are protocol errors (never shown)', async () => {
    for (const chunks of [
      ['event: status\ndata: {not json\n\n'],
      [frame('status', { seq: 1, phase: 'writing' }).replace(ID, '55555555-5555-4555-8555-555555555555')],
      [frame('status', { seq: 2, phase: 'writing' }), frame('status', { seq: 1, phase: 'saving' })],
    ]) {
      await expect(consumeStreamResponse(sseResponse(chunks), ID, {})).rejects.toMatchObject({ code: 'stream_protocol' });
    }
  });

  it('terminal error and cancelled events map to stable codes and the approved copy', async () => {
    const err = await consumeStreamResponse(sseResponse([frame('error', { seq: 1, code: 'invalid_reply', reason: 'invalid_reply', retryable: true })]), ID, {}).catch((e) => e);
    expect(err).toMatchObject({ code: 'invalid_reply' });
    expect(classifyAiError(err).key).toBe('ai.error.invalidReply');
    const sh = await consumeStreamResponse(sseResponse([frame('error', { seq: 1, code: 'sharing_changed', retryable: false })]), ID, {}).catch((e) => e);
    expect(classifyAiError(sh).key).toBe('ai.chat.replyDiscardedPrivacy');
    const c = await consumeStreamResponse(sseResponse([frame('cancelled', { seq: 1, usage: { requests: 2 } })]), ID, {}).catch((e) => e);
    expect(c).toMatchObject({ code: 'request_cancelled', usage: { requests: 2 } });
    expect(classifyAiError(c).key).toBe('ai.chat.replyStopped');
  });

  it('a JSON response is consumed normally (duplicate replay, or a server without streaming); JSON errors before the stream map as before', async () => {
    const ok = new Response(JSON.stringify({ reply: reply('Stored.'), proposal: null, duplicate: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await consumeStreamResponse(ok, ID, {})).toMatchObject({ duplicate: true, reply: { content: 'Stored.' } });
    const consent = new Response(JSON.stringify({ code: 'consent_required', reason: 'consent_required', error: 'x' }), { status: 409, headers: { 'content-type': 'application/json' } });
    const e = await consumeStreamResponse(consent, ID, {}).catch((x) => x);
    expect(classifyAiError(e).key).toBe('ai.error.providerChanged');
  });
});

/* ------------------------------------------------------------------ reply flow */
const result = (content = 'Done.'): SendResult => ({ reply: { id: 'r', role: 'assistant', content, createdAt: 'x', status: 'sent', proposalId: null, grounding: [] }, proposal: null, duplicate: false });
function api(o: Partial<ReplyApi> & { statuses?: RequestStatusResult[]; cancels?: (RequestStatusResult | Error)[] } = {}): ReplyApi & { calls: string[] } {
  const calls: string[] = [];
  const statuses = [...(o.statuses ?? [])];
  const cancels = [...(o.cancels ?? [])];
  return {
    calls,
    send: o.send ?? (async () => {
      calls.push('send');
      return result();
    }),
    sendStream: o.sendStream ?? (async () => {
      calls.push('stream');
      return result();
    }),
    cancel: async (id) => {
      calls.push(`cancel:${id}`);
      const c = cancels.shift() ?? { state: 'cancelled' };
      if (c instanceof Error) throw c;
      return c;
    },
    requestStatus: async (id) => {
      calls.push(`status:${id}`);
      return statuses.shift() ?? { state: 'running' };
    },
  };
}
const fast = { sleep: async () => undefined, delayMs: 0 };

describe('reply flow', () => {
  it('streams only when the server says so; Stop only when it also supports cancel', async () => {
    const a = api();
    await sendReply(a, { stream: true, cancel: false }, { id: ID, text: 'x' }, {}, new AbortController().signal);
    await sendReply(a, undefined, { id: ID, text: 'x' }, {}, new AbortController().signal);
    expect(a.calls).toEqual(['stream', 'send']);
    expect(canStream(a, { stream: true, cancel: false })).toBe(true);
    expect(canStop(a, { stream: true, cancel: false })).toBe(false);
    expect(canStop(a, { stream: true, cancel: true })).toBe(true);
    expect(canStop({ send: a.send }, { stream: true, cancel: true })).toBe(false);
  });

  it('Stop is acknowledged: cancelled at once, or cancel_requested → polled until cancelled', async () => {
    expect(await stopReply(api({ cancels: [{ state: 'cancelled', usage: { requests: 1 } }] }), ID, fast)).toEqual({ kind: 'stopped', usage: { requests: 1 } });
    const a = api({ cancels: [{ state: 'cancel_requested' }], statuses: [{ state: 'cancel_requested' }, { state: 'running' }, { state: 'cancelled' }] });
    expect(await stopReply(a, ID, fast)).toMatchObject({ kind: 'stopped' });
    expect(a.calls.filter((c) => c.startsWith('status'))).toHaveLength(3);
  });

  it('success can win the race: the finished exchange is returned', async () => {
    const r = await stopReply(api({ cancels: [{ state: 'succeeded', result: result('Already here.') }] }), ID, fast);
    expect(r).toMatchObject({ kind: 'finished', result: { reply: { content: 'Already here.' } } });
    const r2 = await stopReply(api({ cancels: [{ state: 'cancel_requested' }], statuses: [{ state: 'succeeded', result: result('Won.') }] }), ID, fast);
    expect(r2).toMatchObject({ kind: 'finished' });
  });

  it('a lost Stop acknowledgement says so and checks the same id; it stays unconfirmed when the bound is reached', async () => {
    let unconfirmed = 0;
    const a = api({ cancels: [new Error('offline'), new Error('offline')], statuses: [{ state: 'cancelled' }] });
    expect(await stopReply(a, ID, { ...fast, onUnconfirmed: () => (unconfirmed += 1) })).toMatchObject({ kind: 'stopped' });
    expect(unconfirmed).toBe(1);
    expect(await pollUntilSettled(api(), ID, { ...fast, attempts: 3 })).toEqual({ kind: 'unconfirmed' });
  });

  it('recovery after an interrupted stream uses the same id and never starts another generation', async () => {
    const a = api({ statuses: [{ state: 'running' }, { state: 'succeeded', result: result('Recovered.') }] });
    let waiting = 0;
    const r = await recoverReply(a, { id: ID, text: 'x' }, { ...fast, statusSupported: true, onWaiting: () => (waiting += 1) });
    expect(r).toMatchObject({ kind: 'finished', result: { reply: { content: 'Recovered.' } } });
    expect(waiting).toBe(1);
    expect(a.calls.every((c) => c === `status:${ID}`)).toBe(true);
    // Without request_status (cancellation not deployed): the existing replay of the same id.
    const b = api();
    expect(await recoverReply(b, { id: ID, text: 'x' }, { ...fast, statusSupported: false })).toMatchObject({ kind: 'finished', result: { reply: { content: 'Done.' } } });
    expect(b.calls).toEqual(['send']);
  });

  it('preview text is plain: link markers removed', () => {
    expect(previewText('Breyttu því í Stillingum.\n[[open:/settings|Opna stillingar]]')).toBe('Breyttu því í Stillingum.\n');
  });
});
