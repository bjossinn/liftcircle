/**
 * Supabase implementation of AiApi (see coachingContract.ts). Online-only.
 *
 * Settings, history and proposals use security-definer RPCs (supabase/migrations/20261029000003_ai_coach.sql)
 * that take the user from the access token. Chat and availability go through the `ai-coach` Edge Function,
 * which holds the provider key and builds context server-side from the user's permitted records only.
 *
 * Errors are thrown as AiError (a BackendError) with `code` and, where relevant, `reason` / `usage`:
 *   network → offline · 503 ai_unavailable {reason: not_configured|provider_down} · 429 rate_limited ·
 *   409 ai_disabled|ai_paused|in_progress (same message still being answered) · 401 auth. Proposal responses add details 'stale' | 'not_applicable' | ….
 */
import type { ID } from '@/domain/types';
import type { WeekPlan } from '@/domain/program/schedule';
import { toMealPlanSuggestion, toRecipeSuggestions, type MealPlanSuggestion, type RecipeSuggestions } from '@/domain/nutrition/aiActions';
import type { AiApi, AiAvailability, AiMessage, AiSettings, AiUsage, ProgramProposal } from './coachingContract';
import type { SessionAdjustmentAction, WorkoutContext } from '../../supabase/functions/_shared/ai/workout';
import { backendConfigured, functionsBaseUrl, publishableApiKey, requireSupabase } from './supabase';
import { createSseParser, SseProtocolError } from './sseParser';
import { BackendError, toBackendError } from './syncRemote';
import { getLanguage } from '@/i18n';

type Unavailable = Extract<AiAvailability, { available: false }>['reason'];

export class AiError extends BackendError {
  constructor(
    message: string,
    code: string,
    status?: number,
    readonly reason?: Unavailable | 'rate_limited' | 'stale' | 'not_applicable' | 'not_found' | 'not_open' | 'consent_required' | 'cancelled' | 'sharing_changed' | 'invalid_reply',
    readonly usage?: Partial<AiUsage>,
  ) {
    super(message, code, status, reason ? { reason, usage } : usage ? { usage } : undefined);
    this.name = 'AiError';
  }
}

const OFFLINE = 'You appear to be offline. Check your connection and try again.';
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

async function rpc<T>(fn: string, args?: Record<string, unknown>, fallback = 'Couldn’t reach the training assistant. Please try again.'): Promise<T> {
  if (!backendConfigured) throw new AiError('The training assistant isn’t set up on this server.', 'backend_missing', undefined, 'backend_missing');
  let res: { data: unknown; error: unknown };
  try {
    res = await requireSupabase().rpc(fn, args);
  } catch (e) {
    throw mapRpcError(e, fallback);
  }
  if (res.error) throw mapRpcError(res.error, fallback);
  return res.data as T;
}

function mapRpcError(e: unknown, fallback: string): BackendError {
  const hint = (e as { hint?: unknown })?.hint;
  const be = toBackendError(e, fallback);
  if (be.isNetwork) return new AiError(OFFLINE, 'network', undefined, 'offline');
  if (typeof hint === 'string' && ['stale', 'not_applicable', 'not_found', 'not_open', 'consent_required'].includes(hint)) {
    return new AiError(be.message, be.code ?? 'P0001', be.status, hint as AiError['reason']);
  }
  if (be.isRateLimited) return new AiError(be.message, 'rate_limited', 429, 'rate_limited');
  return be;
}

