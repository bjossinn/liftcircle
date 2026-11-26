/**
 * push-send core (pure; the database, the push transport and the copy model are injected so it's testable with mocks).
 *
 *  1. Generate server-owned candidates (food-log reminders), then claim due jobs (SQL: FOR UPDATE SKIP LOCKED, a claim
 *     token and a 2-minute lease per attempt, so overlapping runs never double-send and only the token holder settles).
 *  2. Rest alerts, tests, coaching and social pushes are processed and settled first, before any model call, so a slow
 *     copy model never delays them. Each job checks the remaining time budget; jobs that no longer fit are released.
 *  3. Quiet hours in the user's time zone defer a job to the end of the quiet window — except rest-over alerts (they
 *     only exist during an active workout) and test pushes (the user just asked for one). Equal start/end = no quiet
 *     hours. A coach reminder whose deferral would leave its own local day is discarded instead (no catch-up).
 *  4. Coach reminders (workout, missed workout, food log): push_check 'prepare' (preferences, pause, expiry, source
 *     state, demo accounts, daily quota reservation) → body copy (copy.ts: AI when allowed, else the approved fallback;
 *     one attempt) → push_check 'dispatch' (everything again; language/consent changes switch to the current-language
 *     fallback) → send. An outcome that might have reached the device (network error/timeout) is 'ambiguous': it
 *     consumes the reservation and is never re-sent (Web Push can't give exactly-once delivery across this boundary).
 *  5. Send to every device of the user. 404/410 delete that subscription; other failures increment failed_count.
 *  6. Clean up sent/cancelled jobs older than 7 days. Logs are counts only, never notification text.
 */
import type { PushSubscriptionKeys, SendOptions } from './webpush.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { aiCopyAllowed, aiCopyEnabled, COACH_TAG, COACH_URL, finalizeCopy, isCoachKind, writeCopy, type CopyAiSettings, type CopyDeps, type CoachKind, type FinalCopy } from './copy.ts';
// @ts-ignore see above
import { resolveProvider } from '../ai/provider.ts';

export type PushKind = 'workout_reminder' | 'rest_over' | 'coaching' | 'social' | 'missed_nudge' | 'food_unlogged' | 'test';
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
  dailyCap?: number;
  snoozeUntil?: string | null;
  revision?: number;
}
export interface CachedCopy {
  body: string;
  language: string;
  source: string;
}
export interface DueJob {
  id: string;
  userId: string;
  kind: PushKind;
  fireAt: string;
  payload: PushPayload;
  attempts: number;
  /** Claim (attempt) token; required to check or settle the job. Absent only from pre-phase-1 databases. */
  token?: string;
  eventDate?: string | null;
  /** End of the event's local day: a coach reminder is never sent or deferred past it. */
  expiresAt?: string | null;
  copy?: CachedCopy | null;
  prefs: PushPrefsRow | null;
  subscriptions: PushSubscriptionKeys[];
}
type Settle = { id: string; token?: string };
export type JobResult =
  | (Settle & { status: 'sent' | 'ambiguous' | 'retry'; copy?: CachedCopy })
  | (Settle & { status: 'dropped' | 'release' })
  | (Settle & { status: 'discarded'; reason: string })
  | (Settle & { status: 'deferred'; fireAt: string })
  /** Already settled by push_check (discarded) or the claim was lost: nothing to report. */
  | (Settle & { status: 'skipped'; reason: string });

export type CheckResult =
  /** copyAttempted: an earlier attempt of this event already passed 'prepare' (it may have called the model). */
  | { status: 'ok'; language?: string; revision?: number; ai?: CopyAiSettings | null; copyAttempted?: boolean }
  /** Current quiet hours: the server already rescheduled the job inside its local day. */
  | { status: 'deferred'; fireAt?: string }
  | { status: 'discard'; reason?: string }
  | { status: 'lost' };

export interface PushDb {
  claimDue(limit: number): Promise<DueJob[]>;
  finish(results: JobResult[]): Promise<void>;
  subscriptionResult(endpoint: string, status: number): Promise<void>;
  cleanup(): Promise<number>;
  /**
   * push_check (phase 1). `copy` is stored on the job under the claim before the check runs, so a retry reuses it.
   * Without it coach reminders are released untouched (old database).
   */
  check?(id: string, token: string, stage: 'prepare' | 'dispatch', copy?: CachedCopy | null): Promise<CheckResult>;
  /** push_generate_food (phase 1). */
  generate?(): Promise<number>;
}
export interface PushDeps {
  db: PushDb;
  /** Returns the push service HTTP status; throw/0 for network errors. */
  send: (sub: PushSubscriptionKeys, payload: string, opts: SendOptions) => Promise<number>;
  now: () => Date;
  /** Copy model access (env + fetch). Without it coach reminders use the approved fallback text. */
  copy?: CopyDeps;
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

/** If `now` is inside the user's quiet hours, the instant they end; otherwise null. Equal start and end = off. */
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
    case 'food_unlogged': {
      // Never deliverable after the reminder's own local day.
      const left = job.expiresAt ? Math.floor((Date.parse(job.expiresAt) - Date.now()) / 1000) : 3 * 3600;
      return { ttl: Math.max(60, Math.min(3 * 3600, Number.isFinite(left) ? left : 3 * 3600)), urgency: 'normal', topic };
    }
    default:
      return { ttl: 24 * 3600, urgency: 'normal', topic };
  }
}

