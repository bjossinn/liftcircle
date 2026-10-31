/**
 * Push scheduling rules computed on the device (src/domain/pushSchedule.ts): reminder time rule, 14-day reminders,
 * missed-session nudges, rest-over alert schedule/replace/cancel, coach-style texts and wording rules.
 */
import { describe, expect, it } from 'vitest';
import {
  clampToAllowed, DEFAULT_PUSH_PREFS, mentionsPainOrIllness, missedNudgeJobs, missedText, reminderText, reminderTime, restAlertJob, restText, toMinutes,
  workoutReminderJobs, zonedToUtc, type PushPrefs,
} from '@/domain/pushSchedule';
import { createProgram } from '@/domain/program/program';
import { applyWeekPlan, skipPlanned, type WeekPlan } from '@/domain/program/schedule';
import * as ops from '@/domain/sessionOps';
import { EXERCISES } from '@/data/exercises';
import type { CoachStyle, Program, ProgramVersion, WorkoutSession } from '@/domain/types';

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const OSLO = 'Europe/Oslo';
const prefs = (over: Partial<PushPrefs> = {}): PushPrefs => ({ ...DEFAULT_PUSH_PREFS, timeZone: OSLO, ...over });

function plan(): Program {
  const t = (id: string, name: string) => ({ id, name, focus: name, kind: 'lifting' as const, estimatedMinutes: 45, exercises: [] });
  const v: ProgramVersion = {
    version: 1, createdAt: 0, reason: 't', templates: [t('A', 'Upper A'), t('B', 'Lower A'), t('C', 'Upper B')],
    schedule: [{ weekday: 1, templateId: 'A' }, { weekday: 3, templateId: 'B' }, { weekday: 5, templateId: 'C' }], weeks: 8, reviewWeek: 8, rationale: [], warnings: [],
  };
  return createProgram(null, v, '2026-10-05', 'Upper/Lower', 'generated');
}
/** A completed session of `templateId` that started at local `hhmm` (Oslo) on `date`. */
const done = (p: Program, templateId: string, date: string, hhmm = '17:00'): WorkoutSession => {
  const startedAt = zonedToUtc(date, hhmm, OSLO).getTime();
  return {
    id: `${templateId}-${date}`, createdAt: 0, updatedAt: 0, name: templateId, status: 'completed', programId: p.id, templateId, plannedDate: date, date, timeZone: OSLO,
    startedAt, endedAt: startedAt + 3_000_000, pausedTotalMs: 0,
    exercises: [{ id: 'e', exerciseId: 'barbell-bench-press', order: 0, sets: [{ id: 's', type: 'normal', weightKg: 60, reps: 8, completed: true }] }],
  };
};
const at = (iso: string) => new Date(iso);
const local = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: OSLO, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

describe('reminder time rule', () => {
  it('default 12:00 when the template was never done', () => {
    expect(reminderTime({ templateId: 'A', sessions: [], prefs: prefs() })).toBe('12:00');
  });

  it('2 h before the start of the most recent completed session of the same template (17:00 → 15:00)', () => {
    const p = plan();
    const sessions = [done(p, 'A', '2026-10-12', '18:30'), done(p, 'A', '2026-10-19', '17:00'), done(p, 'B', '2026-10-21', '06:00')];
    expect(reminderTime({ templateId: 'A', sessions, prefs: prefs() })).toBe('15:00');
    // Lower A last started 06:00 → 04:00, clamped to quiet end 07:00.
    expect(reminderTime({ templateId: 'B', sessions, prefs: prefs() })).toBe('07:00');
  });

  it('fixed-time override wins over history', () => {
    const p = plan();
    expect(reminderTime({ templateId: 'A', sessions: [done(p, 'A', '2026-10-19', '17:00')], prefs: prefs({ fixedReminderTime: '08:15' }) })).toBe('08:15');
  });

  it('clamps into the allowed window: not before quiet_end, not after quiet_start (5-min margin)', () => {
    const q = { quietStart: '22:00', quietEnd: '07:00' };
    expect(clampToAllowed(toMinutes('06:00'), q)).toBe(toMinutes('07:00'));
    expect(clampToAllowed(toMinutes('23:30'), q)).toBe(toMinutes('21:55'));
    expect(clampToAllowed(toMinutes('15:00'), q)).toBe(toMinutes('15:00'));
    expect(reminderTime({ sessions: [], prefs: prefs({ fixedReminderTime: '23:30' }) })).toBe('21:55');
    expect(reminderTime({ sessions: [], prefs: prefs({ fixedReminderTime: '05:00', quietEnd: '06:30' }) })).toBe('06:30');
  });
});

