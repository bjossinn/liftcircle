/**
 * Validation of Hard Earned backup files (format 'liftcircle-backup', version 1).
 *
 * Everything here is pure (no Dexie, no network) and runs BEFORE any local data is touched.
 * Rules:
 *  - Envelope: exact format id, integer version 1…BACKUP_VERSION (newer → "update the app"), records map.
 *  - Size: file ≤ MAX_BACKUP_BYTES, ≤ MAX_RECORDS_PER_ENTITY per type, ≤ MAX_RECORDS_TOTAL overall,
 *    bounded string lengths and nested list sizes.
 *  - Every known entity is checked against its schema (types, required fields, nested objects, finite
 *    numbers). Objects are "loose": fields this version doesn't know about are kept, so a round trip
 *    never drops data added by another part of the app.
 *  - IDs: non-empty bounded strings; duplicates inside the file (per type) and duplicate nested ids
 *    (session exercises/sets, program templates/slots) are errors.
 *  - References inside one record (program currentVersion → versions, schedule → template ids) are errors.
 *    References between records (workout → exercise/program, meal plan → recipe) are reported as
 *    warnings, because a backup can legitimately reference something deleted before it was made.
 *  - Set VALUES (negative/out-of-range numbers, completed sets missing reps/time) are not rejected here:
 *    the importer repairs them with sanitizeImportedSession (invalid values become "not recorded",
 *    invalid completed sets are imported as not completed) and the preview says how many.
 * Any error rejects the whole file: nothing is imported.
 */
import { z } from 'zod';
import { ACCOUNT_ROW_ID, SYNCED_ENTITIES, type SyncedEntity } from '@/db/db';

export const BACKUP_FORMAT = 'liftcircle-backup';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
export const MAX_RECORDS_PER_ENTITY = 50_000;
export const MAX_RECORDS_TOTAL = 200_000;
const MAX_ISSUES_SHOWN = 8;

/** An error whose message is meant for the person importing (kept as-is through storage helpers). */
export class BackupValidationError extends Error {
  readonly userFacing = true;
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length ? `${message}\n${issues.slice(0, MAX_ISSUES_SHOWN).map((i) => `• ${i}`).join('\n')}${issues.length > MAX_ISSUES_SHOWN ? `\n…and ${issues.length - MAX_ISSUES_SHOWN} more` : ''}` : message);
  }
}

/* ---------------------------------------------------------------- primitives */
const id = z.string().min(1, 'missing id').max(128, 'id is too long');
const str = (max = 200) => z.string().max(max);
const text = str(10_000);
const fin = z.number(); // zod 4 rejects NaN and ±Infinity
const nonNeg = (max: number) => z.number().min(0).max(max);
const epoch = z.number().min(0).max(4_102_444_800_000); // ≤ year 2100
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');
const ids = (max = 1000) => z.array(str(128)).max(max);
const opt = <T extends z.ZodType>(t: T) => t.optional();
const nullish = <T extends z.ZodType>(t: T) => t.nullable().optional();

const syncFields = {
  id,
  createdAt: opt(epoch),
  updatedAt: opt(epoch),
  serverVersion: opt(fin),
  deletedAt: opt(epoch),
};

const entered = z.looseObject({ value: fin, unit: z.enum(['kg', 'lb']) });

/* ---------------------------------------------------------------- programs */
const prescription = z.looseObject({
  id,
  exerciseId: id,
  sets: nonNeg(100),
  repMin: nonNeg(1000),
  repMax: nonNeg(1000),
  targetRir: z.number().min(-1).max(20),
  restSec: nonNeg(86_400),
  durationSec: opt(nonNeg(86_400)),
  warmup: opt(text),
  priority: opt(fin),
  startLoadKg: opt(nonNeg(2000)),
  alternatives: opt(ids(200)),
  notes: opt(text),
});

const sessionTemplate = z.looseObject({
  id,
  name: str(),
  focus: opt(str()),
  kind: opt(str(32)),
  exercises: z.array(prescription).max(200),
  estimatedMinutes: opt(nonNeg(24 * 60)),
  cardio: opt(z.looseObject({ activity: str(64), minutes: nonNeg(24 * 60), intensity: str(32), notes: opt(text) })),
  trimmedExerciseIds: opt(ids(200)),
});

