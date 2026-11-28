/**
 * Push notification scheduling rules (pure; computed on the device, uploaded with replace_scheduled_jobs).
 *
 * Workout reminder time, per planned session:
 *   1. the user's fixed reminder time, if set;
 *   2. else 2 hours before the start of the most recent completed session of the same template, in the user's
 *      time zone (last "Upper A" started 17:00 → 15:00);
 *   3. else 12:00;
 *   then clamped into the allowed window (not before quiet_end; not after quiet_start, with a 5-minute margin so
 *   the send job doesn't land in quiet hours). A time already past today isn't sent.
 * Reminders skip days whose session is started, done, skipped or moved, and rest days.
 *
 * Missed-session nudge: a planned day that ends without a workout (and wasn't skipped/moved — week plans are
 * overrides, so they count) → one nudge the next day at that day's reminder time. Future days get a nudge
 * scheduled in advance; it is cancelled by the next upload once the workout is logged. Never when the latest
 * local input mentioned pain, injury or illness.
 *
 * Texts are short, in the coach style, and never mention body weight or food. They are placeholders: since roadmap
 * item 9 the server replaces the text of every coach reminder with approved, always-supportive copy in the account
 * language at send time (supabase/functions/_shared/push/copy.ts), after re-checking the synchronized data. Uploaded
 * schedules are candidates, not proof that a workout was missed.
 */
import type { ActivityLog, CoachStyle, Exercise, ID, ISODate, Program, WeightUnit, WorkoutSession } from './types';
import { plannedSessionsInRange } from './program/schedule';
import { nextSet } from './coachCheers';
import { sessionDisplayName } from './program/localize';
import { getLanguage, t, type Language } from '@/i18n';

export type PushKind = 'workout_reminder' | 'rest_over' | 'coaching' | 'social' | 'missed_nudge' | 'food_unlogged';
export const PUSH_KINDS: PushKind[] = ['workout_reminder', 'rest_over', 'coaching', 'social', 'missed_nudge', 'food_unlogged'];
/** On by default once push is on — everything except social and food-log reminders. */
export const DEFAULT_PUSH_KINDS: PushKind[] = ['workout_reminder', 'rest_over', 'coaching', 'missed_nudge'];
/** Coach notifications (roadmap item 9): the daily limit and the pause apply to these three, across all devices. */
export const COACH_PUSH_KINDS: PushKind[] = ['workout_reminder', 'missed_nudge', 'food_unlogged'];
export const DAILY_CAPS = [1, 2, 3] as const;
export type DailyCap = (typeof DAILY_CAPS)[number];
export const SNOOZE_DAYS = [1, 3, 7, 14] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];
/** Food-log reminders are server-scheduled once a day at this local time. */
export const FOOD_REMINDER_TIME = '19:00';

export interface PushPrefs {
  kinds: PushKind[];
  /** 'HH:MM' or null. */
  fixedReminderTime: string | null;
  timeZone: string;
  quietStart: string;
  quietEnd: string;
  /** Maximum coach reminders per local day (default 2). */
  dailyCap: DailyCap;
  /** ISO instant until which coach reminders are paused, or null. */
  snoozeUntil: string | null;
  /** Server revision of these settings (optimistic concurrency); 0 = never saved. */
  revision: number;
}
export const DEFAULT_PUSH_PREFS: PushPrefs = {
  kinds: DEFAULT_PUSH_KINDS,
  fixedReminderTime: null,
  timeZone: 'UTC',
  quietStart: '22:00',
  quietEnd: '07:00',
  dailyCap: 2,
  snoozeUntil: null,
  revision: 0,
};
export const isDailyCap = (v: unknown): v is DailyCap => (DAILY_CAPS as readonly unknown[]).includes(v);
export const isSnoozeDays = (v: unknown): v is SnoozeDays => (SNOOZE_DAYS as readonly unknown[]).includes(v);
export const isHHMM = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
/** Quiet hours with the same start and end are off. */
export const quietHoursOff = (p: Pick<PushPrefs, 'quietStart' | 'quietEnd'>) => p.quietStart === p.quietEnd;
/** The pause still in effect at `now`, or null. */
export function activeSnooze(p: Pick<PushPrefs, 'snoozeUntil'>, now: number = Date.now()): string | null {
  const t = p.snoozeUntil ? Date.parse(p.snoozeUntil) : NaN;
  return Number.isFinite(t) && t > now ? p.snoozeUntil : null;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}