/** Turn a failed functions.invoke into an AiError (FunctionsHttpError carries the Response in `context`). */
export async function mapInvokeError(error: unknown): Promise<BackendError> {
  const ctx = (error as { context?: unknown })?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    let body: { error?: string; code?: string; reason?: string; usage?: Partial<AiUsage> } = {};
    try {
      body = (await ctx.clone().json()) as typeof body;
    } catch {
      /* not JSON (gateway error page) */
    }
    const s = ctx.status;
    if (s === 401) return new AiError('Your session has expired. Please sign in again.', 'auth', 401);
    if (s === 429) return new AiError(body.error || 'You’ve reached today’s training assistant limit.', 'rate_limited', 429, 'rate_limited', body.usage);
    // 1.0.3: the same message is still being answered (a replay); not a settings problem.
    if (s === 409 && body.code === 'in_progress') return new AiError(body.error || 'Still answering this message.', 'in_progress', 409);
    // Item 10: stopped (the message id can't be reused), or sharing changed while the reply was written (discarded).
    if (s === 409 && body.code === 'request_cancelled') return new AiError(body.error || 'The reply was stopped.', 'request_cancelled', 409, 'cancelled', body.usage);
    if (s === 409 && body.code === 'sharing_changed') return new AiError(body.error || 'Your sharing settings changed.', 'sharing_changed', 409, 'sharing_changed');
    if (s === 409 && body.code === 'training_not_shared') return new AiError(body.error || 'Training isn’t shared.', 'training_not_shared', 409);
    if (body.code === 'invalid_reply') return new AiError(body.error || 'The reply could not be checked.', 'invalid_reply', s, 'invalid_reply');
    if (s === 409) return new AiError(body.error || 'The training assistant is turned off.', body.code || 'ai_disabled', 409, 'disabled');
    if (s === 503 || body.code === 'ai_unavailable') {
      const reason: Unavailable = body.reason === 'not_configured' ? 'not_configured' : 'provider_down';
      return new AiError(body.error || 'The training assistant is unavailable right now.', 'ai_unavailable', s, reason);
    }
    if (s === 404) return new AiError('The training assistant isn’t deployed on this server yet.', 'ai_unavailable', 404, 'backend_missing');
    return new AiError(body.error || 'Couldn’t reach the training assistant. Please try again.', body.code || `http_${s}`, s);
  }
  const name = String((error as Error)?.name ?? '');
  const msg = String((error as Error)?.message ?? '');
  if (/FunctionsFetchError|FunctionsRelayError/.test(name) || /Failed to send a request|failed to fetch|network/i.test(msg) || isOffline()) {
    return new AiError(OFFLINE, 'network', undefined, 'offline');
  }
  return toBackendError(error, 'Couldn’t reach the training assistant. Please try again.');
}

/* ------------------------------------------------------------------ streaming (item 10) */
/** One SSE event payload (v1). `seq` increases; anything else is a protocol error. */
type StreamEvent = { v: number; requestId: string; seq: number } & Record<string, unknown>;
export type StreamPhase = 'preparing' | 'training' | 'nutrition' | 'recipes' | 'planning' | 'writing' | 'checking' | 'saving';
const PHASES = new Set<StreamPhase>(['preparing', 'training', 'nutrition', 'recipes', 'planning', 'writing', 'checking', 'saving']);

export interface StreamHandlers {
  /** A server-owned phase (mapped to ai.chat.status.*); never model text. */
  onPhase?: (phase: StreamPhase) => void;
  /** A chunk of the finished, stored answer (preview only until the final result). */
  onText?: (text: string) => void;
  /** Any bytes arrived (heartbeats included): the connection is alive. */
  onActivity?: () => void;
}

/** The stream ended without a terminal event: the reply is unconfirmed (same message id; check its status). */
export class StreamInterrupted extends AiError {
  constructor() {
    super('The connection was interrupted.', 'stream_interrupted');
    this.name = 'StreamInterrupted';
  }
}

export interface SendResult {
  reply: AiChatMessage;
  proposal: ProgramProposal | null;
  duplicate: boolean;
  usage?: Partial<AiUsage>;
}

const toResult = (r: { reply: Record<string, unknown>; proposal?: Record<string, unknown> | null; duplicate?: unknown; usage?: unknown }): SendResult => ({
  reply: toMessage(r.reply),
  proposal: r.proposal ? toProposal(r.proposal) : null,
  duplicate: r.duplicate === true,
  ...(r.usage && typeof r.usage === 'object' ? { usage: r.usage as Partial<AiUsage> } : {}),
});

/**
 * POST send with {stream:true} and Accept: text/event-stream over an authenticated fetch (never EventSource, never
 * credentials in the URL). A JSON response (refusal before the stream, a duplicate, or a server without streaming) is
 * consumed normally. Resolves with the authoritative exchange; throws AiError for terminal errors, `request_cancelled`
 * for a settled Stop and StreamInterrupted when the stream ends without a terminal event.
 */
/**
 * Options for every item 10 call that is tied to a message: `expectedUserId` binds it to the account that wrote the
 * message (review P1-1). The session is resolved and its user checked IMMEDIATELY before dispatch, with no await in
 * between, so a message written under account A can never go out with account B's bearer token.
 */
