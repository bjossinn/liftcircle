/**
 * Reply flow for the streaming chat (roadmap item 10). No React; the chat page wires it to state.
 *
 *  - send: streamed when the server says it can (status protocol.stream), otherwise the JSON request — one result shape.
 *  - stop: an ACKNOWLEDGED cancel. 'cancel_requested' is not yet stopped: the request is polled (bounded) until the server
 *    settles it as cancelled, or success won ('finished' → the stored exchange), or it stays unclear ('unconfirmed').
 *  - recover: after an interrupted stream (EOF without a terminal event) the SAME message id is checked, bounded; a slow
 *    stream never starts another generation. Without request_status (cancellation not deployed) the existing in_progress
 *    replay with the same id is used.
 */
import type { AiChatMessage, RequestStatusResult, SendResult, StreamHandlers } from '@/backend/ai';
import type { AiProtocol } from '@/backend/coachingContract';
import type { WorkoutContext } from '../../../../supabase/functions/_shared/ai/workout';
import { SendCancelled, sendWhileInProgress } from './inProgress';

export interface ReplyApi {
  send(input: SendInput): Promise<SendResult | { reply: AiChatMessage; proposal?: SendResult['proposal'] }>;
  sendStream?(input: SendInput, handlers: StreamHandlers, signal?: AbortSignal): Promise<SendResult>;
  cancel?(id: string): Promise<RequestStatusResult>;
  requestStatus?(id: string): Promise<RequestStatusResult>;
}
export interface SendInput {
  id: string;
  text: string;
  mode?: 'chat' | 'checkin_review';
  unsynced?: number;
  workout?: WorkoutContext;
}

export const STATUS_POLL_MS = 1500;
/** ~2.5 min: longer than the server's 2-minute cancel expiry, so a dead worker is finalized within the wait. */
export const STATUS_POLL_ATTEMPTS = 100;
/** After this long without the finished reply, the status line adds "This is taking a little longer." */
export const SLOW_AFTER_MS = 20_000;

const wait = (ms: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>) =>
  sleep
    ? sleep(ms)
    : new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        function done() {
          clearTimeout(t);
          signal?.removeEventListener('abort', done);
          resolve();
        }
        signal?.addEventListener('abort', done);
      });

export const canStream = (api: ReplyApi, protocol: AiProtocol | undefined) => !!protocol?.stream && typeof api.sendStream === 'function';
export const canStop = (api: ReplyApi, protocol: AiProtocol | undefined) =>
  !!protocol?.cancel && typeof api.cancel === 'function' && typeof api.requestStatus === 'function';

/** One send (streamed or JSON), waiting out a replay of the same id that is still being answered (1.0.3). */
export function sendReply(api: ReplyApi, protocol: AiProtocol | undefined, input: SendInput, handlers: StreamHandlers, signal: AbortSignal, opts: { sleep?: (ms: number) => Promise<void> } = {}) {
  return sendWhileInProgress(
    () => {
      if (signal.aborted) throw new SendCancelled();
      return canStream(api, protocol) ? api.sendStream!(input, handlers, signal) : api.send(input);
    },
    { signal, ...(opts.sleep ? { sleep: opts.sleep } : {}) },
  );
}

export type Settled =
  | { kind: 'finished'; result: SendResult }
  | { kind: 'stopped'; usage?: RequestStatusResult['usage'] }
  | { kind: 'failed' }
  | { kind: 'unconfirmed' };

/** Poll the request (same id) until it is settled, bounded. `running`/`cancel_requested` keep waiting. */
export async function pollUntilSettled(
  api: ReplyApi,
  id: string,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal; onWaiting?: () => void } = {},
): Promise<Settled> {
  const attempts = opts.attempts ?? STATUS_POLL_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    if (opts.signal?.aborted) throw new SendCancelled();
    let st: RequestStatusResult | null = null;
    try {
      st = await api.requestStatus!(id);
    } catch {
      st = null; // offline for a moment: try again
    }
    if (st?.state === 'succeeded' && st.result) return { kind: 'finished', result: st.result };
    if (st?.state === 'cancelled') return { kind: 'stopped', usage: st.usage };
    if (st?.state === 'failed') return { kind: 'failed' };
    if (st?.state === 'none') return { kind: 'unconfirmed' };
    if (st) opts.onWaiting?.();
    await wait(opts.delayMs ?? STATUS_POLL_MS, opts.signal, opts.sleep);
  }
  return { kind: 'unconfirmed' };
}

/** The user's Stop: acknowledged by the server, never just a closed reader. */
export async function stopReply(
  api: ReplyApi,
  id: string,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal; onUnconfirmed?: () => void } = {},
): Promise<Settled> {
  let first: RequestStatusResult;
  try {
    first = await api.cancel!(id);
  } catch {
    // The Stop may or may not have arrived: say so, and find out with the same id.
    opts.onUnconfirmed?.();
    try {
      first = await api.cancel!(id);
    } catch {
      return pollUntilSettled(api, id, opts);
    }
  }
  if (first.state === 'succeeded' && first.result) return { kind: 'finished', result: first.result };
  if (first.state === 'cancelled') return { kind: 'stopped', usage: first.usage };
  return pollUntilSettled(api, id, opts);
}

/**
 * After an interrupted stream: where is this message's reply? Same id, bounded. Servers without request_status use the
 * existing replay (a stored reply comes back as a duplicate; one still running answers in_progress and is waited for).
 */
export async function recoverReply(
  api: ReplyApi,
  input: SendInput,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal; onWaiting?: () => void; statusSupported: boolean },
): Promise<Settled> {
  if (opts.statusSupported && api.requestStatus) return pollUntilSettled(api, input.id, opts);
  try {
    const r = await sendWhileInProgress(() => api.send(input), { signal: opts.signal, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
    return { kind: 'finished', result: { duplicate: false, proposal: null, ...r } as SendResult };
  } catch (e) {
    if (e instanceof SendCancelled) throw e;
    return { kind: 'unconfirmed' };
  }
}

/** Preview text: plain, with in-app link markers removed (links become buttons only on the final reply). */
export function previewText(s: string): string {
  return s.replace(/\[\[\s*open\s*:[^\]]*\]\]/gi, '').replace(/\n{3,}/g, '\n\n');
}