/* ------------------------------------------------------------------ delivery */
type Delivery = 'sent' | 'gone' | 'ambiguous' | 'failed';
async function deliver(deps: PushDeps, job: DueJob, payload: PushPayload): Promise<Delivery> {
  const body = JSON.stringify({ title: payload.title || 'Hard Earned', body: payload.body ?? '', url: payload.url || '/', tag: payload.tag || job.kind });
  let ok = 0;
  let gone = 0;
  let unknown = 0;
  for (const sub of job.subscriptions) {
    let status = 0;
    try {
      status = await deps.send(sub, body, sendOptionsFor(job));
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) ok++;
    if (status === 404 || status === 410) gone++;
    if (status === 0) unknown++;
    if (status > 0) await deps.db.subscriptionResult(sub.endpoint, status);
  }
  if (ok > 0) return 'sent';
  if (gone === job.subscriptions.length) return 'gone';
  return unknown > 0 ? 'ambiguous' : 'failed';
}

/** Rest alerts, tests, coaching and social pushes (unchanged rules; network errors are retried). */
export async function processJob(deps: PushDeps, job: DueJob): Promise<JobResult> {
  const now = deps.now();
  const base = { id: job.id, ...(job.token ? { token: job.token } : {}) };
  if (!QUIET_EXEMPT.includes(job.kind)) {
    const until = quietUntil(now, job.prefs);
    if (until) return { ...base, status: 'deferred', fireAt: until.toISOString() };
  }
  if (!job.subscriptions.length) return { ...base, status: 'dropped' };
  // Every push shows a notification (iOS revokes permission for silent pushes): title is always present.
  const d = await deliver(deps, job, job.payload);
  if (d === 'sent') return { ...base, status: 'sent' };
  if (d === 'gone') return { ...base, status: 'dropped' };
  return { ...base, status: 'retry' };
}

export interface CoachStats {
  modelCalls: number;
  aiCopy: number;
  fallbackCopy: number;
  inputTokens: number;
  outputTokens: number;
}
const asLang = (v: unknown): 'en' | 'is' => (v === 'is' ? 'is' : 'en');

/**
 * Coach reminders (workout, missed workout, food log). `budgetMs` is the worker time left for this job; the copy model
 * only gets what remains after a sending reserve.
 */
