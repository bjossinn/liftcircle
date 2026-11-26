/**
 * Reply flow for the streaming chat (roadmap item 10). No React; the chat page wires it to state.
 *
 *  - send: streamed when the server says it can (status protocol.stream), otherwise the JSON request — one result shape.
 *    `prepare()` runs before EVERY attempt (the first send, each in_progress retry, a JSON recovery replay): it
 *    re-checks sharing and rebuilds the input, so a retry never goes out with data the user has since stopped sharing
 *    (review P1-2). It returns null to stop the flow.
 *  - Every call is bound to the account that wrote the message (`expectedUserId`, review P1-1) and to the flow's abort
 *    signal; control calls are time-bounded (review P2-5).
 *  - stop: an ACKNOWLEDGED cancel. 'cancel_requested' is not yet stopped: the request is polled (bounded) until the server
 *    settles it as cancelled, or success won ('finished' → the stored exchange), or it stays unclear ('unconfirmed').
 *  - recover: after an interrupted or stalled stream the SAME message id is checked, bounded; a slow stream never starts
 *    another generation. Without request_status (cancellation not deployed) the existing in_progress replay is used.
 */
import type { AiChatMessage, CallOptions, RequestStatusResult, SendResult, StreamHandlers } from '@/backend/ai';
import type { AiProtocol } from '@/backend/coachingContract';
import type { WorkoutContext } from '../../../../supabase/functions/_shared/ai/workout';
import { SendCancelled, sendWhileInProgress } from './inProgress';

export interface ReplyApi {
  send(input: SendInput, opts?: CallOptions): Promise<SendResult | { reply: AiChatMessage; proposal?: SendResult['proposal'] }>;
  sendStream?(input: SendInput, handlers: StreamHandlers, opts?: CallOptions): Promise<SendResult>;
  cancel?(id: string, opts?: CallOptions): Promise<RequestStatusResult>;
  requestStatus?(id: string, opts?: CallOptions): Promise<RequestStatusResult>;
}
export interface SendInput {
  id: string;
  text: string;
  mode?: 'chat' | 'checkin_review';
  unsynced?: number;
  workout?: WorkoutContext;
  /** A workout question (generated text and/or a workout request), with or without its attachment. */
  contextual?: boolean;
}
/** Rebuilds the input right before an attempt; null = this message may not be sent now (e.g. Training sharing off). */
export type Prepare = () => Promise<SendInput | null>;