const programVersion = z.looseObject({
  version: z.number().int().min(1).max(100_000),
  createdAt: opt(epoch),
  reason: opt(text),
  templates: z.array(sessionTemplate).max(100),
  schedule: z.array(z.looseObject({ weekday: z.number().int().min(0).max(6), templateId: id })).max(100),
  weeks: opt(nonNeg(520)),
  reviewWeek: opt(nonNeg(520)),
  rationale: opt(z.array(text).max(200)),
  warnings: opt(z.array(text).max(200)),
});

const program = z.looseObject({
  ...syncFields,
  name: str(),
  source: str(32),
  managedBy: opt(z.looseObject({ kind: str(32) })),
  startDate: isoDate,
  active: z.boolean(),
  currentVersion: z.number().int().min(1),
  versions: z.array(programVersion).min(1).max(1000),
  inputs: opt(z.looseObject({})),
  rotationIndex: opt(nonNeg(1_000_000)),
  overrides: opt(z.array(z.looseObject({ date: isoDate, templateId: id, status: str(32), movedTo: opt(isoDate) })).max(10_000)),
});

/* ---------------------------------------------------------------- logging */
const loggedSet = z.looseObject({
  id,
  type: str(32),
  // Values are repaired (not rejected) by sanitizeImportedSession — only types/finiteness are enforced here.
  weightKg: nullish(fin),
  entered: opt(entered),
  reps: nullish(fin),
  durationSec: nullish(fin),
  distanceM: nullish(fin),
  rpe: nullish(fin),
  rir: nullish(fin),
  completed: z.boolean(),
  completedAt: opt(epoch),
});

const sessionExercise = z.looseObject({
  id,
  exerciseId: id,
  order: fin,
  supersetGroup: opt(str(64)),
  prescription: opt(z.looseObject({})),
  sets: z.array(loggedSet).max(500),
  notes: opt(text),
  discomfort: opt(z.boolean()),
  swappedFrom: opt(str(128)),
});

const session = z.looseObject({
  ...syncFields,
  name: str(),
  status: z.enum(['active', 'completed']),
  programId: opt(str(128)),
  programVersion: opt(fin),
  templateId: opt(str(128)),
  plannedDate: opt(isoDate),
  date: isoDate,
  timeZone: str(64),
  startedAt: epoch,
  endedAt: opt(epoch),
  pausedAt: opt(epoch),
  pausedTotalMs: nonNeg(365 * 86_400_000),
  exercises: z.array(sessionExercise).max(200),
  notes: opt(text),
  rest: opt(z.looseObject({})),
  sharedPostIds: opt(ids()),
});

/* ---------------------------------------------------------------- other entities */
const activity = z.looseObject({
  ...syncFields,
  type: str(64),
  customName: opt(str()),
  date: isoDate,
  timeZone: str(64),
  startedAt: opt(epoch),
  durationSec: nonNeg(7 * 86_400),
  distanceM: opt(nonNeg(10_000_000)),
  elevationM: opt(z.number().min(-20_000).max(100_000)),
  avgHr: opt(nonNeg(400)),
  maxHr: opt(nonNeg(400)),
  intensity: opt(str(32)),
  energyKcal: opt(nonNeg(100_000)),
  energySource: opt(str(32)),
  notes: opt(text),
  sharedPostIds: opt(ids()),
});

const activityTemplate = z.looseObject({
  ...syncFields,
  name: str(),
  type: str(64),
  durationSec: opt(nonNeg(7 * 86_400)),
  distanceM: opt(nonNeg(10_000_000)),
  intervals: opt(z.array(z.looseObject({ label: str(), seconds: nonNeg(86_400), repeat: nonNeg(1000) })).max(500)),
});

const measurement = z.looseObject({
  ...syncFields,
  kind: str(64),
  date: isoDate,
  value: z.number().min(0).max(10_000),
  entered: opt(entered),
  note: opt(text),
});