describe('workout reminders (next 14 days)', () => {
  const p = plan();
  const base = { program: p, sessions: [] as WorkoutSession[], today: '2026-10-26', now: at('2026-10-26T08:00:00Z'), prefs: prefs() };

  it('one reminder per planned training day, none on rest days, opening Today with the session name', () => {
    const jobs = workoutReminderJobs(base);
    expect(jobs.map((j) => j.dedupeKey)).toEqual(['reminder:2026-10-26', 'reminder:2026-10-28', 'reminder:2026-10-30', 'reminder:2026-11-02', 'reminder:2026-11-04', 'reminder:2026-11-06']);
    expect(jobs[0].payload).toEqual({ title: 'Hard Earned', body: 'Upper A today. Ready for a session?', url: '/', tag: 'workout' });
    expect(jobs.every((j) => local(j.fireAt).endsWith('12:00'))).toBe(true);
    expect(jobs.some((j) => j.dedupeKey === 'reminder:2026-10-27')).toBe(false); // Tuesday rest day
  });

  it('a time already passed today is not sent today', () => {
    const jobs = workoutReminderJobs({ ...base, now: at('2026-10-26T11:30:00Z') }); // 12:30 in Oslo
    expect(jobs[0].dedupeKey).toBe('reminder:2026-10-28');
  });

  it('skips today when the session is already started or completed', () => {
    const active: WorkoutSession = { ...done(p, 'A', '2026-10-26', '07:30'), id: 'act', status: 'active', endedAt: undefined };
    expect(workoutReminderJobs({ ...base, sessions: [active] })[0].dedupeKey).toBe('reminder:2026-10-28');
    expect(workoutReminderJobs({ ...base, sessions: [done(p, 'A', '2026-10-26', '07:30')] })[0].dedupeKey).toBe('reminder:2026-10-28');
  });

  it('moved and skipped sessions, and week plans (date overrides), are respected', () => {
    const skipped = skipPlanned(p, '2026-10-28', 'B');
    expect(workoutReminderJobs({ ...base, program: skipped }).map((j) => j.dedupeKey)).not.toContain('reminder:2026-10-28');
    const moved: Program = { ...p, overrides: [{ date: '2026-10-28', templateId: 'B', status: 'moved', movedTo: '2026-10-29' }] };
    const keys = workoutReminderJobs({ ...base, program: moved }).map((j) => j.dedupeKey);
    expect(keys).not.toContain('reminder:2026-10-28');
    expect(keys).toContain('reminder:2026-10-29');
    const wp: WeekPlan = {
      kind: 'week_adjustment', id: 'wp1', baseProgramId: p.id, baseVersion: p.currentVersion, weekStart: '2026-10-26', weekEnd: '2026-11-01', targetSessions: 2,
      completed: [], sessions: [{ templateId: 'A', name: 'Upper A', date: '2026-10-26', plannedDate: '2026-10-26' }, { templateId: 'B', name: 'Lower A', date: '2026-10-31', plannedDate: '2026-10-28' }],
      skipped: [{ templateId: 'C', name: 'Upper B', plannedDate: '2026-10-30' }], adjustments: [], warnings: [], summary: '',
    };
    const applied = applyWeekPlan(p, wp, '2026-10-26', [], 1);
    expect(applied.ok).toBe(true);
    const wk = workoutReminderJobs({ ...base, program: (applied as { program: Program }).program }).map((j) => j.dedupeKey);
    expect(wk.filter((k) => k <= 'reminder:2026-11-01')).toEqual(['reminder:2026-10-26', 'reminder:2026-10-31']);
    expect(wk).toContain('reminder:2026-11-02'); // next week reverts to the usual schedule
  });

  it('uses the user’s time zone across the DST change (Europe/Oslo, 25 Oct 2026)', () => {
    const jobs = workoutReminderJobs({ ...base, today: '2026-10-23', now: at('2026-10-23T05:00:00Z'), prefs: prefs({ fixedReminderTime: '17:00' }) });
    const fri = jobs.find((j) => j.dedupeKey === 'reminder:2026-10-23')!;
    const mon = jobs.find((j) => j.dedupeKey === 'reminder:2026-10-26')!;
    expect(fri.fireAt).toBe('2026-10-23T15:00:00.000Z'); // CEST, UTC+2
    expect(mon.fireAt).toBe('2026-10-26T16:00:00.000Z'); // CET, UTC+1
    const ny = workoutReminderJobs({ ...base, now: at('2026-10-26T00:00:00Z'), prefs: prefs({ timeZone: 'America/New_York' }) });
    expect(ny[0].fireAt).toBe('2026-10-26T16:00:00.000Z'); // 12:00 EDT
  });
});

