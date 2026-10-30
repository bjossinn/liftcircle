/**
 * Training statistics, personal records and short factual observations.
 * Pure functions over the CURRENT records, so editing a historical set or session
 * recomputes every summary, chart and record naturally.
 *
 * Conventions (also exported as `VOLUME_CONVENTIONS` so the UI can show them):
 * - Warm-up sets are counted separately and excluded from working sets, volume and records.
 * - A working set is a completed set of type normal, drop or timed.
 * - Load volume = load × reps × (implements ?? 1). A pair of dumbbells logged "per hand" has implements = 2.
 * - Unilateral exercises log reps per side; each side lifts the load, so volume is multiplied by 2.
 *   Rep totals are shown as logged (per side).
 * - Volume is split into free weights (barbell/dumbbell/kettlebell, convention total or per_hand),
 *   machines & cables (stack settings, not comparable with free weights) and added load on bodyweight
 *   exercises (weighted dip/pull-up: the added load only, not your bodyweight).
 * - Assisted and pure bodyweight exercises are excluded from load volume; their reps are counted instead.
 * - Estimated 1RM uses the Epley formula w × (1 + reps/30), only for free-weight weight×reps exercises
 *   and sets of 1–10 reps. It is an estimate, not a tested maximum.
 * - Weekly working sets per muscle: primary muscles count 1 set, secondary muscles 0.5.
 * - Records compare only sets of the same exercise (same id, therefore the same load convention).
 */
import type {
  ActivityLog, ActivityType, Exercise, FoodLogEntry, ID, ISODate, LoggedSet, Measurement, MuscleGroup, UserGoal,
  WeightUnit, WorkoutSession,
} from './types';
import { addDays, diffDays, rangeDays, startOfWeek } from '@/lib/dates';
import { formatWeight, fromKg, round, trimNum } from './units';
import { hasRecordedLoad, isCountableSet, isValidCompletedSet } from './setValidation';

export const VOLUME_CONVENTIONS: string[] = [
  'Warm-up sets are counted separately and are not included in working sets, volume or records.',
  'Volume = weight × reps. Dumbbells entered per hand count both dumbbells (× 2).',
  'Unilateral exercises are logged as reps per side; volume counts both sides (× 2).',
  'Free weights, machines/cables and added load on bodyweight exercises are kept separate because the numbers are not comparable.',
  'Assisted and bodyweight-only exercises are not included in load volume; their reps are counted instead.',
  'Estimated 1RM uses the Epley formula: weight × (1 + reps ÷ 30), for free-weight sets of 1–10 reps only. It is an estimate.',
  'Working sets per muscle: a primary muscle counts as 1 set, a secondary muscle as 0.5.',
];
/** Single-string form of the conventions (e.g. for share snapshots). */
export const CONVENTIONS = VOLUME_CONVENTIONS.join(' ');
export const VOLUME_CONVENTION_SHORT = 'Working sets only; per-hand dumbbells ×2; unilateral ×2 (both sides).';

/* ------------------------------------------------------------------ sets */
export function isWarmup(set: LoggedSet): boolean {
  return set.type === 'warmup';
}
/**
 * Completed, VALID, non-warm-up set (shared rules in domain/setValidation). Invalid completed sets
 * (0 reps, negative/non-finite numbers, no time on a timed set…) never count as work.
 * Pass the exercise whenever it is known; without it generic rules apply.
 */
export function isWorkingSet(set: LoggedSet, ex?: Exercise): boolean {
  return isCountableSet(set, ex);
}

/** Epley estimated one-rep max. Only for 1–10 reps and a positive load. */
export function e1rm(weightKg: number, reps: number): number | null {
  if (!(weightKg > 0) || !Number.isFinite(weightKg)) return null;
  if (!Number.isInteger(reps) || reps < 1 || reps > 10) return null;
  return weightKg * (1 + reps / 30);
}

/** Loaded weight×reps free-weight exercise (total or per_hand convention). */
export function e1rmEligible(ex: Exercise): boolean {
  return ex.tracking === 'weight_reps' && (ex.load === 'total' || ex.load === 'per_hand');
}

export type VolumeBucket = 'free' | 'machine' | 'added';
/** Which load-volume bucket an exercise belongs to, or null when it has no comparable load volume. */
export function volumeBucket(ex: Exercise): VolumeBucket | null {
  if (ex.tracking === 'weight_reps') {
    if (ex.load === 'total' || ex.load === 'per_hand') return 'free';
    if (ex.load === 'stack') return 'machine';
    return null;
  }
  if (ex.tracking === 'bodyweight_plus' && ex.load === 'added') return 'added';
  return null;
}

