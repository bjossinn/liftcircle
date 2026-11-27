/**
 * Which Progress sections and sub-metrics have recorded data (roadmap item 11). Pure selectors over the active
 * account's alive records; they reuse the existing stats/set-validation helpers and never change a formula.
 * Unknown values stay unknown: an explicitly recorded numeric zero is data, a missing value is not.
 */
import type { ActivityLog, ActivityType, Exercise, FoodLogEntry, ID, ISODate, Measurement, MeasurementKind, UserGoal, WorkoutSession } from '@/domain/types';
import { exercisesWithHistory, summarizeSession } from '@/domain/stats';
import { ACTIVITY_TYPES, activityTypeInfo } from '@/domain/activities';

export type SectionId = 'consistency' | 'exercise' | 'volume' | 'activities' | 'body' | 'nutrition' | 'goals';
/** The existing section order. */
export const SECTION_ORDER: SectionId[] = ['consistency', 'exercise', 'volume', 'activities', 'body', 'nutrition', 'goals'];

export interface AvailabilityInput {
  /** Alive completed sessions (completedSessions(): discomfort-only sessions are retained). */
  sessions: WorkoutSession[];
  activities: ActivityLog[];
  measurements: Measurement[];
  goals: UserGoal[];
  /** Alive food logs, all history, read regardless of the nutrition setting. */
  foodLogs: FoodLogEntry[];
  byId: Map<ID, Exercise>;
}

export type Availability = Record<SectionId, boolean> & { any: boolean };

/** True when at least one completed session has a countable working set (bodyweight/timed sets count). */
export function hasWorkingSets(sessions: WorkoutSession[], byId: Map<ID, Exercise>): boolean {
  return sessions.some((s) => summarizeSession(s, byId).workingSets > 0);
}

/** All-history eligibility per section. A plan alone is not workout data. */
export function sectionAvailability(i: AvailabilityInput): Availability {
  const a = {
    consistency: i.sessions.length > 0 || i.activities.length > 0,
    exercise: exercisesWithHistory(i.sessions).length > 0,
    volume: hasWorkingSets(i.sessions, i.byId),
    activities: i.activities.length > 0,
    body: i.measurements.length > 0,
    nutrition: i.foodLogs.length > 0,
    goals: i.goals.length > 0,
  };
  return { ...a, any: SECTION_ORDER.some((k) => a[k]) };
}

/** Earliest record date not after `today` across workouts, activities, measurements and food (for the "All" range). */
export function earliestDate(i: Pick<AvailabilityInput, 'sessions' | 'activities' | 'measurements' | 'foodLogs'>, today: ISODate): ISODate | null {
  let min: ISODate | null = null;
  for (const list of [i.sessions, i.activities, i.measurements, i.foodLogs] as { date: ISODate }[][])
    for (const r of list) if (r.date <= today && (min == null || r.date < min)) min = r.date;
  return min;
}

/** Measurement kinds that have at least one entry, in the given (existing) order. */
export function measuredKinds(measurements: Measurement[], order: MeasurementKind[]): MeasurementKind[] {
  const have = new Set(measurements.map((m) => m.kind));
  return order.filter((k) => have.has(k));
}

/** The chart kind to show: the requested one while it still has entries, else bodyweight, else the first measured. */
export function pickMeasurementKind(requested: MeasurementKind | null, available: MeasurementKind[]): MeasurementKind | null {
  if (requested && available.includes(requested)) return requested;
  if (available.includes('bodyweight')) return 'bodyweight';
  return available[0] ?? null;
}

/** A selected option, validated against the current choices (never a removed one). */
export function validChoice<T>(requested: T | null | undefined, available: readonly T[]): T | undefined {
  return requested != null && available.includes(requested) ? requested : available[0];
}

export type ProteinView = 'none' | 'unknown' | 'numeric';
/** 'numeric' when any log has a protein number (0 included); 'unknown' when logs exist but none has one. */
export function proteinView(logs: FoodLogEntry[]): ProteinView {
  if (!logs.length) return 'none';
  return logs.some((l) => l.protein != null && Number.isFinite(l.protein)) ? 'numeric' : 'unknown';
}

/** A recorded, finite distance (0 included: it was recorded). */
export const hasDistance = (a: Pick<ActivityLog, 'distanceM'>) => a.distanceM != null && Number.isFinite(a.distanceM);

/** Pace/speed needs a positive distance, a positive duration and an activity type that supports it. */
export function paceEligible(a: Pick<ActivityLog, 'type' | 'distanceM' | 'durationSec'>): boolean {
  return (a.distanceM ?? 0) > 0 && Number.isFinite(a.distanceM!) && a.durationSec > 0 && !!activityTypeInfo(a.type).paceMode;
}

/** Activity types with pace/speed data, in the catalog order. */
export function paceTypes(activities: ActivityLog[]): ActivityType[] {
  const set = new Set(activities.filter(paceEligible).map((a) => a.type));
  return ACTIVITY_TYPES.filter((x) => set.has(x.type)).map((x) => x.type);
}

export type LoadBucket = 'freeWeightKg' | 'machineKg' | 'addedBodyweightKg';
/** Load buckets with recorded load volume (> 0). Bodyweight or assisted work never creates a load bucket. */
export function loadBuckets(totals: Record<LoadBucket, number>): LoadBucket[] {
  return (['freeWeightKg', 'machineKg', 'addedBodyweightKg'] as const).filter((b) => totals[b] > 0);
}
