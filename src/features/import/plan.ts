/**
 * Turn a parsed Strong/Hevy export into Hard Earned workouts, show what will happen, then write it.
 *
 * Rules:
 *  1. Nothing is written until `applyWorkoutImport` runs (the preview step).
 *  2. Each workout gets a STABLE id: a SHA-256 hash of the source app, the start time as written in the file and every
 *     exercise and set value, formatted as a UUID. Importing the same file again produces the same ids, so it adds
 *     nothing; the same id already in the cloud keeps the cloud copy (preferRemote). A workout whose source + start
 *     time was imported before (even if since edited in the other app, or deleted here) is skipped too.
 *  3. Exercise names are matched to the library (matching.ts). Unmatched names become custom exercises (one per
 *     name, reused across workouts and later imports), never dropped.
 *  4. Weights: the file's unit when it states one; otherwise the unit chosen in the preview. Warm-up sets stay
 *     warm-ups (they never count as working sets). Invalid values are repaired with sanitizeImportedSession.
 *  5. Imported workouts are ordinary completed sessions (history, progression, Progress), marked `imported`. The
 *     import never goes through the logger, so no coach cheers, auto-share, analytics "first workout" events or
 *     push notifications are triggered.
 *  6. All records and their sync-queue entries are written in ONE transaction: either everything or nothing.
 */
import type { CustomExercise, Equipment, Exercise, ISODate, LoadConvention, LoggedSet, MovementPattern, MuscleGroup, SessionExercise, TrackingType, WeightUnit, WorkoutSession } from '@/domain/types';
import type { LiftDb } from '@/db/db';
import { saveRecordsAtomic, type BulkWrite } from '@/db/repo';
import { localDate } from '@/lib/dates';
import { uuid } from '@/lib/id';
import { zonedToUtc } from '@/domain/pushSchedule';
import { toKg } from '@/domain/units';
import { defaultIncrement, normalizeText } from '@/data/exerciseMeta';
import { sanitizeImportedSession, setFieldsFor, validateLoggedSet } from '@/domain/setValidation';
import { t } from '@/i18n';
import { createMatcher, matchKey, qualifierEquipment, splitQualifier } from './matching';
import type { ImportDistanceUnit, ImportSource, ImportStart, ParsedExercise, ParsedImport, ParsedSet, ParsedWorkout } from './types';

export interface ImportOptions {
  timeZone: string;
  /** Unit used for weights when the file doesn't state one. */
  weightUnit: WeightUnit;
  now?: number;
}

export interface ExerciseLine {
  /** Name as written in the export. */
  name: string;
  exerciseId: string;
  /** Library name it maps to (same as `name` for new custom exercises). */
  exerciseName: string;
  sets: number;
}

export interface WorkoutImportPlan {
  source: ImportSource;
  /** Workouts in the file. */
  workoutsFound: number;
  /** Sets in the file (warm-ups included). */
  setsFound: number;
  /** Workouts that will be added / were imported before. */
  newWorkouts: number;
  alreadyImported: number;
  /** Sets that will be added (warm-ups included) and how many of them are warm-ups. */
  newSets: number;
  warmupSets: number;
  /** Calendar date range of the file's workouts (account time zone). */
  from?: ISODate;
  to?: ISODate;
  /** Export names mapped to existing exercises (library or earlier custom ones). */
  matched: ExerciseLine[];
  /** Export names that become new custom exercises. */
  created: ExerciseLine[];
  /** The file doesn't say whether weights are kg or lb (the preview asks). */
  unitNeeded: boolean;
  /** The file's slash dates could be day/month or month/day (the preview asks; Import waits for an answer). */
  dayOrderNeeded: boolean;
  skippedRows: number;
  /** Sets with impossible values, imported as not done / not recorded. */
  repairedSets: number;
  sessions: WorkoutSession[];
  customExercises: CustomExercise[];
}