export interface ScheduledJob {
  dedupeKey: string;
  fireAt: string;
  payload: PushPayload;
  /** Local day the reminder belongs to (the server discards it once that day is over). */
  eventDate?: ISODate;
  /** The planned day the reminder is about (a missed-workout nudge: the previous day). */
  sourceDate?: ISODate;
}

/* ------------------------------------------------------------------ time zone helpers */
function tzParts(ms: number, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
export function safeZone(tz: string | undefined): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC' });
    return tz || 'UTC';
  } catch {
    return 'UTC';
  }
}
function offsetAt(ms: number, timeZone: string): number {
  const p = tzParts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** UTC instant of local wall-clock `date` + `hhmm` in `timeZone` (DST-aware; a skipped hour resolves forward). */
export function zonedToUtc(date: ISODate, hhmm: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetAt(guess, timeZone);
  t = guess - offsetAt(t, timeZone);
  return new Date(t);
}
/** Local 'HH:MM' of an instant in `timeZone`. */
export function localHHMM(ms: number, timeZone: string): string {
  const p = tzParts(ms, timeZone);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}
export const toMinutes = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  return m ? (+m[1] % 24) * 60 + +m[2] : 0;
};
export const fromMinutes = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const addDays = (d: ISODate, n: number): ISODate => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ reminder time rule */
const QUIET_MARGIN_MIN = 5;

/** Moves a local time into the allowed window (outside quiet hours). */
export function clampToAllowed(min: number, prefs: Pick<PushPrefs, 'quietStart' | 'quietEnd'>): number {
  const start = toMinutes(prefs.quietStart);
  const end = toMinutes(prefs.quietEnd);
  if (start === end) return min;
  if (start > end) {
    // usual case: quiet overnight (22:00 → 07:00); allowed window is [end, start − margin]
    const latest = Math.max(end, start - QUIET_MARGIN_MIN);
    if (min < end) return end;
    if (min > latest) return latest;
    return min;
  }
  // quiet during the day (e.g. 09:00 → 17:00): push out of it to the end
  return min >= start && min < end ? end : min;
}

export interface ReminderTimeInput {
  templateId?: string;
  sessions: WorkoutSession[];
  prefs: PushPrefs;
}
/** 'HH:MM' local reminder time for a planned session (rules 1–3 + clamp). */
export function reminderTime(i: ReminderTimeInput): string {
  const tz = safeZone(i.prefs.timeZone);
  let min: number;
  if (i.prefs.fixedReminderTime && /^\d{2}:\d{2}$/.test(i.prefs.fixedReminderTime)) {
    min = toMinutes(i.prefs.fixedReminderTime);
  } else {
    const last = i.templateId
      ? i.sessions.filter((s) => s.status === 'completed' && !s.deletedAt && s.templateId === i.templateId && s.startedAt > 0).sort((a, b) => b.startedAt - a.startedAt)[0]
      : undefined;
    min = last ? Math.max(0, toMinutes(localHHMM(last.startedAt, tz)) - 120) : 12 * 60;
  }
  return fromMinutes(clampToAllowed(min, i.prefs));
}

/* ------------------------------------------------------------------ texts (coach style) */
/** Reminder text in `language` (default: the current language, which follows the account language). */
export function reminderText(name: string, style: CoachStyle = 'supportive', language: Language = getLanguage()): string {
  if (style === 'supportive') return t('push.reminder.supportive', { name }, language);
  if (style === 'strict') return t('push.reminder.strict', { name }, language);
  return t('push.reminder.direct', { name }, language);
}
export function missedText(name: string, style: CoachStyle = 'supportive', language: Language = getLanguage()): string {
  if (style === 'supportive') return t('push.missed.supportive', { name }, language);
  if (style === 'strict') return t('push.missed.strict', { name }, language);
  return t('push.missed.direct', { name }, language);
}
export function restText(exerciseName: string, setNumber: number, detail: string, language: Language = getLanguage()): string {
  return detail
    ? t('push.restWithDetail', { exercise: exerciseName, number: setNumber, detail }, language)
    : t('push.rest', { exercise: exerciseName, number: setNumber }, language);
}

/** Latest local input mentions pain/injury/illness → no nudges. */
export function mentionsPainOrIllness(text: string | null | undefined): boolean {
  return /\b(pain|painful|hurts?|hurting|injur(y|ed|ies)|sprain|strain(ed)?|sore (knee|back|shoulder|neck)|ill|illness|sick|fever|flu|covid|migraine|dizzy)\b/i.test(text ?? '');
}