/** Multiplier applied to load × reps: implements (2 for a pair of dumbbells) × sides (2 for unilateral). */
export function volumeMultiplier(ex: Exercise): number {
  return (ex.implements ?? 1) * (ex.unilateral ? 2 : 1);
}

/** Load volume of one set in kg; 0 for warm-ups, incomplete sets and non-comparable exercises. */
export function setVolumeKg(set: LoggedSet, ex: Exercise): number {
  if (!isWorkingSet(set, ex)) return 0;
  if (!volumeBucket(ex)) return 0;
  if (!hasRecordedLoad(set, ex)) return 0; // "load not recorded" never becomes volume
  const w = set.weightKg ?? 0;
  const r = set.reps ?? 0;
  if (w <= 0 || r <= 0) return 0;
  return w * r * volumeMultiplier(ex);
}

/** Loaded exercises whose load must be a recorded measurement to count toward records/volume. */
function usesRecordedLoad(ex: Exercise): boolean {
  return ex.tracking === 'weight_reps' || ex.tracking === 'bodyweight_plus' || ex.tracking === 'assisted';
}

/* --------------------------------------------------------------- sessions */
export interface SessionSummary {
  durationSec: number;
  workingSets: number;
  warmupSets: number;
  totalReps: number;
  exercisesDone: number;
  volume: { freeWeightKg: number; machineKg: number; addedBodyweightKg: number };
  /** Reps from assisted and bodyweight-only exercises (not part of load volume). */
  bodyweightReps: number;
  /** Seconds of completed timed work (holds, timed sets). */
  timedSec: number;
}

export function sessionDurationSec(s: WorkoutSession, now = Date.now()): number {
  const end = s.endedAt ?? s.pausedAt ?? now;
  return Math.max(0, Math.round((end - s.startedAt - (s.pausedTotalMs ?? 0)) / 1000));
}

export function summarizeSession(s: WorkoutSession, byId: Map<ID, Exercise>): SessionSummary {
  const out: SessionSummary = {
    durationSec: sessionDurationSec(s),
    workingSets: 0,
    warmupSets: 0,
    totalReps: 0,
    exercisesDone: 0,
    volume: { freeWeightKg: 0, machineKg: 0, addedBodyweightKg: 0 },
    bodyweightReps: 0,
    timedSec: 0,
  };
  for (const se of s.exercises) {
    const ex = byId.get(se.exerciseId);
    let done = false;
    for (const set of se.sets) {
      if (!isValidCompletedSet(set, ex)) continue; // incomplete or invalid sets aren't completed work
      if (isWarmup(set)) {
        out.warmupSets++;
        continue;
      }
      done = true;
      out.workingSets++;
      out.totalReps += set.reps ?? 0;
      out.timedSec += set.durationSec ?? 0;
      if (!ex) continue;
      const v = setVolumeKg(set, ex);
      const b = volumeBucket(ex);
      if (b === 'free') out.volume.freeWeightKg += v;
      else if (b === 'machine') out.volume.machineKg += v;
      else if (b === 'added') out.volume.addedBodyweightKg += v;
      if (ex.tracking === 'reps' || ex.tracking === 'assisted' || (ex.tracking === 'bodyweight_plus' && !(set.weightKg! > 0))) {
        out.bodyweightReps += set.reps ?? 0;
      }
    }
    if (done) out.exercisesDone++;
  }
  return out;
}

/** Completed, non-deleted sessions. */
export function completedSessions(sessions: WorkoutSession[]): WorkoutSession[] {
  return sessions.filter((s) => s.status === 'completed' && !s.deletedAt);
}

/* ---------------------------------------------------------------- records */
export type RecordKind = 'heaviest' | 'e1rm' | 'reps_at_weight' | 'most_reps' | 'longest_duration' | 'least_assistance';
export interface RecordHit {
  exerciseId: ID;
  kind: RecordKind;
  value: number;
  label: string;
}
export const RECORD_KIND_LABELS: Record<RecordKind, string> = {
  heaviest: 'Heaviest working set',
  e1rm: 'Best estimated 1RM (Epley)',
  reps_at_weight: 'Most reps at a weight',
  most_reps: 'Most reps in a set',
  longest_duration: 'Longest duration',
  least_assistance: 'Least assistance',
};

interface Bests {
  heaviest?: number;
  e1rm?: number;
  mostReps?: number;
  longest?: number;
  leastAssist?: number;
  /** weight key (kg, 2 decimals) → max reps */
  repsAt: Map<number, number>;
  /** entered value for display, keyed like repsAt */
  entered: Map<number, LoggedSet['entered']>;
  heaviestSet?: LoggedSet;
  leastAssistSet?: LoggedSet;
}
const wKey = (kg: number) => Math.round(kg * 100) / 100;

