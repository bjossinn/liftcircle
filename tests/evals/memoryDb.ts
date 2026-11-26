/**
 * In-memory AiDb with the reservation-aware request state machine (roadmap item 10). It mirrors the SQL functions in
 * supabase/migrations/20261126000001_ai_coach_followups.sql and 20261130000001_ai_cancellation.sql:
 *
 *   begin:   none → running (charged) · running < 3 min → in_progress · running ≥ 3 min → takeover (same charge)
 *            failed → running (charged again) · succeeded → duplicate · cancel_requested | cancelled → cancelled
 *   fail:    running (own attempt) → failed, refund once · cancel_requested (own attempt) → cancelled, refund once
 *   cancel:  none → cancelled tombstone · running → cancel_requested (abandoned ≥ 3 min → cancelled) · failed → cancelled
 *            succeeded → succeeded · cancel_requested past expiry → cancelled
 *   settle:  cancel_requested (own attempt) → cancelled, refund once · cancelled → usage booked once, no refund
 *   record:  cancel_requested | cancelled → PT409 'cancelled' (nothing stored) · failed → charged again · → succeeded
 *
 * Refunds go to the day the request was charged; failed/cancelled usage is booked on the current day, once per attempt
 * (late reports are idempotent). Used by unit tests and by the eval runner (tests/live/coach-eval.mjs). Synthetic data only.
 */
import type {
  AccountStatePayload, ActiveProgramRow, AiDb, AiSettingsRow, AttemptUsage, BeginRequestResult, CancelResult, FoodLogPayload, GoalPayload,
  MeasurementPayload, RecordExchangeInput, RefExercise, RefIngredient, RefRecipe, RequestState, SessionPayload, StoredExchange, StoredMessage,
} from '../../supabase/functions/_shared/ai/types';

export const RUNNING_TAKEOVER_MS = 3 * 60_000;
export const CANCEL_EXPIRY_MS = 2 * 60_000;

export interface UsageDay {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  failedRequests: number;
  failedInputTokens: number;
  failedOutputTokens: number;
  cancelledRequests: number;
  unknownUsageAttempts: number;
}
export interface RequestRow {
  messageId: string;
  attempt: string;
  state: Exclude<RequestState, 'none'>;
  charged: boolean;
  day: string;
  startedAt: number;
  cancelRequestedAt: number | null;
}

export interface MemoryDbInput {
  uid: string;
  settings: AiSettingsRow;
  account?: AccountStatePayload | null;
  program?: ActiveProgramRow | null;
  sessions?: SessionPayload[];
  goals?: GoalPayload[];
  bodyweight?: MeasurementPayload[];
  foodLogs?: FoodLogPayload[];
  history?: StoredMessage[];
  exercises?: RefExercise[];
  recipes?: RefRecipe[];
  ingredients?: RefIngredient[];
  /** Wall clock for reservation ages (ms). Default Date.now. */
  clock?: () => number;
  /** UTC day used for charges and usage (default: from `clock`). */
  day?: () => string;
  /** Turn off the item 10 cancellation functions (an older database). */
  noCancellation?: boolean;
}

const emptyDay = (): UsageDay => ({
  requests: 0, inputTokens: 0, outputTokens: 0, costUsd: null, failedRequests: 0, failedInputTokens: 0, failedOutputTokens: 0, cancelledRequests: 0, unknownUsageAttempts: 0,
});
const err = (message: string, code: string, hint?: string) => Object.assign(new Error(message), { code, ...(hint ? { hint } : {}) });
let seq = 0;
const newAttempt = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