/* ------------------------------------------------------------------ jobs */
export interface PlanJobsInput {
  program: Program | null | undefined;
  sessions: WorkoutSession[];
  activities?: ActivityLog[];
  today: ISODate;
  now: Date;
  prefs: PushPrefs;
  style?: CoachStyle;
  /** True when the latest local input (AI chat message, discomfort flag) mentions pain, injury or illness. */
  painFlag?: boolean;
  days?: number;
  /** Language of the texts (default: the current language, i.e. the account language). */
  language?: Language;
}

const started = (sessions: WorkoutSession[], date: ISODate) =>
  sessions.some((s) => !s.deletedAt && (s.status === 'active' || s.status === 'completed') && (s.plannedDate === date || s.date === date));

/** Workout reminders for the next 14 days (one per planned training day). */
export function workoutReminderJobs(i: PlanJobsInput): ScheduledJob[] {
  if (!i.program) return [];
  const tz = safeZone(i.prefs.timeZone);
  const days = i.days ?? 14;
  let items: ReturnType<typeof plannedSessionsInRange> = [];
  try {
    items = plannedSessionsInRange(i.program, i.today, addDays(i.today, days - 1), i.today, i.sessions, i.activities ?? []);
  } catch {
    return [];
  }
  const out: ScheduledJob[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.date)) continue;
    if (it.status !== 'planned' && it.status !== 'today') continue; // done, skipped, moved away, missed
    if (it.sessionId || started(i.sessions, it.date)) continue; // already started or completed
    const at = zonedToUtc(it.date, reminderTime({ templateId: it.template.id, sessions: i.sessions, prefs: i.prefs }), tz);
    if (at.getTime() <= i.now.getTime()) continue;
    seen.add(it.date);
    out.push({ dedupeKey: `reminder:${it.date}`, fireAt: at.toISOString(), payload: { title: 'Hard Earned', body: reminderText(sessionDisplayName(it.template, i.language), i.style, i.language), url: '/', tag: 'workout' }, eventDate: it.date, sourceDate: it.date });
  }
  return out;
}

/** Missed-session nudges: yesterday's missed day, and (in advance) every upcoming planned day. */
export function missedNudgeJobs(i: PlanJobsInput): ScheduledJob[] {
  if (!i.program || i.painFlag) return [];
  const tz = safeZone(i.prefs.timeZone);
  const days = i.days ?? 14;
  const from = addDays(i.today, -1);
  let items: ReturnType<typeof plannedSessionsInRange> = [];
  try {
    items = plannedSessionsInRange(i.program, from, addDays(i.today, days - 2), i.today, i.sessions, i.activities ?? []);
  } catch {
    return [];
  }
  const out: ScheduledJob[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.date)) continue;
    const open = it.date < i.today ? it.status === 'missed' : it.status === 'planned' || it.status === 'today';
    if (!open || it.sessionId || started(i.sessions, it.date)) continue;
    const nudgeDay = addDays(it.date, 1);
    const at = zonedToUtc(nudgeDay, reminderTime({ templateId: it.template.id, sessions: i.sessions, prefs: i.prefs }), tz);
    if (at.getTime() <= i.now.getTime()) continue;
    seen.add(it.date);
    out.push({ dedupeKey: `nudge:${it.date}`, fireAt: at.toISOString(), payload: { title: 'Hard Earned', body: missedText(sessionDisplayName(it.template, i.language), i.style, i.language), url: '/', tag: 'workout' }, eventDate: nudgeDay, sourceDate: it.date });
  }
  // At most one nudge per calendar day.
  const perDay = new Map<string, ScheduledJob>();
  for (const j of out) {
    const key = new Date(j.fireAt).toISOString().slice(0, 10);
    if (!perDay.has(key)) perDay.set(key, j);
  }
  return [...perDay.values()];
}

/** The rest-over push for an active workout's running rest timer (dedupe key per workout), or null. */
export function restAlertJob(session: WorkoutSession, byId: Map<ID, Exercise>, unit: WeightUnit, language: Language = getLanguage()): ScheduledJob | null {
  const endsAt = session.status === 'active' ? session.rest?.endsAt : undefined;
  if (endsAt == null) return null;
  const n = nextSet(session, byId, unit, session.rest?.forExerciseId, language);
  if (!n) return null;
  return {
    dedupeKey: `rest:${session.id}`,
    fireAt: new Date(endsAt).toISOString(),
    payload: { title: 'Hard Earned', body: restText(n.exerciseName, n.number, n.detail), url: `/train/session/${session.id}`, tag: 'rest' },
  };
}