export async function processCoachJob(deps: PushDeps, job: DueJob, budgetMs: number, stats?: CoachStats): Promise<JobResult> {
  const kind = job.kind as CoachKind;
  const token = job.token;
  const dbCheck = deps.db.check?.bind(deps.db);
  if (!token || !dbCheck) return { id: job.id, ...(token ? { token } : {}), status: 'release' };
  // A failed check call settles nothing: the job is released (or, after 'dispatching', its lease ends as ambiguous).
  const check = (stage: 'prepare' | 'dispatch', copy?: CachedCopy | null): Promise<CheckResult | null> => dbCheck(job.id, token, stage, copy ?? null).catch(() => null);
  const base = { id: job.id, token };
  const expires = job.expiresAt ? Date.parse(job.expiresAt) : NaN;
  const notOk = (r: Exclude<CheckResult, { status: 'ok' }>): JobResult =>
    ({ ...base, status: 'skipped', reason: r.status === 'discard' ? r.reason ?? 'discard' : r.status });

  // Cheap pre-check with the settings captured at claim time; the server re-checks quiet hours with the current
  // settings at both stages (push_check), so a window starting mid-generation or changed meanwhile still applies.
  const now0 = deps.now();
  if (Number.isFinite(expires) && now0.getTime() >= expires) return { ...base, status: 'discarded', reason: 'expired' };
  const until = quietUntil(now0, job.prefs);
  if (until) {
    // Deferral must stay within the event's own local day; otherwise the reminder is dropped (no catch-up).
    if (Number.isFinite(expires) && until.getTime() >= expires) return { ...base, status: 'discarded', reason: 'quiet_hours' };
    return { ...base, status: 'deferred', fireAt: until.toISOString() };
  }
  if (!job.subscriptions.length) return { ...base, status: 'dropped' };

  const started = deps.now().getTime();
  const prep = await check('prepare');
  if (!prep) return { ...base, status: 'release' };
  if (prep.status !== 'ok') return notOk(prep);
  const language = asLang(prep.language);
  // The deployment flag gates generated wording everywhere: new text, cached text and the final dispatch.
  const flagOn = !!deps.copy && aiCopyEnabled(deps.copy.env);
  const provider = flagOn && deps.copy ? resolveProvider(deps.copy.env)?.provider ?? null : null;
  const allowed = (ai: CopyAiSettings | null | undefined) => flagOn && aiCopyAllowed(kind, ai ?? null, provider);

  // One generation attempt per event: once an attempt stored copy on the job, it is reused (or replaced by the
  // fallback in the current language), never regenerated. 'prepare' commits an attempt marker before any model call,
  // so an attempt that was interrupted before its copy was saved (crash, failed RPC) is followed by the fallback.
  let copy: FinalCopy;
  if (job.copy && (job.copy.source === 'fallback' || job.copy.source === 'ai')) {
    copy = finalizeCopy(kind, job.copy, language, allowed(prep.ai));
  } else if (prep.copyAttempted) {
    copy = finalizeCopy(kind, null, language, false);
  } else if (deps.copy && flagOn) {
    const remaining = budgetMs - (deps.now().getTime() - started) - 2000; // keep time to send and settle
    const r = await writeCopy(deps.copy, kind, language, prep.ai ?? null, remaining);
    if (stats) {
      if (r.modelCalled) stats.modelCalls++;
      stats.inputTokens += r.usage?.inputTokens ?? 0;
      stats.outputTokens += r.usage?.outputTokens ?? 0;
    }
    copy = r;
  } else {
    copy = finalizeCopy(kind, null, language, false);
  }
  const attempt: CachedCopy = { body: copy.body, language: copy.language, source: copy.source };

  // Final check right before sending (stores the attempt's copy first): preferences, pause, quiet hours, cap,
  // consent, language and source state may all have changed.
  const fin = await check('dispatch', attempt);
  if (!fin) return { ...base, status: 'release' };
  if (fin.status !== 'ok') return notOk(fin);
  const finalCopy = finalizeCopy(kind, copy, asLang(fin.language), allowed(fin.ai));
  if (stats) finalCopy.source === 'ai' ? stats.aiCopy++ : stats.fallbackCopy++;
  const cached: CachedCopy = { body: finalCopy.body, language: finalCopy.language, source: finalCopy.source };

  const d = await deliver(deps, job, { title: finalCopy.title, body: finalCopy.body, url: COACH_URL[kind], tag: COACH_TAG[kind] });
  if (d === 'sent') return { ...base, status: 'sent', copy: cached };
  if (d === 'gone') return { ...base, status: 'dropped' };
  if (d === 'ambiguous') return { ...base, status: 'ambiguous', copy: cached };
  return { ...base, status: 'retry', copy: cached };
}

export async function runPushSend(deps: PushDeps, opts: { batch?: number; budgetMs?: number; maxBatches?: number } = {}) {
  const batch = opts.batch ?? 50;
  const budget = opts.budgetMs ?? 20_000;
  const maxBatches = opts.maxBatches ?? 10;
  const started = deps.now().getTime();
  const left = () => budget - (deps.now().getTime() - started);
  const summary = { claimed: 0, sent: 0, deferred: 0, retry: 0, dropped: 0, ambiguous: 0, discarded: 0, released: 0, skipped: 0, generated: 0, cleaned: 0 };
  const stats: CoachStats = { modelCalls: 0, aiCopy: 0, fallbackCopy: 0, inputTokens: 0, outputTokens: 0 };
  const count = (r: JobResult) => {
    const key = r.status === 'release' ? 'released' : r.status;
    summary[key]++;
  };
  if (deps.db.generate) {
    try {
      summary.generated = await deps.db.generate();
    } catch {
      // Older database without food reminders: everything else still runs.
    }
  }
  for (let b = 0; b < maxBatches && left() > 0; b++) {
    const jobs = await deps.db.claimDue(batch);
    if (!jobs.length) break;
    summary.claimed += jobs.length;
    // 1) Everything that isn't a coach reminder goes out first and is settled before any model call.
    const quick: JobResult[] = [];
    for (const job of jobs.filter((j) => !isCoachKind(j.kind))) {
      const r = left() > 0 ? await processJob(deps, job) : { id: job.id, ...(job.token ? { token: job.token } : {}), status: 'release' as const };
      quick.push(r);
      count(r);
    }
    if (quick.length) await deps.db.finish(quick);
    // 2) Coach reminders, each with the time that is actually left.
    const coach: JobResult[] = [];
    for (const job of jobs.filter((j) => isCoachKind(j.kind))) {
      const remaining = left();
      const r: JobResult = remaining > 0 ? await processCoachJob(deps, job, remaining, stats) : { id: job.id, ...(job.token ? { token: job.token } : {}), status: 'release' };
      count(r);
      if (r.status !== 'skipped') coach.push(r);
    }
    if (coach.length) await deps.db.finish(coach);
    if (jobs.length < batch) break;
  }
  summary.cleaned = await deps.db.cleanup();
  deps.log?.('push_send', { ...summary, ...stats });
  return { ...summary, ...stats };
}
