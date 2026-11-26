/**
 * Roadmap item 5: privacy-first product analytics (src/analytics). Covers the allowlist boundary, the opt-out, guest
 * and demo mode, one-time milestones derived from local records, the offline queue and its transport, and that no
 * health/training data, chat content or PII can ever reach the queue or the wire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MIGRATION_SQL from '../../supabase/migrations/20261127000001_product_analytics.sql?raw';
// Roadmap item 7 re-defines private.analytics_props_ok (ai_action_used.action_type gains 'session_adjustment').
import SESSION_ADJUST_SQL from '../../supabase/migrations/20261128000001_ai_session_adjustment.sql?raw';
import { ACCOUNT_ROW_ID, LiftDb } from '@/db/db';
import { defaultAccountState } from '@/state/defaults';
import type { WorkoutSession } from '@/domain/types';
import { EVENT_NAMES, EVENT_SCHEMA, ONCE_EVENTS, sanitizeEvent } from '@/analytics/events';
import {
  BATCH_SIZE, DONE_KEY, MAX_QUEUE, QUEUE_KEY, analyticsEnabled, clearAnalyticsQueue, flushAnalytics, isMissingBackend, resetAnalyticsState,
  analyticsRetryAt, armAnalyticsRetry, setAnalyticsAccount, setAnalyticsTransport, track, trackAiAction, trackSetLogged, trackWorkoutCompleted, trackWorkoutStarted, type QueuedEvent, type WireEvent,
} from '@/analytics/analytics';

let db: LiftDb;
let n = 0;
const sent: WireEvent[][] = [];
const queue = async (d = db) => ((await d.kv.get(QUEUE_KEY))?.value as QueuedEvent[] | undefined) ?? [];
const names = async (d = db) => (await queue(d)).map((e) => e.name);
const setOnline = (v: boolean) => vi.stubGlobal('navigator', { onLine: v });
const DAY = 86_400_000;

function session(id: string, over: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    id,
    createdAt: 0,
    updatedAt: 0,
    name: 'Heavy squat day: left knee sore',
    status: 'completed',
    date: '2026-11-20',
    timeZone: 'UTC',
    startedAt: Date.parse('2026-11-20T10:00:00Z'),
    endedAt: Date.parse('2026-11-20T11:00:00Z'),
    pausedTotalMs: 0,
    notes: 'Felt pain in my shoulder, 82.5 kg bodyweight',
    exercises: [
      {
        id: `${id}-e1`,
        exerciseId: 'barbell-back-squat',
        order: 0,
        notes: 'knee caved',
        discomfort: true,
        sets: [
          { id: `${id}-w`, type: 'warmup', weightKg: 60, reps: 5, completed: true },
          { id: `${id}-s1`, type: 'normal', weightKg: 142.5, reps: 5, rpe: 9, rir: 1, completed: true },
        ],
      },
    ],
    ...over,
  } as WorkoutSession;
}

beforeEach(() => {
  db = new LiftDb(`analytics-user-${++n}`);
  sent.length = 0;
  resetAnalyticsState();
  setAnalyticsTransport(async (events) => {
    sent.push(events);
  });
  setOnline(true);
});
afterEach(() => {
  resetAnalyticsState();
  setAnalyticsTransport(null);
  vi.unstubAllGlobals();
  db.close();
});

describe('allowlist boundary (sanitizeEvent)', () => {
  it('drops unknown event names', () => {
    for (const bad of ['chat_message_sent', 'weight_logged', 'body_measurement', '', null, 42, {}, '__proto__', 'toString']) expect(sanitizeEvent(bad)).toBeNull();
  });

  it('strips non-allowlisted keys and non-enum values, keeps allowlisted enums', () => {
    expect(sanitizeEvent('first_set_logged', { weightKg: 100, reps: 5, exercise: 'Bench press', notes: 'x', email: 'a@b.c' })).toEqual({ name: 'first_set_logged', props: {} });
    expect(sanitizeEvent('workout_started', { source: 'template', name: 'Upper A', durationSec: 3600 })).toEqual({ name: 'workout_started', props: { source: 'template' } });
    expect(sanitizeEvent('workout_started', { source: 'I squatted 140kg' })).toEqual({ name: 'workout_started', props: {} });
    expect(sanitizeEvent('workout_started', { source: ['template'] })).toEqual({ name: 'workout_started', props: {} });
    expect(sanitizeEvent('onboarding_completed', { path: 'manual', displayName: 'Jo' })).toEqual({ name: 'onboarding_completed', props: { path: 'manual' } });
  });

  it('ai_action_used needs both enums; message text never survives', () => {
    expect(sanitizeEvent('ai_action_used', { action_type: 'chat_message', outcome: 'sent', text: 'my knee hurts', reply: 'rest it' })).toEqual({
      name: 'ai_action_used',
      props: { action_type: 'chat_message', outcome: 'sent' },
    });
    expect(sanitizeEvent('ai_action_used', { action_type: 'chat_message' })).toBeNull();
    expect(sanitizeEvent('ai_action_used', { action_type: 'chat_message', outcome: 'my knee hurts' })).toBeNull();
    expect(sanitizeEvent('ai_action_used', { action_type: { toString: () => 'week_plan' }, outcome: 'applied' })).toBeNull();
  });

  it('ignores inherited / prototype keys', () => {
    const props = Object.create({ source: 'template' });
    expect(sanitizeEvent('workout_started', props)).toEqual({ name: 'workout_started', props: {} });
  });

  it('no allowlisted key or value names health data, chat content or PII', () => {
    const words = EVENT_NAMES.flatMap((n) => Object.entries(EVENT_SCHEMA[n].props as Record<string, readonly string[]>).flatMap(([k, vals]) => [k, ...vals]));
    // Token-level (snake_case parts), so an enum label like chat_message is fine but a `weight_kg` key is not.
    const forbidden = /^(weights?|kg|lbs?|reps?|rpe|rir|sets?|exercises?|measurements?|body|calories|kcal|protein|macros?|carbs?|fats?|injury|injuries|pain|discomfort|notes?|text|content|prompt|reply|body|email|name|username|phone|age|height|bmi)$/i;
    expect(words.filter((w) => w.split('_').some((t) => forbidden.test(t)))).toEqual([]);
    expect(words.every((w) => /^[a-z_0-9]{1,32}$/.test(w))).toBe(true);
  });

  it('matches the server allowlist in the migrations (names, keys, values, one-time milestones)', () => {
    const sql: string = MIGRATION_SQL;
    // The allowlist as finally defined: the latest migration that (re)creates analytics_props_ok wins, in full.
    const latest: string = SESSION_ADJUST_SQL;
    expect(latest).toContain('create or replace function private.analytics_props_ok');
    for (const name of EVENT_NAMES) expect(sql).toContain(`'${name}'`);
    for (const name of EVENT_NAMES) {
      for (const [key, vals] of Object.entries(EVENT_SCHEMA[name].props as Record<string, readonly string[]>)) {
        const line = latest.split('\n').find((l) => l.includes(`('${name}', '${key}'`));
        expect(line, `${name}.${key}`).toBeTruthy();
        expect(line).toContain(`array[${vals.map((v) => `'${v}'`).join(', ')}]`);
      }
    }
    const once = /product_analytics_once[\s\S]*?where event_name in \(([^)]*)\)/.exec(sql)?.[1] ?? '';
    expect(once.match(/'[a-z_0-9]+'/g)?.map((s) => s.slice(1, -1)).sort()).toEqual([...ONCE_EVENTS].sort());
  });
});

describe('recording', () => {
  it('queues allowlisted events locally with id, name, enum props and time only', async () => {
    expect(await trackWorkoutStarted(db, 'template')).toBe(true);
    const [e] = await queue();
    expect(Object.keys(e).sort()).toEqual(['at', 'id', 'name', 'props']);
    expect(e).toMatchObject({ name: 'workout_started', props: { source: 'template' } });
  });

  it('guest and demo databases record nothing', async () => {
    for (const key of ['guest', 'demo']) {
      const g = new LiftDb(key);
      expect(await track(g, 'first_set_logged')).toBe(false);
      await trackSetLogged(g, 'x');
      await trackAiAction(g, 'chat_message', 'sent');
      expect(await queue(g)).toEqual([]);
      g.close();
    }
  });

  it('privacy toggle: default on; off records nothing and Settings clears the queue', async () => {
    expect(analyticsEnabled(defaultAccountState().settings)).toBe(true);
    await trackWorkoutStarted(db, 'empty');
    const acc = defaultAccountState();
    await db.account.put({ ...acc, id: ACCOUNT_ROW_ID, settings: { ...acc.settings, analytics: false } });
    expect(await trackWorkoutStarted(db, 'empty')).toBe(false);
    expect(await trackAiAction(db, 'week_plan', 'applied')).toBe(false);
    expect(await names()).toEqual(['workout_started']); // the earlier one, until Settings clears it
    await clearAnalyticsQueue(db);
    expect(await queue()).toEqual([]);
  });

  it('one-time milestones are recorded once per account', async () => {
    expect(await track(db, 'onboarding_completed', { path: 'suggested' })).toBe(true);
    expect(await track(db, 'onboarding_completed', { path: 'manual' })).toBe(false);
    expect(await names()).toEqual(['onboarding_completed']);
    // Another account has its own database, so its own milestones.
    const other = new LiftDb(`analytics-other-${n}`);
    expect(await track(other, 'onboarding_completed', { path: 'manual' })).toBe(true);
    other.close();
  });

  it('the queue is bounded', async () => {
    for (let i = 0; i < MAX_QUEUE + 15; i++) await trackWorkoutStarted(db, 'empty');
    expect((await queue()).length).toBe(MAX_QUEUE);
  });

  it('never throws, even when storage fails', async () => {
    const broken = new LiftDb(`analytics-broken-${n}`);
    broken.close();
    await expect(track(broken, 'first_set_logged')).resolves.toBe(false);
    await expect(trackSetLogged(broken, 'x')).resolves.toBeUndefined();
    await expect(trackWorkoutCompleted(broken, 'x')).resolves.toBeUndefined();
  });
});

describe('milestones from local records', () => {
  it('first_set_logged: the first working set of a new account, once (warm-ups and repeats ignored)', async () => {
    const active = session('a1', { status: 'active', endedAt: undefined });
    active.exercises[0].sets = [{ id: 'w', type: 'warmup', weightKg: 40, reps: 5, completed: true }];
    await db.sessions.put(active);
    await trackSetLogged(db, 'a1');
    expect(await names()).toEqual([]); // warm-up only
    active.exercises[0].sets.push({ id: 's', type: 'normal', weightKg: 100, reps: 5, completed: true });
    await db.sessions.put(active);
    await trackSetLogged(db, 'a1');
    await trackSetLogged(db, 'a1');
    expect(await names()).toEqual(['first_set_logged']);
  });

  it('first_set_logged survives an immediate Finish: the read runs after the workout was already completed', async () => {
    // Tick the first set, then Finish straight away: by the time the (delayed) milestone read runs, the same workout
    // is stored as completed. It must not count as earlier history.
    await db.sessions.put(session('w1'));
    await trackSetLogged(db, 'w1');
    expect(await names()).toEqual(['first_set_logged']);
    // A different, earlier finished workout still means "not a first".
    const other = new LiftDb(`analytics-race-${n}`);
    await other.sessions.put(session('old'));
    await other.sessions.put(session('w2', { endedAt: Date.parse('2026-11-21T11:00:00Z') }));
    await trackSetLogged(other, 'w2');
    expect(await names(other)).toEqual([]);
    other.close();
  });

  it('first_set_logged never fires late for an account that already had workouts', async () => {
    await db.sessions.put(session('old'));
    await db.sessions.put(session('a1', { status: 'active', endedAt: undefined }));
    await trackSetLogged(db, 'a1');
    expect(await names()).toEqual([]);
    expect((await db.kv.get(DONE_KEY))?.value).toContain('first_set_logged');
  });

  it('first_workout_completed, then second_workout_within_7d when the second ends within 7 days', async () => {
    const t0 = Date.parse('2026-11-20T11:00:00Z');
    await db.sessions.put(session('w1', { endedAt: t0 }));
    await trackWorkoutCompleted(db, 'w1');
    await trackWorkoutCompleted(db, 'w1'); // finish handler running twice
    await db.sessions.put(session('w2', { startedAt: t0 + 6 * DAY, endedAt: t0 + 6 * DAY + 3600_000 }));
    await trackWorkoutCompleted(db, 'w2');
    await db.sessions.put(session('w3', { startedAt: t0 + 8 * DAY, endedAt: t0 + 8 * DAY }));
    await trackWorkoutCompleted(db, 'w3');
    expect(await names()).toEqual(['first_workout_completed', 'second_workout_within_7d']);
  });

  it('no second_workout_within_7d when the second workout is more than 7 days later', async () => {
    const t0 = Date.parse('2026-11-01T11:00:00Z');
    await db.sessions.put(session('w1', { endedAt: t0 }));
    await trackWorkoutCompleted(db, 'w1');
    await db.sessions.put(session('w2', { startedAt: t0 + 7 * DAY + 60_000, endedAt: t0 + 7 * DAY + 60_000 }));
    await trackWorkoutCompleted(db, 'w2');
    expect(await names()).toEqual(['first_workout_completed']);
  });

  it('accounts with earlier workouts get neither milestone; deleted workouts do not count', async () => {
    await db.sessions.put(session('gone', { deletedAt: 1 }));
    await db.sessions.put(session('w1'));
    await db.sessions.put(session('w2', { endedAt: Date.parse('2026-11-21T11:00:00Z') }));
    await db.sessions.put(session('w3', { endedAt: Date.parse('2026-11-22T11:00:00Z') }));
    await trackWorkoutCompleted(db, 'w3');
    expect(await names()).toEqual([]);
  });
});

describe('transport', () => {
  it('sends only for the signed-in account of this database, and only online', async () => {
    await trackWorkoutStarted(db, 'repeat');
    await flushAnalytics(db); // no account gate
    setAnalyticsAccount('someone-else');
    await flushAnalytics(db);
    setAnalyticsAccount(db.accountKey);
    setOnline(false);
    await flushAnalytics(db);
    expect(sent).toEqual([]);
    setOnline(true);
    await flushAnalytics(db);
    expect(sent.length).toBe(1);
    expect(sent[0][0]).toMatchObject({ name: 'workout_started', props: { source: 'repeat' } });
    expect(Object.keys(sent[0][0]).sort()).toEqual(['id', 'name', 'occurred_at', 'props']);
    expect(await queue()).toEqual([]);
  });

  it('re-checks stored events at the boundary: tampered or unknown entries are never sent', async () => {
    await db.kv.put({
      key: QUEUE_KEY,
      value: [
        { id: 'a', name: 'workout_started', props: { source: 'template', weightKg: 140, notes: 'knee pain' }, at: Date.now(), email: 'x@y.z' },
        { id: 'b', name: 'chat_message', props: { text: 'hello coach' }, at: Date.now() },
        { id: 'c', name: 'ai_action_used', props: { action_type: 'chat_message', outcome: 'I feel dizzy' }, at: Date.now() },
      ],
    });
    setAnalyticsAccount(db.accountKey);
    await flushAnalytics(db);
    expect(sent.flat()).toEqual([{ id: 'a', name: 'workout_started', props: { source: 'template' }, occurred_at: expect.any(String) }]);
    expect(await queue()).toEqual([]); // invalid ones are dropped, not retried forever
  });

  it('missing migration / server errors: silent, events stay queued and are retried later', async () => {
    const err = Object.assign(new Error('Could not find the function public.log_product_events(p_events) in the schema cache'), { code: 'PGRST202' });
    expect(isMissingBackend(err)).toBe(true);
    expect(isMissingBackend(Object.assign(new Error('boom'), { code: '500' }))).toBe(false);
    setAnalyticsTransport(async () => {
      throw err;
    });
    await trackAiAction(db, 'meal_plan', 'proposed');
    setAnalyticsAccount(db.accountKey);
    await expect(flushAnalytics(db)).resolves.toBeUndefined();
    expect(await names()).toEqual(['ai_action_used']);
    // Backed off: the next flush doesn't even try.
    const t = vi.fn(async () => undefined);
    setAnalyticsTransport(t);
    await flushAnalytics(db);
    expect(t).not.toHaveBeenCalled();
    // After the backoff (fresh session state) it goes through.
    resetAnalyticsState();
    setAnalyticsAccount(db.accountKey);
    await flushAnalytics(db);
    expect(t).toHaveBeenCalledTimes(1);
    expect(await queue()).toEqual([]);
  });

  it('opting out deletes queued events at the next flush instead of sending them', async () => {
    await trackWorkoutStarted(db, 'empty');
    const acc = defaultAccountState();
    await db.account.put({ ...acc, id: ACCOUNT_ROW_ID, settings: { ...acc.settings, analytics: false } });
    setAnalyticsAccount(db.accountKey);
    await flushAnalytics(db);
    expect(sent).toEqual([]);
    expect(await queue()).toEqual([]);
  });

  it('consent switched off mid-flush (sync / backup restore): no further batch is sent and the queue is cleared', async () => {
    for (let i = 0; i < 57; i++) await trackWorkoutStarted(db, 'empty');
    const acc = defaultAccountState();
    setAnalyticsTransport(async (events) => {
      sent.push(events);
      // While the first batch is in flight, another device's opt-out arrives through sync (it writes the account row).
      if (sent.length === 1) await db.account.put({ ...acc, id: ACCOUNT_ROW_ID, settings: { ...acc.settings, analytics: false } });
    });
    setAnalyticsAccount(db.accountKey);
    await flushAnalytics(db);
    expect(sent.map((b) => b.length)).toEqual([50]);
    expect(await queue()).toEqual([]);
  });

  it('account switched mid-flush: no further batch is sent for the old account', async () => {
    for (let i = 0; i < 57; i++) await trackWorkoutStarted(db, 'empty');
    setAnalyticsTransport(async (events) => {
      sent.push(events);
      setAnalyticsAccount('another-account');
    });
    setAnalyticsAccount(db.accountKey);
    await flushAnalytics(db);
    expect(sent.map((b) => b.length)).toEqual([50]);
    expect((await queue()).length).toBe(7); // kept for when this account is signed in again
  });

  it('a backoff schedules its own retry: an idle app sends once the backoff expires', async () => {
    let fail = true;
    setAnalyticsTransport(async (events) => {
      if (fail) throw Object.assign(new Error('Service unavailable'), { status: 503 });
      sent.push(events);
    });
    await trackAiAction(db, 'week_plan', 'applied');
    setAnalyticsAccount(db.accountKey);
    await flushAnalytics(db);
    expect(analyticsRetryAt()).toBeGreaterThan(Date.now());
    fail = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const flush = vi.fn((d: LiftDb) => flushAnalytics(d));
      const stop = armAnalyticsRetry(db, flush);
      vi.advanceTimersByTime(29_000);
      expect(flush).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      expect(flush).toHaveBeenCalledTimes(1);
      await flush.mock.results[0].value;
      expect(sent.flat().map((e) => e.name)).toEqual(['ai_action_used']);
      expect(await queue()).toEqual([]);
      expect(analyticsRetryAt()).toBe(0);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the retry timer is cleaned up (unmount / opt-out / account change)', async () => {
    setAnalyticsTransport(async () => {
      throw Object.assign(new Error('Service unavailable'), { status: 503 });
    });
    await trackAiAction(db, 'week_plan', 'applied');
    setAnalyticsAccount(db.accountKey);
    await flushAnalytics(db);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const flush = vi.fn(async () => undefined);
      const stop = armAnalyticsRetry(db, flush);
      stop();
      vi.advanceTimersByTime(60 * 60_000);
      expect(flush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends in batches of at most BATCH_SIZE', async () => {
    for (let i = 0; i < BATCH_SIZE + 7; i++) await trackWorkoutStarted(db, 'empty');
    setAnalyticsAccount(db.accountKey);
    await flushAnalytics(db);
    expect(sent.map((b) => b.length)).toEqual([BATCH_SIZE, 7]);
  });
});

describe('no health data, chat content or PII ever leaves the device', () => {
  it('a real first week (heavy sets, injuries, notes, body weight, chat) only produces bare events', async () => {
    const acc = defaultAccountState();
    await db.account.put({ ...acc, id: ACCOUNT_ROW_ID, profile: { ...acc.profile, displayName: 'Jordan Example', limitations: ['knee'] } });
    await db.measurements.put({ id: 'm1', createdAt: 0, updatedAt: 0, kind: 'bodyweight', date: '2026-11-20', value: 82.5 } as never);
    const active = session('w1', { status: 'active', endedAt: undefined });
    await db.sessions.put(active);
    await trackSetLogged(db, 'w1');
    await db.sessions.put(session('w1'));
    await trackWorkoutCompleted(db, 'w1');
    await db.sessions.put(session('w2', { endedAt: Date.parse('2026-11-23T11:00:00Z') }));
    await trackWorkoutCompleted(db, 'w2');
    await trackAiAction(db, 'chat_message', 'sent');
    await trackAiAction(db, 'week_plan', 'applied');
    setAnalyticsAccount(db.accountKey);
    await flushAnalytics(db);

    const everything = JSON.stringify({ queue: await queue(), sent });
    for (const secret of ['142.5', '82.5', 'barbell-back-squat', 'squat', 'knee', 'shoulder', 'pain', 'Jordan', 'rpe', 'rir', 'weight', 'reps', 'notes', 'discomfort', '@']) {
      expect(everything.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(sent.flat().map((e) => e.name)).toEqual(['first_set_logged', 'first_workout_completed', 'second_workout_within_7d', 'ai_action_used', 'ai_action_used']);
  });
});
