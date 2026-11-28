/**
 * History list rows for logged workouts (pure, so the title, search text and session mark are unit-tested).
 * Stored names stay as stored; the shown title is localized only for unrenamed generated/manual sessions.
 */
import type { Program, WorkoutSession } from '@/domain/types';
import { workoutMarkSource } from '@/domain/program/sessionMark';
import { workoutDisplayName } from '@/features/program/parts';

export interface WorkoutHistoryRow {
  title: string;
  /** Lower-cased text the history search matches: the shown (localized) title AND the stored name, notes, exercises. */
  search: string;
  mark: ReturnType<typeof workoutMarkSource>;
}

export function workoutHistoryRow(
  s: Pick<WorkoutSession, 'name' | 'notes' | 'templateId' | 'programId' | 'programVersion' | 'nameEdited'>,
  exerciseNames: readonly string[],
  programs: readonly Program[] = [],
): WorkoutHistoryRow {
  const title = workoutDisplayName(s);
  const search = [...new Set([title, s.name])].concat(s.notes ?? '', exerciseNames).join(' ').toLocaleLowerCase();
  return { title, search, mark: workoutMarkSource(s, programs) };
}
