/**
 * Calendar view of a program: which session is planned on which local date, what was done,
 * missed, skipped or moved — and sensible rescheduling of missed sessions.
 */
import { hasCompletedWork } from '@/domain/setValidation';
import type { ActivityLog, ActivityType, ID, ISODate, PlanOverride, Program, SessionTemplate, WorkoutSession } from '@/domain/types';
import { addDays, formatDate, rangeDays, startOfWeek, weekday } from '@/lib/dates';
import { currentVersion, templateById } from './program';

export type PlannedStatus = 'planned' | 'today' | 'done' | 'missed' | 'skipped' | 'moved';
export interface PlannedSession {
  date: ISODate;
  template: SessionTemplate;
  status: PlannedStatus;
  sessionId?: ID;
  movedTo?: ISODate;
  movedFrom?: ISODate;
}

interface RawItem {
  date: ISODate;
  template: SessionTemplate;
  order: number;
  movedFrom?: ISODate;
}

/** Days after the planned date on which doing the session still counts for it. */
const LATE_WINDOW_DAYS = 2;

const ACTIVITY_MATCH: Partial<Record<ActivityType, ActivityType[]>> = {
  walk: ['walk', 'hike'],
  hike: ['hike', 'walk'],
  yoga: ['yoga', 'mobility', 'stretch'],
  mobility: ['mobility', 'yoga', 'stretch'],
  stretch: ['stretch', 'mobility', 'yoga'],
};

export function isHardTemplate(t: SessionTemplate): boolean {
  if (t.kind === 'lifting' || t.kind === 'conditioning') return true;
  return !!t.cardio && t.cardio.intensity !== 'easy';
}