export function createMemoryDb(input: MemoryDbInput) {
  const clock = input.clock ?? Date.now;
  const day = input.day ?? (() => new Date(clock()).toISOString().slice(0, 10));
  const state = {
    settings: input.settings,
    messages: [...(input.history ?? [])] as StoredMessage[],
    exchanges: new Map<string, StoredExchange>(),
    requests: new Map<string, RequestRow>(),
    usage: new Map<string, UsageDay>(),
    /** message:attempt pairs whose usage was booked (late reports are idempotent). */
    reports: new Set<string>(),
    recorded: [] as RecordExchangeInput[],
    calls: [] as string[],
  };
  const usageOf = (d: string) => {
    let u = state.usage.get(d);
    if (!u) state.usage.set(d, (u = emptyDay()));
    return u;
  };
  const charge = (limit: number | null) => {
    const u = usageOf(day());
    if (limit != null && u.requests >= limit) throw err(`You've reached today's AI coach limit of ${limit} messages.`, 'PT429', 'rate_limited');
    u.requests += 1;
    return u.requests;
  };
  const refund = (r: RequestRow) => {
    if (!r.charged) return false;
    const u = usageOf(r.day);
    u.requests = Math.max(0, u.requests - 1);
    r.charged = false;
    return true;
  };
  const book = (r: RequestRow, attempt: string, usage: AttemptUsage, kind: 'failed' | 'cancelled') => {
    const key = `${r.messageId}:${attempt}`;
    if (state.reports.has(key)) return;
    state.reports.add(key);
    const u = usageOf(day());
    u.failedRequests += 1;
    if (kind === 'cancelled') u.cancelledRequests += 1;
    u.failedInputTokens += usage.inputTokens;
    u.failedOutputTokens += usage.outputTokens;
    if (usage.unknown) u.unknownUsageAttempts += 1;
  };
  /** Bounded expiry finalizer: a cancel nobody acknowledged (worker died) becomes cancelled, refunded once. */
  const finalizeExpired = (r: RequestRow | undefined) => {
    if (r && r.state === 'cancel_requested' && r.cancelRequestedAt != null && clock() - r.cancelRequestedAt >= CANCEL_EXPIRY_MS) {
      r.state = 'cancelled';
      refund(r);
    }
  };
  const cancellation = !input.noCancellation;

  const db: AiDb = {
    async getSettings() {
      return state.settings;
    },
    async getExchange(_uid, id) {
      return state.exchanges.get(id) ?? null;
    },
    async checkAndCountUsage(_uid, limit) {
      return limit - charge(limit);
    },
    async beginRequest(_uid, id, limit): Promise<BeginRequestResult> {
      state.calls.push(`begin:${id}`);
      if (state.exchanges.has(id)) return { status: 'duplicate' };
      const r = state.requests.get(id);
      finalizeExpired(r);
      if (r) {
        if (r.state === 'succeeded') return { status: 'duplicate' };
        if (r.state === 'cancel_requested' || r.state === 'cancelled') return { status: 'cancelled' };
        if (r.state === 'running') {
          if (clock() - r.startedAt < RUNNING_TAKEOVER_MS) return { status: 'in_progress' };
          r.attempt = newAttempt();
          r.startedAt = clock();
          return { status: 'started', attempt: r.attempt };
        }
        const n = charge(limit);
        Object.assign(r, { attempt: newAttempt(), state: 'running', charged: true, day: day(), startedAt: clock(), cancelRequestedAt: null });
        return { status: 'started', attempt: r.attempt, remaining: limit - n };
      }
      const n = charge(limit);
      const row: RequestRow = { messageId: id, attempt: newAttempt(), state: 'running', charged: true, day: day(), startedAt: clock(), cancelRequestedAt: null };
      state.requests.set(id, row);
      return { status: 'started', attempt: row.attempt, remaining: limit - n };
    },
    async failRequest(_uid, id, attempt, usage) {
      state.calls.push(`fail:${id}`);
      const r = state.requests.get(id);
      if (!r || r.attempt !== attempt) return;
      if (r.state === 'running') {
        r.state = 'failed';
        refund(r);
        book(r, attempt, usage, 'failed');
      } else if (r.state === 'cancel_requested') {
        r.state = 'cancelled';
        refund(r);
        book(r, attempt, usage, 'cancelled');
      } else if (r.state === 'cancelled') book(r, attempt, usage, 'cancelled');
    },
    async getUsage(_uid, d) {
      const u = state.usage.get(d);
      return u ? { day: d, requests: u.requests, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd } : null;
    },
    async getAccountState() {
      return input.account ?? null;
    },
    async getActiveProgram() {
      return input.program ?? null;
    },
    async getRecentSessions(_uid, limit) {
      return (input.sessions ?? []).slice(0, limit);
    },
    async getGoals() {
      return input.goals ?? [];
    },
    async getBodyweight() {
      return input.bodyweight ?? [];
    },
    async getFoodLogs() {
      return input.foodLogs ?? [];
    },
    async getHistory(_uid, after, limit) {
      return state.messages.filter((m) => !after || m.createdAt > after).slice(-limit);
    },
    async recordExchange(_uid, rec) {
      state.calls.push(`record:${rec.message.id}`);
      const existing = state.exchanges.get(rec.message.id);
      if (existing) return { ...existing, duplicate: true };
      const r = state.requests.get(rec.message.id);
      if (r && (r.state === 'cancel_requested' || r.state === 'cancelled')) throw err('The reply was stopped.', 'PT409', 'cancelled');
      const t = clock();
      const user: StoredMessage = { id: rec.message.id, role: 'user', content: rec.message.content, createdAt: new Date(t).toISOString() };
      const reply: StoredMessage = {
        id: `reply-${rec.message.id}`, role: 'assistant', content: rec.reply.content, createdAt: new Date(t + 1).toISOString(),
        grounding: rec.reply.grounding, proposalId: rec.proposal ? `proposal-${rec.message.id}` : null, why: rec.reply.why ?? null, action: rec.reply.action ?? null,
      };
      state.messages.push(user, reply);
      const proposal = rec.proposal ? ({ id: `proposal-${rec.message.id}`, ...rec.proposal } as unknown as StoredExchange['proposal']) : null;
      const ex: StoredExchange = { reply, proposal, duplicate: false };
      state.exchanges.set(rec.message.id, ex);
      state.recorded.push(rec);
      const u = usageOf(day());
      u.inputTokens += rec.usage.inputTokens;
      u.outputTokens += rec.usage.outputTokens;
      if (r && r.state !== 'succeeded') {
        if (!r.charged) {
          charge(null);
          r.charged = true;
          r.day = day();
        }
        r.state = 'succeeded';
      }
      return ex;
    },
    async getExercises() {
      return input.exercises ?? [];
    },
    async getRecipes() {
      return input.recipes ?? [];
    },
    async getIngredients() {
      return input.ingredients ?? [];
    },
    ...(cancellation
      ? {
          async cancelSupported() {
            return true;
          },
          async requestState(_uid: string, id: string): Promise<RequestState> {
            if (state.exchanges.has(id)) return 'succeeded';
            return state.requests.get(id)?.state ?? 'none';
          },
          async requestStatus(_uid: string, id: string): Promise<RequestState> {
            if (state.exchanges.has(id)) return 'succeeded';
            const r = state.requests.get(id);
            finalizeExpired(r);
            return r?.state ?? 'none';
          },
          async cancelRequest(_uid: string, id: string): Promise<CancelResult> {
            state.calls.push(`cancel:${id}`);
            if (state.exchanges.has(id)) return { status: 'succeeded' };
            const r = state.requests.get(id);
            finalizeExpired(r);
            if (!r) {
              state.requests.set(id, { messageId: id, attempt: newAttempt(), state: 'cancelled', charged: false, day: day(), startedAt: clock(), cancelRequestedAt: clock() });
              return { status: 'cancelled' };
            }
            if (r.state === 'succeeded') return { status: 'succeeded' };
            if (r.state === 'cancelled') return { status: 'cancelled' };
            if (r.state === 'failed') {
              r.state = 'cancelled';
              return { status: 'cancelled' };
            }
            if (r.state === 'running' && clock() - r.startedAt >= RUNNING_TAKEOVER_MS) {
              r.state = 'cancelled';
              refund(r);
              return { status: 'cancelled' };
            }
            if (r.state === 'running') {
              r.state = 'cancel_requested';
              r.cancelRequestedAt = clock();
            }
            return { status: 'cancel_requested' };
          },
          async settleCancelled(_uid: string, id: string, attempt: string, usage: AttemptUsage) {
            state.calls.push(`settle:${id}`);
            const r = state.requests.get(id);
            if (!r || r.attempt !== attempt) return { settled: false, refunded: false };
            if (r.state === 'cancel_requested') {
              r.state = 'cancelled';
              const refunded = refund(r);
              book(r, attempt, usage, 'cancelled');
              return { settled: true, refunded };
            }
            if (r.state === 'cancelled') book(r, attempt, usage, 'cancelled');
            return { settled: false, refunded: false };
          },
        }
      : {}),
  };
  return {
    db,
    state,
    usageOf,
    setSettings(s: AiSettingsRow) {
      state.settings = s;
    },
  };
}
