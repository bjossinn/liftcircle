import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import type { Exercise, ID } from '@/domain/types';
import { EXERCISES } from './exercises';
import { useDb } from '@/state/app';
import { alive } from '@/db/repo';

const BUNDLED = new Map(EXERCISES.map((e) => [e.id, e]));

export function bundledExercise(id: ID): Exercise | undefined {
  return BUNDLED.get(id);
}

/** All exercises: bundled read-only catalog + the user's custom exercises. */
export function useExercises(): { list: Exercise[]; byId: Map<ID, Exercise>; get: (id: ID) => Exercise | undefined } {
  const db = useDb();
  const custom = useLiveQuery(() => db.customExercises.toArray(), [db]) ?? [];
  return useMemo(() => {
    const list = [...EXERCISES, ...alive(custom)];
    const byId = new Map(list.map((e) => [e.id, e]));
    return { list, byId, get: (id: ID) => byId.get(id) };
  }, [custom]);
}

export function exerciseName(id: ID, byId?: Map<ID, Exercise>): string {
  return byId?.get(id)?.name ?? BUNDLED.get(id)?.name ?? 'Unknown exercise';
}
