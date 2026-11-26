/**
 * Roadmap item 7, app side: applying a training assistant `session_adjustment` to the live workout and undoing it
 * (src/domain/sessionAdjust.ts, ai/sessionAdjustStore.ts), the workout snapshot and visible message built for a
 * contextual request (ai/workoutContext.ts), and the defensive parse of a stored action (backend/ai.ts).
 * Real Dexie (fake-indexeddb): the saved program and its templates must stay byte-for-byte the same.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiftDb } from '@/db/db';
import { kvGet, saveRecord } from '@/db/repo';
import { EXERCISES } from '@/data/exercises';
import { createProgram } from '@/domain/program/program';
import { applySessionAdjustment, adjustmentLines, revertSessionAdjustment } from '@/domain/sessionAdjust';
import * as ops from '@/domain/sessionOps';
import type { Exercise, LoggedSet, Program, ProgramVersion, SessionExercise, WorkoutSession } from '@/domain/types';
import { toSessionAdjustment } from '@/backend/ai';
import { activeRecordFor, AI_SESSION_ADJUST_KEY, applyAdjustment, loadAdjustRecords, revertAdjustment } from '@/features/coaching/ai/sessionAdjustStore';
import {
  AI_COACH_REQUEST_KEY, buildWorkoutContext, coachRequestText, openCoachWith, prepareCoachRequest, takeCoachRequest, type CoachRequest,
} from '@/features/coaching/ai/workoutContext';
import { parseWorkoutContext, type SessionAdjustmentAction } from '../../supabase/functions/_shared/ai/workout';

const byId = new Map<string, Exercise>(EXERCISES.map((e) => [e.id, e]));
const pick = (pred: (e: Exercise) => boolean) => EXERCISES.find(pred)!;
const BENCH = pick((e) => e.id === 'barbell-bench-press');
const DB_BENCH = pick((e) => e.id === 'dumbbell-bench-press');
const ROW = pick((e) => e.tracking === 'weight_reps' && e.id !== BENCH.id && e.id !== DB_BENCH.id && /row/i.test(e.name));
const RAISE = pick((e) => /lateral raise/i.test(e.name));

let n = 0;
const s = (completed: boolean, type: LoggedSet['type'] = 'normal'): LoggedSet => ({ id: `set-${++n}`, type, weightKg: completed ? 60 : null, reps: completed ? 10 : null, completed });
const rx = (sets: number, slotId: string) => ({ sets, repMin: 8, repMax: 12, targetRir: 2, restSec: 90, slotId });
function ex(id: string, e: Exercise, sets: LoggedSet[], slotId: string, order: number): SessionExercise {
  return { id, exerciseId: e.id, order, sets, prescription: rx(sets.filter((x) => x.type !== 'warmup').length, slotId) };
}

function plan(): Program {
  const v: ProgramVersion = {
    version: 1, createdAt: 0, reason: 'test', weeks: 8, reviewWeek: 8, rationale: [], warnings: [], schedule: [{ weekday: 6, templateId: 'tA' }],
    templates: [{
      id: 'tA', name: 'Push A', focus: 'Push', kind: 'lifting', estimatedMinutes: 60,
      exercises: [
        { id: 'slot-bench', exerciseId: BENCH.id, sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 120, warmup: '', priority: 1, alternatives: [] },
        { id: 'slot-row', exerciseId: ROW.id, sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 90, warmup: '', priority: 2, alternatives: [] },
        { id: 'slot-raise', exerciseId: RAISE.id, sets: 3, repMin: 12, repMax: 15, targetRir: 1, restSec: 60, warmup: '', priority: 3, alternatives: [] },
      ],
    }],
  };
  return createProgram(null, v, '2026-11-01', 'Push Pull', 'generated');
}

function liveSession(p: Program): WorkoutSession {
  return {
    id: 'sess-live', createdAt: 0, updatedAt: 0, name: 'Push A', status: 'active', programId: p.id, programVersion: 1, templateId: 'tA', date: '2026-11-28', timeZone: 'UTC',
    startedAt: Date.now() - 25 * 60_000, pausedTotalMs: 0,
    exercises: [
      ex('se-bench', BENCH, [s(true, 'warmup'), s(true), s(true), s(false)], 'slot-bench', 0),
      ex('se-row', ROW, [s(false), s(false), s(false)], 'slot-row', 1),
      ex('se-raise', RAISE, [s(false), s(false), s(false)], 'slot-raise', 2),
    ],
  };
}

const shorten = (over: Partial<SessionAdjustmentAction> = {}): SessionAdjustmentAction => ({
  kind: 'session_adjustment', id: 'msg-1', sessionId: 'sess-live', change: 'shorten', minutes: 12, estimatedMinutes: 11,
  removeSets: [{ sessionExerciseId: 'se-row', name: ROW.name, count: 1 }], dropExercises: [{ sessionExerciseId: 'se-raise', name: RAISE.name }], summary: '', warnings: [], ...over,
});
const swap = (over: Partial<SessionAdjustmentAction> = {}): SessionAdjustmentAction => ({
  kind: 'session_adjustment', id: 'msg-2', sessionId: 'sess-live', change: 'swap', removeSets: [], dropExercises: [], summary: '', warnings: [],
  swap: { sessionExerciseId: 'se-row', fromExerciseId: ROW.id, fromName: ROW.name, toExerciseId: DB_BENCH.id, toName: DB_BENCH.name }, ...over,
});

/* ================================================================== pure apply / undo */
describe('applySessionAdjustment / revertSessionAdjustment (pure)', () => {
  it('shorten: drops pending sets from the end and unstarted exercises; completed sets untouched; undo restores exactly', () => {
    const before = liveSession(plan());
    const r = applySessionAdjustment(before, shorten(), byId);
    if (!r.ok) throw new Error(r.reason);
    expect(r.session.exercises.map((e) => e.id)).toEqual(['se-bench', 'se-row']);
    expect(r.session.exercises[1].sets).toHaveLength(2);
    expect(r.session.exercises[0]).toEqual(before.exercises[0]);
    expect(r.session.exercises.map((e) => e.order)).toEqual([0, 1]);
    const back = revertSessionAdjustment(r.session, r.undo);
    if (!back.ok) throw new Error(back.reason);
    expect(back.session.exercises).toEqual(before.exercises);
  });

  it('shorten: an exercise that got a completed set since the suggestion keeps it (only pending sets go)', () => {
    const cur = liveSession(plan());
    cur.exercises[2].sets[0] = { ...cur.exercises[2].sets[0], completed: true, weightKg: 8, reps: 12 };
    const r = applySessionAdjustment(cur, shorten(), byId);
    if (!r.ok) throw new Error(r.reason);
    const raise = r.session.exercises.find((e) => e.id === 'se-raise')!;
    expect(raise.sets.map((x) => x.completed)).toEqual([true]);
  });

  it('undo after more sets were logged keeps those sets', () => {
    const r = applySessionAdjustment(liveSession(plan()), shorten(), byId);
    if (!r.ok) throw new Error(r.reason);
    const row = r.session.exercises[1];
    const logged = ops.toggleSetComplete(r.session, row.id, row.sets[0].id, Date.now()).session;
    const back = revertSessionAdjustment(logged, r.undo);
    if (!back.ok) throw new Error(back.reason);
    expect(back.session.exercises.map((e) => e.id)).toEqual(['se-bench', 'se-row', 'se-raise']);
    expect(back.session.exercises[1].sets).toHaveLength(3);
    expect(back.session.exercises[1].sets[0].completed).toBe(true);
  });

  it('swap with no completed sets: in place, rebuilt for the new exercise, swappedFrom recorded; undo restores the original', () => {
    const before = liveSession(plan());
    const r = applySessionAdjustment(before, swap(), byId);
    if (!r.ok) throw new Error(r.reason);
    const row = r.session.exercises[1];
    expect(row.id).toBe('se-row');
    expect(row.exerciseId).toBe(DB_BENCH.id);
    expect(row.swappedFrom).toBe(ROW.id);
    const back = revertSessionAdjustment(r.session, r.undo);
    if (!back.ok) throw new Error(back.reason);
    expect(back.session.exercises).toEqual(before.exercises);
  });

  it('swap with completed sets: they stay; the remaining sets move to the new exercise right after it; undo merges back', () => {
    const before = liveSession(plan());
    const r = applySessionAdjustment(before, swap({ swap: { sessionExerciseId: 'se-bench', fromExerciseId: BENCH.id, fromName: BENCH.name, toExerciseId: DB_BENCH.id, toName: DB_BENCH.name } }), byId);
    if (!r.ok) throw new Error(r.reason);
    expect(r.session.exercises.map((e) => e.exerciseId)).toEqual([BENCH.id, DB_BENCH.id, ROW.id, RAISE.id]);
    expect(r.session.exercises[0].sets.every((x) => x.completed)).toBe(true);
    expect(r.session.exercises[1].sets.filter((x) => x.type !== 'warmup')).toHaveLength(1);
    expect(r.session.exercises.map((e) => e.order)).toEqual([0, 1, 2, 3]);
    const back = revertSessionAdjustment(r.session, r.undo);
    if (!back.ok) throw new Error(back.reason);
    expect(back.session.exercises).toEqual(before.exercises);
  });

  it('undo refuses once a set was logged on the swapped-in exercise; apply refuses a finished or different workout', () => {
    const r = applySessionAdjustment(liveSession(plan()), swap(), byId);
    if (!r.ok) throw new Error(r.reason);
    const row = r.session.exercises[1];
    const logged = ops.updateSet(r.session, row.id, row.sets.find((x) => x.type !== 'warmup')!.id, { completed: true, weightKg: 20, reps: 10 });
    const back = revertSessionAdjustment(logged, r.undo);
    expect(back.ok).toBe(false);
    expect(!back.ok && back.reason).toMatch(/logged sets on the new exercise/);
    const done = { ...liveSession(plan()), status: 'completed' as const };
    expect(applySessionAdjustment(done, shorten(), byId)).toMatchObject({ ok: false, reason: expect.stringMatching(/already finished/) });
    expect(applySessionAdjustment(liveSession(plan()), shorten({ sessionId: 'other' }), byId)).toMatchObject({ ok: false });
    // Already swapped (e.g. applied on another device): out of date, not applied twice.
    expect(applySessionAdjustment(r.session, swap(), byId)).toMatchObject({ ok: false, reason: expect.stringMatching(/already changed/) });
  });

  it('preview lines describe exactly what changes', () => {
    expect(adjustmentLines(shorten())).toEqual([`Skip ${RAISE.name}`, `${ROW.name}: 1 fewer set`]);
    expect(adjustmentLines(swap())).toEqual([`${ROW.name} → ${DB_BENCH.name}`]);
  });
});