function rawItems(p: Program, from: ISODate, to: ISODate): RawItem[] {
  const v = currentVersion(p);
  if (!v) return [];
  const byId = new Map(v.templates.map((t) => [t.id, t]));
  const start = from < p.startDate ? p.startDate : from;
  const out: RawItem[] = [];
  if (start <= to) {
    for (const d of rangeDays(start, to)) {
      const wd = weekday(d);
      v.schedule.forEach((slot, i) => {
        if (slot.weekday !== wd) return;
        const t = byId.get(slot.templateId);
        if (t) out.push({ date: d, template: t, order: i });
      });
    }
  }
  for (const o of p.overrides) {
    if (o.status !== 'moved' || !o.movedTo || o.movedTo < from || o.movedTo > to) continue;
    const t = byId.get(o.templateId) ?? templateById(p, o.templateId);
    if (t) out.push({ date: o.movedTo, template: t, order: 1000, movedFrom: o.date });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
}

export function plannedSessionsInRange(
  p: Program,
  from: ISODate,
  to: ISODate,
  today: ISODate,
  sessions: WorkoutSession[],
  activities?: ActivityLog[],
): PlannedSession[] {
  const items = rawItems(p, from, to);
  const mine = sessions.filter((s) => !s.deletedAt && (!s.programId || s.programId === p.id));
  const completed = mine.filter((s) => s.status === 'completed' && hasCompletedWork(s));
  const active = mine.filter((s) => s.status === 'active');
  const acts = (activities ?? []).filter((a) => !a.deletedAt);
  const claimed = new Set<ID>();
  const overrideFor = (date: ISODate, templateId: ID) => p.overrides.find((o) => o.date === date && o.templateId === templateId);

  // Pass 1: exact (plannedDate) and same-day matches, so late matching never steals them.
  const matchExact = (it: RawItem): WorkoutSession | undefined =>
    completed.find((s) => !claimed.has(s.id) && s.templateId === it.template.id && s.plannedDate === it.date) ??
    completed.find((s) => !claimed.has(s.id) && s.templateId === it.template.id && !s.plannedDate && s.date === it.date);
  const matched = new Map<RawItem, WorkoutSession>();
  for (const it of items) {
    if (!it.movedFrom && overrideFor(it.date, it.template.id)) continue;
    const s = matchExact(it);
    if (s) {
      claimed.add(s.id);
      matched.set(it, s);
    }
  }
  // Pass 2: done a day or two late without rescheduling.
  for (const it of items) {
    if (matched.has(it) || (!it.movedFrom && overrideFor(it.date, it.template.id))) continue;
    const late = addDays(it.date, LATE_WINDOW_DAYS);
    const s = completed.find(
      (x) => !claimed.has(x.id) && x.templateId === it.template.id && !x.plannedDate && x.date > it.date && x.date <= late,
    );
    if (s) {
      claimed.add(s.id);
      matched.set(it, s);
    }
  }
  const claimedActs = new Set<ID>();

  return items.map((it) => {
    const base: PlannedSession = { date: it.date, template: it.template, status: 'planned' };
    if (it.movedFrom) base.movedFrom = it.movedFrom;
    const o = it.movedFrom ? undefined : overrideFor(it.date, it.template.id);
    if (o?.status === 'skipped') return { ...base, status: 'skipped' };
    if (o?.status === 'moved') return { ...base, status: 'moved', movedTo: o.movedTo };
    const s = matched.get(it);
    if (s) return { ...base, status: 'done', sessionId: s.id };
    if (it.template.cardio && !it.template.exercises.length) {
      const types = ACTIVITY_MATCH[it.template.cardio.activity] ?? [it.template.cardio.activity];
      const late = addDays(it.date, LATE_WINDOW_DAYS);
      const a =
        acts.find((x) => !claimedActs.has(x.id) && x.date === it.date && types.includes(x.type)) ??
        acts.find((x) => !claimedActs.has(x.id) && x.date === it.date) ??
        acts.find((x) => !claimedActs.has(x.id) && x.date > it.date && x.date <= late && x.date <= today && types.includes(x.type));
      if (a) {
        claimedActs.add(a.id);
        return { ...base, status: 'done', sessionId: a.id };
      }
    }
    if (it.date === today) {
      const act = active.find((x) => x.templateId === it.template.id);
      return act ? { ...base, status: 'today', sessionId: act.id } : { ...base, status: 'today' };
    }
    if (it.date < today) return { ...base, status: 'missed' };
    return base;
  });
}

export function nextPlannedSession(p: Program, today: ISODate, sessions: WorkoutSession[]): PlannedSession | null {
  const items = plannedSessionsInRange(p, today, addDays(today, 13), today, sessions);
  return items.find((i) => i.status === 'today' || i.status === 'planned') ?? null;
}

/** Find the override that represents this planned item (handles items that were already moved once). */
function originalKey(p: Program, date: ISODate, templateId: ID): ISODate {
  const movedIn = p.overrides.find((o) => o.status === 'moved' && o.movedTo === date && o.templateId === templateId);
  return movedIn ? movedIn.date : date;
}

/**
 * Move a missed session to the next suitable day before that session comes round again.
 * Never puts two sessions on one day, only uses days the user marked available, and for
 * newer lifters never creates back-to-back hard days (it skips instead).
 */
export function rescheduleMissed(
  p: Program,
  missedDate: ISODate,
  templateId: ID,
  today: ISODate,
  sessions: WorkoutSession[],
): { program: Program; movedTo: ISODate | null; message: string } {
  const t = templateById(p, templateId);
  if (!t) return { program: p, movedTo: null, message: 'This session is no longer part of your program.' };
  const origin = originalKey(p, missedDate, templateId);
  const v = currentVersion(p);
  const exp = p.inputs?.experience;
  const strict = !exp || exp === 'new' || exp === 'returning';
  const hard = isHardTemplate(t);

  // Window: from tomorrow-or-today up to (not including) the next regular occurrence of the same session.
  const earliest = addDays(missedDate, 1) > today ? addDays(missedDate, 1) : today;
  let horizon = addDays(missedDate, 7);
  for (let d = addDays(missedDate, 1); d < horizon; d = addDays(d, 1)) {
    if (v.schedule.some((s) => s.templateId === templateId && s.weekday === weekday(d))) {
      horizon = d;
      break;
    }
  }
  if (earliest >= horizon) return finishSkip(p, origin, templateId, 'Your next ' + t.name + ' is coming up, so we skipped this one. Just carry on with the plan.');

  const others = plannedSessionsInRange(p, addDays(earliest, -1), horizon, today, sessions).filter(
    (x) => !(x.template.id === templateId && x.date === missedDate) && x.status !== 'skipped' && x.status !== 'moved',
  );
  const done = sessions.filter((s) => !s.deletedAt && s.status === 'completed' && hasCompletedWork(s));
  const occupied = (d: ISODate) => others.some((x) => x.date === d) || done.some((s) => s.date === d);
  const hardOn = (d: ISODate) => others.some((x) => x.date === d && isHardTemplate(x.template)) || done.some((s) => s.date === d);
  const avail = new Set(p.inputs?.availableWeekdays?.length ? p.inputs.availableWeekdays : [0, 1, 2, 3, 4, 5, 6]);
  const days = rangeDays(earliest, addDays(horizon, -1)).filter((d) => avail.has(weekday(d)) && !occupied(d));
  const spaced = days.find((d) => !hard || (!hardOn(addDays(d, -1)) && !hardOn(addDays(d, 1))));
  const target = spaced ?? (strict ? undefined : days[0]);
  if (!target) {
    return finishSkip(
      p,
      origin,
      templateId,
      strict && days.length
        ? `There’s no free day before your next ${t.name} without back-to-back hard sessions, so we skipped it. Your plan continues as normal.`
        : `There’s no free available day before your next ${t.name}, so we skipped it. Your plan continues as normal.`,
    );
  }
  const overrides = p.overrides.filter((o) => !(o.date === origin && o.templateId === templateId));
  overrides.push({ date: origin, templateId, status: 'moved', movedTo: target });
  const adjacent = hard && !spaced;
  return {
    program: { ...p, overrides, updatedAt: Date.now() },
    movedTo: target,
    message: `Moved ${t.name} to ${formatDate(target)}.${adjacent ? ' It’s next to another hard session, so keep the effort a little lower.' : ''}`,
  };
}

function finishSkip(p: Program, origin: ISODate, templateId: ID, message: string) {
  const overrides = p.overrides.filter((o) => !(o.date === origin && o.templateId === templateId));
  overrides.push({ date: origin, templateId, status: 'skipped' });
  return { program: { ...p, overrides, updatedAt: Date.now() }, movedTo: null, message };
}

export function skipPlanned(p: Program, date: ISODate, templateId: ID): Program {
  const origin = originalKey(p, date, templateId);
  const overrides = p.overrides.filter((o) => !(o.date === origin && o.templateId === templateId));
  overrides.push({ date: origin, templateId, status: 'skipped' });
  return { ...p, overrides, updatedAt: Date.now() };
}

/** Undo a skip or move. */
export function clearOverride(p: Program, date: ISODate, templateId: ID): Program {
  const origin = originalKey(p, date, templateId);
  return { ...p, overrides: p.overrides.filter((o) => !(o.date === origin && o.templateId === templateId)), updatedAt: Date.now() };
}

/**
 * Planned vs completed LIFTING sessions up to today (other activities are matched against
 * activity logs, which this function doesn't receive). Today's not-yet-done session and
 * moved originals are not counted; skipped sessions count as planned but not completed.
 */
export function adherence(p: Program, from: ISODate, to: ISODate, today: ISODate, sessions: WorkoutSession[]): { planned: number; completed: number } {
  const end = to < today ? to : today;
  if (end < from) return { planned: 0, completed: 0 };
  const items = plannedSessionsInRange(p, from, end, today, sessions).filter((i) => i.template.kind === 'lifting' && i.status !== 'moved');
  const counted = items.filter((i) => !(i.status === 'today'));
  return { planned: counted.length, completed: counted.filter((i) => i.status === 'done').length };
}

/* ------------------------------------------------------------------ this-week plans (temporary) */

/**
 * A temporary, this-week-only schedule change (from the training assistant's "Apply to this week"). Mirrors the server's
 * WeekAdjustmentAction (supabase/functions/_shared/ai/types.ts). It is applied as date-specific overrides
 * (moved / skipped) tagged with `weekPlanId`, so it:
 *  - never changes the program's versions, content, frequency, split, inputs or rotation;
 *  - never touches completed workouts (they are separate records) and counts them toward the week's total;
 *  - only affects dates inside that week, so the next week reverts to the baseline schedule automatically;
 *  - is version-aware: a plan made for another program/version (or another week) is refused.
 */
export interface WeekPlan {
  kind: 'week_adjustment';
  id: ID;
  baseProgramId: ID;
  baseVersion: number;
  managedBy?: 'self' | 'coach' | 'ai';
  weekStart: ISODate;
  weekEnd: ISODate;
  /** Total sessions this week, including ones already completed. */
  targetSessions: number;
  completed: { date: ISODate; name: string }[];
  sessions: { templateId: ID; name: string; date: ISODate; plannedDate: ISODate }[];
  skipped: { templateId: ID; name: string; plannedDate: ISODate }[];
  adjustments: string[];
  warnings: string[];
  summary: string;
}

export type WeekPlanState = 'available' | 'applied' | 'stale' | 'expired';

export type WeekPlanResult =
  | { ok: true; program: Program; message: string; alreadyApplied?: boolean }
  | { ok: false; reason: 'stale' | 'expired' | 'week_changed'; message: string };

export const WEEK_PLAN_STALE = 'Your plan changed since this suggestion, so it wasn’t applied. Ask the training assistant again.';
export const WEEK_PLAN_EXPIRED = 'This suggestion was for another week.';
export const WEEK_PLAN_CHANGED = 'Your week changed since this suggestion (a workout was logged or the schedule moved). Ask the training assistant again.';

export function weekPlanState(p: Program | undefined, plan: WeekPlan, today: ISODate, weekStart: 0 | 1): WeekPlanState {
  if (p && p.overrides.some((o) => o.weekPlanId === plan.id)) return 'applied';
  if (startOfWeek(today, weekStart) !== plan.weekStart || today > plan.weekEnd) return 'expired';
  if (!p || p.deletedAt || p.id !== plan.baseProgramId || p.currentVersion !== plan.baseVersion) return 'stale';
  return 'available';
}

export function applyWeekPlan(
  p: Program,
  plan: WeekPlan,
  today: ISODate,
  sessions: WorkoutSession[],
  weekStart: 0 | 1,
  activities?: ActivityLog[],
): WeekPlanResult {
  const state = weekPlanState(p, plan, today, weekStart);
  if (state === 'applied') return { ok: true, program: p, message: 'Already applied to this week.', alreadyApplied: true };
  if (state === 'expired') return { ok: false, reason: 'expired', message: WEEK_PLAN_EXPIRED };
  if (state === 'stale') return { ok: false, reason: 'stale', message: WEEK_PLAN_STALE };

  const from = plan.weekStart;
  const to = addDays(from, 6);
  const changed = { ok: false as const, reason: 'week_changed' as const, message: WEEK_PLAN_CHANGED };
  const done = sessions.filter((s) => !s.deletedAt && s.status === 'completed' && hasCompletedWork(s) && s.date >= from && s.date <= to);
  if (done.length + plan.sessions.length > plan.targetSessions) return changed;
  const doneDates = new Set(done.map((s) => s.date));

  const items = plannedSessionsInRange(p, from, to, today, sessions, activities);
  const pool = items.filter((i) => i.status === 'planned' || i.status === 'today' || i.status === 'missed');
  const used = new Set<PlannedSession>();
  const dates = new Set<ISODate>();
  const moves: { item: PlannedSession; date: ISODate }[] = [];
  for (const c of [...plan.sessions].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (c.date < today || c.date > to || dates.has(c.date) || doneDates.has(c.date)) return changed;
    dates.add(c.date);
    const candidates = pool.filter((i) => i.template.id === c.templateId && !used.has(i));
    const item = candidates.find((i) => i.date === c.plannedDate) ?? candidates[0];
    if (!item) return changed;
    used.add(item);
    moves.push({ item, date: c.date });
  }

  let overrides = [...p.overrides];
  const put = (o: PlanOverride) => {
    overrides = overrides.filter((x) => !(x.date === o.date && x.templateId === o.templateId));
    overrides.push(o);
  };
  for (const { item, date } of moves) {
    if (item.date === date) continue; // stays where it is
    put({ date: originalKey(p, item.date, item.template.id), templateId: item.template.id, status: 'moved', movedTo: date, weekPlanId: plan.id });
  }
  for (const item of pool) {
    if (used.has(item)) continue;
    put({ date: originalKey(p, item.date, item.template.id), templateId: item.template.id, status: 'skipped', weekPlanId: plan.id });
  }
  const names = moves.map((m) => `${m.item.template.name} ${formatDate(m.date, { weekday: 'short' })}`);
  return {
    ok: true,
    program: { ...p, overrides, updatedAt: Date.now() },
    message: `${names.length ? `This week: ${names.join(', ')}.` : 'No more sessions this week.'} Your usual schedule returns next week.`,
  };
}

/** Undo an applied this-week plan (its overrides only; manual skips/moves stay). */
export function revertWeekPlan(p: Program, planId: ID): Program {
  if (!p.overrides.some((o) => o.weekPlanId === planId)) return p;
  return { ...p, overrides: p.overrides.filter((o) => o.weekPlanId !== planId), updatedAt: Date.now() };
}
