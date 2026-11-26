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
import { getLanguage, t, type Language } from '@/i18n';
import type { WorkoutContext, WorkoutIntent } from '../../../../supabase/functions/_shared/ai/workout';

export const AI_COACH_REQUEST_KEY = 'ai-coach-request';
/** A request waiting in the composer ("Today's workout attached"), kept until it's sent or removed. */
export const AI_ATTACHED_REQUEST_KEY = 'ai-attached-request';
/** Which parts of the composer draft the app generated for a contextual request (DraftProvenance). */
export const AI_DRAFT_GENERATED_KEY = 'ai-draft-generated';
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
  /** A request waiting in the composer: the message text written for it (removed if Training sharing is turned off). */
  text?: string;
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

/** The attachment waiting in the composer, if it belongs to this account (no expiry: the user put it there). */
export async function loadAttachedRequest(db: LiftDb, userId: string | undefined): Promise<CoachRequest | null> {
  const r = await kvGet<CoachRequest | null>(AI_ATTACHED_REQUEST_KEY, db).catch(() => null);
  if (!r || typeof r.sessionId !== 'string') return null;
  if (r.userId && userId && r.userId !== userId) return null;
  return r;
}

/** Exercise name for the data snapshot (catalog content, never translated). */
const nameOf = (byId: Map<ID, Exercise>, id: ID) => byId.get(id)?.name ?? 'Exercise';

/**
 * The visible message the user sends (they can read exactly what was asked), in the app language. Catalog/session
 * names go into placeholders unchanged. The typed `req.intent` (not this text) tells the server what was asked.
 */
export function coachRequestText(req: CoachRequest, session: WorkoutSession, byId: Map<ID, Exercise>, language: Language = getLanguage()): string {
  const focus = req.focusId ? session.exercises.find((e) => e.id === req.focusId) : undefined;
  const ex = focus ? (byId.get(focus.exerciseId)?.name ?? t('aiServer.context.exerciseFallback', undefined, language)) : undefined;
  if (req.intent === 'shorten') return t('aiServer.context.shorten', { minutes: req.minutes ?? 20, sessionName: session.name }, language);
  if (req.intent === 'swap') return t('aiServer.context.swap', { exerciseName: ex ?? t('aiServer.context.thisExercise', undefined, language) }, language);
  if (ex && req.shownTarget)
    return t(session.status === 'completed' ? 'aiServer.context.explainCompleted' : 'aiServer.context.explainActive', { exerciseName: ex, shownTarget: req.shownTarget }, language);
  if (ex) return t('aiServer.context.explainExercise', { exerciseName: ex }, language);
  return t(session.status === 'completed' ? 'aiServer.context.explainCompletedGeneric' : 'aiServer.context.explainActiveGeneric', undefined, language);
}

/* ------------------------------------------------------- generated-text provenance */
/** [start, end) character ranges of a text. */
export type TextRanges = [number, number][];

/**
 * Which parts of the composer draft the app generated (a contextual request names exercises and targets), so turning
 * Training sharing off removes exactly those and keeps what the user wrote — in any language, after edits and reloads.
 * Valid only while `draft` is the current draft.
 */
export interface DraftProvenance {
  draft: string;
  generated: TextRanges;
  /** The generated texts themselves (a chunk of one pasted back, or restored by undo, counts as generated again). */
  sources: string[];
  userId?: string;
  /**
   * The whole draft is held back: an older version's edited workout question that can't be split into generated and
   * user-written parts. Kept on the device, never stripped, and not sendable while Training isn't shared.
   */
  held?: boolean;
}

function mergeRanges(r: TextRanges, max: number): TextRanges {
  const sorted = r
    .map(([a, b]) => [Math.max(0, Math.min(a, max)), Math.max(0, Math.min(b, max))] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: TextRanges = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** A pasted/restored chunk this long that is part of a generated text counts as generated, not as the user's own. */
const REINSERT_MIN = 12;

/**
 * The generated ranges after the draft changed from `prev` to `next` (one edit, as a text field reports it):
 * characters before and after the changed span keep their origin; what the user typed or pasted there is theirs.
 */
export function trackDraftEdit(prev: string, next: string, generated: TextRanges, sources: string[] = []): TextRanges {
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev[p] === next[p]) p++;
  let s = 0;
  while (s < max - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  const prevEnd = prev.length - s;
  const delta = next.length - prev.length;
  const out: TextRanges = [];
  for (const [a, b] of generated) {
    if (a < p) out.push([a, Math.min(b, p)]);
    if (b > prevEnd) out.push([Math.max(a, prevEnd) + delta, b + delta]);
  }
  const inserted = next.slice(p, next.length - s);
  if (inserted.trim().length >= REINSERT_MIN && sources.some((src) => src.includes(inserted))) out.push([p, p + inserted.length]);
  return mergeRanges(out, next.length);
}

/** The draft without its generated parts: only what the user wrote (runs kept in order, never rewritten). */
export function stripGenerated(text: string, generated: TextRanges, sources: string[] = []): string {
  const ranges = mergeRanges(generated, text.length);
  const runs: string[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) runs.push(text.slice(at, a));
    at = b;
  }
  if (at < text.length) runs.push(text.slice(at));
  let out = '';
  for (const run of runs) out += out && !/\s$/.test(out) && !/^\s/.test(run) && run.trim() ? ` ${run}` : run;
  // Belt and braces: a whole generated text never survives.
  for (const src of sources) if (src) out = out.split(src).join('');
  return out.trim();
}

/** Offsets of `generated` (relative to `text`) after `text` was trimmed. */
export function rangesAfterTrim(text: string, generated: TextRanges): TextRanges {
  const lead = text.length - text.trimStart().length;
  const len = text.trim().length;
  return mergeRanges(generated.map(([a, b]) => [a - lead, b - lead]), len);
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