export interface CallOptions {
  expectedUserId?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Control calls (cancel, request_status, JSON replay): give up after this long (default 20 s). */
  timeoutMs?: number;
}
export const CONTROL_TIMEOUT_MS = 20_000;
/** A stream that delivers nothing (not even heartbeats, sent every 12 s) for this long is treated as interrupted. */
export const STREAM_INACTIVITY_MS = 45_000;
/** No stream may stay open longer than this (the server's own budget is ~110 s). */
export const STREAM_OVERALL_MS = 180_000;

const abortError = () => Object.assign(new Error('Aborted.'), { name: 'AbortError' });

/** The current session's token, only if it belongs to `expectedUserId` (when given). */
export async function boundToken(expectedUserId: string | undefined): Promise<string> {
  const { data } = await requireSupabase().auth.getSession();
  const session = data.session;
  if (!session?.access_token) throw new AiError('Your session has expired. Please sign in again.', 'auth', 401);
  if (expectedUserId !== undefined && session.user?.id !== expectedUserId) {
    throw new AiError('The signed-in account changed.', 'account_changed');
  }
  return session.access_token;
}

/** Before the response headers arrive, a streamed send gives up after this long (it is then checked by id). */
export const STREAM_ADMISSION_MS = 30_000;

/** Reject with AbortError when `signal` fires; settle with `p` otherwise. */
function untilAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * One request to the ai-coach function, bound to the initiating account (review P1-1) and owning its abort controller,
 * caller-signal link and deadline for the WHOLE call: dispatch, headers AND body consumption (review round 3, P2-1).
 * Nothing here can wait without a bound.
 */
class BoundCall {
  readonly ctl = new AbortController();
  timedOut = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onAbort = () => this.ctl.abort();
  constructor(private readonly opts: CallOptions) {
    opts.signal?.addEventListener('abort', this.onAbort);
  }
  arm(ms: number) {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.ctl.abort();
    }, ms);
  }
  disarm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** Any step of the call, ended at once by the deadline or the caller's abort. */
  within<T>(p: Promise<T>): Promise<T> {
    return untilAbort(p, this.ctl.signal);
  }
  async dispatch(body: Record<string, unknown>, accept: string): Promise<Response> {
    if (!backendConfigured) throw new AiError('The training assistant isn’t set up on this server.', 'backend_missing', undefined, 'backend_missing');
    if (isOffline()) throw new AiError(OFFLINE, 'network', undefined, 'offline');
    if (this.ctl.signal.aborted) throw abortError();
    const token = await this.within(boundToken(this.opts.expectedUserId));
    // Dispatch right after the account check (no await in between).
    return this.within(
      (this.opts.fetchImpl ?? fetch)(`${functionsBaseUrl()}/ai-coach`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, apikey: publishableApiKey(), 'content-type': 'application/json', accept },
        body: JSON.stringify(body),
        signal: this.ctl.signal,
      }),
    );
  }
  /** Map a failure: the caller's abort, our deadline (`onTimeout`), a typed error, or the network. */
  error(e: unknown, onTimeout: () => Error): Error {
    if (this.opts.signal?.aborted) return abortError();
    if (this.timedOut) return onTimeout();
    if (e instanceof AiError) return e;
    if ((e as Error)?.name === 'AbortError') return abortError();
    return new AiError(OFFLINE, 'network', undefined, 'offline');
  }
  release() {
    this.disarm();
    this.opts.signal?.removeEventListener('abort', this.onAbort);
  }
}

/** A JSON call (control request or JSON send): the deadline covers the headers and the body (incl. error bodies). */
async function boundJson<T>(body: Record<string, unknown>, opts: CallOptions): Promise<T> {
  const call = new BoundCall(opts);
  call.arm(opts.timeoutMs ?? CONTROL_TIMEOUT_MS);
  try {
    const res = await call.dispatch(body, 'application/json');
    if (!res.ok) throw await call.within(mapInvokeError({ context: res }));
    let data: unknown;
    try {
      data = await call.within(res.json());
    } catch (e) {
      if (call.ctl.signal.aborted) throw e;
      throw new AiError('Couldn’t reach the training assistant. Please try again.', 'bad_response', res.status);
    }
    return data as T;
  } catch (e) {
    throw call.error(e, () => new AiError('The training assistant didn’t answer in time.', 'control_timeout'));
  } finally {
    call.release();
  }
}

