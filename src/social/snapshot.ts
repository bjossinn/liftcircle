/**
 * Share snapshots: plain copies of ONLY the fields the user selected, taken at share time.
 * A snapshot never contains ids of private records, notes, RPE, bodyweight or any link back
 * into the private workout — later edits to the workout never flow into the post.
 */
import type { ActivityLog, ActivityType, DistanceUnit, Exercise, ID, LoggedSet, ShareFields, WeightUnit, WorkoutSession, WorkoutSnapshot } from '@/domain/types';
import { formatDistance, formatPace, formatWeight, fromKg, paceSecPer, round, speedPerHour } from '@/domain/units';
import { formatDuration } from '@/lib/dates';

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  walk: 'Walk',
  run: 'Run',
  cycle: 'Ride',
  hike: 'Hike',
  swim: 'Swim',
  row: 'Row',
  sport: 'Sport',
  class: 'Class',
  yoga: 'Yoga',
  mobility: 'Mobility',
  stretch: 'Stretching',
  custom: 'Activity',
};

const SPEED_TYPES: ActivityType[] = ['cycle'];
const PACE_TYPES: ActivityType[] = ['run', 'walk', 'hike', 'swim', 'row'];

const workingSets = (sets: LoggedSet[]) => sets.filter((s) => s.completed && s.type !== 'warmup');

function setWeightLabel(set: LoggedSet, ex: Exercise | undefined, unit: WeightUnit): string | undefined {
  if (set.weightKg == null || !ex) return undefined;
  const w = formatWeight(set.weightKg, unit, set.entered);
  switch (ex.load) {
    case 'none':
      return undefined;
    case 'added':
      return set.weightKg > 0 ? `+${w}` : undefined;
    case 'assistance':
      return `${w} assist`;
    case 'per_hand':
      return `${w} each`;
    default:
      return w;
  }
}

/** Free-weight working volume (load × reps × implements) for loads that are comparable. */
function freeWeightVolumeKg(s: WorkoutSession, byId: Map<ID, Exercise>): number {
  let total = 0;
  for (const se of s.exercises) {
    const ex = byId.get(se.exerciseId);
    if (!ex || ex.tracking !== 'weight_reps' || (ex.load !== 'total' && ex.load !== 'per_hand')) continue;
    const mult = ex.load === 'per_hand' ? (ex.implements ?? 2) : (ex.implements ?? 1);
    for (const set of workingSets(se.sets)) {
      if (set.weightKg && set.reps) total += set.weightKg * set.reps * mult;
    }
  }
  return total;
}

function sessionDurationSec(s: WorkoutSession): number {
  if (!s.endedAt) return 0;
  return Math.max(0, Math.round((s.endedAt - s.startedAt - (s.pausedTotalMs ?? 0)) / 1000));
}

export function buildWorkoutSnapshot(
  s: WorkoutSession,
  fields: ShareFields,
  ctx: { byId: Map<ID, Exercise>; unit: WeightUnit; records?: { exercise: string; label: string }[] },
): WorkoutSnapshot {
  const snap: WorkoutSnapshot = { title: s.name?.trim() || 'Workout', kind: 'workout', date: s.date };

  if (fields.duration) {
    const d = sessionDurationSec(s);
    if (d > 0) snap.durationSec = d;
  }

  if (fields.exerciseNames) {
    const exercises: NonNullable<WorkoutSnapshot['exercises']> = [];
    for (const se of [...s.exercises].sort((a, b) => a.order - b.order)) {
      const done = workingSets(se.sets);
      if (done.length === 0) continue;
      const ex = ctx.byId.get(se.exerciseId);
      const item: NonNullable<WorkoutSnapshot['exercises']>[number] = { name: ex?.name ?? 'Exercise' };
      if (fields.weightsReps) {
        item.sets = done.map((set) => {
          const out: { weight?: string; reps?: number; duration?: string } = {};
          const w = setWeightLabel(set, ex, ctx.unit);
          if (w) out.weight = w;
          if (set.reps != null && set.reps > 0) out.reps = set.reps;
          if (set.durationSec != null && set.durationSec > 0) out.duration = formatDuration(set.durationSec);
          return out;
        });
      }
      exercises.push(item);
    }
    if (exercises.length) snap.exercises = exercises;
  }

  if (fields.volume) {
    const kg = freeWeightVolumeKg(s, ctx.byId);
    if (kg > 0) snap.volume = { value: Math.round(fromKg(kg, ctx.unit)), unit: ctx.unit, convention: 'Free-weight working sets' };
  }

  if (fields.records && ctx.records?.length) {
    snap.records = ctx.records.map((r) => ({ exercise: String(r.exercise), label: String(r.label) }));
  }
  return snap;
}

/**
 * Activity snapshot. Field mapping for activities:
 *  - duration → duration
 *  - volume   → distance (the "amount" of the activity)
 *  - pace/speed only when BOTH duration and distance are shared (pace would otherwise reveal the other)
 *  - records  → records passed in ctx
 */
export function buildActivitySnapshot(
  a: ActivityLog,
  fields: ShareFields,
  ctx: { distanceUnit: DistanceUnit; records?: { exercise: string; label: string }[] },
): WorkoutSnapshot {
  const label = a.type === 'custom' ? a.customName?.trim() || ACTIVITY_LABELS.custom : ACTIVITY_LABELS[a.type];
  const snap: WorkoutSnapshot = { title: label, kind: 'activity', date: a.date, activity: { type: a.type, label } };
  if (fields.duration && a.durationSec > 0) snap.durationSec = Math.round(a.durationSec);
  if (fields.volume && a.distanceM && a.distanceM > 0) {
    snap.activity!.distance = formatDistance(a.distanceM, ctx.distanceUnit);
    if (fields.duration && a.durationSec > 0) {
      if (SPEED_TYPES.includes(a.type)) {
        const v = speedPerHour(a.distanceM, a.durationSec, ctx.distanceUnit);
        if (v != null) snap.activity!.pace = `${round(v, 1)} ${ctx.distanceUnit === 'km' ? 'km/h' : 'mph'}`;
      } else if (PACE_TYPES.includes(a.type)) {
        const p = paceSecPer(a.distanceM, a.durationSec, ctx.distanceUnit);
        if (p != null) snap.activity!.pace = formatPace(p, ctx.distanceUnit);
      }
    }
  }
  if (fields.records && ctx.records?.length) {
    snap.records = ctx.records.map((r) => ({ exercise: String(r.exercise), label: String(r.label) }));
  }
  return snap;
}

/** Short one-line description used for post headers ("Upper A · 52 min"). */
export function snapshotHeadline(s: WorkoutSnapshot): string {
  const parts = [s.title];
  if (s.activity?.distance) parts.push(s.activity.distance);
  if (s.durationSec) parts.push(`${Math.max(1, Math.round(s.durationSec / 60))} min`);
  return parts.join(' · ');
}
