/**
 * Activity types, field relevance, pace/speed maths, validation and an optional,
 * clearly approximate energy estimate. Pure: no React, no Dexie.
 *
 * Canonical storage: duration in seconds, distance and elevation in metres.
 */
import { z } from 'zod';
import type { ActivityLog, ActivityType, DistanceUnit, Intensity } from './types';
import { formatSpeed, fromMeters } from './units';
import { getLanguage, t, tKey, type Language } from '@/i18n';

export type ActivityField = 'distance' | 'elevation' | 'hr' | 'pace';
/** How pace/speed is expressed for a type. */
export type PaceMode = 'per_unit' | 'per_100m' | 'per_500m' | 'speed';

export interface ActivityTypeInfo {
  type: ActivityType;
  label: string;
  /** Noun used in sentences ("That distance looks too long for a {{noun}}"), in the current language. */
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

const ACTIVITY_DEFS: Omit<ActivityTypeInfo, 'label' | 'noun'>[] = [
  { type: 'walk', fields: ['distance', 'elevation', 'hr', 'pace'], paceMode: 'per_unit', maxDistanceM: 150_000, maxSpeedKmh: 12, met: { easy: 3, moderate: 3.8, hard: 5 } },
  { type: 'run', fields: ['distance', 'elevation', 'hr', 'pace'], paceMode: 'per_unit', maxDistanceM: 350_000, maxSpeedKmh: 25, met: { easy: 7, moderate: 9.5, hard: 11.5 } },
  { type: 'cycle', fields: ['distance', 'elevation', 'hr'], paceMode: 'speed', maxDistanceM: 1_000_000, maxSpeedKmh: 80, met: { easy: 4, moderate: 6.8, hard: 10 } },
  { type: 'hike', fields: ['distance', 'elevation', 'hr', 'pace'], paceMode: 'per_unit', maxDistanceM: 150_000, maxSpeedKmh: 12, met: { easy: 4.5, moderate: 6, hard: 7.8 } },
  { type: 'swim', fields: ['distance', 'hr', 'pace'], paceMode: 'per_100m', maxDistanceM: 60_000, maxSpeedKmh: 8, met: { easy: 5.8, moderate: 7, hard: 9.8 } },
  { type: 'row', fields: ['distance', 'hr', 'pace'], paceMode: 'per_500m', maxDistanceM: 200_000, maxSpeedKmh: 30, met: { easy: 4.8, moderate: 7, hard: 8.5 } },
  { type: 'sport', fields: ['hr'], paceMode: null, met: { easy: 4.5, moderate: 6.5, hard: 8.5 } },
  { type: 'class', fields: ['hr'], paceMode: null, met: { easy: 4, moderate: 6, hard: 8 } },
  { type: 'yoga', fields: ['hr'], paceMode: null, met: { easy: 2.5, moderate: 3, hard: 4 } },
  { type: 'mobility', fields: ['hr'], paceMode: null, met: { easy: 2.3, moderate: 2.8, hard: 3.5 } },
  { type: 'stretch', fields: ['hr'], paceMode: null, met: { easy: 2.3, moderate: 2.5, hard: 3 } },
  { type: 'custom', fields: ['distance', 'elevation', 'hr'], paceMode: null, maxDistanceM: 1_000_000, met: { easy: 3.5, moderate: 5, hard: 7 } },
];

/**
 * Activity types in display order. `label` (summary.activity.*) and `noun` (activities.noun.*) read the dictionary in
 * the app's current language on every lookup; `type` stays the stored value.
 */
export const ACTIVITY_TYPES: ActivityTypeInfo[] = ACTIVITY_DEFS.map((d) =>
  Object.defineProperties({ ...d } as ActivityTypeInfo, {
    label: { enumerable: true, get: () => activityTypeLabel(d.type) },
    noun: { enumerable: true, get: () => activityTypeNoun(d.type) },
  }),
);

/** Display label for an activity type in `lang` (default: the current language): "Run" / "Hlaup". */
export function activityTypeLabel(type: ActivityType, lang: Language = getLanguage()): string {
  return tKey(`summary.activity.${type}`, type, undefined, lang);
}

/** Noun for an activity type in `lang`, as used inside validation sentences: "run" / "hlaup". */
export function activityTypeNoun(type: ActivityType, lang: Language = getLanguage()): string {
  return tKey(`activities.noun.${type}`, type, undefined, lang);
}

const BY_TYPE = new Map(ACTIVITY_TYPES.map((t) => [t.type, t]));

export function activityTypeInfo(type: ActivityType): ActivityTypeInfo {
  return BY_TYPE.get(type) ?? BY_TYPE.get('custom')!;
}

export function hasField(type: ActivityType, field: ActivityField): boolean {
  return activityTypeInfo(type).fields.includes(field);
}

/** Display name for an activity ("Run", or the custom name — user content, shown as typed — for a custom activity). */
export function activityLabel(a: Pick<ActivityLog, 'type' | 'customName'>, lang: Language = getLanguage()): string {
  if (a.type === 'custom') {
    const name = a.customName?.trim();
    if (name) return name;
    return t('activities.customFallback', undefined, lang);
  }
  return activityTypeLabel(activityTypeInfo(a.type).type, lang);
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
      return { kind: 'speed', value: v, per, text: formatSpeed(v, unit) };
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
    customName: z.string().trim().max(60, { error: () => t('activities.validation.name_too_long') }).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: () => t('activities.validation.choose_a_date') }),
    durationSec: z
      .number({ error: () => t('activities.validation.enter_a_duration') })
      .min(MIN_DURATION_SEC, { error: () => t('activities.validation.duration_min') })
      .max(MAX_DURATION_SEC, { error: () => t('activities.validation.duration_max') }),
    distanceM: optNum,
    elevationM: optNum,
    avgHr: optNum,
    maxHr: optNum,
    intensity: z.enum(['easy', 'moderate', 'hard']).optional(),
    energyKcal: optNum,
    energySource: z.enum(['user', 'device', 'estimate']).optional(),
    notes: z.string().max(2000, { error: () => t('activities.validation.notes_too_long') }).optional(),
  })
  .superRefine((v, ctx) => {
    const info = activityTypeInfo(v.type);
    if (v.type === 'custom' && !v.customName?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['customName'], message: t('activities.validation.give_your_activity_a_name') });
    }
    if (v.distanceM != null) {
      if (v.distanceM <= 0) ctx.addIssue({ code: 'custom', path: ['distanceM'], message: t('activities.validation.distance_must_be_more_than_zero') });
      else if (info.maxDistanceM && v.distanceM > info.maxDistanceM)
        ctx.addIssue({ code: 'custom', path: ['distanceM'], message: t('activities.validation.that_distance_looks_too_long_for', { noun: info.noun }) });
      else if (info.maxSpeedKmh && v.durationSec > 0) {
        const kmh = v.distanceM / 1000 / (v.durationSec / 3600);
        if (kmh > info.maxSpeedKmh)
          ctx.addIssue({ code: 'custom', path: ['distanceM'], message: t('activities.validation.that_pace_looks_too_fast_for', { noun: info.noun }) });
      }
    }
    if (v.elevationM != null && (v.elevationM < 0 || v.elevationM > 10_000))
      ctx.addIssue({ code: 'custom', path: ['elevationM'], message: t('activities.validation.elevation_gain_should_be_between_0') });
    for (const k of ['avgHr', 'maxHr'] as const) {
      const hr = v[k];
      if (hr != null && (hr < 30 || hr > 230 || !Number.isInteger(hr)))
        ctx.addIssue({ code: 'custom', path: [k], message: t('activities.validation.heart_rate_should_be_a_whole') });
    }
    if (v.avgHr != null && v.maxHr != null && v.avgHr > v.maxHr)
      ctx.addIssue({ code: 'custom', path: ['avgHr'], message: t('activities.validation.average_heart_rate_cant_be_higher') });
    if (v.energyKcal != null && (v.energyKcal < 0 || v.energyKcal > 10_000))
      ctx.addIssue({ code: 'custom', path: ['energyKcal'], message: t('activities.validation.energy_should_be_between_0_and') });
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
/** How the approximate energy estimate is calculated, in `lang` (default: the current language). */
export const energyEstimateNote = (lang: Language = getLanguage()) => t('activities.energyEstimateNote', undefined, lang);

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
