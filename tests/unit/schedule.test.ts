import { describe, expect, it } from 'vitest';
import { createProgram } from '@/domain/program/program';
import {
  adherence, applyWeekPlan, clearOverride, nextPlannedSession, plannedSessionsInRange, rescheduleMissed, revertWeekPlan, skipPlanned, weekPlanState, type WeekPlan,
} from '@/domain/program/schedule';
import { withNewVersion } from '@/domain/program/program';
import type { ActivityLog, Experience, OnboardingAnswers, Program, ProgramVersion, SessionTemplate, WorkoutSession } from '@/domain/types';
import { addDays, weekday } from '@/lib/dates';

// 2026-11-02 is a Monday.
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const THU = '2026-11-05';
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const SUN = '2026-11-08';

const lift = (id: string, name: string): SessionTemplate => ({ id, name, focus: name, kind: 'lifting', exercises: [], estimatedMinutes: 45 });
const walk: SessionTemplate = { id: 'act:walk', name: 'Easy walk', focus: 'Recovery', kind: 'walk', exercises: [], estimatedMinutes: 30, cardio: { activity: 'walk', minutes: 30, intensity: 'easy', notes: '' } };

function program(schedule: [number, string][], opts: { experience?: Experience | null; available?: number[]; templates?: SessionTemplate[] } = {}): Program {
  const templates = opts.templates ?? [lift('A', 'Full body A'), lift('B', 'Full body B'), lift('C', 'Full body C'), walk];
  const v: ProgramVersion = { version: 1, createdAt: 0, reason: 'test', templates, schedule: schedule.map(([weekday, templateId]) => ({ weekday, templateId })), weeks: 6, reviewWeek: 6, rationale: [], warnings: [] };
  const inputs = opts.experience === null ? null : ({ experience: opts.experience ?? 'new', availableWeekdays: opts.available ?? [] } as unknown as OnboardingAnswers);
  return createProgram(inputs, v, MON, 'Test', 'generated');
}
const MWF: [number, string][] = [[1, 'A'], [3, 'B'], [5, 'C']];

function done(templateId: string, date: string, plannedDate?: string, programId?: string): WorkoutSession {
  return {
    id: `s-${templateId}-${date}`, createdAt: 0, updatedAt: 0, name: templateId, status: 'completed', templateId, date, plannedDate, programId, timeZone: 'UTC',
    startedAt: Date.parse(date), pausedTotalMs: 0, exercises: [],
  };
}

/** No date ever holds two active (non-moved/non-skipped) planned sessions. */
function assertOnePerDay(p: Program, from: string, to: string, today: string, sessions: WorkoutSession[] = []) {
  const items = plannedSessionsInRange(p, from, to, today, sessions).filter((i) => i.status !== 'moved' && i.status !== 'skipped');
  const dates = items.map((i) => i.date);
  expect(new Set(dates).size).toBe(dates.length);
}

