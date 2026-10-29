/**
 * Supabase implementation of SyncRemote (see contract.ts and supabase/migrations/*_private_records.sql).
 * The server is the authority for versions: sync_push is an atomic compare-and-swap on the
 * server-issued version; sync_pull returns changes with version > cursor in ascending order.
 */
import type { PullChange, PullResult, PushResult, SyncRemote } from './contract';
import { requireSupabase } from './supabase';
import { ACCOUNT_ROW_ID, type SyncedEntity } from '@/db/db';

/** Error with the backend's code/status attached so callers can tell auth/network/validation apart. */
export class BackendError extends Error {
  constructor(
    message: string,
    /** Postgres SQLSTATE / PostgREST code (e.g. 'PT429', '42501', 'PGRST301') or 'network' / 'auth'. */
    readonly code?: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BackendError';
  }
  /** Authentication is missing/expired → pause sync, never discard local data. */
  get isAuth() {
    return this.code === 'auth' || this.status === 401 || this.code === 'PGRST301' || this.code === 'PGRST302';
  }
  get isNetwork() {
    return this.code === 'network';
  }
  get isRateLimited() {
    return this.code === 'PT429' || this.status === 429;
  }
}

interface PgLikeError {
  message?: string;
  code?: string;
  details?: unknown;
  hint?: string | null;
  status?: number;
  name?: string;
}

/** Normalize Supabase/PostgREST/fetch errors into a BackendError with a user-readable message. */
export function toBackendError(e: unknown, fallback = 'Something went wrong. Please try again.'): BackendError {
  if (e instanceof BackendError) return e;
  const err = (e ?? {}) as PgLikeError;
  const msg = String(err.message ?? '');
  if (err.name === 'AbortError') return new BackendError('Cancelled.', 'aborted');
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(msg)) {
    return new BackendError('You appear to be offline. Check your connection and try again.', 'network');
  }
  if (/jwt expired|invalid jwt|jwt.*(malformed|invalid)|not authenticated|session.*(expired|missing)/i.test(msg) ||
      err.code === 'PGRST301' || err.code === 'PGRST302') {
    return new BackendError('Your session has expired. Please sign in again.', 'auth', 401);
  }
  if (err.code === '42501') {
    return new BackendError(/^permission denied/i.test(msg) ? 'You don’t have permission to do that.' : msg || fallback, '42501', 403);
  }
  if (err.code === 'PGRST202') {
    return new BackendError('The server is missing a required update. Please try again later.', err.code, 404);
  }
  // Our RPCs raise user-readable messages (P0001 validation, PT429 rate limit, 22023 bad input).
  if (msg && (err.code === 'P0001' || err.code === 'PT429' || err.code === '22023')) {
    return new BackendError(msg, err.code, err.code === 'PT429' ? 429 : 400, err.details);
  }
  return new BackendError(msg || fallback, err.code, err.status, err.details);
}

/** sync_push needs a uuid; the account_state row is keyed by the account on the server. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function remoteId(entity: SyncedEntity, id: string): string {
  if (entity === 'account_state') return NIL_UUID; // server uses auth.uid()
  if (!UUID_RE.test(id)) throw new BackendError(`Record id "${id}" is not a UUID and cannot be synced.`, '22023', 400);
  return id;
}

interface RawPush {
  status: 'ok' | 'conflict' | 'gone';
  version: number | string;
  payload?: unknown;
  deleted?: boolean;
}

interface RawPull {
  changes: { entity: SyncedEntity; id: string; version: number | string; deleted: boolean; payload: unknown | null }[];
  cursor: number | string;
  hasMore: boolean;
}

export const syncRemote: SyncRemote = {
  async push(entity, id, op, baseVersion, payload): Promise<PushResult> {
    const sb = requireSupabase();
    let res: { data: unknown; error: unknown };
    try {
      res = await sb.rpc('sync_push', {
        p_entity: entity,
        p_id: remoteId(entity, id),
        p_op: op,
        p_base_version: baseVersion ?? null,
        p_payload: op === 'delete' && payload === undefined ? null : (payload ?? null),
      });
    } catch (e) {
      throw toBackendError(e);
    }
    if (res.error) throw toBackendError(res.error, 'Could not sync this change.');
    const r = res.data as RawPush;
    const version = Number(r.version);
    switch (r.status) {
      case 'ok':
        return { status: 'ok', version };
      case 'gone':
        return { status: 'gone', version };
      case 'conflict':
        return { status: 'conflict', version, payload: r.payload, deleted: Boolean(r.deleted) };
      default:
        throw new BackendError('Unexpected sync response from the server.');
    }
  },

  async pull(since, limit = 500): Promise<PullResult> {
    const sb = requireSupabase();
    let res: { data: unknown; error: unknown };
    try {
      res = await sb.rpc('sync_pull', { p_since: since, p_limit: limit });
    } catch (e) {
      throw toBackendError(e);
    }
    if (res.error) throw toBackendError(res.error, 'Could not download changes.');
    const r = res.data as RawPull;
    const changes: PullChange[] = (r.changes ?? []).map((c) => ({
      entity: c.entity,
      // The single account_state row is stored under the account id server-side; locally it is 'account'.
      id: c.entity === 'account_state' ? ACCOUNT_ROW_ID : c.id,
      version: Number(c.version),
      deleted: Boolean(c.deleted),
      payload: c.deleted ? null : c.payload,
    }));
    return { changes, cursor: Number(r.cursor), hasMore: Boolean(r.hasMore) };
  },
};
