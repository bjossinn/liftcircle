/**
 * Activity types, field relevance, pace/speed maths, validation and an optional,
 * clearly approximate energy estimate. Pure: no React, no Dexie.
 *
 * Canonical storage: duration in seconds, distance and elevation in metres.
 */
import { z } from 'zod';
import type { ActivityLog, ActivityType, DistanceUnit, Intensity } from './types';
import { fromMeters, round } from './units';

export type ActivityField = 'distance' | 'elevation' | 'hr' | 'pace';
/** How pace/speed is expressed for a type. */
export type PaceMode = 'per_unit' | 'per_100m' | 'per_500m' | 'speed';

export interface ActivityTypeInfo {
  type: ActivityType;
  label: string;
  /** Past-tense-free noun used in sentences, e.g. "run", "bike ride". */
  noun: string;
  fields: ActivityField[];
  /** null when pace/speed is not meaningful for the type. */
  paceMode: PaceMode | null;
  /** Upper plausibility bound for a single session's distance (metres). */
  maxDistanceM?: number;
  /** Upper plausibility bound for average speed (km/h). */
  maxSpeedKmh?: number;
  /** Approximate MET values (Compendium of Physical Activities ranges, rounded). */
  met: Record<Intensity, number>;
}

export const ACTIVITY_TYPES: ActivityTypeInfo[] = [
  { type: 'walk', label: 'Walk', noun: 'walk', fields: ['distance', 'elevation', 'hr', 'pace'], paceMode: 'per_unit', maxDistanceM: 150_000, maxSpeedKmh: 12, met: { easy: 3, moderate: 3.8, hard: 5 } },
  { type: 'run', label: 'Run', noun: 'run', fields: ['distance', 'elevation', 'hr', 'pace'], paceMode: 'per_unit', maxDistanceM: 350_000, maxSpeedKmh: 25, met: { easy: 7, moderate: 9.5, hard: 11.5 } },
  { type: 'cycle', label: 'Cycle', noun: 'ride', fields: ['distance', 'elevation', 'hr'], paceMode: 'speed', maxDistanceM: 1_000_000, maxSpeedKmh: 80, met: { easy: 4, moderate: 6.8, hard: 10 } },
  { type: 'hike', label: 'Hike', noun: 'hike', fields: ['distance', 'elevation', 'hr', 'pace'], paceMode: 'per_unit', maxDistanceM: 150_000, maxSpeedKmh: 12, met: { easy: 4.5, moderate: 6, hard: 7.8 } },
  { type: 'swim', label: 'Swim', noun: 'swim', fields: ['distance', 'hr', 'pace'], paceMode: 'per_100m', maxDistanceM: 60_000, maxSpeedKmh: 8, met: { easy: 5.8, moderate: 7, hard: 9.8 } },
  { type: 'row', label: 'Row', noun: 'row', fields: ['distance', 'hr', 'pace'], paceMode: 'per_500m', maxDistanceM: 200_000, maxSpeedKmh: 30, met: { easy: 4.8, moderate: 7, hard: 8.5 } },
  { type: 'sport', label: 'Sport', noun: 'sport session', fields: ['hr'], paceMode: null, met: { easy: 4.5, moderate: 6.5, hard: 8.5 } },
  { type: 'class', label: 'Fitness class', noun: 'class', fields: ['hr'], paceMode: null, met: { easy: 4, moderate: 6, hard: 8 } },
  { type: 'yoga', label: 'Yoga', noun: 'yoga session', fields: ['hr'], paceMode: null, met: { easy: 2.5, moderate: 3, hard: 4 } },
  { type: 'mobility', label: 'Mobility', noun: 'mobility session', fields: ['hr'], paceMode: null, met: { easy: 2.3, moderate: 2.8, hard: 3.5 } },
  { type: 'stretch', label: 'Stretching', noun: 'stretching session', fields: ['hr'], paceMode: null, met: { easy: 2.3, moderate: 2.5, hard: 3 } },
  { type: 'custom', label: 'Custom', noun: 'activity', fields: ['distance', 'elevation', 'hr'], paceMode: null, maxDistanceM: 1_000_000, met: { easy: 3.5, moderate: 5, hard: 7 } },
];