/**
 * POST send with {stream:true} and Accept: text/event-stream over an authenticated fetch (never EventSource, never
 * credentials in the URL). A JSON response (refusal before the stream, a duplicate, or a server without streaming) is
 * consumed normally. Resolves with the authoritative exchange; throws AiError for terminal errors, `request_cancelled`
 * for a settled Stop and StreamInterrupted when the stream ends, stalls, or doesn't even start (no headers within the
 * admission deadline: the request may or may not have arrived, so it is checked by id, never resent blindly).
 */
async function streamSend(body: Record<string, unknown>, handlers: StreamHandlers, opts: CallOptions = {}): Promise<SendResult> {
  const call = new BoundCall(opts);
  call.arm(opts.timeoutMs ?? STREAM_ADMISSION_MS);
  try {
    const res = await call.dispatch({ ...body, stream: true }, 'text/event-stream');
    // Headers arrived: from here the stream's own inactivity and overall deadlines bound every read (incl. error and
    // JSON bodies); the caller's abort still reaches the connection through our controller.
    call.disarm();
    return await consumeStreamResponse(res, String(body.id ?? ''), handlers, { signal: call.ctl.signal });
  } catch (e) {
    throw call.error(e, () => new StreamInterrupted());
  } finally {
    call.release();
  }
}

/** Exported for tests: turn the function's response (JSON or SSE) into the final result. */
export async function consumeStreamResponse(
  res: Response,
  requestId: string,
  handlers: StreamHandlers,
  limits: { inactivityMs?: number; overallMs?: number; signal?: AbortSignal } = {},
): Promise<SendResult> {
  const type = res.headers.get('content-type') ?? '';
  // Non-stream bodies (an error, a JSON reply) are read within the inactivity deadline too (review round 3, P2-1).
  const bodyRead = <T,>(p: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new StreamInterrupted()), limits.inactivityMs ?? STREAM_INACTIVITY_MS);
      const onAbort = () => reject(abortError());
      if (limits.signal?.aborted) return onAbort();
      limits.signal?.addEventListener('abort', onAbort, { once: true });
      p.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        limits.signal?.removeEventListener('abort', onAbort);
      });
    });
  if (!res.ok) throw await bodyRead(mapInvokeError({ context: res }));
  if (!type.includes('text/event-stream')) {
    let json: Record<string, unknown>;
    try {
      json = (await bodyRead(res.json())) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof StreamInterrupted || (e as Error)?.name === 'AbortError') throw e;
      throw new AiError('Couldn’t reach the training assistant. Please try again.', 'bad_response', res.status);
    }
    return toResult(json as Parameters<typeof toResult>[0]);
  }
  if (!res.body) throw new StreamInterrupted();
  let lastSeq = 0;
  const box: { terminal: { kind: 'complete'; result: SendResult } | { kind: 'error'; error: AiError } | null } = { terminal: null };
  const parser = createSseParser({
    onHeartbeat: () => handlers.onActivity?.(),
    onEvent: (e) => {
      if (box.terminal) return;
      let ev: StreamEvent;
      try {
        ev = JSON.parse(e.data) as StreamEvent;
      } catch {
        throw new SseProtocolError('malformed');
      }
      if (!ev || ev.v !== 1 || ev.requestId !== requestId || typeof ev.seq !== 'number' || ev.seq <= lastSeq) throw new SseProtocolError('malformed');
      lastSeq = ev.seq;
      handlers.onActivity?.();
      if (e.event === 'status') {
        if (PHASES.has(ev.phase as StreamPhase)) handlers.onPhase?.(ev.phase as StreamPhase);
      } else if (e.event === 'text_delta') {
        if (typeof ev.text === 'string') handlers.onText?.(ev.text);
      } else if (e.event === 'complete') {
        if (!ev.reply || typeof ev.reply !== 'object') throw new SseProtocolError('malformed');
        box.terminal = { kind: 'complete', result: toResult(ev as unknown as Parameters<typeof toResult>[0]) };
      } else if (e.event === 'cancelled') {
        box.terminal = { kind: 'error', error: new AiError('The reply was stopped.', 'request_cancelled', 409, 'cancelled', (ev.usage as Partial<AiUsage>) ?? undefined) };
      } else if (e.event === 'error') {
        const code = typeof ev.code === 'string' ? ev.code : 'internal';
        const reason = typeof ev.reason === 'string' ? ev.reason : undefined;
        box.terminal = { kind: 'error', error: errorFromCode(code, reason, ev.retryable === true) };
      }
    },
  });
  const reader = res.body.getReader();
  const inactivityMs = limits.inactivityMs ?? STREAM_INACTIVITY_MS;
  const overallEnd = Date.now() + (limits.overallMs ?? STREAM_OVERALL_MS);
  /** One read, bounded by inactivity, the overall deadline and the caller's signal (review P2-5). */
  const read = () =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      const wait = Math.max(0, Math.min(inactivityMs, overallEnd - Date.now()));
      const timer = setTimeout(() => reject(new StreamInterrupted()), wait);
      const onAbort = () => reject(abortError());
      if (limits.signal?.aborted) return onAbort();
      limits.signal?.addEventListener('abort', onAbort, { once: true });
      reader.read().then(resolve, reject).finally(() => {
        clearTimeout(timer);
        limits.signal?.removeEventListener('abort', onAbort);
      });
    });
  try {
    for (;;) {
      const { done, value } = await read();
      if (done) break;
      parser.push(value);
      if (box.terminal) break;
    }
    if (!box.terminal) parser.end();
  } catch (e) {
    if (e instanceof SseProtocolError) throw new AiError('Couldn’t read the reply. Checking its status…', 'stream_protocol');
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new StreamInterrupted();
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const t = box.terminal;
  if (!t) throw new StreamInterrupted();
  if (t.kind === 'error') throw t.error;
  return t.result;
}