const goal = z.looseObject({
  ...syncFields,
  title: str(),
  kind: str(64),
  exerciseId: opt(str(128)),
  target: fin,
  deadline: opt(isoDate),
  achievedAt: opt(epoch),
});

const customExercise = z.looseObject({
  ...syncFields,
  name: str().min(1),
  category: opt(str(32)),
  pattern: str(64),
  tracking: str(64),
  load: str(64),
  equipment: z.array(str(64)).max(50),
  primaryMuscles: z.array(str(64)).max(50),
  secondaryMuscles: opt(z.array(str(64)).max(50)),
  aliases: opt(z.array(str()).max(100)),
  substitutions: opt(ids(200)),
  cues: opt(z.array(text).max(100)),
  mistakes: opt(z.array(text).max(100)),
  setup: opt(text),
  execution: opt(text),
});

const macrosPartial = z.looseObject({ kcal: opt(nonNeg(100_000)), protein: opt(nonNeg(10_000)), carbs: opt(nonNeg(10_000)), fat: opt(nonNeg(10_000)), fiber: opt(nonNeg(10_000)) });

const customFood = z.looseObject({
  ...syncFields,
  name: str().min(1),
  brand: opt(str()),
  per: z.looseObject({ amount: nonNeg(100_000), unit: str(16) }),
  macros: macrosPartial,
  isLabel: opt(z.boolean()),
});

const foodItem = {
  name: str(),
  source: z.looseObject({ kind: str(32), refId: opt(str(128)) }),
  servings: opt(nonNeg(1000)),
  grams: opt(nonNeg(100_000)),
  kcal: opt(nonNeg(100_000)),
  protein: opt(nonNeg(10_000)),
  carbs: opt(nonNeg(10_000)),
  fat: opt(nonNeg(10_000)),
};

const foodLog = z.looseObject({ ...syncFields, date: isoDate, meal: str(32), ...foodItem });
const savedMeal = z.looseObject({ ...syncFields, name: str(), items: z.array(z.looseObject(foodItem)).max(200) });

const mealPlan = z.looseObject({
  ...syncFields,
  weekStart: isoDate,
  days: z.array(z.looseObject({ date: isoDate, items: z.array(z.looseObject({ id, slot: str(32), recipeId: id, servings: nonNeg(100) })).max(50) })).max(31),
  shoppingChecked: opt(ids(5000)),
});

const savedTemplate = z.looseObject({ ...syncFields, template: sessionTemplate });

const accountState = z.looseObject({
  ...syncFields,
  id: z.literal(ACCOUNT_ROW_ID),
  settings: z.looseObject({
    units: z.looseObject({ weight: z.enum(['kg', 'lb']), length: z.enum(['cm', 'ftin']), distance: z.enum(['km', 'mi']) }),
    theme: opt(str(16)),
    weekStart: opt(z.number().int().min(0).max(6)),
    timeZone: opt(str(64)),
    rest: opt(z.looseObject({ defaultSec: opt(nonNeg(3600)) })),
    workout: opt(z.looseObject({ defaultSets: opt(nonNeg(100)), plateIncrementKg: opt(nonNeg(100)), plateIncrementLb: opt(nonNeg(200)) })),
    notifications: opt(z.looseObject({})),
    social: opt(z.looseObject({ discoverable: opt(z.boolean()) })),
    nutritionEnabled: opt(z.boolean()),
    demoData: opt(z.boolean()),
  }),
  profile: z.looseObject({
    displayName: opt(str()),
    age: opt(nonNeg(150)),
    heightCm: opt(nonNeg(300)),
    targetWeightKg: opt(nonNeg(1000)),
    limitations: opt(z.array(str(64)).max(50)),
    injuryNotes: opt(text),
    diet: opt(z.looseObject({})),
  }),
  nutrition: z.looseObject({
    mode: str(32),
    proteinG: opt(nonNeg(2000)),
    proteinPerKg: opt(nonNeg(10)),
    calories: opt(nonNeg(20_000)),
    mealsPerDay: opt(nonNeg(20)),
  }),
  favorites: opt(z.looseObject({ exercises: opt(ids(5000)), recipes: opt(ids(5000)) })),
});