const BY_TYPE = new Map(ACTIVITY_TYPES.map((t) => [t.type, t]));

export function activityTypeInfo(type: ActivityType): ActivityTypeInfo {
  return BY_TYPE.get(type) ?? BY_TYPE.get('custom')!;
}

export function hasField(type: ActivityType, field: ActivityField): boolean {
  return activityTypeInfo(type).fields.includes(field);
}

/** Display name for an activity ("Run", or the custom name for a custom activity). */
export function activityLabel(a: Pick<ActivityLog, 'type' | 'customName'>): string {
  if (a.type === 'custom') return a.customName?.trim() || 'Custom activity';
  return activityTypeInfo(a.type).label;
}

/* --------------------------------------------------------- pace & speed */
export interface PaceResult {
  kind: 'pace' | 'speed';
  /** pace: seconds per `per` unit; speed: km/h or mph. */
  value: number;
  /** e.g. 'km', 'mi', '100 m', '500 m', 'km/h', 'mph' */
  per: string;
  text: string;
}

export function formatPaceSec(sec: number): string {
  let m = Math.floor(sec / 60);
  let s = Math.round(sec - m * 60);
  if (s === 60) {
    m += 1;
    s = 0;
  }
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Pace or speed for an activity in the user's distance unit.
 * Run/walk/hike: min per km or mile. Swim: per 100 m. Row: per 500 m (split). Cycle: km/h or mph.
 */
export function paceOrSpeed(
  a: { type: ActivityType; distanceM?: number | null; durationSec?: number | null },
  unit: DistanceUnit,
): PaceResult | null {
  const mode = activityTypeInfo(a.type).paceMode;
  const d = a.distanceM ?? 0;
  const t = a.durationSec ?? 0;
  if (!mode || d <= 0 || t <= 0) return null;
  switch (mode) {
    case 'per_unit': {
      const v = t / fromMeters(d, unit);
      return { kind: 'pace', value: v, per: unit, text: `${formatPaceSec(v)} /${unit}` };
    }
    case 'per_100m': {
      const v = t / (d / 100);
      return { kind: 'pace', value: v, per: '100 m', text: `${formatPaceSec(v)} /100 m` };
    }
    case 'per_500m': {
      const v = t / (d / 500);
      return { kind: 'pace', value: v, per: '500 m', text: `${formatPaceSec(v)} /500 m` };
    }
    case 'speed': {
      const v = fromMeters(d, unit) / (t / 3600);
      const per = unit === 'km' ? 'km/h' : 'mph';
      return { kind: 'speed', value: v, per, text: `${round(v, 1)} ${per}` };
    }
  }
}

/* ---------------------------------------------------- duration helpers */
export function splitHms(sec: number): { h: number; m: number; s: number } {
  const t = Math.max(0, Math.round(sec));
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}
export function hmsToSec(h: number | null | undefined, m: number | null | undefined, s: number | null | undefined): number {
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

/* ------------------------------------------------------------ validation */
export const MIN_DURATION_SEC = 60;
export const MAX_DURATION_SEC = 24 * 3600;

const optNum = z.number().optional();

/** Shape validated before saving. Field names match ActivityLog. */
export const activityInputSchema = z
  .object({
    type: z.enum(['walk', 'run', 'cycle', 'hike', 'swim', 'row', 'sport', 'class', 'yoga', 'mobility', 'stretch', 'custom']),
    customName: z.string().trim().max(60, 'Keep the name under 60 characters').optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date'),
    durationSec: z
      .number({ error: 'Enter a duration' })
      
      .min(MIN_DURATION_SEC, 'Duration must be at least 1 minute')
      .max(MAX_DURATION_SEC, 'Duration can be at most 24 hours'),
    distanceM: optNum,
    elevationM: optNum,
    avgHr: optNum,
    maxHr: optNum,
    intensity: z.enum(['easy', 'moderate', 'hard']).optional(),
    energyKcal: optNum,
    energySource: z.enum(['user', 'device', 'estimate']).optional(),
    notes: z.string().max(2000, 'Notes can be at most 2000 characters').optional(),
  })
  .superRefine((v, ctx) => {
    const info = activityTypeInfo(v.type);
    if (v.type === 'custom' && !v.customName?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['customName'], message: 'Give your activity a name' });
    }
    if (v.distanceM != null) {
      if (v.distanceM <= 0) ctx.addIssue({ code: 'custom', path: ['distanceM'], message: 'Distance must be more than zero' });
      else if (info.maxDistanceM && v.distanceM > info.maxDistanceM)
        ctx.addIssue({ code: 'custom', path: ['distanceM'], message: `That distance looks too long for a ${info.noun}` });
      else if (info.maxSpeedKmh && v.durationSec > 0) {
        const kmh = v.distanceM / 1000 / (v.durationSec / 3600);
        if (kmh > info.maxSpeedKmh)
          ctx.addIssue({ code: 'custom', path: ['distanceM'], message: `That pace looks too fast for a ${info.noun} — check distance and duration` });
      }
    }
    if (v.elevationM != null && (v.elevationM < 0 || v.elevationM > 10_000))
      ctx.addIssue({ code: 'custom', path: ['elevationM'], message: 'Elevation gain should be between 0 and 10,000 m' });
    for (const k of ['avgHr', 'maxHr'] as const) {
      const hr = v[k];
      if (hr != null && (hr < 30 || hr > 230 || !Number.isInteger(hr)))
        ctx.addIssue({ code: 'custom', path: [k], message: 'Heart rate should be a whole number from 30 to 230 bpm' });
    }
    if (v.avgHr != null && v.maxHr != null && v.avgHr > v.maxHr)
      ctx.addIssue({ code: 'custom', path: ['avgHr'], message: 'Average heart rate can’t be higher than maximum' });
    if (v.energyKcal != null && (v.energyKcal < 0 || v.energyKcal > 10_000))
      ctx.addIssue({ code: 'custom', path: ['energyKcal'], message: 'Energy should be between 0 and 10,000 kcal' });
  });