/* ================================================================== on the device (Dexie) */
describe('apply / undo on the device', () => {
  let db: LiftDb;
  beforeEach(() => {
    db = new LiftDb(`session-adjust-${++n}`);
  });
  afterEach(async () => {
    await db.delete();
  });

  it('Apply changes only today’s session (program template untouched); Undo restores it; applying twice is a no-op', async () => {
    const p = await saveRecord('programs', plan(), db);
    const programBefore = structuredClone(await db.programs.get(p.id));
    const before = await saveRecord('sessions', liveSession(p), db);

    expect(await applyAdjustment(db, shorten(), byId, ['x'])).toEqual({ ok: true });
    const after = (await db.sessions.get(before.id))!;
    expect(after.exercises.map((e) => e.id)).toEqual(['se-bench', 'se-row']);
    expect(await db.programs.get(p.id)).toEqual(programBefore); // the saved plan never changes
    expect(await db.programs.count()).toBe(1);
    expect(activeRecordFor(await loadAdjustRecords(db), before.id)).toMatchObject({ actionId: 'msg-1', summary: ['x'] });
    // The session edit is queued for sync like any other edit; nothing for programs.
    const outbox = await db.outbox.toArray();
    expect(outbox.filter((o) => (o as { entity?: string }).entity === 'programs')).toHaveLength(1); // only the seed save above
    expect(outbox.filter((o) => (o as { entity?: string }).entity === 'sessions').length).toBeGreaterThanOrEqual(1);

    expect(await applyAdjustment(db, shorten(), byId, ['x'])).toEqual({ ok: true });
    expect((await db.sessions.get(before.id))!.exercises).toHaveLength(2);

    expect(await revertAdjustment(db, 'msg-1')).toEqual({ ok: true });
    expect((await db.sessions.get(before.id))!.exercises).toEqual(before.exercises);
    expect(await db.programs.get(p.id)).toEqual(programBefore);
    expect(activeRecordFor(await loadAdjustRecords(db), before.id)).toBeNull();
    expect((await kvGet<Record<string, { revertedAt?: number }>>(AI_SESSION_ADJUST_KEY, db))!['msg-1'].revertedAt).toBeTypeOf('number');
  });

  it('a swap is applied and undone on the device the same way', async () => {
    const p = await saveRecord('programs', plan(), db);
    const programBefore = structuredClone(await db.programs.get(p.id));
    const before = await saveRecord('sessions', liveSession(p), db);
    expect(await applyAdjustment(db, swap(), byId, [])).toEqual({ ok: true });
    expect((await db.sessions.get(before.id))!.exercises[1].exerciseId).toBe(DB_BENCH.id);
    expect(await revertAdjustment(db, 'msg-2')).toEqual({ ok: true });
    expect((await db.sessions.get(before.id))!.exercises).toEqual(before.exercises);
    expect(await db.programs.get(p.id)).toEqual(programBefore);
  });

  it('a finished workout can’t be changed', async () => {
    const p = await saveRecord('programs', plan(), db);
    await saveRecord('sessions', { ...liveSession(p), status: 'completed', endedAt: Date.now() }, db);
    expect(await applyAdjustment(db, shorten(), byId, [])).toMatchObject({ ok: false, reason: expect.stringMatching(/already finished/) });
    expect(await applyAdjustment(db, shorten({ sessionId: 'gone' }), byId, [])).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer on this device/) });
  });
});

