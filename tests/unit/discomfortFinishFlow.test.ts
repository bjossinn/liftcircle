/**
 * Review P1 (PR #18, round 2): stopping an exercise because it hurt, before completing any set, must still block the
 * next load increase. End to end: active workout → finishSession → saved history (real Dexie) → next recommendation in
 * the app (engine, summary, next workout pre-fill) and in the training assistant's context (buildContext). Plus the
 * other readers of saved sessions: stats, volume, records, share snapshot, sync/import validation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { LiftDb } from '@/db/db';
import * as ops from '@/domain/sessionOps';
import { buildSessionFromTemplate, suggestionFor } from '@/domain/program/session';
import { nextTargetsFor } from '@/domain/nextTargets';
import { detectRecords, exercisesDone, personalRecords, summarizeSession } from '@/domain/stats';
import { sanitizeImportedSession, validateSessionRecord, hasCompletedWork } from '@/domain/setValidation';
import { buildWorkoutSnapshot } from '@/social/snapshot';
import { completedHistory } from '@/features/train/start';
import { defaultSettings, defaultAccountState } from '@/state/defaults';
import { buildContext } from '../../supabase/functions/_shared/ai/context';
import type { AiDb, RefExercise, SessionPayload } from '../../supabase/functions/_shared/ai/types';
import type { Exercise, Prescription, SessionTemplate, WorkoutSession } from '@/domain/types';

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const squat = byId.get('barbell-back-squat') as Exercise;
const bench = byId.get('barbell-bench-press') as Exercise;
const rxOf = (exerciseId: string, priority: 1 | 2): Prescription => ({ id: `slot-${exerciseId}`, exerciseId, sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 120, warmup: '', priority, alternatives: [] });
const template: SessionTemplate = { id: 't-a', name: 'Full body A', kind: 'lifting', exercises: [rxOf(bench.id, 1), rxOf(squat.id, 1)] } as SessionTemplate;
const settings = defaultSettings();
const T0 = Date.parse('2026-11-20T17:00:00Z');

/** Previous workout: squat 3×12 @ 60 kg RIR 2 (one successful session; a beginner's next squat would be 62.5 kg). */
function previous(): WorkoutSession {
  const s = buildSessionFromTemplate({ ...template, exercises: [rxOf(squat.id, 1)] }, { catalog: EXERCISES, history: [], settings, date: '2026-11-20', timeZone: 'UTC', experience: 'new' });
  let cur: WorkoutSession = { ...s, id: 'prev', startedAt: T0 };
  const se = cur.exercises[0];
  for (const set of se.sets) {
    if (set.type === 'warmup') continue;
    cur = ops.updateSet(cur, se.id, set.id, { weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: 12, rir: 2 });
    cur = ops.toggleSetComplete(cur, se.id, set.id, T0 + 60_000, squat).session;
  }
  return ops.finishSession(cur, T0 + 3_600_000);
}

let db: LiftDb;
let n = 0;
beforeEach(() => {
  db = new LiftDb(`discomfort-flow-${++n}`);
});

/** Today: one bench set done, squat flagged "Felt discomfort", stopped before any squat set; then Finish. */
async function finishTodaysWorkout(): Promise<{ finished: WorkoutSession; history: WorkoutSession[] }> {
  await db.sessions.put(previous());
  const t1 = T0 + 3 * 86_400_000;
  let s = buildSessionFromTemplate(template, { catalog: EXERCISES, history: await completedHistory(db), settings, date: '2026-11-23', timeZone: 'UTC', experience: 'new' });
  s = { ...s, id: 'today', startedAt: t1 };
  const b = s.exercises.find((e) => e.exerciseId === bench.id)!;
  const firstWorking = b.sets.find((x) => x.type !== 'warmup')!;
  s = ops.updateSet(s, b.id, firstWorking.id, { weightKg: 40, entered: { value: 40, unit: 'kg' }, reps: 10, rir: 2 });
  s = ops.toggleSetComplete(s, b.id, firstWorking.id, t1 + 60_000, bench).session;
  const sq = s.exercises.find((e) => e.exerciseId === squat.id)!;
  s = ops.setDiscomfort(s, sq.id, true);
  const finished = ops.finishSession(s, t1 + 1_800_000);
  await db.sessions.put(finished);
  return { finished, history: await completedHistory(db) };
}