function bestsFor(sets: LoggedSet[], ex: Exercise): Bests {
  const b: Bests = { repsAt: new Map(), entered: new Map() };
  for (const set of sets) {
    if (!isWorkingSet(set, ex)) continue;
    // A missing (or, for weight×reps, zero) load is "not recorded": it never sets a load record.
    const w = usesRecordedLoad(ex) ? (hasRecordedLoad(set, ex) ? set.weightKg! : null) : set.weightKg ?? null;
    const r = set.reps ?? 0;
    const d = set.durationSec ?? 0;
    switch (ex.tracking) {
      case 'weight_reps':
      case 'bodyweight_plus': {
        if (w != null && w > 0 && r > 0) {
          if (b.heaviest == null || w > b.heaviest) {
            b.heaviest = w;
            b.heaviestSet = set;
          }
          const k = wKey(w);
          if ((b.repsAt.get(k) ?? 0) < r) {
            b.repsAt.set(k, r);
            b.entered.set(k, set.entered);
          }
          if (e1rmEligible(ex)) {
            const e = e1rm(w, r);
            if (e != null && (b.e1rm == null || e > b.e1rm)) b.e1rm = e;
          }
        }
        if (ex.tracking === 'bodyweight_plus' && r > 0 && w === 0) {
          if (b.mostReps == null || r > b.mostReps) b.mostReps = r;
        }
        break;
      }
      case 'reps':
        if (r > 0 && (b.mostReps == null || r > b.mostReps)) b.mostReps = r;
        break;
      case 'assisted':
        if (r > 0 && w != null && w >= 0 && (b.leastAssist == null || w < b.leastAssist)) {
          b.leastAssist = w;
          b.leastAssistSet = set;
        }
        if (r > 0 && (b.mostReps == null || r > b.mostReps)) b.mostReps = r;
        break;
      case 'duration':
      case 'distance_time':
        if (d > 0 && (b.longest == null || d > b.longest)) b.longest = d;
        break;
    }
  }
  return b;
}

function setsOf(sessions: WorkoutSession[], exerciseId: ID): LoggedSet[] {
  const out: LoggedSet[] = [];
  for (const s of sessions) for (const se of s.exercises) if (se.exerciseId === exerciseId) out.push(...se.sets);
  return out;
}

const fmtSec = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')} min` : `${s} s`;
};

/**
 * Records set in `s` compared with the user's other completed sessions.
 * A record needs earlier history for the same exercise: a first-ever session sets a baseline, not a record.
 */
export function detectRecords(s: WorkoutSession, history: WorkoutSession[], byId: Map<ID, Exercise>, unit: WeightUnit): RecordHit[] {
  const others = completedSessions(history).filter((h) => h.id !== s.id);
  const hits: RecordHit[] = [];
  const seen = new Set<ID>();
  for (const se of s.exercises) {
    if (seen.has(se.exerciseId)) continue;
    seen.add(se.exerciseId);
    const ex = byId.get(se.exerciseId);
    if (!ex) continue;
    const prevSets = setsOf(others, ex.id).filter((x) => isWorkingSet(x, ex));
    if (prevSets.length === 0) continue;
    const cur = bestsFor(setsOf([s], ex.id), ex);
    const prev = bestsFor(prevSets, ex);
    const name = ex.name;
    if (cur.heaviest != null && prev.heaviest != null && cur.heaviest > prev.heaviest + 1e-9) {
      const reps = cur.heaviestSet?.reps;
      hits.push({ exerciseId: ex.id, kind: 'heaviest', value: cur.heaviest, label: `${name}: heaviest set ${formatWeight(cur.heaviest, unit, cur.heaviestSet?.entered)}${reps ? ` × ${reps}` : ''}` });
    }
    if (cur.e1rm != null && prev.e1rm != null && cur.e1rm > prev.e1rm + 1e-9) {
      hits.push({ exerciseId: ex.id, kind: 'e1rm', value: cur.e1rm, label: `${name}: best estimated 1RM ${trimNum(fromKg(cur.e1rm, unit), 1)} ${unit} (Epley)` });
    }
    // Most reps at a weight used before (heavier new weights are already covered by "heaviest").
    let bestRepsHit: { k: number; reps: number } | null = null;
    for (const [k, reps] of cur.repsAt) {
      const before = prev.repsAt.get(k);
      if (before != null && reps > before && (!bestRepsHit || k > bestRepsHit.k)) bestRepsHit = { k, reps };
    }
    if (bestRepsHit) {
      hits.push({
        exerciseId: ex.id,
        kind: 'reps_at_weight',
        value: bestRepsHit.reps,
        label: `${name}: ${bestRepsHit.reps} reps at ${formatWeight(bestRepsHit.k, unit, cur.entered.get(bestRepsHit.k))}`,
      });
    }
    if (cur.mostReps != null && prev.mostReps != null && cur.mostReps > prev.mostReps && ex.tracking !== 'assisted') {
      hits.push({ exerciseId: ex.id, kind: 'most_reps', value: cur.mostReps, label: `${name}: ${cur.mostReps} reps in a set` });
    }
    if (cur.longest != null && prev.longest != null && cur.longest > prev.longest) {
      hits.push({ exerciseId: ex.id, kind: 'longest_duration', value: cur.longest, label: `${name}: longest ${fmtSec(cur.longest)}` });
    }
    if (cur.leastAssist != null && prev.leastAssist != null && cur.leastAssist < prev.leastAssist - 1e-9) {
      hits.push({
        exerciseId: ex.id,
        kind: 'least_assistance',
        value: cur.leastAssist,
        label: `${name}: least assistance ${cur.leastAssist === 0 ? 'none' : formatWeight(cur.leastAssist, unit, cur.leastAssistSet?.entered)}`,
      });
    }
  }
  return hits;
}

