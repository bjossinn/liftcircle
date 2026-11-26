/**
 * Privacy-first product analytics: a small, offline-first queue of allowlisted events (src/analytics/events.ts).
 *
 * - Recording never throws, never blocks logging and never shows anything in the UI.
 * - Events live in the ACCOUNT-SCOPED database (db.kv), bounded to MAX_QUEUE, and are only sent with that same
 *   account's session (like pending posts). Guest and demo databases record nothing: there is no account to send for.
 * - Settings → Sharing & privacy → "Share product usage events" (settings.analytics, default on). Off: nothing is
 *   recorded, and anything still queued is deleted instead of sent.
 * - One-time milestones (EVENT_SCHEMA[..].once) are deduplicated on the device and by a unique index on the server.
 * - Transport is the log_product_events RPC. If the migration isn't applied yet, the device is offline, the session
 *   expired or the server errors, events simply stay queued (with backoff) and nothing is reported.
 */
import { useEffect } from 'react';
import { ACCOUNT_ROW_ID, type LiftDb } from '@/db/db';
import { backendConfigured, supabase } from '@/backend/supabase';
import { uuid } from '@/lib/id';
import type { Settings, WorkoutSession } from '@/domain/types';
import { useApp } from '@/state/app';
import { EVENT_SCHEMA, ONCE_EVENTS, sanitizeEvent, type AiActionType, type AiOutcome, type EventName, type EventProps, type WorkoutStartSource } from './events';

export const QUEUE_KEY = 'analytics:queue';
export const DONE_KEY = 'analytics:milestones';
export const MAX_QUEUE = 200;
export const BATCH_SIZE = 50;
const DAY = 86_400_000;

export interface QueuedEvent {
  id: string;
  name: EventName;
  props: Record<string, string>;
  /** Epoch ms when it happened. */
  at: number;
}
/** What goes over the wire: exactly these four fields. */
export interface WireEvent {
  id: string;
  name: EventName;
  props: Record<string, string>;
  occurred_at: string;
}

/** Settings → "Share product usage events". Undefined (older accounts) means on. */
export const analyticsEnabled = (s: Pick<Settings, 'analytics'> | undefined | null) => s?.analytics !== false;

async function enabledFor(db: LiftDb): Promise<boolean> {
  if (db.isGuest) return false;
  const a = await db.account.get(ACCOUNT_ROW_ID);
  return analyticsEnabled(a?.settings);
}

const readQueue = async (db: LiftDb) => {
  const v = (await db.kv.get(QUEUE_KEY))?.value;
  return Array.isArray(v) ? (v as QueuedEvent[]) : [];
};
const readDone = async (db: LiftDb) => {
  const v = (await db.kv.get(DONE_KEY))?.value;
  return Array.isArray(v) ? (v as string[]) : [];
};

/* ============================================================ recording */

/**
 * Record one event. Returns true when it was queued. Unknown names, non-allowlisted properties and repeated one-time
 * milestones are dropped silently. Never throws.
 */
export async function track<N extends EventName>(db: LiftDb, name: N, props?: EventProps<N>): Promise<boolean> {
  try {
    if (!(await enabledFor(db))) return false;
    const clean = sanitizeEvent(name, props);
    if (!clean) return false;
    let queued = false;
    await db.transaction('rw', db.kv, async () => {
      if (EVENT_SCHEMA[clean.name].once) {
        const done = await readDone(db);
        if (done.includes(clean.name)) return;
        await db.kv.put({ key: DONE_KEY, value: [...done, clean.name] });
      }
      const q = await readQueue(db);
      q.push({ id: uuid(), name: clean.name, props: clean.props, at: Date.now() });
      await db.kv.put({ key: QUEUE_KEY, value: q.slice(-MAX_QUEUE) });
      queued = true;
    });
    if (queued) scheduleFlush(db);
    return queued;
  } catch {
    return false;
  }
}

/** Remember that a one-time milestone already happened (e.g. before analytics existed) without recording it. */
async function markDone(db: LiftDb, name: EventName) {
  try {
    await db.transaction('rw', db.kv, async () => {
      const done = await readDone(db);
      if (!done.includes(name)) await db.kv.put({ key: DONE_KEY, value: [...done, name] });
    });
  } catch {
    /* best effort */
  }
}
const isDone = async (db: LiftDb, name: EventName) => {
  try {
    return (await readDone(db)).includes(name);
  } catch {
    return true;
  }
};

/** Delete everything queued and not yet sent (opt-out). */
export async function clearAnalyticsQueue(db: LiftDb): Promise<void> {
  try {
    await db.kv.delete(QUEUE_KEY);
  } catch {
    /* ignore */
  }
}

/* ============================================================ milestones (derived from local records only) */

const workingSets = (s: WorkoutSession) => s.exercises.reduce((n, e) => n + e.sets.filter((x) => x.completed && x.type !== 'warmup').length, 0);

/**
 * After a set was ticked in the logger: `first_set_logged` when the account has no finished workout with a working
 * set yet (so this is its first workout's first set). Reads only counts; nothing about the set itself is recorded.
 */
export async function trackSetLogged(db: LiftDb): Promise<void> {
  try {
    if (db.isGuest || (await isDone(db, 'first_set_logged'))) return;
    const sessions = (await db.sessions.toArray()).filter((s) => !s.deletedAt);
    // Any finished workout with a working set means this account logged sets before: not a first.
    if (sessions.some((s) => s.status === 'completed' && workingSets(s) > 0)) return void (await markDone(db, 'first_set_logged'));
    if (sessions.some((s) => workingSets(s) > 0)) await track(db, 'first_set_logged');
  } catch {
    /* never surfaces */
  }
}

