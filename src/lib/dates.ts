import type { ISODate } from '@/domain/types';
import { getLanguage, localeFor, t, tp, type Language } from '@/i18n';

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
/** English weekday names (0 = Sunday). Internal/legacy use only — UI uses weekdayShort/weekdayLong (localized). */
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WD_KEY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** Localized short weekday label (0 = Sunday): "Mon" / "mán.". */
export function weekdayShort(i: number, language: Language = getLanguage()): string {
  return t(`format.weekdayShort.${WD_KEY[((i % 7) + 7) % 7]}`, undefined, language);
}
/** Localized weekday name (0 = Sunday): "Monday" / "mánudagur". */
export function weekdayLong(i: number, language: Language = getLanguage()): string {
  return t(`format.weekday.${WD_KEY[((i % 7) + 7) % 7]}`, undefined, language);
}
/** "on Monday" / "á mánudaginn" (a phrase; don't add another preposition). */
export function weekdayOn(i: number, language: Language = getLanguage()): string {
  return t(`format.weekdayOn.${WD_KEY[((i % 7) + 7) % 7]}`, undefined, language);
}
/** "on Mondays" / "á mánudögum" (recurring). */
export function weekdayRecurring(i: number, language: Language = getLanguage()): string {
  return t(`format.weekdayRecurring.${WD_KEY[((i % 7) + 7) % 7]}`, undefined, language);
}

/**
 * A calendar date in the app language. Formatted on the UTC calendar date so the device time zone can't move it
 * ("Thu 26 Nov" / "fim., 26. nóv.").
 */
export function formatDate(d: ISODate, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }, language: Language = getLanguage()): string {
  return new Intl.DateTimeFormat(localeFor(language), { ...opts, timeZone: 'UTC' }).format(new Date(toUTCms(d)));
}

/**
 * Standalone relative label for a calendar date: "Today" / "Í dag", "Yesterday" / "Í gær", "Tomorrow" / "Á morgun",
 * the day before yesterday / after tomorrow; otherwise null (callers show formatDate).
 */
export function relativeDayLabel(d: ISODate, today: ISODate, language: Language = getLanguage()): string | null {
  const diff = diffDays(d, today);
  if (diff === 0) return t('format.relative.today', undefined, language);
  if (diff === -1) return t('format.relative.yesterday', undefined, language);
  if (diff === 1) return t('format.relative.tomorrow', undefined, language);
  if (diff === -2) return t('format.relative.dayBeforeYesterday', undefined, language);
  if (diff === 2) return t('format.relative.dayAfterTomorrow', undefined, language);
  return null;
}
/** "3 days ago" / "fyrir 3 dögum", "in 2 days" / "eftir 2 daga" (Icelandic plural rules). */
export function daysAgoText(days: number, language: Language = getLanguage()): string {
  return days >= 0 ? tp('format.daysAgo', days, undefined, language) : tp('format.inDays', -days, undefined, language);
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}
/** "45 min" / "45 mín.", "1 h 5 min" / "1 klst. 5 mín." (a timer stays formatDuration's "1:05:00"). */
export function formatMinutes(sec: number, language: Language = getLanguage()): string {
  const m = Math.round(sec / 60);
  if (m < 60) return t('format.minutes', { count: m }, language);
  return t('format.hoursMinutes', { hours: Math.floor(m / 60), minutes: m % 60 }, language);
}