export const ENTITY_SCHEMAS: Record<SyncedEntity, z.ZodType> = {
  account_state: accountState,
  programs: program,
  templates: savedTemplate,
  sessions: session,
  activities: activity,
  activity_templates: activityTemplate,
  measurements: measurement,
  goals: goal,
  custom_exercises: customExercise,
  custom_foods: customFood,
  food_logs: foodLog,
  saved_meals: savedMeal,
  meal_plans: mealPlan,
};

const envelope = z.looseObject({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int().min(1),
  exportedAt: z.string().max(64),
  records: z.record(z.string().max(64), z.array(z.unknown())),
});

export interface ValidatedBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  app?: string;
  exportedAt: string;
  includesMedia?: boolean;
  note?: string;
  records: Partial<Record<SyncedEntity, { id: string; [k: string]: unknown }[]>>;
  /** Record types in the file that this version doesn't know (ignored, listed in the preview). */
  unknownEntities: string[];
}

/* ---------------------------------------------------------------- helpers */
function pathText(path: PropertyKey[]): string {
  return path.map((p) => (typeof p === 'number' ? `[${p + 1}]` : `.${String(p)}`)).join('').replace(/^\./, '');
}

function dupes(list: string[]): string[] {
  const seen = new Set<string>();
  const d = new Set<string>();
  for (const x of list) (seen.has(x) ? d : seen).add(x);
  return [...d];
}

/** Integrity checks inside one record (nested ids, program references). */
function recordIntegrity(entity: SyncedEntity, r: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (entity === 'sessions') {
    const exs = r.exercises as { id: string; sets: { id: string }[] }[];
    const d = dupes(exs.map((e) => e.id));
    if (d.length) out.push(`duplicate exercise entry id ${d[0]}`);
    exs.forEach((e, i) => {
      const ds = dupes(e.sets.map((s) => s.id));
      if (ds.length) out.push(`exercise ${i + 1} has duplicate set id ${ds[0]}`);
    });
  }
  const checkTemplate = (t: { id: string; exercises: { id: string }[] }, where: string) => {
    const d = dupes(t.exercises.map((p) => p.id));
    if (d.length) out.push(`${where}: duplicate exercise slot id ${d[0]}`);
  };
  if (entity === 'programs') {
    const versions = r.versions as { version: number; templates: { id: string; name?: string; exercises: { id: string }[] }[]; schedule: { templateId: string }[] }[];
    const dv = dupes(versions.map((v) => String(v.version)));
    if (dv.length) out.push(`duplicate program version ${dv[0]}`);
    if (!versions.some((v) => v.version === r.currentVersion)) out.push(`current version ${String(r.currentVersion)} is missing`);
    for (const v of versions) {
      const tids = v.templates.map((t) => t.id);
      const dt = dupes(tids);
      if (dt.length) out.push(`version ${v.version}: duplicate session template id ${dt[0]}`);
      const known = new Set(tids);
      const missing = v.schedule.filter((s) => !known.has(s.templateId)).map((s) => s.templateId);
      if (missing.length) out.push(`version ${v.version}: schedule refers to unknown session template ${missing[0]}`);
      v.templates.forEach((t) => checkTemplate(t, `version ${v.version}, ${t.name || t.id}`));
    }
  }
  if (entity === 'templates') checkTemplate(r.template as { id: string; exercises: { id: string }[] }, 'template');
  if (entity === 'meal_plans') {
    const items = (r.days as { items: { id: string }[] }[]).flatMap((d) => d.items.map((i) => i.id));
    const d = dupes(items);
    if (d.length) out.push(`duplicate meal plan item id ${d[0]}`);
  }
  return out;
}

/** Parse JSON without letting a "__proto__" key reach object prototypes. */
function safeJsonParse(textIn: string): unknown {
  return JSON.parse(textIn, (key, value) => (key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value));
}

