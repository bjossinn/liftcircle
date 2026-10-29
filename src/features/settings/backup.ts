/**
 * Versioned JSON backup + CSV exports of private structured records.
 * Photos are NOT included in structured backups (they live in cloud storage for shared posts only).
 *
 * Import rules (shown to the person in the preview):
 *  1. The whole file is validated first (see backupSchema.ts). Any problem → nothing is imported.
 *  2. Records are matched by their stable id.
 *     - Not on this device → ADDED (if the same id already exists in your cloud account, the cloud copy wins).
 *     - On this device and identical → skipped.
 *     - On this device and different → "keep" (default): this device's version stays;
 *       "replace": the backup's version overwrites it (synced as a normal edit).
 *     - Deleted on this device → skipped (a deletion is never undone by an import).
 *  3. Settings & targets (one record per account) are never merged silently: when this device already has
 *     them, each part — settings, private profile, nutrition targets, favourites — is kept unless you choose
 *     "use backup" for it.
 *  4. Only one workout can be in progress and one program active: an in-progress workout from the backup is
 *     skipped when a different one is in progress here, and an active program from the backup is added as
 *     inactive when another program is active here.
 *  5. Workout sets with invalid values are repaired with sanitizeImportedSession: invalid numbers become
 *     "not recorded" and completed sets that are still invalid are imported as not completed, so they never
 *     count as work. The preview shows how many.
 *  6. Everything selected is written in ONE local transaction together with its sync queue entries: if any
 *     write fails, nothing changes.
 */
import { SYNCED_ENTITIES, type LiftDb, type SyncedEntity } from '@/db/db';
import { saveRecordsAtomic, tableFor, type BulkWrite } from '@/db/repo';
import type { AccountState, ActivityLog, Exercise, Measurement, Program, SyncFields, WorkoutSession } from '@/domain/types';
import { BRAND } from '@/config/brand';
import { EXERCISES } from '@/data/exercises';
import { RECIPES_BY_ID } from '@/data/recipes';
import { sanitizeImportedSession } from '@/domain/setValidation';
import { BACKUP_FORMAT, BACKUP_VERSION, BackupValidationError, parseBackupText, validateBackupObject, type ValidatedBackup } from './backupSchema';

export { BACKUP_FORMAT, BACKUP_VERSION, BackupValidationError } from './backupSchema';

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  app?: string;
  exportedAt: string;
  includesMedia?: boolean;
  note?: string;
  records: Partial<Record<SyncedEntity, unknown[]>>;
  unknownEntities?: string[];
}

export async function buildBackup(db: LiftDb): Promise<Backup> {
  const records: Backup['records'] = {};
  for (const entity of Object.keys(SYNCED_ENTITIES) as SyncedEntity[]) {
    const rows = (await tableFor(db, entity).toArray()) as { deletedAt?: number; serverVersion?: number }[];
    const live = rows.filter((r) => !r.deletedAt).map(({ serverVersion: _v, ...r }) => r);
    if (live.length) records[entity] = live;
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: BRAND.name,
    exportedAt: new Date().toISOString(),
    includesMedia: false,
    note: 'Structured records only (workouts, activities, programs, measurements, nutrition, settings). Photos attached to shared posts are not included.',
    records,
  };
}

/** Validate a backup file's text. Throws BackupValidationError (user-facing message) — never touches data. */
export function parseBackup(text: string): ValidatedBackup {
  return parseBackupText(text);
}

/* ------------------------------------------------------------ import options */
export type ExistingRule = 'keep' | 'replace';
export type SingletonPart = 'settings' | 'profile' | 'nutrition' | 'favorites';
export const SINGLETON_PARTS: { key: SingletonPart; label: string }[] = [
  { key: 'settings', label: 'App settings (units, rest timer, sharing, notifications)' },
  { key: 'profile', label: 'Private profile (name, age, height, goals, limitations, diet)' },
  { key: 'nutrition', label: 'Nutrition targets' },
  { key: 'favorites', label: 'Favourite exercises and recipes' },
];