export interface PersonalRecord {
  exerciseId: ID;
  kind: RecordKind;
  value: number;
  label: string;
  date: ISODate;
  sessionId: ID;
}

/**
 * All-time bests for one exercise across completed sessions, with the date each was first reached.
 * Recomputed from current records, so corrections to old sessions are reflected immediately.
 */
export function personalRecords(sessions: WorkoutSession[], ex: Exercise, unit: WeightUnit): PersonalRecord[] {
  const list = completedSessions(sessions)
    .filter((s) => s.exercises.some((se) => se.exerciseId === ex.id))
    .sort((a, b) => (a.date === b.date ? a.startedAt - b.startedAt : a.date < b.date ? -1 : 1));
  const best = new Map<RecordKind, PersonalRecord>();
  const repsAt = new Map<number, PersonalRecord>();
  const consider = (kind: RecordKind, value: number | undefined, better: (a: number, b: number) => boolean, s: WorkoutSession, label: string) => {
    if (value == null) return;
    const cur = best.get(kind);
    if (!cur || better(value, cur.value)) best.set(kind, { exerciseId: ex.id, kind, value, label, date: s.date, sessionId: s.id });
  };
  for (const s of list) {
    const b = bestsFor(setsOf([s], ex.id), ex);
    consider('heaviest', b.heaviest, (a, c) => a > c + 1e-9, s, b.heaviest != null ? `${formatWeight(b.heaviest, unit, b.heaviestSet?.entered)}${b.heaviestSet?.reps ? ` × ${b.heaviestSet.reps}` : ''}` : '');
    consider('e1rm', b.e1rm, (a, c) => a > c + 1e-9, s, b.e1rm != null ? `${trimNum(fromKg(b.e1rm, unit), 1)} ${unit} (estimated, Epley)` : '');
    if (ex.tracking !== 'assisted') consider('most_reps', b.mostReps, (a, c) => a > c, s, `${b.mostReps} reps`);
    consider('longest_duration', b.longest, (a, c) => a > c, s, b.longest != null ? fmtSec(b.longest) : '');
    consider('least_assistance', b.leastAssist, (a, c) => a < c - 1e-9, s, b.leastAssist === 0 ? 'No assistance' : b.leastAssist != null ? `${formatWeight(b.leastAssist, unit, b.leastAssistSet?.entered)} assistance` : '');
    for (const [k, reps] of b.repsAt) {
      const cur = repsAt.get(k);
      if (!cur || reps > cur.value)
        repsAt.set(k, { exerciseId: ex.id, kind: 'reps_at_weight', value: reps, label: `${reps} reps at ${formatWeight(k, unit, b.entered.get(k))}`, date: s.date, sessionId: s.id });
    }
  }
  const out = [...best.values()];
  // Most reps at the three heaviest weights used — enough to be useful without listing every load.
  const weights = [...repsAt.keys()].sort((a, b) => b - a).slice(0, 3);
  for (const w of weights) out.push(repsAt.get(w)!);
  return out;
}

/* ----------------------------------------------------------------- series */
export interface ExercisePoint {
  date: ISODate;
  sessionId: ID;
  /** Heaviest working-set load (kg). For assisted exercises this is the assistance. */
  topWeightKg: number | null;
  bestE1rmKg: number | null;
  totalReps: number;
  maxReps: number;
  workingSets: number;
  longestSec: number | null;
  /** Lowest assistance used with ≥ 1 rep (assisted exercises only). */
  minAssistanceKg: number | null;
  volumeKg: number;
}

