/**
 * Contextual Coach entry points (roadmap item 7): "Short on time", "Equipment busy" and "Explain this" in the workout
 * logger, and "Explain" next to a next target on the workout summary.
 *
 * Tapping one stores a small request on this device (account-scoped kv) and opens the Coach tab. The chat picks it up
 * once, builds a fresh snapshot of that workout from the local database (so it includes sets logged a second ago),
 * and sends a clear, visible message with the snapshot attached (aiApi.send `workout`). When it can't send right now
 * (offline, paused, an earlier message still pending) the text goes into the composer with the workout attached
 * instead, so nothing is lost.
 */
import type { NavigateFunction } from 'react-router';
import { kvGet, kvSet } from '@/db/repo';
import type { LiftDb } from '@/db/db';
import type { Exercise, ID, Program, WorkoutSession } from '@/domain/types';
import { elapsedMs } from '@/domain/sessionOps';
import type { WorkoutContext, WorkoutIntent } from '../../../../supabase/functions/_shared/ai/workout';

export const AI_COACH_REQUEST_KEY = 'ai-coach-request';
/** A request older than this is stale (the user moved on); it is dropped instead of sent. */
export const COACH_REQUEST_TTL_MS = 30 * 60 * 1000;
export const SHORT_ON_TIME_MINUTES = [10, 15, 20, 30, 45] as const;

export interface CoachRequest {
  intent: WorkoutIntent;
  sessionId: ID;
  /** swap / explain: the session exercise it's about. */
  focusId?: ID;
  /** shorten: minutes left. */
  minutes?: number;
  /** explain: the recommendation as the app showed it. */
  shownTarget?: string;
  createdAt: number;
  userId?: string;
}

/** Store the request and open the Coach tab (it sends it). */
export async function openCoachWith(db: LiftDb, nav: NavigateFunction, req: Omit<CoachRequest, 'createdAt'>): Promise<void> {
  await kvSet(AI_COACH_REQUEST_KEY, { ...req, createdAt: Date.now() } satisfies CoachRequest, db).catch(() => undefined);
  nav('/coach');
}

/** Read and clear the pending request (once). Stale requests and ones from another account are dropped. */
export async function takeCoachRequest(db: LiftDb, userId: string | undefined, now = Date.now()): Promise<CoachRequest | null> {
  const r = await kvGet<CoachRequest | null>(AI_COACH_REQUEST_KEY, db).catch(() => null);
  if (!r) return null;
  await kvSet(AI_COACH_REQUEST_KEY, null, db).catch(() => undefined);
  if (typeof r.createdAt !== 'number' || now - r.createdAt > COACH_REQUEST_TTL_MS || now < r.createdAt - 60_000) return null;
  if (r.userId && userId && r.userId !== userId) return null;
  return r;
}

const nameOf = (byId: Map<ID, Exercise>, id: ID) => byId.get(id)?.name ?? 'Exercise';

/** The visible message the user sends (they can read exactly what was asked). */
export function coachRequestText(req: CoachRequest, session: WorkoutSession, byId: Map<ID, Exercise>): string {
  const focus = req.focusId ? session.exercises.find((e) => e.id === req.focusId) : undefined;
  const ex = focus ? nameOf(byId, focus.exerciseId) : undefined;
  if (req.intent === 'shorten')
    return `Short on time: I have about ${req.minutes ?? 20} minutes left. Please shorten the rest of today’s workout (${session.name}).`;
  if (req.intent === 'swap')
    return `Equipment busy: the equipment for ${ex ?? 'this exercise'} is taken. What can I do instead, just for today?`;
  if (ex && req.shownTarget)
    return session.status === 'completed'
      ? `Explain this: why is my next target for ${ex} “${req.shownTarget}”?`
      : `Explain this: why does the app suggest “${req.shownTarget}” for ${ex} today?`;
  if (ex) return `Explain this: how should I approach ${ex} today, and why?`;
  return session.status === 'completed' ? 'Explain this: what do my next targets from this workout mean?' : 'Explain this: how is today’s workout going, and what should I aim for next?';
}

/** A compact, data-only snapshot of the workout (what the server's parseWorkoutContext accepts). */
export function buildWorkoutContext(req: CoachRequest, session: WorkoutSession, byId: Map<ID, Exercise>, program?: Program | null, now = Date.now()): WorkoutContext {
  const version = program && session.programId === program.id ? program.versions.find((v) => v.version === (session.programVersion ?? program.currentVersion)) : undefined;
  const template = version?.templates.find((t) => t.id === session.templateId);
  const ms = session.status === 'completed' && session.endedAt ? session.endedAt - session.startedAt - (session.pausedTotalMs ?? 0) : elapsedMs(session, now);
  return {
    sessionId: session.id,
    status: session.status,
    name: session.name.slice(0, 80),
    date: session.date,
    elapsedMin: Math.max(0, Math.round(ms / 60000)),
    intent: req.intent,
    ...(req.intent === 'shorten' && req.minutes ? { minutesLeft: req.minutes } : {}),
    ...(req.focusId && session.exercises.some((e) => e.id === req.focusId) ? { focusId: req.focusId } : {}),
    ...(req.intent === 'explain' && req.shownTarget ? { shownTarget: req.shownTarget.slice(0, 160) } : {}),
    exercises: session.exercises.slice(0, 20).map((se) => {
      const rx = se.prescription;
      const slot = rx?.slotId ? template?.exercises.find((x) => x.id === rx.slotId) : undefined;
      return {
        id: se.id,
        exerciseId: se.exerciseId,
        name: nameOf(byId, se.exerciseId).slice(0, 80),
        sets: se.sets.slice(0, 15).map((x) => ({
          type: x.type,
          done: x.completed,
          ...(x.weightKg != null ? { weightKg: x.weightKg } : {}),
          ...(x.reps != null ? { reps: x.reps } : {}),
          ...(x.durationSec != null ? { durationSec: x.durationSec } : {}),
        })),
        ...(rx ? { target: { sets: rx.sets, repMin: rx.repMin, repMax: rx.repMax, targetRir: rx.targetRir, restSec: rx.restSec, ...(rx.durationSec ? { durationSec: rx.durationSec } : {}) } } : {}),
        ...(slot ? { priority: slot.priority } : {}),
        ...(se.discomfort ? { discomfort: true } : {}),
      };
    }),
  };
}

/** Load the session (and its plan, for slot priorities) and build the message + snapshot. null: the workout is gone. */
export async function prepareCoachRequest(db: LiftDb, req: CoachRequest, byId: Map<ID, Exercise>): Promise<{ text: string; workout: WorkoutContext } | null> {
  const session = await db.sessions.get(req.sessionId).catch(() => undefined);
  if (!session || session.deletedAt) return null;
  const program = session.programId ? await db.programs.get(session.programId).catch(() => undefined) : undefined;
  return { text: coachRequestText(req, session, byId), workout: buildWorkoutContext(req, session, byId, program ?? null) };
}