describe('missed-session nudges', () => {
  const p = plan();
  it('yesterday’s planned session without a workout → one nudge today at that day’s reminder time', () => {
    const jobs = missedNudgeJobs({ program: p, sessions: [done(p, 'A', '2026-10-19', '17:00')], today: '2026-10-27', now: at('2026-10-27T06:00:00Z'), prefs: prefs() });
    const first = jobs[0];
    expect(first.dedupeKey).toBe('nudge:2026-10-26');
    expect(local(first.fireAt)).toBe('Tue 15:00');
    expect(first.payload.body).toBe('Upper A is still open from yesterday. Can you fit it in today? Even 20 minutes counts.');
  });

  it('done, skipped or moved days get no nudge; upcoming days get one in advance (cancelled once trained)', () => {
    const trained = missedNudgeJobs({ program: p, sessions: [done(p, 'A', '2026-10-26')], today: '2026-10-27', now: at('2026-10-27T06:00:00Z'), prefs: prefs() });
    expect(trained.map((j) => j.dedupeKey)).not.toContain('nudge:2026-10-26');
    expect(trained.map((j) => j.dedupeKey)).toContain('nudge:2026-10-28'); // Wednesday, scheduled for Thursday
    const skipped = missedNudgeJobs({ program: skipPlanned(p, '2026-10-26', 'A'), sessions: [], today: '2026-10-27', now: at('2026-10-27T06:00:00Z'), prefs: prefs() });
    expect(skipped.map((j) => j.dedupeKey)).not.toContain('nudge:2026-10-26');
  });

  it('never nudges after pain/injury/illness was mentioned; at most one per day', () => {
    expect(missedNudgeJobs({ program: p, sessions: [], today: '2026-10-27', now: at('2026-10-27T06:00:00Z'), prefs: prefs(), painFlag: true })).toEqual([]);
    expect(mentionsPainOrIllness('my knee hurts')).toBe(true);
    expect(mentionsPainOrIllness('Got the flu, sorry')).toBe(true);
    expect(mentionsPainOrIllness('feeling great today')).toBe(false);
    const jobs = missedNudgeJobs({ program: p, sessions: [], today: '2026-10-27', now: at('2026-10-27T06:00:00Z'), prefs: prefs() });
    const days = jobs.map((j) => j.fireAt.slice(0, 10));
    expect(new Set(days).size).toBe(days.length);
  });
});