/* ================================================================== contextual requests */
describe('contextual requests (workout → Coach)', () => {
  let db: LiftDb;
  beforeEach(() => {
    db = new LiftDb(`coach-request-${++n}`);
  });
  afterEach(async () => {
    await db.delete();
  });

  it('the snapshot carries targets, done sets and plan priorities, and passes the server’s parser unchanged', () => {
    const p = plan();
    const sess = liveSession(p);
    const req: CoachRequest = { intent: 'shorten', sessionId: sess.id, minutes: 20, createdAt: Date.now() };
    const w = buildWorkoutContext(req, sess, byId, p);
    expect(w).toMatchObject({ sessionId: 'sess-live', status: 'active', name: 'Push A', intent: 'shorten', minutesLeft: 20 });
    expect(w.elapsedMin).toBeGreaterThanOrEqual(24);
    expect(w.exercises.map((e) => [e.id, e.priority])).toEqual([['se-bench', 1], ['se-row', 2], ['se-raise', 3]]);
    expect(w.exercises[0].sets.map((x) => x.done)).toEqual([true, true, true, false]);
    expect(w.exercises[0].target).toEqual({ sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 90 });
    expect(parseWorkoutContext(JSON.parse(JSON.stringify(w)))).toEqual(w);
  });

  it('the visible message says what was asked', () => {
    const sess = liveSession(plan());
    const t = (r: Partial<CoachRequest>) => coachRequestText({ sessionId: sess.id, createdAt: 0, intent: 'shorten', ...r }, sess, byId);
    expect(t({ minutes: 15 })).toBe('Short on time: I have about 15 minutes left. Please shorten the rest of today’s workout (Push A).');
    expect(t({ intent: 'swap', focusId: 'se-row' })).toBe(`Equipment busy: the equipment for ${ROW.name} is taken. What can I do instead, just for today?`);
    expect(t({ intent: 'explain', focusId: 'se-bench', shownTarget: 'Add weight → 62.5 kg × 8' })).toBe(`Explain this: why does the app suggest “Add weight → 62.5 kg × 8” for ${BENCH.name} today?`);
    const done = { ...sess, status: 'completed' as const };
    expect(coachRequestText({ sessionId: sess.id, createdAt: 0, intent: 'explain', focusId: 'se-bench', shownTarget: '62.5 kg × 8 (Add weight)' }, done, byId)).toBe(
      `Explain this: why is my next target for ${BENCH.name} “62.5 kg × 8 (Add weight)”?`,
    );
  });

  it('openCoachWith stores the request and opens /coach; it is taken once, never for another account or when stale', async () => {
    const p = await saveRecord('programs', plan(), db);
    await saveRecord('sessions', liveSession(p), db);
    const paths: string[] = [];
    await openCoachWith(db, ((to: string) => paths.push(to)) as never, { intent: 'shorten', sessionId: 'sess-live', minutes: 15, userId: 'u1' });
    expect(paths).toEqual(['/coach']);
    expect(await takeCoachRequest(db, 'u2')).toBeNull(); // another account: dropped
    await openCoachWith(db, (() => undefined) as never, { intent: 'shorten', sessionId: 'sess-live', minutes: 15, userId: 'u1' });
    const req = await takeCoachRequest(db, 'u1');
    expect(req).toMatchObject({ intent: 'shorten', minutes: 15 });
    expect(await takeCoachRequest(db, 'u1')).toBeNull(); // once
    await openCoachWith(db, (() => undefined) as never, { intent: 'swap', sessionId: 'sess-live', focusId: 'se-row' });
    expect(await takeCoachRequest(db, 'u1', Date.now() + 31 * 60_000)).toBeNull(); // stale
    expect(await kvGet(AI_COACH_REQUEST_KEY, db)).toBeNull();
    const prepared = await prepareCoachRequest(db, req!, byId);
    expect(prepared?.text).toMatch(/^Short on time/);
    expect(prepared?.workout.exercises.find((e) => e.id === 'se-raise')?.priority).toBe(3);
    expect(await prepareCoachRequest(db, { ...req!, sessionId: 'gone' }, byId)).toBeNull();
  });
});

/* ================================================================== stored action parse */
describe('toSessionAdjustment (stored action, untrusted)', () => {
  it('accepts a well-formed action and refuses malformed ones', () => {
    expect(toSessionAdjustment(shorten())).toEqual(shorten());
    expect(toSessionAdjustment(swap())).toEqual(swap());
    expect(toSessionAdjustment({ ...swap(), swap: undefined })).toBeNull();
    expect(toSessionAdjustment({ ...shorten(), removeSets: [], dropExercises: [] })).toBeNull();
    expect(toSessionAdjustment({ ...shorten(), change: 'delete_everything' })).toBeNull();
    expect(toSessionAdjustment({ ...shorten(), kind: 'week_adjustment' })).toBeNull();
    expect(toSessionAdjustment(null)).toBeNull();
    // Out-of-range counts are dropped rather than trusted.
    expect(toSessionAdjustment({ ...shorten(), removeSets: [{ sessionExerciseId: 'se-row', name: 'Row', count: 999 }] })?.removeSets).toEqual([]);
  });
});
