/**
 * App-rendered AI coach welcome (pure builder) and the client parser for stored this-week plans.
 * No AI provider involved (the welcome is deterministic by design).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/supabase', () => ({ backendConfigured: false, requireSupabase: () => { throw new Error('no backend in tests'); } }));

import { toWeekPlan } from '@/backend/ai';
import { createProgram } from '@/domain/program/program';
import type { Program, ProgramVersion, WorkoutSession } from '@/domain/types';
import { buildWelcome } from '@/features/coaching/ai/welcome';

const ALL = { profile: true, training: true, measurements: false, nutrition: false };
const WED = '2026-10-28';

function plan(managedBy?: Program['managedBy']): Program {
  const t = (id: string, name: string) => ({ id, name, focus: name, kind: 'lifting' as const, estimatedMinutes: 45, exercises: [] });
  const v: ProgramVersion = {
    version: 1, createdAt: 0, reason: 't', templates: [t('A', 'Full body A'), t('B', 'Full body B'), t('C', 'Full body C')],
    schedule: [{ weekday: 1, templateId: 'A' }, { weekday: 3, templateId: 'B' }, { weekday: 5, templateId: 'C' }], weeks: 8, reviewWeek: 8, rationale: [], warnings: [],
  };
  const p = createProgram(null, v, '2026-10-05', 'Full body 3x', 'generated');
  return managedBy ? { ...p, managedBy } : p;
}
const done = (p: Program, templateId: string, date: string): WorkoutSession => ({
  id: `${templateId}${date}`, createdAt: 0, updatedAt: 0, name: templateId, status: 'completed', programId: p.id, templateId, plannedDate: date, date, timeZone: 'UTC', startedAt: 0, pausedTotalMs: 0, exercises: [],
});

describe('buildWelcome (deterministic, permitted facts only)', () => {
  it('states plan, frequency and this week’s real status', () => {
    const p = plan();
    const w = buildWelcome({ scopes: ALL, goal: 'strength', program: p, sessions: [done(p, 'A', '2026-10-26')], today: WED, weekStart: 1 });
    expect(w.lines).toEqual(['Goal: strength. You’re on “Full body 3x” — 3 sessions a week (Mon, Wed, Fri).', 'This week: 1 of 3 done (Full body A, Mon). Next: Full body B, today.']);
    const words = [w.greeting, ...w.lines, w.closing].join(' ').split(/\s+/).length;
    expect(words).toBeLessThanOrEqual(60); // brief
  });

  it('no workouts yet: says none done, never claims a review', () => {
    const w = buildWelcome({ scopes: ALL, program: plan(), sessions: [], today: '2026-10-26', weekStart: 1 });
    expect(w.lines[1]).toBe('This week: 3 planned, none done yet. Next: Full body A, today.');
    expect(JSON.stringify(w)).not.toMatch(/reviewed|looked at|your workouts show/i);
  });

  it('coach-managed plan is named as such; all done is reported', () => {
    const p = plan({ kind: 'coach', coachName: 'Sam' });
    const w = buildWelcome({ scopes: ALL, program: p, sessions: [done(p, 'A', '2026-10-26'), done(p, 'B', '2026-10-28'), done(p, 'C', '2026-10-30')], today: '2026-10-31', weekStart: 1 });
    expect(w.lines[0]).toContain('(managed by Sam)');
    expect(w.lines[1]).toBe('This week: all 3 planned sessions done.');
  });

  it('no active plan / profile not shared', () => {
    expect(buildWelcome({ scopes: ALL, goal: 'lose_fat', program: null, sessions: [], today: WED, weekStart: 1 }).lines).toEqual(['Your goal: lose fat. You don’t have an active plan yet — I can help you pick a starting point.']);
    const w = buildWelcome({ scopes: { ...ALL, profile: false }, goal: 'lose_fat', program: plan(), sessions: [], today: WED, weekStart: 1 });
    expect(JSON.stringify(w)).not.toMatch(/lose fat/i);
  });
});

describe('toWeekPlan (client parse of a stored action)', () => {
  const good = {
    kind: 'week_adjustment', id: 'm1', baseProgramId: 'p1', baseVersion: 2, weekStart: '2026-10-26', weekEnd: '2026-11-01', targetSessions: 2,
    completed: [{ date: '2026-10-26', name: 'A' }], sessions: [{ templateId: 'B', name: 'B', date: '2026-10-29', plannedDate: '2026-10-28' }], skipped: [], adjustments: ['x'], warnings: [], summary: '',
  };
  it('accepts a well-formed action and rejects malformed or unknown ones', () => {
    expect(toWeekPlan(good)).toMatchObject({ id: 'm1', sessions: [{ templateId: 'B', date: '2026-10-29' }], managedBy: 'self' });
    expect(toWeekPlan({ ...good, kind: 'rewrite_plan' })).toBeNull();
    expect(toWeekPlan({ ...good, baseVersion: '2' })).toBeNull();
    expect(toWeekPlan({ ...good, sessions: [{ templateId: 'B', date: 'Thursday', plannedDate: '2026-10-28' }] })).toBeNull();
    expect(toWeekPlan(null)).toBeNull();
  });
});