/** A terminal SSE error (stable code) as the same AiError the JSON path throws. */
function errorFromCode(code: string, reason: string | undefined, retryable: boolean): AiError {
  if (code === 'ai_unavailable') return new AiError('The training assistant is unavailable right now.', 'ai_unavailable', 503, reason === 'not_configured' ? 'not_configured' : 'provider_down');
  if (code === 'sharing_changed') return new AiError('Your sharing settings changed.', 'sharing_changed', 409, 'sharing_changed');
  if (code === 'invalid_reply') return new AiError('The reply could not be checked.', 'invalid_reply', 502, 'invalid_reply');
  if (code === 'rate_limited') return new AiError('You’ve reached today’s training assistant limit.', 'rate_limited', 429, 'rate_limited');
  const e = new AiError('Couldn’t reach the training assistant. Please try again.', code);
  return Object.assign(e, { retryable });
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  if (!backendConfigured) throw new AiError('The training assistant isn’t set up on this server.', 'backend_missing', undefined, 'backend_missing');
  if (isOffline()) throw new AiError(OFFLINE, 'network', undefined, 'offline');
  let res: { data: unknown; error: unknown };
  try {
    res = await requireSupabase().functions.invoke('ai-coach', { body });
  } catch (e) {
    throw await mapInvokeError(e);
  }
  if (res.error) throw await mapInvokeError(res.error);
  return res.data as T;
}

/* ------------------------------------------------------------------ mapping */
const DEFAULT_SCOPES = { profile: true, training: true, measurements: false, nutrition: false };

function toSettings(raw: Record<string, unknown> | null): AiSettings | null {
  if (!raw) return null;
  const sc = (raw.scopes ?? {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    paused: raw.paused === true,
    consentAt: (raw.consentAt as string | null) ?? null,
    consentVersion: (raw.consentVersion as string | null) ?? null,
    scopes: {
      profile: typeof sc.profile === 'boolean' ? sc.profile : DEFAULT_SCOPES.profile,
      training: typeof sc.training === 'boolean' ? sc.training : DEFAULT_SCOPES.training,
      measurements: typeof sc.measurements === 'boolean' ? sc.measurements : DEFAULT_SCOPES.measurements,
      nutrition: typeof sc.nutrition === 'boolean' ? sc.nutrition : DEFAULT_SCOPES.nutrition,
    },
    scopesChangedAt: (raw.scopesChangedAt as string | null) ?? null,
    profileNotes: typeof raw.profileNotes === 'string' ? raw.profileNotes : '',
    // Supportive is the default (Nov 2026); a stored 'balanced' or 'strict' is the user's choice.
    coachStyle: raw.coachStyle === 'balanced' || raw.coachStyle === 'strict' ? raw.coachStyle : 'supportive',
  };
}

/**
 * An AI message plus the optional fields: collapsed "Why this?" reasoning and at most one structured action — a this-week
 * plan, a today-only workout change, a meal plan suggestion or recipe cards (ai_messages.action; unknown or malformed
 * kinds are dropped).
 */
export type AiChatMessage = AiMessage & {
  why?: string | null;
  weekPlan?: WeekPlan | null;
  sessionAdjustment?: SessionAdjustmentAction | null;
  mealPlan?: MealPlanSuggestion | null;
  recipes?: RecipeSuggestions | null;
};

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const strs = (v: unknown, max = 8) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);