/** One point per completed session containing the exercise, oldest first. */
export function exerciseSeries(sessions: WorkoutSession[], exerciseId: ID, ex?: Exercise): ExercisePoint[] {
  const list = completedSessions(sessions).sort((a, b) => (a.date === b.date ? a.startedAt - b.startedAt : a.date < b.date ? -1 : 1));
  const out: ExercisePoint[] = [];
  for (const s of list) {
    const sets = setsOf([s], exerciseId).filter((x) => isWorkingSet(x, ex));
    if (sets.length === 0) continue;
    let top: number | null = null;
    let be: number | null = null;
    let reps = 0;
    let maxReps = 0;
    let longest: number | null = null;
    let minA: number | null = null;
    let vol = 0;
    for (const set of sets) {
      const w = ex && usesRecordedLoad(ex) ? (hasRecordedLoad(set, ex) ? set.weightKg! : null) : set.weightKg ?? null;
      const r = set.reps ?? 0;
      reps += r;
      maxReps = Math.max(maxReps, r);
      if (w != null && w > 0 && r > 0 && (top == null || w > top)) top = w;
      if (set.durationSec && (longest == null || set.durationSec > longest)) longest = set.durationSec;
      if (ex) {
        if (e1rmEligible(ex) && w != null) {
          const e = e1rm(w, r);
          if (e != null && (be == null || e > be)) be = e;
        }
        if (ex.tracking === 'assisted' && w != null && w >= 0 && r > 0 && (minA == null || w < minA)) minA = w;
        vol += setVolumeKg(set, ex);
      }
    }
    out.push({ date: s.date, sessionId: s.id, topWeightKg: top, bestE1rmKg: be, totalReps: reps, maxReps, workingSets: sets.length, longestSec: longest, minAssistanceKg: minA, volumeKg: vol });
  }
  return out;
}

/** Exercise ids with at least one completed working set, most recently used first. */
export function exercisesWithHistory(sessions: WorkoutSession[]): ID[] {
  const last = new Map<ID, string>();
  for (const s of completedSessions(sessions))
    for (const se of s.exercises)
      if (se.sets.some((x) => isWorkingSet(x))) {
        const prev = last.get(se.exerciseId);
        if (!prev || s.date > prev) last.set(se.exerciseId, s.date);
      }
  return [...last.entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).map(([id]) => id);
}

/* --------------------------------------------------------------- weekly */
/** Every week start between from and to (inclusive), aligned to weekStart. */
export function weekStarts(from: ISODate, to: ISODate, weekStart: 0 | 1): ISODate[] {
  const out: ISODate[] = [];
  for (let w = startOfWeek(from, weekStart); w <= to; w = addDays(w, 7)) out.push(w);
  return out;
}

export interface WeeklySets {
  week: ISODate;
  total: number;
  muscles: Partial<Record<MuscleGroup, number>>;
}

/**
 * Weekly working sets by muscle group. Primary muscles count 1, secondary 0.5.
 * `total` is the plain number of working sets (not muscle-weighted). Unilateral sets count once.
 */
export function weeklyWorkingSets(sessions: WorkoutSession[], byId: Map<ID, Exercise>, weekStart: 0 | 1, from: ISODate, to: ISODate): WeeklySets[] {
  const weeks = new Map(weekStarts(from, to, weekStart).map((w) => [w, { week: w, total: 0, muscles: {} } as WeeklySets]));
  for (const s of completedSessions(sessions)) {
    if (s.date < from || s.date > to) continue;
    const row = weeks.get(startOfWeek(s.date, weekStart));
    if (!row) continue;
    for (const se of s.exercises) {
      const ex = byId.get(se.exerciseId);
      const n = se.sets.filter((x) => isWorkingSet(x, ex)).length;
      if (!n) continue;
      row.total += n;
      if (!ex) continue;
      for (const m of ex.primaryMuscles) row.muscles[m] = (row.muscles[m] ?? 0) + n;
      for (const m of ex.secondaryMuscles) if (!ex.primaryMuscles.includes(m)) row.muscles[m] = (row.muscles[m] ?? 0) + n * 0.5;
    }
  }
  return [...weeks.values()];
}