/** The flow stopped before an attempt because sharing no longer allows this message (review P1-2). */
export class SharingBlocked extends Error {
  readonly code = 'training_not_shared';
  constructor() {
    super('Training sharing is off.');
    this.name = 'SharingBlocked';
  }
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

const isAccountChange = (e: unknown) => (e as { code?: unknown } | null)?.code === 'account_changed';
const isAbort = (e: unknown) => e instanceof SendCancelled || (e as Error | null)?.name === 'AbortError';

export const canStream = (api: ReplyApi, protocol: AiProtocol | undefined) => !!protocol?.stream && typeof api.sendStream === 'function';
export const canStop = (api: ReplyApi, protocol: AiProtocol | undefined) =>
  !!protocol?.cancel && typeof api.cancel === 'function' && typeof api.requestStatus === 'function';

interface FlowOpts {
  /** The account that wrote the message: every request is refused if another account is signed in by then. */
  expectedUserId?: string;
  sleep?: (ms: number) => Promise<void>;
}

/** One attempt's input, or a stop: checked right before dispatch. */
async function prepared(prepare: Prepare, signal: AbortSignal): Promise<SendInput> {
  if (signal.aborted) throw new SendCancelled();
  const input = await prepare();
  if (signal.aborted) throw new SendCancelled();
  if (!input) throw new SharingBlocked();
  return input;
}

/** One send (streamed or JSON), waiting out a replay of the same id that is still being answered (1.0.3). */
export function sendReply(api: ReplyApi, protocol: AiProtocol | undefined, prepare: Prepare, handlers: StreamHandlers, signal: AbortSignal, opts: FlowOpts = {}) {
  const call: CallOptions = { signal, ...(opts.expectedUserId !== undefined ? { expectedUserId: opts.expectedUserId } : {}) };
  return sendWhileInProgress(
    async () => {
      const input = await prepared(prepare, signal);
      return canStream(api, protocol) ? api.sendStream!(input, handlers, call) : api.send(input, call);
    },
    { signal, ...(opts.sleep ? { sleep: opts.sleep } : {}) },
  );
}

export type Settled =
  | { kind: 'finished'; result: SendResult }
  | { kind: 'stopped'; usage?: RequestStatusResult['usage'] }
  | { kind: 'failed' }
  | { kind: 'blocked' }
  | { kind: 'unconfirmed' };

/** Poll the request (same id) until it is settled, bounded. `running`/`cancel_requested` keep waiting. */
export async function pollUntilSettled(
  api: ReplyApi,
  id: string,
  opts: FlowOpts & { attempts?: number; delayMs?: number; signal?: AbortSignal; onWaiting?: () => void } = {},
): Promise<Settled> {
  const attempts = opts.attempts ?? STATUS_POLL_ATTEMPTS;
  const call: CallOptions = { ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.expectedUserId !== undefined ? { expectedUserId: opts.expectedUserId } : {}) };
  for (let i = 0; i < attempts; i++) {
    if (opts.signal?.aborted) throw new SendCancelled();
    let st: RequestStatusResult | null = null;
    try {
      st = await api.requestStatus!(id, call);
    } catch (e) {
      if (isAbort(e) || opts.signal?.aborted) throw new SendCancelled();
      if (isAccountChange(e)) throw e;
      st = null; // offline or slow for a moment: try again, within the bound
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
  opts: FlowOpts & { attempts?: number; delayMs?: number; signal?: AbortSignal; onUnconfirmed?: () => void } = {},
): Promise<Settled> {
  const call: CallOptions = { ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.expectedUserId !== undefined ? { expectedUserId: opts.expectedUserId } : {}) };
  let first: RequestStatusResult | null = null;
  for (let i = 0; i < 2 && !first; i++) {
    if (opts.signal?.aborted) throw new SendCancelled();
    try {
      first = await api.cancel!(id, call);
    } catch (e) {
      if (isAbort(e) || opts.signal?.aborted) throw new SendCancelled();
      if (isAccountChange(e)) throw e;
      // The Stop may or may not have arrived: say so, and find out with the same id.
      if (i === 0) opts.onUnconfirmed?.();
    }
  }
  if (first?.state === 'succeeded' && first.result) return { kind: 'finished', result: first.result };
  if (first?.state === 'cancelled') return { kind: 'stopped', usage: first.usage };
  return pollUntilSettled(api, id, opts);
}

/**
 * After an interrupted or stalled stream: where is this message's reply? Same id, bounded. Servers without
 * request_status use the existing replay (a stored reply comes back as a duplicate; one still running answers
 * in_progress and is waited for) — rebuilt by `prepare` before every attempt, like a send.
 */
export async function recoverReply(
  api: ReplyApi,
  prepare: Prepare,
  id: string,
  opts: FlowOpts & { attempts?: number; delayMs?: number; signal?: AbortSignal; onWaiting?: () => void; statusSupported: boolean },
): Promise<Settled> {
  if (opts.statusSupported && api.requestStatus) return pollUntilSettled(api, id, opts);
  const signal = opts.signal ?? new AbortController().signal;
  const call: CallOptions = { signal, ...(opts.expectedUserId !== undefined ? { expectedUserId: opts.expectedUserId } : {}) };
  try {
    const r = await sendWhileInProgress(async () => api.send(await prepared(prepare, signal), call), { signal, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
    return { kind: 'finished', result: { duplicate: false, proposal: null, ...r } as SendResult };
  } catch (e) {
    if (isAbort(e)) throw new SendCancelled();
    if (e instanceof SharingBlocked) return { kind: 'blocked' };
    if (isAccountChange(e)) throw e;
    return { kind: 'unconfirmed' };
  }
}

/** Preview text: plain, with in-app link markers removed (links become buttons only on the final reply). */
export function previewText(s: string): string {
  return s.replace(/\[\[\s*open\s*:[^\]]*\]\]/gi, '').replace(/\n{3,}/g, '\n\n');
}
