/**
 * push-send core (pure; the database and the push transport are injected so it's testable with mocks).
 *
 *  1. Claim due jobs (SQL: FOR UPDATE SKIP LOCKED + claimed_at, so overlapping runs never double-send).
 *  2. Quiet hours in the user's time zone defer a job to the end of the quiet window — except rest-over alerts
 *     (they only exist during an active workout) and test pushes (the user just asked for one).
 *  3. Send to every device of the user. 404/410 delete that subscription; other failures increment failed_count.
 *  4. Report: sent / deferred / retry (transient failure; cancelled after 5 attempts) / dropped (no device left).
 *  5. Clean up sent/cancelled jobs older than 7 days.
 * Bounded: batches of `batch` jobs, stops after `budgetMs` or `maxBatches`.
 */
import type { PushSubscriptionKeys, SendOptions } from './webpush.ts';

export type PushKind = 'workout_reminder' | 'rest_over' | 'coaching' | 'social' | 'missed_nudge' | 'test';
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}
export interface PushPrefsRow {
  kinds?: string[];
  timeZone?: string;
  quietStart?: string;
  quietEnd?: string;
}
export interface DueJob {
  id: string;
  userId: string;
  kind: PushKind;
  fireAt: string;
  payload: PushPayload;
  attempts: number;
  prefs: PushPrefsRow | null;
  subscriptions: PushSubscriptionKeys[];
}
export type JobResult = { id: string; status: 'sent' | 'retry' | 'dropped' } | { id: string; status: 'deferred'; fireAt: string };

export interface PushDb {
  claimDue(limit: number): Promise<DueJob[]>;
  finish(results: JobResult[]): Promise<void>;
  subscriptionResult(endpoint: string, status: number): Promise<void>;
  cleanup(): Promise<number>;
}
export interface PushDeps {
  db: PushDb;
  /** Returns the push service HTTP status; throw/0 for network errors. */
  send: (sub: PushSubscriptionKeys, payload: string, opts: SendOptions) => Promise<number>;
  now: () => Date;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/* ------------------------------------------------------------------ caller check */
/** push-send is only for the cron job: the x-push-secret header must equal PUSH_CRON_SECRET (constant-time compare). */
export function authorizePush(given: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || !given || given.length !== secret.length) return false;
  let r = 0;
  for (let i = 0; i < secret.length; i++) r |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return r === 0;
}

/* ------------------------------------------------------------------ time zone helpers */
function tzParts(ms: number, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function safeZone(tz: string | undefined): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC' });
    return tz || 'UTC';
  } catch {
    return 'UTC';
  }
}
/** Offset (ms) of `timeZone` from UTC at instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const p = tzParts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** The UTC instant of local wall-clock `date` (YYYY-MM-DD) + `hhmm` in `timeZone` (DST-aware). */
export function zonedToUtc(date: string, hhmm: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetAt(guess, timeZone);
  t = guess - offsetAt(t, timeZone);
  return new Date(t);
}
const toMin = (hhmm: string | undefined, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
  return m ? (+m[1] % 24) * 60 + +m[2] : fallback;
};

/** If `now` is inside the user's quiet hours, the instant they end; otherwise null. */
export function quietUntil(now: Date, prefs: PushPrefsRow | null): Date | null {
  const tz = safeZone(prefs?.timeZone);
  const start = toMin(prefs?.quietStart, 22 * 60);
  const end = toMin(prefs?.quietEnd, 7 * 60);
  if (start === end) return null;
  const p = tzParts(now.getTime(), tz);
  const m = p.h * 60 + p.mi;
  const inQuiet = start > end ? m >= start || m < end : m >= start && m < end;
  if (!inQuiet) return null;
  const today = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  const endStr = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  let at = zonedToUtc(today, endStr, tz);
  if (at.getTime() <= now.getTime()) {
    const next = new Date(Date.UTC(p.y, p.mo - 1, p.d) + 86_400_000).toISOString().slice(0, 10);
    at = zonedToUtc(next, endStr, tz);
  }
  return at;
}

const QUIET_EXEMPT: PushKind[] = ['rest_over', 'test'];

export function sendOptionsFor(job: DueJob): SendOptions {
  const topic = job.payload.tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined;
  switch (job.kind) {
    case 'rest_over':
      return { ttl: 300, urgency: 'high', topic };
    case 'test':
      return { ttl: 600, urgency: 'normal', topic };
    case 'workout_reminder':
    case 'missed_nudge':
      return { ttl: 3 * 3600, urgency: 'normal', topic };
    default:
      return { ttl: 24 * 3600, urgency: 'normal', topic };
  }
}

export async function processJob(deps: PushDeps, job: DueJob): Promise<JobResult> {
  const now = deps.now();
  if (!QUIET_EXEMPT.includes(job.kind)) {
    const until = quietUntil(now, job.prefs);
    if (until) return { id: job.id, status: 'deferred', fireAt: until.toISOString() };
  }
  if (!job.subscriptions.length) return { id: job.id, status: 'dropped' };
  // Every push shows a notification (iOS revokes permission for silent pushes): title is always present.
  const payload = JSON.stringify({ title: job.payload.title || 'Hard Earned', body: job.payload.body ?? '', url: job.payload.url || '/', tag: job.payload.tag || job.kind });
  let ok = 0;
  let gone = 0;
  for (const sub of job.subscriptions) {
    let status = 0;
    try {
      status = await deps.send(sub, payload, sendOptionsFor(job));
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) ok++;
    if (status === 404 || status === 410) gone++;
    if (status > 0) await deps.db.subscriptionResult(sub.endpoint, status);
  }
  if (ok > 0) return { id: job.id, status: 'sent' };
  if (gone === job.subscriptions.length) return { id: job.id, status: 'dropped' };
  return { id: job.id, status: 'retry' };
}

export async function runPushSend(deps: PushDeps, opts: { batch?: number; budgetMs?: number; maxBatches?: number } = {}) {
  const batch = opts.batch ?? 50;
  const budget = opts.budgetMs ?? 20_000;
  const maxBatches = opts.maxBatches ?? 10;
  const started = deps.now().getTime();
  const summary = { claimed: 0, sent: 0, deferred: 0, retry: 0, dropped: 0, cleaned: 0 };
  for (let b = 0; b < maxBatches && deps.now().getTime() - started < budget; b++) {
    const jobs = await deps.db.claimDue(batch);
    if (!jobs.length) break;
    summary.claimed += jobs.length;
    const results: JobResult[] = [];
    for (const job of jobs) {
      const r = await processJob(deps, job);
      results.push(r);
      summary[r.status]++;
    }
    await deps.db.finish(results);
    if (jobs.length < batch) break;
  }
  summary.cleaned = await deps.db.cleanup();
  deps.log?.('push_send', summary);
  return summary;
}