export interface WeeklyVolume {
  week: ISODate;
  freeWeightKg: number;
  machineKg: number;
  addedBodyweightKg: number;
  bodyweightReps: number;
  workingSets: number;
}
export function weeklyVolume(sessions: WorkoutSession[], byId: Map<ID, Exercise>, weekStart: 0 | 1, from: ISODate, to: ISODate): WeeklyVolume[] {
  const weeks = new Map(
    weekStarts(from, to, weekStart).map((w) => [w, { week: w, freeWeightKg: 0, machineKg: 0, addedBodyweightKg: 0, bodyweightReps: 0, workingSets: 0 } as WeeklyVolume]),
  );
  for (const s of completedSessions(sessions)) {
    if (s.date < from || s.date > to) continue;
    const row = weeks.get(startOfWeek(s.date, weekStart));
    if (!row) continue;
    const sum = summarizeSession(s, byId);
    row.freeWeightKg += sum.volume.freeWeightKg;
    row.machineKg += sum.volume.machineKg;
    row.addedBodyweightKg += sum.volume.addedBodyweightKg;
    row.bodyweightReps += sum.bodyweightReps;
    row.workingSets += sum.workingSets;
  }
  return [...weeks.values()];
}

export interface WeeklyActivity {
  week: ISODate;
  workouts: number;
  activities: number;
  workoutMinutes: number;
  activityMinutes: number;
  distanceM: number;
}
export function weeklyTotals(sessions: WorkoutSession[], activities: ActivityLog[], weekStart: 0 | 1, from: ISODate, to: ISODate, type?: ActivityType): WeeklyActivity[] {
  const weeks = new Map(
    weekStarts(from, to, weekStart).map((w) => [w, { week: w, workouts: 0, activities: 0, workoutMinutes: 0, activityMinutes: 0, distanceM: 0 } as WeeklyActivity]),
  );
  for (const s of completedSessions(sessions)) {
    if (s.date < from || s.date > to) continue;
    const row = weeks.get(startOfWeek(s.date, weekStart));
    if (!row) continue;
    row.workouts++;
    row.workoutMinutes += sessionDurationSec(s) / 60;
  }
  for (const a of activities) {
    if (a.deletedAt || a.date < from || a.date > to) continue;
    if (type && a.type !== type) continue;
    const row = weeks.get(startOfWeek(a.date, weekStart));
    if (!row) continue;
    row.activities++;
    row.activityMinutes += a.durationSec / 60;
    row.distanceM += a.distanceM ?? 0;
  }
  return [...weeks.values()];
}

/* ---------------------------------------------------------------- cardio */
export interface CardioPoint {
  id: ID;
  date: ISODate;
  type: ActivityType;
  durationSec: number;
  distanceM: number | null;
  /** Seconds per km (null without distance). */
  paceSecPerKm: number | null;
  speedKmh: number | null;
}
/** One point per activity (oldest first); optional type filter. */
export function cardioSeries(activities: ActivityLog[], type?: ActivityType): CardioPoint[] {
  return activities
    .filter((a) => !a.deletedAt && (!type || a.type === type))
    .sort((a, b) => (a.date === b.date ? (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt) : a.date < b.date ? -1 : 1))
    .map((a) => {
      const d = a.distanceM && a.distanceM > 0 ? a.distanceM : null;
      const t = a.durationSec;
      return {
        id: a.id,
        date: a.date,
        type: a.type,
        durationSec: t,
        distanceM: d,
        paceSecPerKm: d && t > 0 ? t / (d / 1000) : null,
        speedKmh: d && t > 0 ? d / 1000 / (t / 3600) : null,
      };
    });
}

/* -------------------------------------------------------- rolling average */
export interface DatedValue {
  date: ISODate;
  value: number;
}
/**
 * Trailing calendar-window average: for each point, the mean of all points dated within
 * the previous `days` days including its own date. Multiple entries per day all count.
 */
export function rollingAverage<T extends DatedValue>(points: T[], days = 7): (T & { avg: number })[] {
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return sorted.map((p) => {
    const start = addDays(p.date, -(days - 1));
    const win = sorted.filter((q) => q.date >= start && q.date <= p.date);
    const avg = win.reduce((s, q) => s + q.value, 0) / win.length;
    return { ...p, avg };
  });
}

/** Mean of entries dated in [from, to], or null. */
export function windowAverage(points: DatedValue[], from: ISODate, to: ISODate): number | null {
  const win = points.filter((p) => p.date >= from && p.date <= to);
  if (!win.length) return null;
  return win.reduce((s, p) => s + p.value, 0) / win.length;
}

