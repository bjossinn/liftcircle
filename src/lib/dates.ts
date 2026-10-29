import type { ISODate } from '@/domain/types';

/** The device's IANA time zone, falling back to UTC. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Local calendar date (YYYY-MM-DD) of an instant in a given IANA time zone. */
export function localDate(epochMs: number, timeZone: string): ISODate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
    new Date(epochMs),
  );
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function todayISO(timeZone: string = deviceTimeZone()): ISODate {
  return localDate(Date.now(), timeZone);
}

/** Pure calendar arithmetic on YYYY-MM-DD (no time zone involved). */
export function parseISO(d: ISODate): { y: number; m: number; day: number } {
  const [y, m, day] = d.split('-').map(Number);
  return { y, m, day };
}
export function toUTCms(d: ISODate): number {
  const { y, m, day } = parseISO(d);
  return Date.UTC(y, m - 1, day);
}
export function fromUTCms(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDays(d: ISODate, n: number): ISODate {
  return fromUTCms(toUTCms(d) + n * 86400000);
}
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTCms(a) - toUTCms(b)) / 86400000);
}
/** 0 = Sunday … 6 = Saturday */
export function weekday(d: ISODate): number {
  return new Date(toUTCms(d)).getUTCDay();
}
export function startOfWeek(d: ISODate, weekStart: 0 | 1): ISODate {
  const wd = weekday(d);
  const back = (wd - weekStart + 7) % 7;
  return addDays(d, -back);
}
export function rangeDays(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatDate(d: ISODate, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(toUTCms(d)));
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}
export function formatMinutes(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
