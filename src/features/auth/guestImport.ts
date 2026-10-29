/**
 * Moving guest (signed-out) records into a signed-in account.
 * Nothing is attached silently: the user previews counts and confirms.
 * Duplicates are prevented by stable record ids (records already in the account are skipped),
 * and existing cloud records win on the server (see sync engine: base_version null → keep cloud).
 */
import { accountDbExists, ACCOUNT_ROW_ID, LiftDb, SYNCED_ENTITIES, type SyncedEntity } from '@/db/db';
import { saveRecord, tableFor } from '@/db/repo';

export const ENTITY_LABELS: Record<SyncedEntity, string> = {
  account_state: 'Settings & targets',
  programs: 'Programs',
  templates: 'Saved templates',
  sessions: 'Workouts',
  activities: 'Activities',
  activity_templates: 'Activity templates',
  measurements: 'Body measurements',
  goals: 'Goals',
  custom_exercises: 'Custom exercises',
  custom_foods: 'Custom foods',
  food_logs: 'Food log entries',
  saved_meals: 'Saved meals',
  meal_plans: 'Meal plans',
};

export interface ImportRow {
  entity: SyncedEntity;
  label: string;
  toImport: number;
  alreadyThere: number;
}

async function withGuest<T>(fn: (g: LiftDb) => Promise<T>): Promise<T | null> {
  if (!(await accountDbExists('guest'))) return null;
  const g = new LiftDb('guest');
  try {
    return await fn(g);
  } finally {
    g.close();
  }
}

export async function guestHasData(): Promise<boolean> {
  return (
    (await withGuest(async (g) => {
      const counts = await Promise.all([g.sessions.count(), g.activities.count(), g.programs.count(), g.measurements.count(), g.foodLogs.count()]);
      return counts.some((c) => c > 0);
    })) ?? false
  );
}

export async function previewGuestImport(target: LiftDb): Promise<ImportRow[]> {
  return (
    (await withGuest(async (g) => {
      const rows: ImportRow[] = [];
      for (const entity of Object.keys(SYNCED_ENTITIES) as SyncedEntity[]) {
        const recs = (await tableFor(g, entity).toArray()) as { id: string; deletedAt?: number }[];
        const live = recs.filter((r) => !r.deletedAt);
        if (live.length === 0) continue;
        let already = 0;
        for (const r of live) if (await tableFor(target, entity).get(r.id)) already++;
        if (entity === 'account_state' && (await target.account.get(ACCOUNT_ROW_ID))) already = live.length;
        rows.push({ entity, label: ENTITY_LABELS[entity], toImport: live.length - already, alreadyThere: already });
      }
      return rows;
    })) ?? []
  );
}

/** Copy selected entities. Returns number of records imported. */
export async function importGuestData(target: LiftDb, userId: string, entities: SyncedEntity[]): Promise<number> {
  if (target.isGuest || target.accountKey !== userId) throw new Error('Sign in to the account you want to import into.');
  let n = 0;
  await withGuest(async (g) => {
    for (const entity of entities) {
      const recs = (await tableFor(g, entity).toArray()) as { id: string; deletedAt?: number; serverVersion?: number; status?: string }[];
      for (const r of recs) {
        if (r.deletedAt) continue;
        if (entity === 'account_state' && (await target.account.get(ACCOUNT_ROW_ID))) continue;
        if (await tableFor(target, entity).get(r.id)) continue; // duplicate → skip
        const { serverVersion: _v, ...clean } = r;
        await saveRecord(entity, clean as never, target, { preferRemote: true });
        n++;
      }
    }
    await g.kv.put({ key: `imported:${userId}`, value: Date.now() });
  });
  return n;
}

export async function guestImportState(userId: string): Promise<'none' | 'imported' | 'dismissed' | 'available'> {
  return (
    (await withGuest(async (g) => {
      if (await g.kv.get(`imported:${userId}`)) return 'imported' as const;
      if (await g.kv.get(`dismissed:${userId}`)) return 'dismissed' as const;
      const counts = await Promise.all([g.sessions.count(), g.activities.count(), g.programs.count(), g.measurements.count(), g.foodLogs.count()]);
      return counts.some((c) => c > 0) ? ('available' as const) : ('none' as const);
    })) ?? 'none'
  );
}

export async function dismissGuestImport(userId: string) {
  await withGuest((g) => g.kv.put({ key: `dismissed:${userId}`, value: Date.now() }));
}

/** Remove guest records from this device after a successful import (optional). */
export async function clearGuestData() {
  await withGuest(async (g) => {
    await Promise.all((Object.keys(SYNCED_ENTITIES) as SyncedEntity[]).map((e) => tableFor(g, e).clear()));
  });
}