export type ActivityInput = z.input<typeof activityInputSchema>;

export function validateActivity(input: ActivityInput): { ok: true; value: z.output<typeof activityInputSchema> } | { ok: false; errors: Record<string, string> } {
  const r = activityInputSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = String(issue.path[0] ?? 'form');
    if (!errors[key]) errors[key] = issue.message;
  }
  return { ok: false, errors };
}

/* ---------------------------------------------------------- energy (approx) */
export const ENERGY_ESTIMATE_NOTE =
  'Approximate: MET × body weight (kg) × hours, using typical MET values for the activity and intensity. Real energy use varies a lot between people.';

/**
 * Optional, clearly approximate energy estimate. Only call when the user asks for it and
 * a bodyweight is known. Never added automatically.
 */
export function estimateEnergyKcal(p: { type: ActivityType; intensity?: Intensity; durationSec: number; weightKg?: number | null }): { kcal: number; met: number } | null {
  if (!p.weightKg || p.weightKg <= 0 || !p.durationSec || p.durationSec <= 0) return null;
  const met = activityTypeInfo(p.type).met[p.intensity ?? 'moderate'];
  return { kcal: Math.round(met * p.weightKg * (p.durationSec / 3600)), met };
}

/* --------------------------------------------------------- local time */
/** Offset (ms) of an IANA zone from UTC at a given instant. */
function zoneOffsetMs(epoch: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epoch));
  const g = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return asUTC - Math.floor(epoch / 1000) * 1000;
}

/** Epoch ms for a wall-clock date + 'HH:MM' in an IANA time zone. */
export function zonedTimeToEpoch(date: string, hhmm: string, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall - zoneOffsetMs(wall, timeZone);
  guess = wall - zoneOffsetMs(guess, timeZone);
  return guess;
}

/** 'HH:MM' wall-clock time of an instant in a time zone. */
export function epochToZonedTime(epoch: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(epoch));
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? '00';
  return `${g('hour')}:${g('minute')}`;
}