/* -------------------------------------------------------------- nutrition */
export interface ProteinDay {
  date: ISODate;
  /** null = nothing logged that day (no data, NOT zero). */
  proteinG: number | null;
  /** null when there's no data or no target. */
  met: boolean | null;
}
/** Per-day protein vs target. Days with no logs, or logs without protein values, are "no data". */
export function proteinDays(logs: FoodLogEntry[], from: ISODate, to: ISODate, targetG?: number | null): ProteinDay[] {
  const by = new Map<ISODate, number>();
  for (const l of logs) {
    if (l.deletedAt || l.date < from || l.date > to || l.protein == null) continue;
    by.set(l.date, (by.get(l.date) ?? 0) + l.protein);
  }
  return rangeDays(from, to).map((d) => {
    const p = by.has(d) ? by.get(d)! : null;
    return { date: d, proteinG: p, met: p == null || !targetG ? null : p >= targetG };
  });
}

/* -------------------------------------------------------------- goals */
export interface GoalProgress {
  current: number | null;
  /** 0–1 (clamped); null when it can't be computed. */
  fraction: number | null;
  /** Short factual text, e.g. "3 of 4 sessions this week". */
  text: string;
  reached: boolean;
}

export interface GoalContext {
  sessions: WorkoutSession[];
  activities: ActivityLog[];
  measurements: Measurement[];
  foodLogs: FoodLogEntry[];
  proteinTargetG?: number | null;
  byId: Map<ID, Exercise>;
  today: ISODate;
  weekStart: 0 | 1;
  unit: WeightUnit;
}

/** Progress toward a goal from actual records. Targets use canonical units (kg, minutes, days, sessions). */
export function goalProgress(g: UserGoal, c: GoalContext): GoalProgress {
  const wk = startOfWeek(c.today, c.weekStart);
  const frac = (cur: number, target: number) => (target > 0 ? Math.max(0, Math.min(1, cur / target)) : null);
  switch (g.kind) {
    case 'sessions_per_week': {
      const n = completedSessions(c.sessions).filter((s) => s.date >= wk && s.date <= c.today).length;
      return { current: n, fraction: frac(n, g.target), text: `${n} of ${g.target} workout${g.target === 1 ? '' : 's'} this week`, reached: n >= g.target };
    }
    case 'cardio_minutes': {
      const m = Math.round(c.activities.filter((a) => !a.deletedAt && a.date >= wk && a.date <= c.today).reduce((s, a) => s + a.durationSec / 60, 0));
      return { current: m, fraction: frac(m, g.target), text: `${m} of ${g.target} min this week`, reached: m >= g.target };
    }
    case 'protein_days': {
      if (!c.proteinTargetG) return { current: null, fraction: null, text: 'Set a protein target to track this goal', reached: false };
      const days = proteinDays(c.foodLogs, wk, c.today, c.proteinTargetG);
      const met = days.filter((d) => d.met).length;
      const noData = days.filter((d) => d.proteinG == null).length;
      return { current: met, fraction: frac(met, g.target), text: `${met} of ${g.target} day${g.target === 1 ? '' : 's'} this week${noData ? ` · ${noData} without logs` : ''}`, reached: met >= g.target };
    }
    case 'exercise_load': {
      const ex = g.exerciseId ? c.byId.get(g.exerciseId) : undefined;
      if (!ex) return { current: null, fraction: null, text: 'Choose an exercise', reached: false };
      const series = exerciseSeries(c.sessions, ex.id, ex);
      if (ex.tracking === 'assisted') {
        const vals = series.map((p) => p.minAssistanceKg).filter((v): v is number => v != null);
        if (!vals.length) return { current: null, fraction: null, text: `No ${ex.name} sets logged yet`, reached: false };
        const cur = Math.min(...vals);
        const start = vals[0];
        const reached = cur <= g.target + 1e-9;
        const fraction = reached ? 1 : start > g.target ? Math.max(0, Math.min(1, (start - cur) / (start - g.target))) : 0;
        return { current: cur, fraction, text: `Least assistance ${formatWeight(cur, c.unit)} · target ${formatWeight(g.target, c.unit)}`, reached };
      }
      const vals = series.map((p) => p.topWeightKg).filter((v): v is number => v != null);
      if (!vals.length) return { current: null, fraction: null, text: `No ${ex.name} sets logged yet`, reached: false };
      const cur = Math.max(...vals);
      return { current: cur, fraction: frac(cur, g.target), text: `Best ${formatWeight(cur, c.unit)} of ${formatWeight(g.target, c.unit)}`, reached: cur >= g.target - 1e-9 };
    }
    case 'bodyweight': {
      const bw = c.measurements.filter((m) => m.kind === 'bodyweight' && !m.deletedAt).sort((a, b) => (a.date < b.date ? -1 : 1));
      if (!bw.length) return { current: null, fraction: null, text: 'Add a bodyweight entry to track this goal', reached: false };
      const created = new Date(g.createdAt).toISOString().slice(0, 10);
      const startEntry = bw.filter((m) => m.date <= created).at(-1) ?? bw[0];
      const avg = windowAverage(bw.map((m) => ({ date: m.date, value: m.value })), addDays(c.today, -6), c.today) ?? bw.at(-1)!.value;
      const start = startEntry.value;
      const losing = g.target < start;
      const reached = losing ? avg <= g.target : avg >= g.target;
      const span = Math.abs(start - g.target);
      const fraction = reached ? 1 : span > 0 ? Math.max(0, Math.min(1, (losing ? start - avg : avg - start) / span)) : 0;
      return { current: avg, fraction, text: `7-day average ${formatWeight(avg, c.unit)} · target ${formatWeight(g.target, c.unit)}`, reached };
    }
    case 'custom':
    default:
      return { current: null, fraction: g.achievedAt ? 1 : null, text: g.achievedAt ? 'Achieved' : 'Mark it achieved when you get there', reached: !!g.achievedAt };
  }
}

