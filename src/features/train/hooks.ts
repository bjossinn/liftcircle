import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router';
import { useCallback, useMemo } from 'react';
import { useApp } from '@/state/app';
import { alive } from '@/db/repo';
import type { Program, SessionTemplate, WorkoutSession, ActivityLog, ISODate } from '@/domain/types';
import { useExercises } from '@/data/catalog';
import { useToast } from '@/components/toast';
import { activityLinkFor, repeatSession, startEmpty, startFromTemplate } from './start';
import { currentVersion } from '@/domain/program/program';
import { availableEquipment } from '@/domain/program/generator';
import type { SubstitutionConstraints } from '@/domain/substitution';

export function useActiveProgram(): Program | null | undefined {
  const { db } = useApp();
  return useLiveQuery(async () => alive(await db.programs.toArray()).find((p) => p.active) ?? null, [db]);
}

export function useAllSessions(): WorkoutSession[] | undefined {
  const { db } = useApp();
  return useLiveQuery(async () => alive(await db.sessions.toArray()).sort((a, b) => b.startedAt - a.startedAt), [db]);
}

export function useAllActivities(): ActivityLog[] | undefined {
  const { db } = useApp();
  return useLiveQuery(async () => alive(await db.activities.toArray()).sort((a, b) => (b.date === a.date ? (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt) : b.date.localeCompare(a.date))), [db]);
}

/** Start helpers bound to the current account, with navigation and error toasts. */
export function useStarters() {
  const { db, account } = useApp();
  const { list } = useExercises();
  const nav = useNavigate();
  const toast = useToast();
  const ctx = { db, settings: account.settings, catalog: list };
  const go = (s: WorkoutSession) => nav(`/train/session/${s.id}`);
  const fail = (e: unknown) => toast.show((e as Error).message || 'Couldn’t start the workout', { tone: 'error' });

  const startTemplate = useCallback(
    async (t: SessionTemplate, meta: { program?: Program; plannedDate?: ISODate } = {}) => {
      if (t.kind !== 'lifting' && t.exercises.length === 0) return nav(activityLinkFor(t, meta.plannedDate));
      try {
        go(await startFromTemplate(t, ctx, { programId: meta.program?.id, programVersion: meta.program ? currentVersion(meta.program).version : undefined, plannedDate: meta.plannedDate }));
      } catch (e) {
        fail(e);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, account.settings, list],
  );
  const repeat = useCallback(
    async (s: WorkoutSession) => {
      try {
        go(await repeatSession(s, ctx));
      } catch (e) {
        fail(e);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, account.settings, list],
  );
  const empty = useCallback(async () => {
    try {
      go(await startEmpty(ctx));
    } catch (e) {
      fail(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, account.settings, list]);
  return { startTemplate, repeat, empty };
}

/**
 * The user's equipment, exclusions and movement constraints for default substitution suggestions:
 * from the active program's inputs and the account profile's limitations. Undefined while loading.
 */
export function useSubstitutionConstraints(): SubstitutionConstraints | undefined {
  const { account } = useApp();
  const program = useActiveProgram();
  const limits = account.profile?.limitations;
  return useMemo(() => {
    if (program === undefined) return undefined;
    const a = program?.inputs;
    const limitations = new Set([...(a?.limitations ?? []), ...(limits ?? [])]);
    const c: SubstitutionConstraints = { limitations };
    if (a && (a.equipment?.length || a.location !== 'full_gym')) c.equipment = availableEquipment({ equipment: a.equipment ?? [], location: a.location });
    if (a?.excludedExerciseIds?.length) c.excluded = new Set(a.excludedExerciseIds);
    return c;
  }, [program, limits]);
}