/** Defensive parse of a stored week_adjustment action (anything malformed → null, never applicable). */
export function toWeekPlan(raw: unknown): WeekPlan | null {
  const a = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!a || a.kind !== 'week_adjustment' || typeof a.id !== 'string' || typeof a.baseProgramId !== 'string') return null;
  if (typeof a.baseVersion !== 'number' || !isDate(a.weekStart) || !isDate(a.weekEnd) || typeof a.targetSessions !== 'number') return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').slice(0, 14) : []);
  const sessions = list(a.sessions).filter((x) => typeof x.templateId === 'string' && isDate(x.date) && isDate(x.plannedDate))
    .map((x) => ({ templateId: String(x.templateId), name: typeof x.name === 'string' ? x.name : 'Session', date: String(x.date), plannedDate: String(x.plannedDate) }));
  if (sessions.length !== list(a.sessions).length) return null;
  return {
    kind: 'week_adjustment',
    id: a.id,
    baseProgramId: a.baseProgramId,
    baseVersion: a.baseVersion,
    managedBy: a.managedBy === 'coach' || a.managedBy === 'ai' ? a.managedBy : 'self',
    weekStart: a.weekStart,
    weekEnd: a.weekEnd,
    targetSessions: a.targetSessions,
    completed: list(a.completed).filter((x) => isDate(x.date)).map((x) => ({ date: String(x.date), name: typeof x.name === 'string' ? x.name : 'Workout' })),
    sessions,
    skipped: list(a.skipped).filter((x) => typeof x.templateId === 'string' && isDate(x.plannedDate))
      .map((x) => ({ templateId: String(x.templateId), name: typeof x.name === 'string' ? x.name : 'Session', plannedDate: String(x.plannedDate) })),
    adjustments: strs(a.adjustments, 4),
    warnings: strs(a.warnings, 4),
    summary: typeof a.summary === 'string' ? a.summary : '',
  };
}

const idStr = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 100;
const shortStr = (v: unknown, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Defensive parse of a stored session_adjustment action (anything malformed → null, never applicable). */
export function toSessionAdjustment(raw: unknown): SessionAdjustmentAction | null {
  const a = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!a || a.kind !== 'session_adjustment' || !idStr(a.id) || !idStr(a.sessionId)) return null;
  if (a.change !== 'shorten' && a.change !== 'swap') return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').slice(0, 20) : []);
  const removeSets = list(a.removeSets)
    .filter((x) => idStr(x.sessionExerciseId) && typeof x.count === 'number' && x.count >= 1 && x.count <= 20)
    .map((x) => ({ sessionExerciseId: String(x.sessionExerciseId), name: shortStr(x.name) || 'Exercise', count: Math.round(x.count as number) }));
  const dropExercises = list(a.dropExercises).filter((x) => idStr(x.sessionExerciseId)).map((x) => ({ sessionExerciseId: String(x.sessionExerciseId), name: shortStr(x.name) || 'Exercise' }));
  const sw = (a.swap && typeof a.swap === 'object' ? a.swap : null) as Record<string, unknown> | null;
  const swap = sw && idStr(sw.sessionExerciseId) && idStr(sw.fromExerciseId) && idStr(sw.toExerciseId)
    ? { sessionExerciseId: String(sw.sessionExerciseId), fromExerciseId: String(sw.fromExerciseId), fromName: shortStr(sw.fromName) || 'Exercise', toExerciseId: String(sw.toExerciseId), toName: shortStr(sw.toName) || 'Exercise' }
    : undefined;
  if (a.change === 'swap' && !swap) return null;
  if (a.change === 'shorten' && !removeSets.length && !dropExercises.length) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
  return {
    kind: 'session_adjustment',
    id: String(a.id),
    sessionId: String(a.sessionId),
    change: a.change,
    ...(num(a.minutes) != null ? { minutes: num(a.minutes) } : {}),
    ...(num(a.estimatedMinutes) != null ? { estimatedMinutes: num(a.estimatedMinutes) } : {}),
    ...(a.change === 'swap' ? { swap } : {}),
    removeSets: a.change === 'shorten' ? removeSets : [],
    dropExercises: a.change === 'shorten' ? dropExercises : [],
    summary: shortStr(a.summary, 300),
    warnings: strs(a.warnings, 4),
  };
}