/* ---------------------------------------------------------- observations */
export interface ObservationInput {
  sessions: WorkoutSession[];
  activities: ActivityLog[];
  measurements: Measurement[];
  today: ISODate;
  weekStart: 0 | 1;
  unit: WeightUnit;
  /** Adherence to the active program this week (from schedule.adherence), when there is one. */
  plan?: { planned: number; completed: number } | null;
  byId?: Map<ID, Exercise>;
}

const MINUS = '−';
function signed(n: number, decimals = 1): string {
  const r = round(n, decimals);
  if (r === 0) return '±0';
  return r > 0 ? `+${r.toFixed(decimals)}` : `${MINUS}${Math.abs(r).toFixed(decimals)}`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Short, factual observations about recent records. No scores, no inferences about recovery or
 * muscle gained — just what the logs say.
 */
export function observations(o: ObservationInput): string[] {
  const out: string[] = [];
  const wk = startOfWeek(o.today, o.weekStart);
  const prevWk = addDays(wk, -7);
  const prevWkEnd = addDays(wk, -1);
  const done = completedSessions(o.sessions);
  const acts = o.activities.filter((a) => !a.deletedAt);

  if (o.plan && o.plan.planned > 0) {
    out.push(`You completed ${o.plan.completed} of ${o.plan.planned} planned sessions this week.`);
  }
  const wWeek = done.filter((s) => s.date >= wk && s.date <= o.today).length;
  const aWeek = acts.filter((a) => a.date >= wk && a.date <= o.today).length;
  if (wWeek || aWeek) {
    const parts = [];
    if (wWeek) parts.push(plural(wWeek, 'workout'));
    if (aWeek) parts.push(plural(aWeek, 'other activity', 'other activities'));
    out.push(`This week you’ve logged ${parts.join(' and ')}.`);
  }

  const minutes = (from: ISODate, to: ISODate) => Math.round(acts.filter((a) => a.date >= from && a.date <= to).reduce((s, a) => s + a.durationSec / 60, 0));
  const cw = minutes(wk, o.today);
  const pw = minutes(prevWk, prevWkEnd);
  if (cw > 0 || pw > 0) {
    out.push(`Activity time this week: ${cw} min (${signed(cw - pw, 0)} min vs last week).`);
  }

  if (o.byId) {
    const sets = (from: ISODate, to: ISODate) =>
      done.filter((s) => s.date >= from && s.date <= to).reduce((n, s) => n + summarizeSession(s, o.byId!).workingSets, 0);
    const cs = sets(wk, o.today);
    if (cs > 0) out.push(`Working sets this week: ${cs} (last week: ${sets(prevWk, prevWkEnd)}).`);
  }

  const bw = o.measurements.filter((m) => m.kind === 'bodyweight' && !m.deletedAt).map((m) => ({ date: m.date, value: m.value }));
  const cur = windowAverage(bw, addDays(o.today, -6), o.today);
  if (cur != null) {
    const prev = windowAverage(bw, addDays(o.today, -13), addDays(o.today, -7));
    const v = round(fromKg(cur, o.unit), 1).toFixed(1);
    const delta = prev != null ? ` (${signed(fromKg(cur, o.unit) - fromKg(prev, o.unit))} ${o.unit} vs last week)` : '';
    out.push(`Bodyweight 7-day average: ${v} ${o.unit}${delta}`);
  }

  if (!done.length && !acts.length) out.push('No workouts or activities logged yet.');
  else {
    const last = [...done.map((s) => s.date), ...acts.map((a) => a.date)].filter((d) => d <= o.today).sort().at(-1);
    if (last && last < addDays(o.today, -6)) {
      out.push(`Your last logged session was ${diffDays(o.today, last)} days ago.`);
    }
  }
  return out;
}
