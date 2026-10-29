/** Ways to begin a workout. Only one session can be active at a time. */
import type { Exercise, ID, ISODate, SessionTemplate, Settings, WorkoutSession } from '@/domain/types';
import type { LiftDb } from '@/db/db';
import { alive, saveRecord } from '@/db/repo';
import { buildSessionFromTemplate } from '@/domain/program/session';
import { uuid } from '@/lib/id';
import { todayISO } from '@/lib/dates';

export async function activeSession(db: LiftDb): Promise<WorkoutSession | undefined> {
  return db.sessions.where('status').equals('active').filter((s) => !s.deletedAt).first();
}

export async function completedHistory(db: LiftDb): Promise<WorkoutSession[]> {
  return alive(await db.sessions.where('status').equals('completed').toArray()).sort((a, b) => b.startedAt - a.startedAt);
}

export interface StartCtx {
  db: LiftDb;
  settings: Settings;
  catalog: Exercise[];
}

/** Lifting template → active session. Cardio/walk/mobility templates are logged as activities instead. */
export async function startFromTemplate(
  t: SessionTemplate,
  ctx: StartCtx,
  meta: { programId?: ID; programVersion?: number; plannedDate?: ISODate } = {},
): Promise<WorkoutSession> {
  const existing = await activeSession(ctx.db);
  if (existing) return existing;
  const history = await completedHistory(ctx.db);
  const tz = ctx.settings.timeZone;
  const session = buildSessionFromTemplate(t, {
    catalog: ctx.catalog,
    history,
    settings: ctx.settings,
    programId: meta.programId,
    programVersion: meta.programVersion,
    plannedDate: meta.plannedDate,
    date: todayISO(tz),
    timeZone: tz,
  });
  session.templateId = t.id;
  return saveRecord('sessions', session, ctx.db);
}

const pos = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? v : null);
const pos0 = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v >= 0 ? v : null);

/** Repeat a past workout: same exercises and loads, nothing completed. */
export async function repeatSession(past: WorkoutSession, ctx: StartCtx): Promise<WorkoutSession> {
  const existing = await activeSession(ctx.db);
  if (existing) return existing;
  const now = Date.now();
  const tz = ctx.settings.timeZone;
  const s: WorkoutSession = {
    id: uuid(),
    createdAt: now,
    updatedAt: now,
    name: past.name,
    status: 'active',
    templateId: past.templateId,
    date: todayISO(tz),
    timeZone: tz,
    startedAt: now,
    pausedTotalMs: 0,
    exercises: past.exercises.map((e, i) => ({
      id: uuid(),
      exerciseId: e.exerciseId,
      order: i,
      supersetGroup: e.supersetGroup,
      prescription: e.prescription,
      // Copy loads and targets, but never copy invalid values (0 reps, negative/non-finite numbers) forward.
      sets: e.sets.map((st) => ({
        ...st,
        id: uuid(),
        weightKg: pos0(st.weightKg),
        entered: pos0(st.weightKg) == null ? undefined : st.entered,
        reps: pos(st.reps),
        durationSec: pos(st.durationSec),
        distanceM: pos(st.distanceM),
        completed: false,
        completedAt: undefined,
        rpe: null,
        rir: null,
      })),
    })),
  };
  return saveRecord('sessions', s, ctx.db);
}

export async function startEmpty(ctx: StartCtx, name = 'Workout'): Promise<WorkoutSession> {
  const existing = await activeSession(ctx.db);
  if (existing) return existing;
  const now = Date.now();
  const tz = ctx.settings.timeZone;
  return saveRecord(
    'sessions',
    { id: uuid(), createdAt: now, updatedAt: now, name, status: 'active', date: todayISO(tz), timeZone: tz, startedAt: now, pausedTotalMs: 0, exercises: [] },
    ctx.db,
  );
}

/** Query string for logging a non-lifting planned session as an activity. */
export function activityLinkFor(t: SessionTemplate, date?: ISODate): string {
  const p = new URLSearchParams();
  p.set('type', t.cardio?.activity ?? (t.kind === 'mobility' ? 'mobility' : t.kind === 'walk' ? 'walk' : 'custom'));
  if (t.cardio?.minutes) p.set('duration', String(t.cardio.minutes * 60));
  else if (t.estimatedMinutes) p.set('duration', String(t.estimatedMinutes * 60));
  p.set('notes', t.cardio?.notes ?? t.name);
  if (date) p.set('date', date);
  return `/train/activity/new?${p}`;
}