export interface ImportOptions {
  /** Record types to import. */
  entities: SyncedEntity[];
  /** What to do with records whose id already exists on this device with different content. Default 'keep'. */
  existing?: ExistingRule;
  /** Settings & targets already on this device: which parts to take from the backup. Missing = keep. */
  singleton?: Partial<Record<SingletonPart, ExistingRule>>;
}

export interface EntityPreview {
  entity: SyncedEntity;
  total: number;
  /** Not on this device → will be added. */
  newCount: number;
  /** Same id on this device (identical + different). */
  existing: number;
  identical: number;
  /** Same id, different content: kept or replaced depending on the rule. */
  differs: number;
  /** Deleted on this device: always skipped. */
  deletedHere: number;
  /** Records adjusted or skipped by rule 4 (in-progress workout / active program). */
  adjusted: number;
  notes: string[];
}

export interface ImportPreview {
  backup: ValidatedBackup;
  rows: EntityPreview[];
  unknownEntities: string[];
  /** Cross-record references that can't be resolved (imported anyway). */
  warnings: string[];
  /** Settings & targets record: null when the backup has none. */
  singleton: null | { onDevice: boolean; differs: Record<SingletonPart, boolean> };
  repaired: { sessions: number; sets: number };
}

export interface ImportResult {
  added: number;
  replaced: number;
  skipped: number;
  /** Records written (added + replaced). */
  written: number;
  byEntity: Partial<Record<SyncedEntity, { added: number; replaced: number; skipped: number }>>;
}

/* ------------------------------------------------------------ planning */
type Rec = SyncFields & Record<string, unknown>;
const VOLATILE = new Set(['updatedAt', 'serverVersion', 'createdAt']);

