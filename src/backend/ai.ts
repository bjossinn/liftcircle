/**
 * Supabase implementation of AiApi (see coachingContract.ts). Online-only.
 *
 * Settings, history and proposals use security-definer RPCs (supabase/migrations/20261029000003_ai_coach.sql)
 * that take the user from the access token. Chat and availability go through the `ai-coach` Edge Function,
 * which holds the provider key and builds context server-side from the user's permitted records only.
 *
 * Errors are thrown as AiError (a BackendError) with `code` and, where relevant, `reason` / `usage`:
 *   network → offline · 503 ai_unavailable {reason: not_configured|provider_down} · 429 rate_limited ·
 *   409 ai_disabled|ai_paused · 401 auth. Proposal responses add details 'stale' | 'not_applicable' | ….
 */
import type { ID } from '@/domain/types';
import type { WeekPlan } from '@/domain/program/schedule';
import { toMealPlanSuggestion, toRecipeSuggestions, type MealPlanSuggestion, type RecipeSuggestions } from '@/domain/nutrition/aiActions';
import type { AiApi, AiAvailability, AiMessage, AiSettings, AiUsage, ProgramProposal } from './coachingContract';
import { backendConfigured, requireSupabase } from './supabase';
import { BackendError, toBackendError } from './syncRemote';

type Unavailable = Extract<AiAvailability, { available: false }>['reason'];

export class AiError extends BackendError {
  constructor(
    message: string,
    code: string,
    status?: number,
    readonly reason?: Unavailable | 'rate_limited' | 'stale' | 'not_applicable' | 'not_found' | 'not_open' | 'consent_required',
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
async function mapInvokeError(error: unknown): Promise<BackendError> {
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
    coachStyle: raw.coachStyle === 'supportive' || raw.coachStyle === 'strict' ? raw.coachStyle : 'balanced',
  };
}

/**
 * An AI message plus the optional fields: collapsed "Why this?" reasoning and at most one structured action — a this-week
 * plan, a meal plan suggestion or recipe cards (ai_messages.action; unknown or malformed kinds are dropped).
 */
export type AiChatMessage = AiMessage & { why?: string | null; weekPlan?: WeekPlan | null; mealPlan?: MealPlanSuggestion | null; recipes?: RecipeSuggestions | null };

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

function toMessage(raw: Record<string, unknown>): AiChatMessage {
  return {
    ...(typeof raw.why === 'string' && raw.why.trim() ? { why: raw.why } : {}),
    ...(raw.action ? { weekPlan: toWeekPlan(raw.action), mealPlan: toMealPlanSuggestion(raw.action), recipes: toRecipeSuggestions(raw.action) } : {}),
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
export const aiApi: AiApi = {
  async status() {
    if (!backendConfigured) return { available: false, reason: 'backend_missing' };
    if (isOffline()) return { available: false, reason: 'offline' };
    try {
      const r = await invoke<{ available: boolean; reason?: Unavailable; usage?: AiUsage; provider?: unknown; providerName?: unknown; consentCurrent?: unknown }>({ action: 'status' });
      if (r.available)
        return {
          available: true,
          usage: r.usage,
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

  async send(input: { id: ID; text: string; mode?: 'chat' | 'checkin_review' }) {
    const r = await invoke<{ reply: Record<string, unknown>; proposal?: Record<string, unknown> | null }>({
      action: 'send',
      id: input.id,
      text: input.text,
      mode: input.mode ?? 'chat',
    });
    return { reply: toMessage(r.reply), proposal: r.proposal ? toProposal(r.proposal) : null };
  },

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
