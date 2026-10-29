/**
 * AiDb backed by Supabase clients (pure: the clients are passed in, no npm/Deno imports here).
 *
 * - `user`  = a client carrying the caller's JWT → RLS applies to every read (defence in depth), AND every
 *            query still filters explicitly by the verified uid (coaching adds coach-read policies to some
 *            private tables, so "whatever RLS lets me see" would include a coach's clients — never rely on it).
 * - `admin` = service-role client, used ONLY for the service-only RPCs (usage counter, exchange record/lookup).
 */
import type {
  AccountStatePayload, ActiveProgramRow, AiDb, AiSettingsRow, FoodLogPayload, GoalPayload, MeasurementPayload, RefExercise,
  RefIngredient, RefRecipe, SessionPayload, StoredExchange, StoredMessage, UsageRow,
} from './types.ts';

// Minimal structural view of supabase-js (query builders are thenables resolving to {data, error}).
// deno-lint-ignore no-explicit-any
type Builder = any;
export interface SbClient {
  from(table: string): Builder;
  rpc(fn: string, args?: Record<string, unknown>): Builder;
}

interface SbResult<T> {
  data: T | null;
  error: { message?: string; code?: string; hint?: string } | null;
}

export class DbError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'DbError';
  }
}

async function run<T>(q: PromiseLike<SbResult<T>>): Promise<T | null> {
  const { data, error } = await q;
  if (error) throw new DbError(error.message || 'Database error', error.code);
  return data;
}

const payloads = <T>(rows: { payload: T }[] | null): T[] => (rows ?? []).map((r) => r.payload).filter(Boolean);

/** Reference catalogs change only with a deploy/seed, so cache them per isolate for a few minutes. */
const refCache = new Map<string, { at: number; rows: unknown[] }>();
async function cachedRef<T>(key: string, load: () => Promise<T[]>): Promise<T[]> {
  const hit = refCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.rows as T[];
  const rows = await load();
  refCache.set(key, { at: Date.now(), rows });
  return rows;
}

export function createSupabaseAiDb(user: SbClient, admin: SbClient): AiDb {
  return {
    async getSettings(_uid) {
      // get_ai_settings derives the user from the JWT (auth.uid()), which is the same verified uid.
      return (await run<AiSettingsRow | null>(user.rpc('get_ai_settings'))) ?? null;
    },
    async getExchange(uid, messageId) {
      return (await run<StoredExchange | null>(admin.rpc('ai_get_exchange', { p_user: uid, p_message_id: messageId }))) ?? null;
    },
    async checkAndCountUsage(uid, limit) {
      const { data, error } = await admin.rpc('ai_check_and_count_usage', { p_user: uid, p_limit: limit });
      if (error) throw new DbError(error.message || 'Usage check failed', error.code);
      return Number(data ?? 0);
    },
    async getUsage(uid, day) {
      const r = await run<{ requests: number; input_tokens: number; output_tokens: number; cost_usd: number | null } | null>(
        user.from('ai_usage').select('requests, input_tokens, output_tokens, cost_usd').eq('user_id', uid).eq('day', day).maybeSingle(),
      );
      return r ? ({ day, requests: Number(r.requests), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), costUsd: r.cost_usd == null ? null : Number(r.cost_usd) } satisfies UsageRow) : null;
    },
    async getAccountState(uid) {
      const r = await run<{ payload: AccountStatePayload } | null>(
        user.from('account_state').select('payload').eq('owner_id', uid).is('deleted_at', null).maybeSingle(),
      );
      return r?.payload ?? null;
    },
    async getActiveProgram(uid) {
      const rows = await run<{ id: string; payload: ActiveProgramRow['payload'] }[]>(
        user.from('programs').select('id, payload').eq('owner_id', uid).eq('active', true).is('deleted_at', null)
          .order('updated_at', { ascending: false }).limit(1),
      );
      return rows?.[0] ? { id: rows[0].id, payload: rows[0].payload } : null;
    },
    async getRecentSessions(uid, limit) {
      return payloads(await run<{ payload: SessionPayload }[]>(
        user.from('workout_sessions').select('payload').eq('owner_id', uid).eq('status', 'completed').is('deleted_at', null)
          .order('session_date', { ascending: false }).order('started_at', { ascending: false }).limit(Math.min(50, limit)),
      ));
    },
    async getGoals(uid) {
      return payloads(await run<{ payload: GoalPayload }[]>(
        user.from('goals').select('payload').eq('owner_id', uid).is('deleted_at', null).order('updated_at', { ascending: false }).limit(10),
      ));
    },
    async getBodyweight(uid, sinceDate) {
      return payloads(await run<{ payload: MeasurementPayload }[]>(
        user.from('measurements').select('payload').eq('owner_id', uid).eq('kind', 'bodyweight').is('deleted_at', null)
          .gte('measured_on', sinceDate).order('measured_on', { ascending: true }).limit(200),
      ));
    },
    async getFoodLogs(uid, sinceDate) {
      return payloads(await run<{ payload: FoodLogPayload }[]>(
        user.from('food_logs').select('payload').eq('owner_id', uid).is('deleted_at', null).gte('log_date', sinceDate).limit(500),
      ));
    },
    async getHistory(uid, after, limit) {
      let q = user.from('ai_messages').select('id, role, content, created_at, proposal_id').eq('user_id', uid);
      if (after) q = q.gt('created_at', after);
      const rows = await run<{ id: string; role: 'user' | 'assistant'; content: string; created_at: string; proposal_id: string | null }[]>(
        q.order('seq', { ascending: false }).limit(Math.min(50, limit)),
      );
      return (rows ?? []).reverse().map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: r.created_at, proposalId: r.proposal_id }) satisfies StoredMessage);
    },
    async recordExchange(uid, input) {
      const r = await run<StoredExchange>(admin.rpc('ai_record_exchange', {
        p_user: uid,
        p_message: input.message,
        p_reply: input.reply,
        p_proposal: input.proposal,
        p_usage: input.usage,
      }));
      if (!r) throw new DbError('Could not store the reply.');
      return r;
    },
    getExercises() {
      return cachedRef<RefExercise>('ex', async () =>
        ((await run<{ data: RefExercise }[]>(user.from('ref_exercises').select('data').limit(2000))) ?? []).map((r) => r.data));
    },
    getRecipes() {
      return cachedRef<RefRecipe>('rec', async () =>
        ((await run<{ data: RefRecipe }[]>(user.from('ref_recipes').select('data').limit(2000))) ?? []).map((r) => r.data));
    },
    getIngredients() {
      return cachedRef<RefIngredient>('ing', async () =>
        ((await run<{ data: RefIngredient }[]>(user.from('ref_ingredients').select('data').limit(5000))) ?? []).map((r) => r.data));
    },
  };
}