function toMessage(raw: Record<string, unknown>): AiChatMessage {
  return {
    ...(typeof raw.why === 'string' && raw.why.trim() ? { why: raw.why } : {}),
    ...(raw.action
      ? { weekPlan: toWeekPlan(raw.action), sessionAdjustment: toSessionAdjustment(raw.action), mealPlan: toMealPlanSuggestion(raw.action), recipes: toRecipeSuggestions(raw.action) }
      : {}),
    id: String(raw.id),
    role: raw.role === 'assistant' ? 'assistant' : 'user',
    content: String(raw.content ?? ''),
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    status: 'sent',
    proposalId: (raw.proposalId as string | null) ?? null,
    grounding: Array.isArray(raw.grounding) ? (raw.grounding as unknown[]).filter((g): g is string => typeof g === 'string') : [],
  };
}

function toProposal(raw: Record<string, unknown>): ProgramProposal {
  return {
    ...(raw as unknown as ProgramProposal),
    changeSummary: Array.isArray(raw.changeSummary) ? (raw.changeSummary as string[]) : [],
    validationErrors: Array.isArray(raw.validationErrors) ? (raw.validationErrors as string[]) : [],
    revision: typeof raw.revision === 'number' ? raw.revision : 1,
    target: raw.target === 'for_coach_review' ? 'for_coach_review' : 'apply',
    authorKind: 'ai',
  };
}

/* ------------------------------------------------------------------ API */
const sendBody = (input: { id: ID; text: string; mode?: 'chat' | 'checkin_review'; unsynced?: number; workout?: WorkoutContext; contextual?: boolean }) => ({
  action: 'send',
  // The app language: server-written text (summaries, warnings, errors) and the fallback reply language follow it.
  language: getLanguage(),
  id: input.id,
  text: input.text,
  mode: input.mode ?? 'chat',
  ...(input.unsynced ? { unsynced: input.unsynced } : {}),
  ...(input.workout ? { workout: input.workout } : {}),
  // The text (or part of it) was generated from a workout (review round 3, P1): sent even when the attachment was
  // removed, so the server can refuse it while Training isn't shared, whatever this device believes.
  ...(input.contextual ? { contextual: true } : {}),
});

export type RequestState = 'none' | 'running' | 'cancel_requested' | 'cancelled' | 'failed' | 'succeeded';
export interface RequestStatusResult {
  state: RequestState;
  /** Present when the reply was stored (success won). */
  result?: SendResult;
  usage?: Partial<AiUsage>;
}
const STATES = new Set<RequestState>(['none', 'running', 'cancel_requested', 'cancelled', 'failed', 'succeeded']);
function toStatus(r: Record<string, unknown>): RequestStatusResult {
  const state = STATES.has(r.state as RequestState) ? (r.state as RequestState) : 'none';
  return {
    state,
    ...(state === 'succeeded' && r.reply && typeof r.reply === 'object' ? { result: toResult(r as Parameters<typeof toResult>[0]) } : {}),
    ...(r.usage && typeof r.usage === 'object' ? { usage: r.usage as Partial<AiUsage> } : {}),
  };
}
async function sendJson(input: { id: ID; text: string; mode?: 'chat' | 'checkin_review'; unsynced?: number; workout?: WorkoutContext; contextual?: boolean }, opts?: CallOptions) {
  type R = { reply: Record<string, unknown>; proposal?: Record<string, unknown> | null; duplicate?: unknown; usage?: unknown };
  // Bound to the initiating account when the caller says which (the chat always does; review P1-1). The JSON send
  // waits for the whole answer, so it isn't cut off by the control timeout.
  const r = opts?.expectedUserId !== undefined ? await boundJson<R>(sendBody(input), { ...opts, timeoutMs: opts.timeoutMs ?? STREAM_OVERALL_MS }) : await invoke<R>(sendBody(input));
  return toResult(r);
}