/* ---------------------------------------------------------------- hashing */

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A UUID-shaped id from a hash (version nibble 5, RFC 4122 variant) — valid for the uuid columns in the backend. */
export function uuidFromHex(hex: string): string {
  const h = hex.slice(0, 32).split('');
  h[12] = '5';
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * The stable key "source|start time" of a workout: the start as read from the file (local wall-clock time, or the UTC
 * instant). Independent of the time zone or unit chosen at import; a different day/month choice gives a different key,
 * so a wrongly read date can be deleted and imported again with the right order.
 */
export const importKey = (source: ImportSource, w: Pick<ParsedWorkout, 'start'>) =>
  `${source}|${'local' in w.start ? w.start.local : new Date(w.start.epochMs).toISOString()}`;

/** Stable workout id: hash of source, start time and every exercise and set value as written in the file. */
export async function workoutHashId(source: ImportSource, w: ParsedWorkout): Promise<string> {
  const canonical = JSON.stringify([
    'hard-earned-import-v1',
    importKey(source, w),
    w.exercises.map((e) => [matchKey(e.name), e.sets.map((s) => [s.type, s.weight, s.weightUnit ?? '', s.reps, s.distance, s.distanceUnit ?? '', s.durationSec, s.rpe])]),
  ]);
  return uuidFromHex(await sha256Hex(canonical));
}

/* ------------------------------------------------------------- conversions */

const pad = (n: number) => String(n).padStart(2, '0');

/** Epoch ms of an export time, reading local wall-clock times in `timeZone`. */
export function startEpoch(start: ImportStart, timeZone: string): number {
  if ('epochMs' in start) return start.epochMs;
  const [date, time] = start.local.split('T');
  const [h, mi, s] = time.split(':').map(Number);
  return zonedToUtc(date, `${pad(h)}:${pad(mi)}`, timeZone).getTime() + (s || 0) * 1000;
}

const DIST_M: Record<ImportDistanceUnit, number> = { km: 1000, mi: 1609.344, m: 1 };
const round1 = (n: number) => Math.round(n * 10) / 10;

const usesLoad = (ex: Exercise) => ex.load !== 'none';

export const APP_NAME: Record<ImportSource, string> = { strong: 'Strong', hevy: 'Hevy' };

/** True when sets of `ex` can hold every value `s` recorded (weight, reps, distance, time). RPE is always kept. */
export function canStore(ex: Exercise, s: ParsedSet): boolean {
  const f = setFieldsFor(ex);
  const has = (v: number | null) => v != null && v > 0;
  return (!has(s.weight) || f.includes('weight')) && (!has(s.reps) || f.includes('reps')) && (!has(s.distance) || f.includes('distance')) && (!has(s.durationSec) || f.includes('duration'));
}

function toLoggedSet(s: ParsedSet, ex: Exercise, file: ParsedImport, opts: ImportOptions, at: number): LoggedSet {
  const unit = s.weightUnit ?? file.weightUnit ?? opts.weightUnit;
  const distUnit = s.distanceUnit ?? file.distanceUnit ?? (unit === 'lb' ? 'mi' : 'km');
  // A zero load means "not recorded" for external loads; for added/assistance loads 0 is real (bodyweight / unassisted).
  const zeroIsReal = ex.load === 'added' || ex.load === 'assistance';
  const weight = usesLoad(ex) && s.weight != null && (s.weight !== 0 || zeroIsReal) ? s.weight : null;
  return {
    id: uuid(),
    type: s.type,
    weightKg: weight != null ? toKg(weight, unit) : null,
    ...(weight != null ? { entered: { value: weight, unit } } : {}),
    reps: s.reps != null && s.reps !== 0 ? s.reps : null,
    durationSec: s.durationSec != null && s.durationSec !== 0 ? Math.round(s.durationSec) : null,
    distanceM: s.distance != null && s.distance !== 0 ? round1(s.distance * DIST_M[distUnit]) : null,
    rpe: s.rpe != null && s.rpe >= 1 && s.rpe <= 10 ? s.rpe : null,
    rir: null,
    completed: true,
    completedAt: at,
  };
}

/* -------------------------------------------------------- custom exercises */

const PATTERNS: [RegExp, MovementPattern, MuscleGroup[], Exercise['category']][] = [
  [/\b(carry|farmer)\b/, 'carry', ['full_body'], 'compound'],
  [/\b(run|running|jog|cycling|bike|cycle|elliptical|swim|stair|ski erg|walk|treadmill|cardio|rowing machine|rower)\b/, 'conditioning', ['cardio'], 'cardio'],
  [/\bleg curl\b|\bhamstring curl\b/, 'isolation_lower', ['hamstrings'], 'isolation'],
  [/\bleg extension\b/, 'isolation_lower', ['quads'], 'isolation'],
  [/\bcalf\b/, 'isolation_lower', ['calves'], 'isolation'],
  [/\b(abduct|adduct)/, 'isolation_lower', ['glutes'], 'isolation'],
  [/\b(squat|leg press)\b/, 'squat', ['quads', 'glutes'], 'compound'],
  [/\b(lunge|split squat|step up)\b/, 'lunge', ['quads', 'glutes'], 'compound'],
  [/\b(deadlift|rdl|good morning|hip thrust|swing|glute bridge|back extension|hyperextension)\b/, 'hinge', ['hamstrings', 'glutes'], 'compound'],
  [/\b(crunch|plank|sit up|situp|ab|abs|leg raise|knee raise|twist|rollout|wood ?chop|hollow)\b/, 'trunk', ['abs'], 'core'],
  [/\b(lateral raise|front raise|rear delt|reverse fly|face pull|upright row|shrug)\b/, 'isolation_upper', ['shoulders'], 'isolation'],
  [/\b(pull ?up|chin ?up|pulldown|pull down)\b/, 'vertical_pull', ['lats'], 'compound'],
  [/\brow\b/, 'horizontal_pull', ['upper_back', 'lats'], 'compound'],
  [/\b(overhead press|shoulder press|military|arnold|push press)\b/, 'vertical_push', ['shoulders'], 'compound'],
  [/\b(bench|chest press|push ?up|dip|fly|flye|crossover|pec deck)\b/, 'horizontal_push', ['chest'], 'compound'],
  [/\b(curl)\b/, 'isolation_upper', ['biceps'], 'isolation'],
  [/\b(tricep|skull ?crusher|pushdown|kickback)/, 'isolation_upper', ['triceps'], 'isolation'],
  [/\b(stretch|mobility|yoga)\b/, 'mobility', ['full_body'], 'mobility'],
];

/** A custom exercise for an unmatched export name, with tracking inferred from the values its sets recorded. */
export function inferCustomExercise(name: string, sets: ParsedSet[], id: string, now: number): CustomExercise {
  const any = (f: (s: ParsedSet) => number | null) => sets.some((s) => (f(s) ?? 0) > 0);
  const hasWeight = any((s) => s.weight);
  const hasReps = any((s) => s.reps);
  const hasDistance = any((s) => s.distance);
  const hasTime = any((s) => s.durationSec);
  const { qualifier } = splitQualifier(name);
  const lower = name.toLowerCase();
  const equipment: Equipment[] = qualifier ? qualifierEquipment(qualifier).slice(0, 1) : [];
  const assisted = /\bassist/.test(lower);
  const weighted = /\bweighted\b/.test(lower);
  let tracking: TrackingType;
  let load: LoadConvention;
  if (hasReps && assisted) [tracking, load] = ['assisted', 'assistance'];
  else if (hasReps && weighted) [tracking, load] = ['bodyweight_plus', 'added'];
  else if (hasReps && hasWeight) [tracking, load] = ['weight_reps', equipment[0] === 'dumbbell' ? 'per_hand' : equipment[0] === 'machine' || equipment[0] === 'cable' ? 'stack' : 'total'];
  else if (hasReps) [tracking, load] = ['reps', 'none'];
  // Loaded carries / sled pushes / weighted holds: distance and/or time with a load (distance_time keeps all three).
  else if (hasWeight && (hasDistance || hasTime)) [tracking, load] = ['distance_time', equipment[0] === 'dumbbell' || equipment[0] === 'kettlebell' ? 'per_hand' : 'total'];
  else if (hasDistance) [tracking, load] = ['distance_time', 'none'];
  else if (hasTime) [tracking, load] = ['duration', 'none'];
  else [tracking, load] = ['weight_reps', 'total'];
  const norm = ` ${normalizeText(name)} `;
  const guess = PATTERNS.find(([re]) => re.test(norm));
  const [pattern, primaryMuscles, category] = guess ? [guess[1], guess[2], guess[3]] : (['isolation_upper', ['full_body'], 'isolation'] as const);
  // Unloaded distance work is cardio; a loaded carry or sled keeps its guessed pattern (carry by default).
  const cardio = tracking === 'distance_time' && load === 'none';
  const loadedCarry = tracking === 'distance_time' && load !== 'none' && !guess;
  return {
    id,
    createdAt: now,
    updatedAt: now,
    custom: true,
    name: name.trim().slice(0, 120),
    aliases: [],
    category: cardio ? 'cardio' : category,
    primaryMuscles: [...(cardio ? (['cardio'] as MuscleGroup[]) : primaryMuscles)],
    secondaryMuscles: [],
    pattern: cardio ? 'conditioning' : loadedCarry ? 'carry' : pattern,
    equipment,
    difficulty: 1,
    tracking,
    load,
    ...(load === 'per_hand' ? { implements: 2 as const } : {}),
    ...(defaultIncrement(load) ? { increment: defaultIncrement(load) } : {}),
    stresses: [],
    setup: '',
    execution: '',
    cues: [],
    mistakes: [],
    substitutions: [],
  };
}

/* ------------------------------------------------------------------ plan */

export interface ExistingState {
  /** Ids of every session on this device (tombstones included). */
  sessionIds: Set<string>;
  /** `imported.key` of every imported session on this device (tombstones included). */
  importKeys: Set<string>;
  /** Ids of every custom exercise on this device (tombstones included). */
  customIds: Set<string>;
}

export async function readExistingState(db: LiftDb): Promise<ExistingState> {
  const sessions = await db.sessions.toArray();
  const customs = await db.customExercises.toArray();
  return {
    sessionIds: new Set(sessions.map((s) => s.id)),
    importKeys: new Set(sessions.flatMap((s) => (s.imported?.key ? [s.imported.key] : []))),
    customIds: new Set(customs.map((c) => c.id)),
  };
}

/**
 * Build the import plan (pure apart from hashing): which workouts are new, how exercises map, which custom exercises
 * to create, and the finished session records. `library` = bundled exercises + the user's live custom exercises.
 *
 * Every exercise block must be able to hold what its sets recorded (`blockFits`): a library match that would drop a
 * recorded weight, reps, distance or time, or that would turn valid sets into not-done ones (rep-count Mountain
 * Climbers on a timed exercise), is replaced for that block by a compatible custom variant named
 * "<export name> (<app>)", inferred from those sets and reused by later imports.
 */
export async function buildImportPlan(file: ParsedImport, library: Exercise[], existing: ExistingState, opts: ImportOptions): Promise<WorkoutImportPlan> {
  const now = opts.now ?? Date.now();
  const matcher = createMatcher(library);
  const keyOf = (name: string) => matchKey(name) || name.trim();
  const customByKey = new Map(library.filter((e) => e.custom).map((e) => [matchKey(e.name), e] as const));
  const newIds = new Set<string>();
  const newCustomId = async (seed: string) => {
    const hashed = uuidFromHex(await sha256Hex(seed));
    // Never overwrite a renamed or deleted custom exercise that happens to have this id.
    const id = existing.customIds.has(hashed) || newIds.has(hashed) ? uuid() : hashed;
    newIds.add(id);
    return id;
  };

  // 1. One candidate per distinct export name: the library match, or a new custom exercise inferred from all its sets.
  const setsByName = new Map<string, ParsedSet[]>();
  for (const w of file.workouts) for (const e of w.exercises) setsByName.set(keyOf(e.name), [...(setsByName.get(keyOf(e.name)) ?? []), ...e.sets]);
  const candidates = new Map<string, Exercise>();
  const created: CustomExercise[] = [];
  for (const w of file.workouts) {
    for (const e of w.exercises) {
      const k = keyOf(e.name);
      if (candidates.has(k)) continue;
      const hit = matcher.match(e.name);
      if (hit) candidates.set(k, hit);
      else {
        const c = inferCustomExercise(e.name, setsByName.get(k) ?? [], await newCustomId(`hard-earned-import-exercise-v1|${k}`), now);
        candidates.set(k, c);
        created.push(c);
      }
    }
  }

  // 2. Blocks the candidate can't represent get a compatible variant (one per export name).
  const at = 0;
  const blockFits = (ex: Exercise, sets: ParsedSet[], variant: Exercise) =>
    sets.every((s) => {
      if (!canStore(ex, s)) return false;
      if (validateLoggedSet(toLoggedSet(s, ex, file, opts, at), ex, { mode: 'record' }).ok) return true;
      // Invalid either way (e.g. fractional reps) → the source data is the problem, not the mapping.
      return !validateLoggedSet(toLoggedSet(s, variant, file, opts, at), variant, { mode: 'record' }).ok;
    });
  const misfit = new Map<string, ParsedSet[]>();
  const misfitBlocks = new Set<ParsedExercise>();
  for (const w of file.workouts) {
    for (const e of w.exercises) {
      const k = keyOf(e.name);
      const probe = inferCustomExercise(e.name, e.sets, 'probe', now);
      if (blockFits(candidates.get(k)!, e.sets, probe)) continue;
      misfitBlocks.add(e);
      misfit.set(k, [...(misfit.get(k) ?? []), ...e.sets]);
    }
  }
  const variants = new Map<string, Exercise>();
  for (const [k, sets] of misfit) {
    const exportName = file.workouts.flatMap((w) => w.exercises).find((e) => keyOf(e.name) === k)!.name.trim();
    const inferred = inferCustomExercise(exportName, sets, 'probe', now);
    let chosen: Exercise | null = null;
    for (let n = 1; n < 50 && !chosen; n++) {
      const name = `${exportName} (${APP_NAME[file.source]}${n > 1 ? ` ${n}` : ''})`;
      const prior = customByKey.get(matchKey(name));
      if (prior) {
        if (sets.every((s) => canStore(prior, s))) chosen = prior;
        continue;
      }
      const v: CustomExercise = { ...inferred, name, id: await newCustomId(`hard-earned-import-variant-v1|${file.source}|${k}|${n}`) };
      created.push(v);
      chosen = v;
    }
    variants.set(k, chosen ?? candidates.get(k)!);
  }
  const exerciseFor = (e: ParsedExercise) => (misfitBlocks.has(e) ? variants.get(keyOf(e.name))! : candidates.get(keyOf(e.name))!);
  const byId = new Map<string, Exercise>([...library.map((e) => [e.id, e] as const), ...created.map((c) => [c.id, c] as const)]);

  // 3. Build sessions; split into new and already imported.
  const sessions: WorkoutSession[] = [];
  const seenIds = new Set<string>();
  let alreadyImported = 0;
  let repairedSets = 0;
  let setsFound = 0;
  const dates: ISODate[] = [];
  const lines = new Map<string, ExerciseLine & { isNew: boolean }>();
  for (const w of file.workouts) {
    const startedAt = startEpoch(w.start, opts.timeZone);
    const date = localDate(startedAt, opts.timeZone);
    dates.push(date);
    setsFound += w.exercises.reduce((n, e) => n + e.sets.length, 0);
    for (const e of w.exercises) {
      const ex = exerciseFor(e);
      const lk = `${keyOf(e.name)}\u0000${ex.id}`;
      const line = lines.get(lk) ?? { name: e.name.trim(), exerciseId: ex.id, exerciseName: ex.name, sets: 0, isNew: newIds.has(ex.id) };
      line.sets += e.sets.length;
      lines.set(lk, line);
    }
    const id = await workoutHashId(file.source, w);
    const key = importKey(file.source, w);
    if (existing.sessionIds.has(id) || existing.importKeys.has(key) || seenIds.has(id)) {
      alreadyImported++;
      continue;
    }
    seenIds.add(id);
    let endedAt = w.end ? startEpoch(w.end, opts.timeZone) : w.durationSec ? startedAt + w.durationSec * 1000 : undefined;
    if (endedAt != null && !(endedAt > startedAt)) endedAt = undefined;
    const exercises: SessionExercise[] = w.exercises.map((e, i) => {
      const ex = exerciseFor(e);
      return {
        id: uuid(),
        exerciseId: ex.id,
        order: i,
        ...(e.supersetId ? { supersetGroup: e.supersetId } : {}),
        sets: e.sets.map((s) => toLoggedSet(s, ex, file, opts, endedAt ?? startedAt)),
        ...(e.notes ? { notes: e.notes } : {}),
      };
    });
    const raw: WorkoutSession = {
      id,
      createdAt: now,
      updatedAt: now,
      name: w.name.trim() || t('import.defaultWorkoutName'),
      status: 'completed',
      date,
      timeZone: opts.timeZone,
      startedAt,
      ...(endedAt != null ? { endedAt } : {}),
      pausedTotalMs: 0,
      exercises,
      ...(w.notes ? { notes: w.notes } : {}),
      imported: { source: file.source, key, importedAt: now },
    };
    const { session, issues } = sanitizeImportedSession(raw, byId);
    repairedSets += issues.length;
    sessions.push(session);
  }

  // 4. Custom exercises used by the new workouts; exercise lists for the preview.
  const usedIds = new Set(sessions.flatMap((s) => s.exercises.map((e) => e.exerciseId)));
  const customExercises = created.filter((c) => usedIds.has(c.id));
  const strip = ({ isNew: _n, ...l }: ExerciseLine & { isNew: boolean }): ExerciseLine => l;
  const byName = (a: ExerciseLine, b: ExerciseLine) => a.name.localeCompare(b.name) || a.exerciseName.localeCompare(b.exerciseName);
  const matched = [...lines.values()].filter((l) => !l.isNew).map(strip).sort(byName);
  const createdLines = [...lines.values()].filter((l) => l.isNew && usedIds.has(l.exerciseId)).map(strip).sort(byName);
  const allSets = sessions.flatMap((s) => s.exercises.flatMap((e) => e.sets));
  const sortedDates = [...dates].sort();
  return {
    source: file.source,
    workoutsFound: file.workouts.length,
    setsFound,
    newWorkouts: sessions.length,
    alreadyImported,
    newSets: allSets.length,
    warmupSets: allSets.filter((s) => s.type === 'warmup').length,
    from: sortedDates[0],
    to: sortedDates[sortedDates.length - 1],
    matched,
    created: createdLines,
    unitNeeded: file.weightUnit == null && file.workouts.some((w) => w.exercises.some((e) => e.sets.some((s) => s.weight != null && s.weight !== 0 && !s.weightUnit))),
    dayOrderNeeded: file.dayOrderNeeded,
    skippedRows: file.skippedRows,
    repairedSets,
    sessions: sessions.sort((a, b) => a.startedAt - b.startedAt),
    customExercises,
  };
}

/** Read this device's state and build the plan. `library` = bundled + live custom exercises. */
export async function planWorkoutImport(db: LiftDb, file: ParsedImport, library: Exercise[], opts: ImportOptions): Promise<WorkoutImportPlan> {
  return buildImportPlan(file, library, await readExistingState(db), opts);
}

/**
 * Write the plan in one transaction (custom exercises first, then workouts). Records that appeared on this device
 * since the preview (e.g. a second tap, or sync) are skipped, so the import stays idempotent.
 */
export async function applyWorkoutImport(db: LiftDb, plan: WorkoutImportPlan): Promise<{ workouts: number; exercises: number }> {
  let workouts = 0;
  let exercises = 0;
  await saveRecordsAtomic(async () => {
    const writes: BulkWrite[] = [];
    workouts = 0;
    exercises = 0;
    for (const c of plan.customExercises) {
      if (await db.customExercises.get(c.id)) continue;
      writes.push({ entity: 'custom_exercises', record: c, preferRemote: true });
      exercises++;
    }
    for (const s of plan.sessions) {
      if (await db.sessions.get(s.id)) continue;
      writes.push({ entity: 'sessions', record: s, preferRemote: true });
      workouts++;
    }
    return writes;
  }, db);
  return { workouts, exercises };
}