/* ---------------------------------------------------------------- entry points */
export function parseBackupText(textIn: string): ValidatedBackup {
  if (textIn.length > MAX_BACKUP_BYTES) throw new BackupValidationError('This file is too large to be a Hard Earned backup.');
  const trimmed = textIn.trim();
  if (!trimmed) throw new BackupValidationError('This file is empty.');
  let json: unknown;
  try {
    json = safeJsonParse(trimmed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    const truncated = trimmed.startsWith('{') && (/end of (json )?input|unterminated|unexpected end/i.test(msg) || !trimmed.endsWith('}'));
    throw new BackupValidationError(truncated ? 'This backup file looks incomplete (it may have been cut off while downloading or copying). Nothing was imported.' : 'This file isn’t valid JSON, so it can’t be a Hard Earned backup.');
  }
  return validateBackupObject(json);
}

export function validateBackupObject(json: unknown): ValidatedBackup {
  const head = z.looseObject({ format: z.literal(BACKUP_FORMAT) }).safeParse(json);
  if (!head.success) throw new BackupValidationError('This doesn’t look like a Hard Earned backup file.');
  const v = (json as { version?: unknown }).version;
  if (typeof v === 'number' && Number.isInteger(v) && v > BACKUP_VERSION) {
    throw new BackupValidationError(`This backup was made by a newer version of the app (backup format ${v}; this app reads up to ${BACKUP_VERSION}). Update the app and try again. Nothing was imported.`);
  }
  const env = envelope.safeParse(json);
  if (!env.success) {
    throw new BackupValidationError('This backup file is damaged or incomplete.', env.error.issues.slice(0, 5).map((i) => `${pathText(i.path) || 'file'}: ${i.message}`));
  }
  const issues: string[] = [];
  const records: ValidatedBackup['records'] = {};
  const unknownEntities: string[] = [];
  let total = 0;
  for (const [key, list] of Object.entries(env.data.records)) {
    if (!Object.prototype.hasOwnProperty.call(SYNCED_ENTITIES, key)) {
      unknownEntities.push(key);
      continue;
    }
    const entity = key as SyncedEntity;
    if (list.length > MAX_RECORDS_PER_ENTITY) {
      issues.push(`${entity}: ${list.length} records is more than this app can import at once (${MAX_RECORDS_PER_ENTITY}).`);
      continue;
    }
    total += list.length;
    const schema = ENTITY_SCHEMAS[entity];
    const ok: { id: string; [k: string]: unknown }[] = [];
    list.forEach((raw, i) => {
      const r = schema.safeParse(raw);
      if (!r.success) {
        const first = r.error.issues[0];
        issues.push(`${entity} record ${i + 1}${first ? ` (${pathText(first.path) || 'record'})` : ''}: ${first?.message ?? 'invalid'}`);
        return;
      }
      const rec = r.data as { id: string; [k: string]: unknown };
      for (const p of recordIntegrity(entity, rec)) issues.push(`${entity} record ${i + 1}: ${p}`);
      ok.push(rec);
    });
    const d = dupes(ok.map((r) => r.id));
    if (d.length) issues.push(`${entity}: the id ${d[0]} appears more than once${d.length > 1 ? ` (and ${d.length - 1} other duplicate id${d.length > 2 ? 's' : ''})` : ''}.`);
    if (entity === 'account_state' && ok.length > 1) issues.push('account_state: a backup can contain only one settings record.');
    records[entity] = ok;
  }
  if (total > MAX_RECORDS_TOTAL) issues.push(`The file has ${total} records; the limit is ${MAX_RECORDS_TOTAL}.`);
  if (issues.length) throw new BackupValidationError('This backup can’t be imported because some records are invalid. Nothing was imported.', issues);
  return {
    format: BACKUP_FORMAT,
    version: env.data.version,
    app: typeof env.data.app === 'string' ? env.data.app : undefined,
    exportedAt: env.data.exportedAt,
    includesMedia: env.data.includesMedia === true ? true : false,
    note: typeof env.data.note === 'string' ? env.data.note : undefined,
    records,
    unknownEntities,
  };
}