const endOf = (s: WorkoutSession) => s.endedAt ?? s.startedAt;

/**
 * After a workout was stored as completed: `first_workout_completed` for the account's first finished workout, and
 * `second_workout_within_7d` when the second finished workout ends within 7 days of the first. Accounts that already
 * had workouts before this existed never get a late "first" event.
 */
export async function trackWorkoutCompleted(db: LiftDb, sessionId: string): Promise<void> {
  try {
    if (db.isGuest) return;
    const done = (await db.sessions.where('status').equals('completed').toArray()).filter((s) => !s.deletedAt).sort((a, b) => endOf(a) - endOf(b));
    const idx = done.findIndex((s) => s.id === sessionId);
    if (idx < 0) return;
    if (done.length === 1) await track(db, 'first_workout_completed');
    else await markDone(db, 'first_workout_completed');
    if (done.length === 2 && idx === 1 && endOf(done[1]) - endOf(done[0]) <= 7 * DAY) await track(db, 'second_workout_within_7d');
    else if (done.length >= 2) await markDone(db, 'second_workout_within_7d');
  } catch {
    /* never surfaces */
  }
}

export const trackWorkoutStarted = (db: LiftDb, source: WorkoutStartSource) => track(db, 'workout_started', { source });
export const trackAiAction = (db: LiftDb, action_type: AiActionType, outcome: AiOutcome) => track(db, 'ai_action_used', { action_type, outcome });
export const trackOnboardingCompleted = (db: LiftDb, path: 'suggested' | 'manual') => track(db, 'onboarding_completed', { path });

/* ============================================================ transport */

export type Transport = (events: WireEvent[]) => Promise<void>;

/** The server reports the RPC isn't there (migration not applied) or the table is missing. */
export function isMissingBackend(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  const status = (e as { status?: unknown })?.status;
  const msg = String((e as { message?: unknown })?.message ?? '');
  return code === 'PGRST202' || code === '42883' || code === '42P01' || status === 404 || /could not find the function|does not exist/i.test(msg);
}

const defaultTransport: Transport = async (events) => {
  const sb = supabase();
  if (!sb) throw Object.assign(new Error('backend missing'), { code: 'PGRST202' });
  const { error } = await sb.rpc('log_product_events', { p_events: events });
  if (error) throw error;
};
let transport: Transport = defaultTransport;
/** Tests only. Pass null to restore the Supabase RPC. */
export function setAnalyticsTransport(t: Transport | null) {
  transport = t ?? defaultTransport;
}

let gateAccount: string | null = null;
/** Which account is signed in with a valid session (null otherwise). Events are only sent for that account's db. */
export function setAnalyticsAccount(accountId: string | null) {
  gateAccount = accountId;
}

let retryAt = 0;
let failures = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Tests only. */
export function resetAnalyticsState() {
  retryAt = 0;
  failures = 0;
  gateAccount = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

function scheduleFlush(db: LiftDb, ms = 3000) {
  if (timer || gateAccount !== db.accountKey) return;
  timer = setTimeout(() => {
    timer = null;
    void flushAnalytics(db);
  }, ms);
}

/** Send queued events in batches. Never throws; concurrent calls share one run. */
export function flushAnalytics(db: LiftDb): Promise<void> {
  if (!flushing) {
    flushing = flushOnce(db)
      .catch(() => undefined)
      .finally(() => {
        flushing = null;
      });
  }
  return flushing;
}

async function flushOnce(db: LiftDb) {
  if (db.isGuest || !gateAccount || gateAccount !== db.accountKey) return;
  if (!(await enabledFor(db))) return clearAnalyticsQueue(db);
  if (transport === defaultTransport && !backendConfigured) return;
  if (!isOnline() || Date.now() < retryAt) return;
  for (let round = 0; round < MAX_QUEUE / BATCH_SIZE; round++) {
    const queue = await readQueue(db);
    if (!queue.length) return;
    const batch = queue.slice(0, BATCH_SIZE);
    // Re-check every stored event at the boundary (storage could hold anything): only clean events are sent.
    const wire: WireEvent[] = [];
    for (const e of batch) {
      const clean = sanitizeEvent(e?.name, e?.props);
      if (clean && typeof e.id === 'string' && Number.isFinite(e.at)) wire.push({ id: e.id, name: clean.name, props: clean.props, occurred_at: new Date(e.at).toISOString() });
    }
    try {
      if (wire.length) await transport(wire);
    } catch (e) {
      failures++;
      // Missing migration: wait a long time. Anything else (5xx, network, expired session): exponential backoff.
      retryAt = Date.now() + (isMissingBackend(e) ? 6 * 60 * 60_000 : Math.min(30 * 60_000, 30_000 * 2 ** (failures - 1)));
      return;
    }
    failures = 0;
    const sent = new Set(batch.map((e) => e?.id));
    await db.transaction('rw', db.kv, async () => {
      const q = await readQueue(db);
      await db.kv.put({ key: QUEUE_KEY, value: q.filter((e) => !sent.has(e?.id)) });
    });
  }
}

/* ============================================================ runner */

/** Keeps the queue moving: on sign-in, when coming back online and when the app becomes visible. */
export function AnalyticsRunner(): null {
  const { db, auth, online } = useApp();
  const account = auth.status === 'signed_in' && auth.userId ? auth.userId : null;
  useEffect(() => {
    setAnalyticsAccount(account);
    if (account && account === db.accountKey && online) void flushAnalytics(db);
  }, [db, account, online]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && void flushAnalytics(db);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [db]);
  return null;
}

export { ONCE_EVENTS };