describe('plannedSessionsInRange', () => {
  it('maps weekdays to dates and derives statuses', () => {
    const p = program(MWF);
    const sessions = [done('A', MON, MON, p.id)];
    const items = plannedSessionsInRange(p, MON, SUN, WED, sessions);
    expect(items.map((i) => [i.date, i.template.id, i.status])).toEqual([
      [MON, 'A', 'done'],
      [WED, 'B', 'today'],
      [FRI, 'C', 'planned'],
    ]);
    expect(items[0].sessionId).toBe(sessions[0].id);
  });

  it('past sessions without a workout are missed; a workout done a day late still counts', () => {
    const p = program(MWF);
    const items = plannedSessionsInRange(p, MON, SUN, SAT, [done('B', THU)]);
    expect(items.find((i) => i.date === MON)!.status).toBe('missed');
    expect(items.find((i) => i.date === WED)!.status).toBe('done');
    expect(items.find((i) => i.date === FRI)!.status).toBe('missed');
  });

  it('ignores dates before the program start and sessions from another program', () => {
    const p = program(MWF);
    expect(plannedSessionsInRange(p, addDays(MON, -7), addDays(MON, -1), MON, [])).toHaveLength(0);
    const other = done('A', MON, MON, 'another-program');
    expect(plannedSessionsInRange(p, MON, MON, TUE, [other])[0].status).toBe('missed');
  });

  it('easy activity days are matched by logged activities', () => {
    const p = program([[1, 'A'], [2, 'act:walk']]);
    const act = { id: 'w1', type: 'walk', date: TUE, timeZone: 'UTC', durationSec: 1800, createdAt: 0, updatedAt: 0 } as ActivityLog;
    const items = plannedSessionsInRange(p, MON, TUE, WED, [], [act]);
    expect(items.find((i) => i.template.id === 'act:walk')!.status).toBe('done');
  });

  it('skip and undo', () => {
    const p = skipPlanned(program(MWF), MON, 'A');
    expect(plannedSessionsInRange(p, MON, MON, TUE, [])[0].status).toBe('skipped');
    const undone = clearOverride(p, MON, 'A');
    expect(plannedSessionsInRange(undone, MON, MON, TUE, [])[0].status).toBe('missed');
  });
});

describe('nextPlannedSession', () => {
  it("returns today's session until it is done, then the next one", () => {
    const p = program(MWF);
    expect(nextPlannedSession(p, WED, [])!.template.id).toBe('B');
    const n = nextPlannedSession(p, WED, [done('B', WED, WED, p.id)]);
    expect(n!.date).toBe(FRI);
    expect(n!.template.id).toBe('C');
  });
});

describe('rescheduleMissed', () => {
  it('beginner: never crams into the next day if that makes back-to-back hard days', () => {
    const p = program(MWF, { experience: 'new' });
    // Missed Monday; Tue/Thu/Sat/Sun are all next to a lifting day before Monday's A comes round again.
    const r = rescheduleMissed(p, MON, 'A', TUE, []);
    expect(r.movedTo).toBeNull();
    expect(r.message).toMatch(/back-to-back|skipped/);
    expect(plannedSessionsInRange(r.program, MON, MON, TUE, [])[0].status).toBe('skipped');
  });

  it('beginner: moves to a free day with rest either side when one exists', () => {
    const p = program([[1, 'A'], [4, 'B']], { experience: 'new' });
    const r = rescheduleMissed(p, MON, 'A', TUE, []);
    expect(r.movedTo).toBe(TUE);
    const items = plannedSessionsInRange(r.program, MON, SUN, TUE, []);
    expect(items.find((i) => i.date === MON)).toMatchObject({ status: 'moved', movedTo: TUE });
    expect(items.find((i) => i.date === TUE)).toMatchObject({ status: 'today', movedFrom: MON });
    assertOnePerDay(r.program, MON, SUN, TUE);
  });

  it('beginner: a completed workout yesterday blocks moving to today', () => {
    const p = program([[1, 'A'], [4, 'B']], { experience: 'new' });
    // Monday's A was missed, but they did an unplanned workout on Tuesday; today is Wednesday.
    const extra = { ...done('X', TUE), templateId: undefined };
    const r = rescheduleMissed(p, MON, 'A', WED, [extra]);
    // Wed is next to Tue (workout) and Thu (B); Fri/Sat are free and spaced → Sat? Fri is next to Thu → Sat.
    expect(r.movedTo).toBe(SAT);
  });

  it('intermediate: may use the next free day, with a lower-effort note, but never a day with another session', () => {
    const p = program(MWF, { experience: 'intermediate' });
    const r = rescheduleMissed(p, MON, 'A', TUE, []);
    expect(r.movedTo).toBe(TUE);
    expect(r.message).toMatch(/effort/);
    assertOnePerDay(r.program, MON, SUN, TUE);
  });

  it('never double-books: no free day → skipped', () => {
    const p = program([[0, 'A'], [1, 'B'], [2, 'C'], [3, 'A'], [4, 'B'], [5, 'C'], [6, 'act:walk']], { experience: 'advanced' });
    const r = rescheduleMissed(p, MON, 'B', TUE, []);
    expect(r.movedTo).toBeNull();
    assertOnePerDay(r.program, MON, SUN, TUE);
  });

  it('only uses days the user marked available', () => {
    const p = program(MWF, { experience: 'advanced', available: [1, 3, 5] });
    const r = rescheduleMissed(p, MON, 'A', TUE, []);
    expect(r.movedTo).toBeNull();
    const p2 = program(MWF, { experience: 'advanced', available: [1, 3, 5, 6] });
    const r2 = rescheduleMissed(p2, MON, 'A', TUE, []);
    expect(r2.movedTo).toBe(SAT);
    expect(weekday(r2.movedTo!)).toBe(6);
  });

  it('moving a moved session again updates the original entry', () => {
    const p = program([[1, 'A'], [4, 'B']], { experience: 'advanced' });
    const first = rescheduleMissed(p, MON, 'A', TUE, []);
    expect(first.movedTo).toBe(TUE);
    const second = rescheduleMissed(first.program, TUE, 'A', WED, []);
    expect(second.program.overrides).toHaveLength(1);
    expect(second.program.overrides[0]).toMatchObject({ date: MON, status: 'moved' });
    expect(second.movedTo).not.toBe(TUE);
    assertOnePerDay(second.program, MON, SUN, WED);
  });
});

