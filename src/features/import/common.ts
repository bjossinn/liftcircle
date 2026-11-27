/** Helpers shared by the Strong and Hevy parsers: header lookup, dates, durations and row grouping. */
import { headerKey, type CsvTable } from './csv';
import type { ImportDistanceUnit, ImportStart, ParsedExercise, ParsedSet, ParsedWorkout } from './types';
import type { WeightUnit } from '@/domain/types';

/** Index of the first header matching any of `names` (compared with `headerKey`), or -1. */
export function column(table: CsvTable, ...names: string[]): number {
  const keys = table.headers.map(headerKey);
  for (const n of names) {
    const i = keys.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

export const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  // Icelandic / Nordic / German month abbreviations seen in localized exports
  maí: 5, mai: 5, jún: 6, júl: 7, ágú: 8, agu: 8, okt: 10, nóv: 11, des: 12, dez: 12, mär: 3, mrz: 3, maj: 5,
};

const pad = (n: number) => String(n).padStart(2, '0');

function localStart(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ampm?: string): ImportStart | null {
  if (ampm) {
    const pm = ampm.toLowerCase() === 'pm';
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  // Reject impossible calendar dates (31 Feb).
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1) return null;
  return { local: `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}` };
}

/**
 * A workout start time from an export cell. Supported:
 *  - "2024-01-15 08:30:00", "2024-01-15T08:30", "2024/01/15 8:30" (local wall-clock time)
 *  - "2024-01-15T08:30:00Z" / "+00:00" offsets (an instant)
 *  - "15 Jan 2024, 08:30" (Hevy), "Jan 15, 2024, 8:30 AM"
 *  - "15.01.2024 08:30" (European), "1/15/2024 8:30 AM" / "15/1/2024 08:30" (day first when the first number > 12)
 */
export function parseStart(raw: string): ImportStart | null {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s?(Z|[+-]\d{2}:?\d{2})$/i.exec(s);
  if (m) {
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${pad(+m[4])}:${m[5]}:${m[6] ?? '00'}${m[7].toUpperCase() === 'Z' ? 'Z' : m[7].length === 5 ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : m[7]}`);
    return Number.isFinite(ms) ? { epochMs: ms } : null;
  }
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s?(am|pm)?)?$/i.exec(s);
  if (m) return localStart(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7]);
  m = /^(\d{1,2})\.?\s([A-Za-zÀ-ÿ]{3,})\.?\s(\d{4}),?(?:\s(\d{1,2}):(\d{2})(?::(\d{2}))?\s?(am|pm)?)?$/i.exec(s);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, 4)] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
    return mo ? localStart(+m[3], mo, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7]) : null;
  }
  m = /^([A-Za-zÀ-ÿ]{3,})\.?\s(\d{1,2}),?\s(\d{4}),?(?:\s(\d{1,2}):(\d{2})(?::(\d{2}))?\s?(am|pm)?)?$/i.exec(s);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 4)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)];
    return mo ? localStart(+m[3], mo, +m[2], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7]) : null;
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return localStart(+m[3], +m[2], +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s?(am|pm)?)?$/i.exec(s);
  if (m) {
    const dayFirst = +m[1] > 12;
    return localStart(+m[3], dayFirst ? +m[2] : +m[1], dayFirst ? +m[1] : +m[2], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7]);
  }
  return null;
}

/**
 * A workout duration in seconds: "1h 5m", "1h5m", "45m", "90s", "1:05:00", "65:00" (mm:ss), or a plain number
 * (seconds, or minutes when `plainUnit` is 'min'). Returns undefined when unreadable or zero.
 */
export function parseDuration(raw: string, plainUnit: 'sec' | 'min' = 'sec'): number | undefined {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  let total: number | null = null;
  const hms = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (hms) total = hms[3] != null ? +hms[1] * 3600 + +hms[2] * 60 + +hms[3] : +hms[1] * 60 + +hms[2];
  else if (/^\d+(\.\d+)?$/.test(s)) total = Number(s) * (plainUnit === 'min' ? 60 : 1);
  else {
    const parts = [...s.matchAll(/(\d+(?:[.,]\d+)?)\s*(h|hr|hrs|hours?|klst|m|min|mins|minutes?|mín|s|sec|secs|seconds?|sek)(?![a-zíú])/g)];
    if (parts.length && parts.map((p) => p[0]).join('').replace(/\s/g, '') === s.replace(/\s/g, '')) {
      total = parts.reduce((sum, p) => {
        const n = Number(p[1].replace(',', '.'));
        const u = p[2];
        return sum + (u.startsWith('h') || u === 'klst' ? n * 3600 : u.startsWith('m') ? n * 60 : n);
      }, 0);
    }
  }
  return total != null && Number.isFinite(total) && total > 0 ? Math.round(total) : undefined;
}

/** "kg" / "lbs" / "lb" from a header suffix or a unit cell. */
export function weightUnitOf(text: string): WeightUnit | undefined {
  const s = text.toLowerCase();
  if (/\b(lbs?|pounds?)\b/.test(s)) return 'lb';
  if (/\b(kgs?|kilo(gram)?s?)\b/.test(s)) return 'kg';
  return undefined;
}

export function distanceUnitOf(text: string): ImportDistanceUnit | undefined {
  const s = text.toLowerCase();
  if (/\b(mi|miles?)\b/.test(s)) return 'mi';
  if (/\b(km|kilomet(er|re)s?)\b/.test(s)) return 'km';
  if (/\b(m|meters?|metres?)\b/.test(s)) return 'm';
  return undefined;
}

/** A set is worth importing when it records at least one value. */
export const hasValues = (s: ParsedSet) => [s.weight, s.reps, s.distance, s.durationSec].some((v) => v != null && v !== 0);

/**
 * Builds workouts from rows in file order: rows with the same workout key form one workout; consecutive rows with the
 * same exercise name form one exercise block (the same exercise later in the workout starts a new block).
 */
export class WorkoutGrouper {
  private byKey = new Map<string, ParsedWorkout>();
  readonly workouts: ParsedWorkout[] = [];

  workout(key: string, make: () => ParsedWorkout): ParsedWorkout {
    let w = this.byKey.get(key);
    if (!w) {
      w = make();
      this.byKey.set(key, w);
      this.workouts.push(w);
    }
    return w;
  }

  exercise(w: ParsedWorkout, name: string, blockKey = name): ParsedExercise {
    const last = w.exercises[w.exercises.length - 1] as (ParsedExercise & { blockKey?: string }) | undefined;
    if (last && last.blockKey === blockKey) return last;
    const ex: ParsedExercise & { blockKey?: string } = { name, sets: [] };
    Object.defineProperty(ex, 'blockKey', { value: blockKey, enumerable: false });
    w.exercises.push(ex);
    return ex;
  }

  /** Drop exercises without sets and workouts without exercises. */
  result(): ParsedWorkout[] {
    for (const w of this.workouts) w.exercises = w.exercises.filter((e) => e.sets.length > 0);
    return this.workouts.filter((w) => w.exercises.length > 0);
  }
}
