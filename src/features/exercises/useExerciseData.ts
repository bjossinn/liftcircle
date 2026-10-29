import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useMemo } from 'react';
import type { DistanceUnit, Exercise, ID, ISODate, LoggedSet, WeightUnit, WorkoutSession } from '@/domain/types';
import { alive } from '@/db/repo';
import type { LiftDb } from '@/db/db';
import { useApp } from '@/state/app';
import { formatDistance, formatWeight } from '@/domain/units';
import { formatDuration } from '@/lib/dates';

/** Completed, non-deleted sessions, newest first. */
export async function completedSessions(db: LiftDb): Promise<WorkoutSession[]> {
  const rows = await db.sessions.where('status').equals('completed').toArray();
  return alive(rows).sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
}

/** Favourite exercise ids stored on the account row. */
export function useFavoriteExercises() {
  const { account, updateAccount } = useApp();
  const ids = useMemo(() => account.favorites?.exercises ?? [], [account.favorites?.exercises]);
  const isFav = useCallback((id: ID) => ids.includes(id), [ids]);
  const toggle = useCallback(
    (id: ID) =>
      updateAccount((a) => {
        const cur = a.favorites?.exercises ?? [];
        const exercises = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        return { ...a, favorites: { ...a.favorites, recipes: a.favorites?.recipes ?? [], exercises } };
      }),
    [updateAccount],
  );
  return { ids, isFav, toggle };
}

/**
 * Exercise ids from the most recent completed sessions, most recent first.
 * `undefined` while loading.
 */
export function useRecentExerciseIds(sessionLimit = 10): ID[] | undefined {
  const { db } = useApp();
  return useLiveQuery(async () => {
    const sessions = (await completedSessions(db)).slice(0, sessionLimit);
    const seen = new Set<ID>();
    const out: ID[] = [];
    for (const s of sessions) {
      const ordered = [...s.exercises].sort((a, b) => a.order - b.order);
      for (const se of ordered) {
        if (!se.sets.some((x) => x.completed)) continue;
        if (!seen.has(se.exerciseId)) {
          seen.add(se.exerciseId);
          out.push(se.exerciseId);
        }
      }
    }
    return out;
  }, [db, sessionLimit]);
}

export interface ExerciseHistoryEntry {
  sessionId: ID;
  sessionName: string;
  date: ISODate;
  sets: LoggedSet[];
  warmups: number;
}

/** The user's completed sets for one exercise, newest session first. `undefined` while loading. */
export function useExerciseHistory(exerciseId: ID | undefined, limit = 6): ExerciseHistoryEntry[] | undefined {
  const { db } = useApp();
  return useLiveQuery(async () => {
    if (!exerciseId) return [];
    const sessions = await completedSessions(db);
    const out: ExerciseHistoryEntry[] = [];
    for (const s of sessions) {
      const done = s.exercises.filter((se) => se.exerciseId === exerciseId).flatMap((se) => se.sets.filter((x) => x.completed));
      if (!done.length) continue;
      const working = done.filter((x) => x.type !== 'warmup');
      out.push({ sessionId: s.id, sessionName: s.name, date: s.date, sets: working, warmups: done.length - working.length });
      if (out.length >= limit) break;
    }
    return out;
  }, [db, exerciseId, limit]);
}

/** Number of sessions (any status) that reference an exercise — used before deleting a custom exercise. */
export function useExerciseUsageCount(exerciseId: ID | undefined): number | undefined {
  const { db } = useApp();
  return useLiveQuery(async () => {
    if (!exerciseId) return 0;
    const rows = alive(await db.sessions.toArray());
    return rows.filter((s) => s.exercises.some((se) => se.exerciseId === exerciseId)).length;
  }, [db, exerciseId]);
}

/** Human-readable set, following the exercise's tracking type and load convention. */
export function formatLoggedSet(set: LoggedSet, ex: Exercise, unit: WeightUnit, distanceUnit: DistanceUnit = 'km'): string {
  const reps = set.reps != null ? `${set.reps}` : null;
  const w = set.weightKg != null ? formatWeight(set.weightKg, unit, set.entered) : null;
  const side = ex.unilateral ? '/side' : '';
  switch (ex.tracking) {
    case 'weight_reps':
      if (w && reps && set.weightKg! > 0) return `${w} × ${reps}${side}`;
      // A missing (or zero) load is "not recorded" — never shown as a known 0.
      return reps ? `${reps} reps${side} (load not recorded)` : (w ?? '–');
    case 'bodyweight_plus':
      if (set.weightKg && w) return `BW + ${w} × ${reps ?? '–'}${side}`;
      if (set.weightKg == null) return `${reps ?? '–'} reps${side} (added load not recorded)`;
      return `BW × ${reps ?? '–'}${side}`;
    case 'assisted':
      if (set.weightKg && w) return `${w} assist × ${reps ?? '–'}${side}`;
      return `${reps ?? '–'} reps${side}`;
    case 'reps':
      return `${reps ?? '–'} reps${side}`;
    case 'duration': {
      const t = set.durationSec != null ? formatDuration(set.durationSec) : '–';
      return w && set.weightKg ? `${t}${side} @ ${w}` : `${t}${side}`;
    }
    case 'distance_time': {
      const parts: string[] = [];
      if (set.distanceM != null) parts.push(set.distanceM < 1000 && distanceUnit === 'km' ? `${Math.round(set.distanceM)} m` : formatDistance(set.distanceM, distanceUnit));
      if (set.durationSec != null) parts.push(formatDuration(set.durationSec));
      if (w && set.weightKg) parts.push(`@ ${w}`);
      return parts.length ? parts.join(' · ') : '–';
    }
  }
}