describe('adherence', () => {
  it('counts planned lifting sessions up to today (excluding today if not done)', () => {
    const p = program([...MWF, [2, 'act:walk']]);
    const sessions = [done('A', MON, MON, p.id), done('B', WED, WED, p.id)];
    expect(adherence(p, MON, SUN, FRI, sessions)).toEqual({ planned: 2, completed: 2 });
    expect(adherence(p, MON, SUN, SAT, sessions)).toEqual({ planned: 3, completed: 2 });
    const skipped = skipPlanned(p, FRI, 'C');
    expect(adherence(skipped, MON, SUN, SAT, sessions)).toEqual({ planned: 3, completed: 2 });
  });
});

describe('this-week plans (AI "Apply to this week")', () => {
  // Saved 3-session plan (A/B/C Mon/Wed/Fri); Monday's A is done; today is Wednesday; "only twice this week".
  const setup = () => {
    const p = program(MWF, { experience: 'intermediate' });
    const sessions = [done('A', MON, MON, p.id)];
    const plan: WeekPlan = {
      kind: 'week_adjustment', id: 'msg-1', baseProgramId: p.id, baseVersion: p.currentVersion, managedBy: 'self', weekStart: MON, weekEnd: SUN, targetSessions: 2,
      completed: [{ date: MON, name: 'Full body A' }], sessions: [{ templateId: 'B', name: 'Full body B', date: THU, plannedDate: WED }],
      skipped: [{ templateId: 'C', name: 'Full body C', plannedDate: FRI }], adjustments: [], warnings: [], summary: '',
    };
    return { p, sessions, plan };
  };

  it('applies as date-specific overrides only: B moves to Thu, C is skipped, A stays done', () => {
    const { p, sessions, plan } = setup();
    expect(weekPlanState(p, plan, WED, 1)).toBe('available');
    const r = applyWeekPlan(p, plan, WED, sessions, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message).toMatch(/usual schedule returns next week/);
    const items = plannedSessionsInRange(r.program, MON, SUN, WED, sessions).map((i) => [i.date, i.template.id, i.status]);
    expect(items).toEqual([
      [MON, 'A', 'done'],
      [WED, 'B', 'moved'],
      [THU, 'B', 'planned'],
      [FRI, 'C', 'skipped'],
    ]);
    expect(r.program.overrides.every((o) => o.weekPlanId === 'msg-1')).toBe(true);
    assertOnePerDay(r.program, MON, SUN, WED, sessions);
    expect(weekPlanState(r.program, plan, WED, 1)).toBe('applied');
  });

  it('never changes baseline frequency, split, version content, inputs or completed history', () => {
    const { p, sessions, plan } = setup();
    const before = JSON.parse(JSON.stringify({ versions: p.versions, currentVersion: p.currentVersion, inputs: p.inputs, rotationIndex: p.rotationIndex, sessions }));
    const r = applyWeekPlan(p, plan, WED, sessions, 1);
    if (!r.ok) throw new Error(r.message);
    expect(JSON.parse(JSON.stringify({ versions: r.program.versions, currentVersion: r.program.currentVersion, inputs: r.program.inputs, rotationIndex: r.program.rotationIndex, sessions }))).toEqual(before);
    // Already-completed session still counts as done (adherence uses the same matching).
    expect(adherence(r.program, MON, SUN, SUN, sessions).completed).toBe(1);
  });

  it('next week reverts automatically to the usual 3-session schedule', () => {
    const { p, sessions, plan } = setup();
    const r = applyWeekPlan(p, plan, WED, sessions, 1);
    if (!r.ok) throw new Error(r.message);
    const nextMon = addDays(MON, 7);
    const next = plannedSessionsInRange(r.program, nextMon, addDays(nextMon, 6), nextMon, sessions).map((i) => [weekday(i.date), i.template.id, i.status]);
    expect(next).toEqual([
      [1, 'A', 'today'],
      [3, 'B', 'planned'],
      [5, 'C', 'planned'],
    ]);
    expect(weekPlanState(r.program, plan, nextMon, 1)).toBe('applied'); // still shows as applied (history), but…
    expect(weekPlanState(p, plan, nextMon, 1)).toBe('expired'); // …an unapplied plan can't be applied next week
    expect(applyWeekPlan(p, plan, nextMon, sessions, 1)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('is version-aware: a newer plan version (or another program) refuses it as stale', () => {
    const { p, sessions, plan } = setup();
    const v2 = withNewVersion(p, { ...p.versions[0], reason: 'coach edit' });
    expect(weekPlanState(v2, plan, WED, 1)).toBe('stale');
    expect(applyWeekPlan(v2, plan, WED, sessions, 1)).toMatchObject({ ok: false, reason: 'stale' });
    expect(applyWeekPlan({ ...p, id: 'other' }, plan, WED, sessions, 1)).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('refuses when the week changed since the suggestion (another workout logged)', () => {
    const { p, plan } = setup();
    const more = [done('A', MON, MON, p.id), done('B', WED, WED, p.id)];
    expect(applyWeekPlan(p, plan, WED, more, 1)).toMatchObject({ ok: false, reason: 'week_changed' });
  });

  it('idempotent and undoable: applying twice is a no-op; undo restores the usual week; manual overrides survive', () => {
    const { p, sessions, plan } = setup();
    const withManual = skipPlanned(p, addDays(MON, 7), 'A'); // a manual skip next week
    const r1 = applyWeekPlan(withManual, plan, WED, sessions, 1);
    if (!r1.ok) throw new Error(r1.message);
    const r2 = applyWeekPlan(r1.program, plan, WED, sessions, 1);
    expect(r2).toMatchObject({ ok: true, alreadyApplied: true });
    if (r2.ok) expect(r2.program).toBe(r1.program);
    const undone = revertWeekPlan(r1.program, plan.id);
    expect(undone.overrides).toEqual(withManual.overrides);
    expect(plannedSessionsInRange(undone, MON, SUN, WED, sessions).map((i) => i.status)).toEqual(['done', 'today', 'planned']);
  });

  it('works for a coach-managed plan (schedule only — content untouched)', () => {
    const { p, sessions, plan } = setup();
    const coach = { ...p, managedBy: { kind: 'coach' as const, coachName: 'Sam' } };
    const r = applyWeekPlan(coach, { ...plan, managedBy: 'coach' }, WED, sessions, 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.program.versions).toEqual(coach.versions);
      expect(r.program.managedBy).toEqual(coach.managedBy);
    }
  });
});
