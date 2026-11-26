/**
 * "Accept & start" at the end of onboarding: after the new plan is saved, start its first workout and open the logger.
 * Only lifting sessions with exercises are started this way; cardio, walks and mobility are logged as activities
 * instead, so they are skipped. Today's session wins; otherwise the next one in the plan (starting it early counts
 * for that planned session, as on Today).
 */
import type { ISODate, Program, WorkoutSession } from '@/domain/types';
import { alive } from '@/db/repo';
import { currentVersion } from '@/domain/program/program';
import { plannedSessionsInRange, type PlannedSession } from '@/domain/program/schedule';
import { addDays } from '@/lib/dates';
import { activeSession, startFromTemplate, type StartCtx } from '@/features/train/start';

export function firstWorkoutToStart(program: Program, today: ISODate, sessions: WorkoutSession[]): PlannedSession | null {
  const items = plannedSessionsInRange(program, today, addDays(today, 13), today, sessions);
  return items.find((i) => (i.status === 'today' || i.status === 'planned') && i.template.kind === 'lifting' && i.template.exercises.length > 0) ?? null;
}

export type FirstWorkoutResult =
  /** A new session was started from the plan's first workout. */
  | { kind: 'started'; session: WorkoutSession }
  /** Another workout is already in progress: nothing new was started (only one session can be active). */
  | { kind: 'already_active'; session: WorkoutSession }
  /** The plan has no lifting workout to start (e.g. only activities, or no scheduled days). */
  | { kind: 'none' };

export async function startFirstWorkout(program: Program, today: ISODate, ctx: StartCtx): Promise<FirstWorkoutResult> {
  const existing = await activeSession(ctx.db);
  if (existing) return { kind: 'already_active', session: existing };
  const sessions = alive(await ctx.db.sessions.toArray());
  const first = firstWorkoutToStart(program, today, sessions);
  if (!first) return { kind: 'none' };
  const session = await startFromTemplate(first.template, ctx, { programId: program.id, programVersion: currentVersion(program).version, plannedDate: first.date });
  return { kind: 'started', session };
}
