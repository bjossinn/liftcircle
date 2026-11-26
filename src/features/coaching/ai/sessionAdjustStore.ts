/**
 * Applying a training assistant `session_adjustment` to the live workout on this device, and undoing it (roadmap item 7).
 * Only the one WorkoutSession record is written (saveRecord → synced like any edit); programs are never touched.
 * Undo records live in account-scoped kv, keyed by the action id, so the chat card and the workout screen's
 * "Changed by your coach · Undo" banner share them. Records for other or finished workouts are pruned after 2 days.
 */
import type { LiftDb } from '@/db/db';
import { kvGet, kvSet, saveRecord } from '@/db/repo';
import type { Exercise, ID, WorkoutSession } from '@/domain/types';
import { applySessionAdjustment, revertSessionAdjustment, type SessionAdjustmentUndo } from '@/domain/sessionAdjust';
import type { SessionAdjustmentAction } from '../../../../supabase/functions/_shared/ai/workout';

export const AI_SESSION_ADJUST_KEY = 'ai-session-adjustments';
const KEEP_MS = 2 * 24 * 60 * 60 * 1000;

export type AdjustRecord = SessionAdjustmentUndo & { revertedAt?: number; summary: string[] };
export type AdjustRecords = Record<string, AdjustRecord>;

export async function loadAdjustRecords(db: LiftDb): Promise<AdjustRecords> {
  const r = await kvGet<AdjustRecords>(AI_SESSION_ADJUST_KEY, db).catch(() => undefined);
  return r && typeof r === 'object' ? r : {};
}

async function saveRecords(db: LiftDb, recs: AdjustRecords, now = Date.now()) {
  const kept = Object.fromEntries(Object.entries(recs).filter(([, r]) => now - r.appliedAt < KEEP_MS));
  await kvSet(AI_SESSION_ADJUST_KEY, kept, db);
}

/** The latest applied (not undone) change for a workout, for the logger's banner. */
export function activeRecordFor(recs: AdjustRecords | undefined, sessionId: ID): AdjustRecord | null {
  return Object.values(recs ?? {}).filter((r) => r.sessionId === sessionId && !r.revertedAt).sort((a, b) => b.appliedAt - a.appliedAt)[0] ?? null;
}

/** Apply to the stored workout. Applying an action that is already applied (and not undone) is a no-op. */
export async function applyAdjustment(db: LiftDb, action: SessionAdjustmentAction, byId: Map<ID, Exercise>, summary: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  const recs = await loadAdjustRecords(db);
  const prev = recs[action.id];
  if (prev && !prev.revertedAt) return { ok: true };
  const session = await db.sessions.get(action.sessionId);
  if (!session) return { ok: false, reason: 'This workout is no longer on this device.' };
  const res = applySessionAdjustment(session, action, byId);
  if (!res.ok) return res;
  await saveRecord('sessions', res.session, db);
  await saveRecords(db, { ...recs, [action.id]: { ...res.undo, summary } });
  return { ok: true };
}

/** Undo from the chat card or the logger banner (the logger passes its own serialized writer via `write`). */
export async function revertAdjustment(
  db: LiftDb,
  actionId: string,
  write?: (fn: (s: WorkoutSession) => WorkoutSession | null) => Promise<boolean>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const recs = await loadAdjustRecords(db);
  const rec = recs[actionId];
  if (!rec || rec.revertedAt) return { ok: true };
  let failure: string | null = null;
  if (write) {
    let ran = false;
    const saved = await write((s) => {
      ran = true;
      const r = revertSessionAdjustment(s, rec);
      if (!r.ok) {
        failure = r.reason;
        return null;
      }
      return r.session;
    });
    if (!ran && !failure) failure = 'This workout is already finished, so it can’t be undone here.';
    if (!saved && !failure) failure = 'Couldn’t save that change on this device.';
  } else {
    const session = await db.sessions.get(rec.sessionId);
    const r = session ? revertSessionAdjustment(session, rec) : ({ ok: false, reason: 'This workout is no longer on this device.' } as const);
    if (!r.ok) failure = r.reason;
    else await saveRecord('sessions', r.session, db);
  }
  if (failure) return { ok: false, reason: failure };
  await saveRecords(db, { ...recs, [actionId]: { ...rec, revertedAt: Date.now() } });
  return { ok: true };
}