describe('coach-style texts', () => {
  const STYLES: CoachStyle[] = ['supportive', 'balanced', 'strict'];
  it('reminder and nudge follow the style; Strict nudge matches the brief, Supportive stays kind', () => {
    expect(reminderText('Upper A')).toBe('Upper A today. Ready for a session?');
    expect(missedText('Upper A', 'strict')).toBe('Upper A is still open from yesterday. Do the first two exercises today: 20 minutes counts.');
    expect(missedText('Upper A', 'supportive')).not.toMatch(/excuse|missed/i);
    expect(new Set(STYLES.map((s) => reminderText('Upper A', s))).size).toBe(3);
  });
  it('never mentions body weight or food, and stays short', () => {
    const all = STYLES.flatMap((s) => [reminderText('Upper A', s), missedText('Upper A', s)]).concat(restText('Bench press', 3, '60 kg × 8'));
    for (const t of all) {
      expect(t).not.toMatch(/\b(body ?weight|fat|calorie|food|eat|diet|kg lost|scale)\b/i);
      expect(t.length).toBeLessThanOrEqual(120);
    }
  });
});

describe('rest-over alert: schedule, replace, cancel', () => {
  const session = (): WorkoutSession => ({
    id: 'w1', createdAt: 1, updatedAt: 1, name: 'Upper A', status: 'active', date: '2026-10-30', timeZone: OSLO, startedAt: 1_000_000, pausedTotalMs: 0,
    exercises: [{
      id: 'e1', exerciseId: 'barbell-bench-press', order: 0, prescription: { sets: 3, repMin: 8, repMax: 10, targetRir: 2, restSec: 90 },
      sets: [
        { id: 'a', type: 'normal', weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: 8, completed: false },
        { id: 'b', type: 'normal', weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: 8, completed: false },
        { id: 'c', type: 'normal', weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: 8, completed: false },
      ],
    }],
  });
  const complete = (s: WorkoutSession, setId: string, now: number) => ops.startRest(ops.toggleSetComplete(s, 'e1', setId, now).session, now, 90_000, 'e1');

  it('scheduled at the rest deadline with the next set, one per workout (dedupe key)', () => {
    const s = complete(session(), 'a', 2_000_000);
    expect(restAlertJob(s, byId, 'kg')).toEqual({
      dedupeKey: 'rest:w1', fireAt: new Date(2_090_000).toISOString(),
      payload: { title: 'Hard Earned', body: 'Rest’s up: Barbell bench press set 2, 60 kg × 8', url: '/train/session/w1', tag: 'rest' },
    });
  });

  it('extend → same key, new deadline (replaces); next set → new deadline and set 3', () => {
    const s = complete(session(), 'a', 2_000_000);
    const extended = ops.extendRest(s, 2_010_000, 15_000);
    expect(restAlertJob(extended, byId, 'kg')).toMatchObject({ dedupeKey: 'rest:w1', fireAt: new Date(2_105_000).toISOString() });
    const next = complete(s, 'b', 2_200_000);
    expect(restAlertJob(next, byId, 'kg')).toMatchObject({ dedupeKey: 'rest:w1', fireAt: new Date(2_290_000).toISOString(), payload: { body: 'Rest’s up: Barbell bench press set 3, 60 kg × 8' } });
  });

  it('skip, pause, finish or discard → nothing to schedule (the upload cancels it)', () => {
    const s = complete(session(), 'a', 2_000_000);
    expect(restAlertJob(ops.skipRest(s), byId, 'kg')).toBeNull();
    expect(restAlertJob(ops.pauseRest(s, 2_010_000), byId, 'kg')).toBeNull();
    expect(restAlertJob(ops.finishSession(s, 2_050_000), byId, 'kg')).toBeNull();
    expect(restAlertJob({ ...s, deletedAt: 1, status: 'completed' }, byId, 'kg')).toBeNull();
    // Last set done: no next set → no alert.
    const last = complete(complete(complete(session(), 'a', 1), 'b', 2), 'c', 3);
    expect(restAlertJob(last, byId, 'kg')).toBeNull();
  });
});