function stable(v: unknown, top = true): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map((x) => stable(x, false)).join(',')}]`;
  const keys = Object.keys(v as object)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined && !(top && VOLATILE.has(k)))
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k], false)}`).join(',')}}`;
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/** Exercises the backup's workouts may reference: bundled, custom in the backup, custom on this device (incl. deleted). */
async function exerciseMap(db: LiftDb, backup: ValidatedBackup): Promise<Map<string, Exercise>> {
  const m = new Map<string, Exercise>(EXERCISES.map((e) => [e.id, e]));
  for (const c of (await db.customExercises.toArray()) as Exercise[]) m.set(c.id, c);
  for (const c of (backup.records.custom_exercises ?? []) as unknown as Exercise[]) m.set(c.id, c);
  return m;
}

interface Plan {
  writes: BulkWrite[];
  rows: EntityPreview[];
  singleton: ImportPreview['singleton'];
  repaired: { sessions: number; sets: number };
  result: ImportResult;
}

/**
 * Decide, record by record, what an import does. Reads only Dexie tables (so it can run inside the
 * import transaction and see the current local state).
 */
async function buildPlan(db: LiftDb, backup: ValidatedBackup, opts: ImportOptions): Promise<Plan> {
  const now = Date.now();
  const rule = opts.existing ?? 'keep';
  const selected = new Set(opts.entities);
  const byId = await exerciseMap(db, backup);
  const writes: BulkWrite[] = [];
  const rows: EntityPreview[] = [];
  const result: ImportResult = { added: 0, replaced: 0, skipped: 0, written: 0, byEntity: {} };
  const repaired = { sessions: 0, sets: 0 };
  let singleton: ImportPreview['singleton'] = null;

  const localActiveProgram = (await db.programs.toArray()).find((p) => p.active && !p.deletedAt);
  const localActiveSession = (await db.sessions.where('status').equals('active').toArray()).find((s) => !s.deletedAt);

  for (const entity of Object.keys(SYNCED_ENTITIES) as SyncedEntity[]) {
    const list = backup.records[entity] as Rec[] | undefined;
    if (!list?.length) continue;
    const row: EntityPreview = { entity, total: list.length, newCount: 0, existing: 0, identical: 0, differs: 0, deletedHere: 0, adjusted: 0, notes: [] };
    const counts = { added: 0, replaced: 0, skipped: 0 };
    const take = selected.has(entity);
    let backupActiveSeen = false;

    for (const raw of list) {
      const { serverVersion: _sv, ...clean } = raw;
      let rec = clean as Rec;
      if (rec.deletedAt) {
        counts.skipped++;
        continue;
      }
      if (entity === 'sessions') {
        const fixed = sanitizeImportedSession(rec as unknown as WorkoutSession, byId);
        if (fixed.issues.length) {
          let n = 0;
          const before = (rec as unknown as WorkoutSession).exercises;
          fixed.session.exercises.forEach((se, i) => se.sets.forEach((st, j) => st !== before[i]?.sets[j] && n++));
          if (n) {
            repaired.sessions++;
            repaired.sets += n;
          }
          rec = fixed.session as unknown as Rec;
        }
      }
      const local = (await tableFor(db, entity).get(rec.id)) as Rec | undefined;

      if (entity === 'account_state') {
        const b = rec as unknown as AccountState;
        if (!local) {
          singleton = { onDevice: false, differs: { settings: true, profile: true, nutrition: true, favorites: true } };
          row.newCount++;
          if (take) {
            writes.push({ entity, record: { ...b, createdAt: b.createdAt ?? now, updatedAt: now }, preferRemote: true });
            counts.added++;
          } else counts.skipped++;
          continue;
        }
        const l = local as unknown as AccountState;
        const differs = { settings: !same(l.settings, b.settings), profile: !same(l.profile, b.profile), nutrition: !same(l.nutrition, b.nutrition), favorites: !same(l.favorites, b.favorites) };
        singleton = { onDevice: true, differs };
        row.existing++;
        if (Object.values(differs).some(Boolean)) row.differs++;
        else row.identical++;
        const parts = (Object.keys(differs) as SingletonPart[]).filter((k) => differs[k] && opts.singleton?.[k] === 'replace');
        if (take && parts.length) {
          const merged: AccountState = { ...l, updatedAt: now };
          for (const k of parts) (merged as unknown as Record<string, unknown>)[k] = b[k];
          writes.push({ entity, record: merged });
          counts.replaced++;
        } else counts.skipped++;
        continue;
      }

      if (local?.deletedAt) {
        row.deletedHere++;
        counts.skipped++;
        continue;
      }

      // Rule 4: one in-progress workout, one active program.
      if (entity === 'sessions' && rec.status === 'active' && localActiveSession && localActiveSession.id !== rec.id && !local) {
        row.adjusted++;
        counts.skipped++;
        continue;
      }
      if (entity === 'programs' && rec.active) {
        const clash = (localActiveProgram && localActiveProgram.id !== rec.id) || backupActiveSeen;
        backupActiveSeen = true;
        if (clash && !local) {
          rec = { ...rec, active: false };
          row.adjusted++;
        }
      }

      if (!local) {
        row.newCount++;
        if (take) {
          writes.push({ entity, record: { ...rec, createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : now, updatedAt: now }, preferRemote: true });
          counts.added++;
        } else counts.skipped++;
        continue;
      }
      row.existing++;
      if (same(local, rec)) {
        row.identical++;
        counts.skipped++;
        continue;
      }
      row.differs++;
      if (take && rule === 'replace') {
        // Keep this device's sync base so the change is pushed as an ordinary edit.
        let next: Rec = { ...rec, createdAt: local.createdAt ?? rec.createdAt ?? now, updatedAt: now, serverVersion: local.serverVersion };
        if (entity === 'programs' && next.active && !local.active && localActiveProgram && localActiveProgram.id !== next.id) next = { ...next, active: false };
        if (next.serverVersion === undefined) delete next.serverVersion;
        writes.push({ entity, record: next });
        counts.replaced++;
      } else counts.skipped++;
    }

    if (row.adjusted) row.notes.push(entity === 'sessions' ? `${row.adjusted} in-progress workout${row.adjusted === 1 ? '' : 's'} skipped because a workout is already in progress here.` : `${row.adjusted} program${row.adjusted === 1 ? '' : 's'} added as inactive because another program is active.`);
    if (row.deletedHere) row.notes.push(`${row.deletedHere} deleted on this device — not restored.`);
    rows.push(row);
    if (take) {
      result.byEntity[entity] = counts;
      result.added += counts.added;
      result.replaced += counts.replaced;
      result.skipped += counts.skipped;
    }
  }
  result.written = result.added + result.replaced;
  return { writes, rows, singleton, repaired, result };
}

/** References between records that don't resolve (the records import fine; this is shown as a warning). */
async function referenceWarnings(db: LiftDb, backup: ValidatedBackup): Promise<string[]> {
  const byId = await exerciseMap(db, backup);
  const programIds = new Set([...(await db.programs.toCollection().primaryKeys()), ...(backup.records.programs ?? []).map((p) => p.id)]);
  const unknownEx = new Set<string>();
  let workoutsMissingProgram = 0;
  for (const s of (backup.records.sessions ?? []) as unknown as WorkoutSession[]) {
    for (const se of s.exercises) if (!byId.has(se.exerciseId)) unknownEx.add(se.exerciseId);
    if (s.programId && !programIds.has(s.programId)) workoutsMissingProgram++;
  }
  for (const p of (backup.records.programs ?? []) as unknown as Program[]) for (const v of p.versions) for (const t of v.templates) for (const rx of t.exercises) if (!byId.has(rx.exerciseId)) unknownEx.add(rx.exerciseId);
  for (const t of (backup.records.templates ?? []) as unknown as { template: { exercises: { exerciseId: string }[] } }[]) for (const rx of t.template.exercises) if (!byId.has(rx.exerciseId)) unknownEx.add(rx.exerciseId);
  let unknownRecipes = 0;
  for (const mp of (backup.records.meal_plans ?? []) as unknown as { days: { items: { recipeId: string }[] }[] }[]) for (const d of mp.days) for (const it of d.items) if (!RECIPES_BY_ID.has(it.recipeId)) unknownRecipes++;
  const out: string[] = [];
  if (unknownEx.size) out.push(`${unknownEx.size} exercise${unknownEx.size === 1 ? ' isn’t' : 's aren’t'} in this app or the backup (probably deleted custom exercises). Those entries are imported and shown by their stored id.`);
  if (workoutsMissingProgram) out.push(`${workoutsMissingProgram} workout${workoutsMissingProgram === 1 ? ' belongs' : 's belong'} to a program that isn’t in the backup or on this device. The workouts are imported on their own.`);
  if (unknownRecipes) out.push(`${unknownRecipes} meal plan item${unknownRecipes === 1 ? '' : 's'} refer${unknownRecipes === 1 ? 's' : ''} to recipes this app doesn’t have.`);
  return out;
}

export async function previewImport(db: LiftDb, backup: ValidatedBackup): Promise<ImportPreview> {
  const plan = await buildPlan(db, backup, { entities: [] });
  return {
    backup,
    rows: plan.rows,
    unknownEntities: backup.unknownEntities ?? [],
    warnings: await referenceWarnings(db, backup),
    singleton: plan.singleton,
    repaired: plan.repaired,
  };
}

function asOptions(o: ImportOptions | SyncedEntity[]): ImportOptions {
  return Array.isArray(o) ? { entities: o } : o;
}

/**
 * Import the selected records in ONE transaction (records + sync queue). Re-validates the backup and
 * re-plans against the current local state inside the transaction. Throws without changing anything on failure.
 */
export async function applyImport(db: LiftDb, backup: ValidatedBackup | Backup, options: ImportOptions | SyncedEntity[]): Promise<ImportResult> {
  const opts = asOptions(options);
  const valid = validateBackupObject(backup); // never trust an object that skipped parseBackup
  let result: ImportResult | null = null;
  await saveRecordsAtomic(async () => {
    const plan = await buildPlan(db, valid, opts);
    result = plan.result;
    return plan.writes;
  }, db);
  if (!result) throw new BackupValidationError('The import didn’t run. Nothing was changed.');
  return result;
}

/** Plain-language summary of what an import with these options would do (for the confirm button / tests). */
export function describePlan(p: ImportPreview, opts: ImportOptions): { add: number; replace: number; keep: number } {
  const sel = new Set(opts.entities);
  let add = 0;
  let replace = 0;
  let keep = 0;
  for (const r of p.rows) {
    if (!sel.has(r.entity)) continue;
    if (r.entity === 'account_state') {
      if (!p.singleton?.onDevice) add += r.newCount;
      else if (SINGLETON_PARTS.some((x) => p.singleton!.differs[x.key] && opts.singleton?.[x.key] === 'replace')) replace++;
      continue;
    }
    add += r.newCount;
    if ((opts.existing ?? 'keep') === 'replace') replace += r.differs;
    else keep += r.differs;
  }
  return { add, replace, keep };
}

export type { ValidatedBackup };

/* --------------------------------------------------------------- CSV */
/** Characters that make spreadsheet apps treat a cell as a formula (CSV/formula injection). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One CSV cell. Numbers (and booleans) are written as-is so numeric columns stay numeric.
 * Text is user-controlled: if it starts with = + - @ tab or CR it is prefixed with ' so spreadsheet apps
 * show it as text instead of evaluating it.
 */
export function csvCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  let s = String(v);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function workoutsCsv(sessions: WorkoutSession[], byId: Map<string, Exercise>): string {
  const rows: unknown[][] = [];
  for (const s of sessions.filter((x) => x.status === 'completed' && !x.deletedAt).sort((a, b) => a.startedAt - b.startedAt)) {
    for (const se of s.exercises) {
      const ex = byId.get(se.exerciseId);
      se.sets.forEach((st, i) =>
        rows.push([
          s.date, s.name, ex?.name ?? se.exerciseId, se.exerciseId, ex?.load ?? '', i + 1, st.type,
          st.weightKg != null ? Math.round(st.weightKg * 1000) / 1000 : '', st.entered ? `${st.entered.value} ${st.entered.unit}` : '',
          st.reps ?? '', st.durationSec ?? '', st.distanceM ?? '', st.rpe ?? '', st.rir ?? '', st.completed ? 'yes' : 'no',
        ]),
      );
    }
  }
  return toCsv(['date', 'workout', 'exercise', 'exercise_id', 'load_convention', 'set', 'set_type', 'weight_kg', 'entered_as', 'reps', 'duration_s', 'distance_m', 'rpe', 'rir', 'completed'], rows);
}

export function measurementsCsv(ms: Measurement[]): string {
  return toCsv(
    ['date', 'kind', 'value', 'unit', 'entered_as', 'note'],
    ms.filter((m) => !m.deletedAt).sort((a, b) => a.date.localeCompare(b.date)).map((m) => [m.date, m.kind, m.value, m.kind === 'bodyweight' ? 'kg' : m.kind === 'bodyfat_pct' ? '%' : 'cm', m.entered ? `${m.entered.value} ${m.entered.unit}` : '', m.note ?? '']),
  );
}

export function activitiesCsv(as: ActivityLog[]): string {
  return toCsv(
    ['date', 'type', 'name', 'duration_s', 'distance_m', 'elevation_m', 'avg_hr', 'max_hr', 'intensity', 'energy_kcal', 'energy_source', 'notes'],
    as.filter((a) => !a.deletedAt).sort((a, b) => a.date.localeCompare(b.date)).map((a) => [a.date, a.type, a.customName ?? '', a.durationSec, a.distanceM ?? '', a.elevationM ?? '', a.avgHr ?? '', a.maxHr ?? '', a.intensity ?? '', a.energyKcal ?? '', a.energySource ?? '', a.notes ?? '']),
  );
}

export function downloadText(filename: string, text: string, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const stamp = () => new Date().toISOString().slice(0, 10);
