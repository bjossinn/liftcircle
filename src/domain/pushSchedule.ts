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
 * Texts are short, in the coach style, and never mention body weight or food.
 */
import type { ActivityLog, CoachStyle, Exercise, ID, ISODate, Program, WeightUnit, WorkoutSession } from './types';
import { plannedSessionsInRange } from './program/schedule';
import { nextSet } from './coachCheers';

export type PushKind = 'workout_reminder' | 'rest_over' | 'coaching' | 'social' | 'missed_nudge';
export const PUSH_KINDS: PushKind[] = ['workout_reminder', 'rest_over', 'coaching', 'social', 'missed_nudge'];
/** On by default once push is on — everything except social. */
export const DEFAULT_PUSH_KINDS: PushKind[] = ['workout_reminder', 'rest_over', 'coaching', 'missed_nudge'];

export interface PushPrefs {
  kinds: PushKind[];
  /** 'HH:MM' or null. */
  fixedReminderTime: string | null;
  timeZone: string;
  quietStart: string;
  quietEnd: string;
}
export const DEFAULT_PUSH_PREFS: PushPrefs = { kinds: DEFAULT_PUSH_KINDS, fixedReminderTime: null, timeZone: 'UTC', quietStart: '22:00', quietEnd: '07:00' };

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
export function reminderText(name: string, style: CoachStyle = 'balanced'): string {
  if (style === 'supportive') return `${name} today, whenever you’re ready. 🙂`;
  if (style === 'strict') return `${name} today. No excuses, let’s go. 💪`;
  return `${name} today. Ready? 💪`;
}
export function missedText(name: string, style: CoachStyle = 'balanced'): string {
  if (style === 'supportive') return `${name} didn’t happen yesterday, and that’s okay. A short session today still counts.`;
  if (style === 'strict') return `You missed ${name} yesterday. Let’s get it done today. No excuses, 20 minutes counts.`;
  return `You missed ${name} yesterday. Can you fit it in today? Even 20 minutes counts.`;
}
export function restText(exerciseName: string, setNumber: number, detail: string): string {
  return `Rest’s up: ${exerciseName} set ${setNumber}${detail ? `, ${detail}` : ''}`;
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
    out.push({ dedupeKey: `reminder:${it.date}`, fireAt: at.toISOString(), payload: { title: 'LiftCircle', body: reminderText(it.template.name, i.style), url: '/', tag: 'workout' } });
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
    out.push({ dedupeKey: `nudge:${it.date}`, fireAt: at.toISOString(), payload: { title: 'LiftCircle', body: missedText(it.template.name, i.style), url: '/', tag: 'workout' } });
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
export function restAlertJob(session: WorkoutSession, byId: Map<ID, Exercise>, unit: WeightUnit): ScheduledJob | null {
  const endsAt = session.status === 'active' ? session.rest?.endsAt : undefined;
  if (endsAt == null) return null;
  const n = nextSet(session, byId, unit, session.rest?.forExerciseId);
  if (!n) return null;
  return {
    dedupeKey: `rest:${session.id}`,
    fireAt: new Date(endsAt).toISOString(),
    payload: { title: 'LiftCircle', body: restText(n.exerciseName, n.number, n.detail), url: `/train/session/${session.id}`, tag: 'rest' },
  };
}