const coreApi: AiApi = {
  async status() {
    if (!backendConfigured) return { available: false, reason: 'backend_missing' };
    if (isOffline()) return { available: false, reason: 'offline' };
    try {
      const r = await invoke<{ available: boolean; reason?: Unavailable; usage?: AiUsage; provider?: unknown; providerName?: unknown; consentCurrent?: unknown; protocol?: { stream?: unknown; cancel?: unknown } }>({ action: 'status', language: getLanguage() });
      if (r.available)
        return {
          available: true,
          usage: r.usage,
          // Item 10: only what this server says it supports (older servers: neither, so JSON and no Stop).
          protocol: { stream: r.protocol?.stream === 1, cancel: r.protocol?.cancel === 1 },
          ...(r.provider === 'openai' || r.provider === 'anthropic' ? { provider: r.provider } : {}),
          ...(typeof r.providerName === 'string' ? { providerName: r.providerName.slice(0, 40) } : {}),
          ...(typeof r.consentCurrent === 'boolean' ? { consentCurrent: r.consentCurrent } : {}),
        };
      return { available: false, reason: r.reason ?? 'provider_down', usage: r.usage };
    } catch (e) {
      const reason = (e as AiError).reason;
      if (reason === 'offline' || reason === 'not_configured' || reason === 'provider_down' || reason === 'backend_missing') {
        return { available: false, reason };
      }
      throw e;
    }
  },

  async getSettings() {
    return toSettings(await rpc<Record<string, unknown> | null>('get_ai_settings'));
  },

  async saveSettings(s) {
    const p: Record<string, unknown> = {};
    if (s.enabled !== undefined) p.enabled = s.enabled;
    if (s.paused !== undefined) p.paused = s.paused;
    if (s.scopes !== undefined) p.scopes = s.scopes;
    if (s.profileNotes !== undefined) p.profileNotes = s.profileNotes;
    if (s.coachStyle !== undefined) p.coachStyle = s.coachStyle;
    if (s.acceptConsent) {
      p.acceptConsent = true;
      // Records which provider the user agreed to; the server refuses to send to a different one.
      if (s.provider) p.consentVersion = `2026-10-29:${s.provider}`;
    }
    const saved = toSettings(await rpc<Record<string, unknown>>('save_ai_settings', { p }));
    if (!saved) throw new AiError('Couldn’t save training assistant settings.', 'unknown');
    return saved;
  },

  async history(limit = 50) {
    const rows = await rpc<Record<string, unknown>[]>('list_ai_messages', { p_limit: limit });
    return (rows ?? []).map(toMessage);
  },

  send: sendJson,

  async clearHistory() {
    await rpc<number>('clear_ai_history');
  },

  async listProposals() {
    const rows = await rpc<Record<string, unknown>[]>('list_ai_proposals');
    return (rows ?? []).map(toProposal);
  },

  async respondProposal(id, accept, applied) {
    await rpc('respond_ai_proposal', {
      p_id: id,
      p_accept: accept,
      p_program_id: applied?.programId ?? null,
      p_version: applied?.version ?? null,
    });
  },
};

/** The training assistant API: the AiApi contract plus the item 10 streaming and Stop calls (capability-gated). */
export const aiApi = {
  ...coreApi,
  /** The contract's send, plus account binding (`opts.expectedUserId`, review P1-1). */
  send: sendJson,
  /** Item 10: the same send, streamed (only when the server's status says `stream`). See streamSend. */
  sendStream(input: { id: ID; text: string; mode?: 'chat' | 'checkin_review'; unsynced?: number; workout?: WorkoutContext; contextual?: boolean }, handlers: StreamHandlers, opts: CallOptions = {}) {
    return streamSend(sendBody(input), handlers, opts);
  },

  /** Item 10: Stop. 'cancel_requested' is not yet stopped: poll requestStatus until the server settles it. */
  async cancel(id: ID, opts: CallOptions = {}): Promise<RequestStatusResult> {
    return toStatus(await boundJson<Record<string, unknown>>({ action: 'cancel', id, language: getLanguage() }, opts));
  },

  /** Item 10: where a message's reply stands (interrupted stream, lost Stop acknowledgement). Same message id. */
  async requestStatus(id: ID, opts: CallOptions = {}): Promise<RequestStatusResult> {
    return toStatus(await boundJson<Record<string, unknown>>({ action: 'request_status', id, language: getLanguage() }, opts));
  },

};