describe('finishSession keeps an exercise stopped with discomfort (no completed sets)', () => {
  it('saved history holds the flagged squat with zero sets; exercises left untouched are still dropped', async () => {
    const { finished, history } = await finishTodaysWorkout();
    const saved = history.find((s) => s.id === 'today')!;
    expect(saved).toEqual(finished);
    expect(saved.exercises.map((e) => [e.exerciseId, e.sets.length, !!e.discomfort])).toEqual([[bench.id, 1, false], [squat.id, 0, true]]);
    // An exercise with nothing completed and no flag is still dropped (unchanged behaviour).
    const untouched = ops.finishSession({ ...finished, status: 'active', exercises: [...finished.exercises, { id: 'x', exerciseId: 'plank', order: 2, sets: [] }] }, T0);
    expect(untouched.exercises.map((e) => e.exerciseId)).not.toContain('plank');
  });

  it('next recommendation in the app: no increase, the next workout pre-fills 60 kg (not 62.5 kg)', async () => {
    const { finished, history } = await finishTodaysWorkout();
    const { suggestion, last } = suggestionFor(rxOf(squat.id, 1), squat, history, settings, 'new');
    expect(suggestion).toMatchObject({ action: 'discomfort_hold', loadKg: 60 });
    expect(last?.sets.filter((x) => x.type !== 'warmup').every((x) => x.reps === 12)).toBe(true);
    expect(nextTargetsFor(finished, history, byId, settings, 'new').get(squat.id)).toMatchObject({ label: 'No increase', text: 'Next: 60 kg' });
    const next = buildSessionFromTemplate(template, { catalog: EXERCISES, history, settings, date: '2026-11-26', timeZone: 'UTC', experience: 'new' });
    const nextSquat = next.exercises.find((e) => e.exerciseId === squat.id)!;
    expect(nextSquat.sets.filter((x) => x.type === 'normal').map((x) => x.weightKg)).toEqual([60, 60, 60]);
    // Control: with the flagged entry dropped (the old finishSession), the beginner rule would have said 62.5 kg.
    const dropped = history.map((s) => (s.id === 'today' ? { ...s, exercises: s.exercises.filter((e) => e.sets.length > 0) } : s));
    expect(suggestionFor(rxOf(squat.id, 1), squat, dropped, settings, 'new').suggestion.loadKg).toBe(62.5);
  });

  it('stats, volume, records and the share snapshot ignore the empty entry', async () => {
    const { finished, history } = await finishTodaysWorkout();
    const sum = summarizeSession(finished, byId);
    expect(sum.exercisesDone).toBe(1);
    expect(sum.workingSets).toBe(1);
    expect(sum.volume.freeWeightKg).toBe(400);
    expect(exercisesDone(finished)).toBe(1);
    expect(detectRecords(finished, history.filter((s) => s.id !== 'today'), byId, 'kg').map((r) => r.exerciseId)).not.toContain(squat.id);
    expect(personalRecords(history, squat, 'kg').every((r) => r.sessionId === 'prev')).toBe(true);
    expect(hasCompletedWork(finished)).toBe(true);
    const snap = buildWorkoutSnapshot(finished, { duration: true, exerciseNames: true, weightsReps: true, volume: true, records: true }, { byId, unit: 'kg' });
    expect(JSON.stringify(snap)).not.toContain(squat.name);
  });

  it('sync / import: the record validates and survives a JSON round trip unchanged', async () => {
    const { finished } = await finishTodaysWorkout();
    const wire = JSON.parse(JSON.stringify(finished)) as WorkoutSession;
    expect(validateSessionRecord(wire, byId)).toEqual([]);
    expect(sanitizeImportedSession(wire, byId)).toEqual({ session: wire, issues: [] });
    expect(wire.exercises[1]).toMatchObject({ exerciseId: squat.id, sets: [], discomfort: true });
  });

  it('next recommendation in the training assistant (real buildContext on the synced rows): no increase', async () => {
    const { history } = await finishTodaysWorkout();
    const rows = JSON.parse(JSON.stringify(history)) as SessionPayload[]; // what sync stores as payload
    const account = defaultAccountState();
    account.profile.experience = 'new';
    const refs = EXERCISES.map((e) => ({ ...e })) as unknown as RefExercise[];
    const program = {
      id: 'p1',
      payload: { id: 'p1', name: 'Plan', active: true, currentVersion: 1, managedBy: { kind: 'self' }, versions: [{ version: 1, templates: [template], schedule: [{ weekday: 1, templateId: template.id }], weeks: 6, reviewWeek: 6 }], inputs: { experience: 'new' } },
    };
    const db = {
      getAccountState: async () => JSON.parse(JSON.stringify(account)),
      getActiveProgram: async () => program,
      getRecentSessions: async (_: string, limit: number) => rows.slice(0, limit),
      getGoals: async () => [],
      getBodyweight: async () => [],
      getFoodLogs: async () => [],
      getHistory: async () => [],
      getExercises: async () => refs,
      getRecipes: async () => [],
      getIngredients: async () => [],
    } as unknown as AiDb;
    const aiSettings = { enabled: true, paused: false, consentAt: '2026-11-01T00:00:00Z', scopes: { profile: true, training: true, measurements: false, nutrition: false }, scopesChangedAt: null, profileNotes: '' };
    const ctx = await buildContext({ db, uid: 'u1', settings: aiSettings as never, text: 'What should I squat next time?', mode: 'chat', now: new Date('2026-11-24T10:00:00Z') });
    const squatLine = ctx.system.split('\n').find((l) => l.startsWith('- Barbell back squat:'))!;
    expect(squatLine).toContain('No increase');
    expect(squatLine).not.toContain('62.5');
    expect(ctx.system).toContain('Barbell back squat no sets completed [discomfort flagged]');
  });
});
