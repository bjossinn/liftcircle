/**
 * Server-sent events for the training assistant (roadmap item 10). Pure: the Deno entry point supplies the writer.
 *
 *   status      {v:1, requestId, seq, phase}                              server-owned phase, only when that work runs
 *   text_delta  {v:1, requestId, seq, replyId, text}                      chunks of the FINAL, STORED answer
 *   complete    {v:1, requestId, seq, reply, proposal, duplicate, usage}  the authoritative exchange (same as JSON)
 *   error       {v:1, requestId, seq, code, reason?, retryable}           stable codes, never provider text
 *   cancelled   {v:1, requestId, seq, usage}                              only after the cancel is durably settled
 *
 * Raw model output is never streamed: the answer is postchecked (it may be replaced entirely) and stored first, and only
 * then released in chunks, promptly and without artificial delays. A broken writer (the client went away) never affects
 * the work: it continues to its normal settlement (the caller keeps it alive with the platform's background task), and
 * the app recovers the stored exchange with the same message id.
 */
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import type { CoachPhase, CoachResult, CoachStart } from './coach.ts';

export const SSE_VERSION = 1;
export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Accel-Buffering': 'no',
};
export const HEARTBEAT_MS = 12_000;
/** Answer chunk size (characters, never splitting a code point). */
export const CHUNK_CHARS = 120;

export type SseEventName = 'status' | 'text_delta' | 'complete' | 'error' | 'cancelled';

export function sseFrame(event: SseEventName, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
export const HEARTBEAT_FRAME = ': keep-alive\n\n';

/** Split text into chunks of about `max` characters at whitespace where possible; never inside a code point. */
export function chunkAnswer(text: string, max = CHUNK_CHARS): string[] {
  const cps = Array.from(text);
  const out: string[] = [];
  let i = 0;
  while (i < cps.length) {
    let end = Math.min(cps.length, i + max);
    if (end < cps.length) {
      let j = end;
      while (j > i + Math.floor(max / 2) && !/\s/.test(cps[j - 1])) j--;
      if (j > i + Math.floor(max / 2)) end = j;
    }
    out.push(cps.slice(i, end).join(''));
    i = end;
  }
  return out;
}

/** Codes the app may retry on its own initiative (a new attempt with the same message id). */
const RETRYABLE = new Set(['ai_unavailable', 'invalid_reply', 'in_progress', 'internal', 'cancel_unconfirmed']);

export interface SseWriter {
  write(chunk: string): void | Promise<void>;
  close(): void;
}

export interface StreamOptions {
  heartbeatMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
}

/**
 * Run a started request and narrate it as SSE. Returns the same CoachResult the JSON path returns (one execution path).
 */
export async function streamCoachRun(start: Extract<CoachStart, { kind: 'started' }>, writer: SseWriter, opts: StreamOptions = {}): Promise<CoachResult | null> {
  const requestId = start.requestId;
  let seq = 0;
  let broken = false;
  const write = async (s: string) => {
    if (broken) return;
    try {
      await writer.write(s);
    } catch {
      broken = true; // the client went away: keep working, stop writing
      opts.log?.('ai_stream_detached', {});
    }
  };
  const emit = (event: SseEventName, data: Record<string, unknown>) => write(sseFrame(event, { v: SSE_VERSION, requestId, seq: ++seq, ...data }));
  const setI = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearI = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const hb = setI(() => void write(HEARTBEAT_FRAME), opts.heartbeatMs ?? HEARTBEAT_MS);
  let lastPhase: CoachPhase | null = null;
  let result: CoachResult | null = null;
  try {
    result = await start.run({
      onPhase: (phase) => {
        if (phase === lastPhase) return;
        lastPhase = phase;
        void emit('status', { phase });
      },
    });
    const body = result.body;
    if (result.status === 200 && body.reply && typeof body.reply === 'object') {
      const reply = body.reply as { id?: string; content?: string };
      for (const text of chunkAnswer(String(reply.content ?? ''))) await emit('text_delta', { replyId: reply.id ?? null, text });
      await emit('complete', { reply: body.reply, proposal: body.proposal ?? null, duplicate: Boolean(body.duplicate), usage: body.usage ?? null });
    } else if (body.code === 'request_cancelled') {
      await emit('cancelled', { usage: body.usage ?? null });
    } else {
      const code = typeof body.code === 'string' ? body.code : 'internal';
      await emit('error', { code, ...(typeof body.reason === 'string' ? { reason: body.reason } : {}), retryable: RETRYABLE.has(code) });
    }
  } catch {
    opts.log?.('ai_stream_error', {});
    await emit('error', { code: 'internal', retryable: true });
  } finally {
    clearI(hb);
    try {
      writer.close();
    } catch {
      // already closed by the client
    }
  }
  return result;
}
