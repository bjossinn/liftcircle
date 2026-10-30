/**
 * "This week" for the AI coach (pure): which planned sessions of the active plan fall in the user's current
 * week, which are done / left / skipped / moved, which workouts were completed, and which dates are still free.
 * It mirrors the app's scheduler (src/domain/program/schedule.ts plannedSessionsInRange) closely enough for
 * coaching: weekday slots of the current version from the plan's start date, date-specific overrides
 * (skipped / moved), and completed workouts matched by template (exact planned date, same day, or ≤ 2 days late).
 *
 * Also validates the `propose_week_adjustment` tool input into a WeekAdjustmentAction — a temporary,
 * this-week-only schedule change. It never touches the plan's content, frequency, split or version.
 */
import type { SessionPayload, UserFacts, WeekAdjustmentAction } from './types.ts';

// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { datePair, shortDate } from './humanDates.ts';
export const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LATE_WINDOW_DAYS = 2;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const dayLabel = (date: string) => `${DAY[weekdayOf(date)]} ${date}`;

export function weekBounds(today: string, weekStart: 0 | 1): { start: string; end: string } {
  const back = (weekdayOf(today) - weekStart + 7) % 7;
  const start = addDays(today, -back);
  return { start, end: addDays(start, 6) };
}

export type WeekItemStatus = 'done' | 'today' | 'upcoming' | 'missed' | 'skipped' | 'moved';
export interface WeekItem {
  date: string;
  templateId: string;
  name: string;
  kind: string;
  status: WeekItemStatus;
  movedTo?: string;
  movedFrom?: string;
  doneOn?: string;
}
export interface WeekState {
  start: string;
  end: string;
  today: string;
  items: WeekItem[];
  /** Every completed workout this week (plan or not) — these count toward "how many this week". */
  completed: { date: string; name: string; templateId?: string; fromPlan: boolean }[];
  /** Planned sessions not done yet and not skipped/moved away (today, upcoming, or missed earlier this week). */
  remaining: WeekItem[];
  /** Dates from today to the end of the week with no completed workout and no remaining planned session. */
  freeDates: string[];
}

export function computeWeekState(
  ap: UserFacts['activeProgram'],
  sessions: SessionPayload[],
  today: string,
  weekStart: 0 | 1,
): WeekState {
  const { start, end } = weekBounds(today, weekStart);
  const inWeek = (d: unknown): d is string => typeof d === 'string' && d >= start && d <= end;
  const completedRaw = sessions.filter((s) => s.status === 'completed' && inWeek(s.date) && s.date! <= today);
  const items: WeekItem[] = [];
  const v = ap?.version;
  if (ap && v) {
    const templates = new Map((v.templates ?? []).filter((t) => typeof t.id === 'string').map((t) => [t.id as string, t]));
    const overrides = ap.overrides ?? [];
    const from = ap.startDate && ap.startDate > start ? ap.startDate : start;
    const ov = (date: string, templateId: string) => overrides.find((o) => o.date === date && o.templateId === templateId);
    for (let d = from; d <= end; d = addDays(d, 1)) {
      for (const slot of v.schedule ?? []) {
        if (slot.weekday !== weekdayOf(d) || typeof slot.templateId !== 'string') continue;
        const t = templates.get(slot.templateId);
        if (!t) continue;
        const o = ov(d, slot.templateId);
        const base: WeekItem = { date: d, templateId: slot.templateId, name: t.name ?? 'Session', kind: t.kind ?? 'lifting', status: 'upcoming' };
        if (o?.status === 'skipped') base.status = 'skipped';
        else if (o?.status === 'moved') {
          base.status = 'moved';
          if (typeof o.movedTo === 'string') base.movedTo = o.movedTo;
        }
        items.push(base);
      }
    }
    for (const o of overrides) {
      if (o.status !== 'moved' || !inWeek(o.movedTo) || typeof o.templateId !== 'string') continue;
      const t = templates.get(o.templateId);
      if (!t) continue;
      items.push({ date: o.movedTo, templateId: o.templateId, name: t.name ?? 'Session', kind: t.kind ?? 'lifting', status: 'upcoming', ...(o.date ? { movedFrom: o.date } : {}) });
    }
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // Match completed workouts to planned items (exact planned date → same day → up to 2 days late).
    const mine = completedRaw.filter((s) => !s.programId || s.programId === ap.id);
    const claimed = new Set<SessionPayload>();
    const open = (it: WeekItem) => it.status === 'upcoming';
    const claim = (it: WeekItem, s: SessionPayload | undefined) => {
      if (!s) return;
      claimed.add(s);
      it.status = 'done';
      it.doneOn = s.date;
    };
    for (const it of items.filter(open)) {
      claim(it, mine.find((s) => !claimed.has(s) && s.templateId === it.templateId && s.plannedDate === it.date) ??
        mine.find((s) => !claimed.has(s) && s.templateId === it.templateId && !s.plannedDate && s.date === it.date));
    }
    for (const it of items.filter(open)) {
      const late = addDays(it.date, LATE_WINDOW_DAYS);
      claim(it, mine.find((s) => !claimed.has(s) && s.templateId === it.templateId && !s.plannedDate && s.date! > it.date && s.date! <= late));
    }
    for (const it of items.filter(open)) it.status = it.date === today ? 'today' : it.date < today ? 'missed' : 'upcoming';
  }
  const doneIds = new Set(items.filter((i) => i.status === 'done').map((i) => `${i.templateId}|${i.doneOn}`));
  const completed = completedRaw
    .map((s) => ({ date: s.date!, name: typeof s.name === 'string' && s.name ? s.name.slice(0, 80) : 'Workout', ...(s.templateId ? { templateId: s.templateId } : {}), fromPlan: doneIds.has(`${s.templateId}|${s.date}`) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const remaining = items.filter((i) => i.status === 'today' || i.status === 'upcoming' || i.status === 'missed');
  const busy = new Set([...completed.map((c) => c.date), ...remaining.filter((r) => r.status !== 'missed').map((r) => r.date)]);
  const freeDates: string[] = [];
  for (let d = today; d <= end; d = addDays(d, 1)) if (!busy.has(d)) freeDates.push(d);
  return { start, end, today, items, completed, remaining, freeDates };
}

/** Lines for the prompt (names are neutralized by the caller's `clean`). */
export function weekLines(w: WeekState, clean: (s: string) => string, opts: { hasPlan: boolean }): string[] {
  const lines = [`This week: ${dayLabel(w.start)} to ${dayLabel(w.end)}; today is ${dayLabel(w.today)}.`];
  if (opts.hasPlan) {
    const st: Record<WeekItemStatus, string> = { done: 'done', today: 'planned today, not done yet', upcoming: 'upcoming', missed: 'missed (not done)', skipped: 'skipped', moved: 'moved' };
    lines.push(
      `Plan this week: ${w.items.map((i) => `${dayLabel(i.date)} ${clean(i.name)} [${clean(i.templateId)}] — ${st[i.status]}${i.movedTo ? ` to ${i.movedTo}` : ''}${i.movedFrom ? ` (moved from ${i.movedFrom})` : ''}${i.status === 'done' && i.doneOn && i.doneOn !== i.date ? ` on ${i.doneOn}` : ''}`).join('; ') || 'no sessions scheduled this week'}.`,
    );
  }
  lines.push(
    w.completed.length
      ? `Completed workouts this week (these count toward any limit for this week): ${w.completed.length} — ${w.completed.map((c) => `${dayLabel(c.date)} "${clean(c.name)}"${c.fromPlan ? '' : ' (not matched to a planned session)'}`).join('; ')}.`
      : 'Completed workouts this week: none yet.',
  );
  if (opts.hasPlan) {
    lines.push(
      w.remaining.length
        ? `Planned sessions still left this week: ${w.remaining.map((r) => `${clean(r.name)} [${clean(r.templateId)}] (planned ${dayLabel(r.date)}${r.status === 'missed' ? ', missed' : ''})`).join('; ')}.`
        : 'Planned sessions still left this week: none.',
    );
  }
  lines.push(`Free dates left this week (no workout done or planned): ${w.freeDates.map(dayLabel).join(', ') || 'none'}.`);
  return lines;
}

/* ------------------------------------------------------------------ propose_week_adjustment */
export interface WeekToolContext {
  facts: UserFacts;
  week: WeekState | null;
  trainingShared: boolean;
  messageId: string;
}

const strList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, maxLen)).filter(Boolean).slice(0, maxItems);

export function validateWeekAdjustment(raw: Record<string, unknown>, ctx: WeekToolContext): { action: WeekAdjustmentAction | null; errors: string[] } {
  const ap = ctx.facts.activeProgram;
  const w = ctx.week;
  if (!ctx.trainingShared) return { action: null, errors: ['Training data is not shared, so this week cannot be planned. Answer in text and suggest sharing Training in AI coach settings.'] };
  if (!ap || !ap.version || !w) return { action: null, errors: ['The user has no active plan to adjust.'] };
  const errors: string[] = [];
  const target = typeof raw.total_sessions_this_week === 'number' ? raw.total_sessions_this_week : Number(raw.total_sessions_this_week);
  if (!(Number.isInteger(target) && target >= 0 && target <= 7)) errors.push('total_sessions_this_week must be a whole number 0–7.');
  const done = w.completed.length;
  if (Number.isInteger(target) && target < done)
    errors.push(`The user already completed ${done} workout${done === 1 ? '' : 's'} this week; total_sessions_this_week counts those, so it must be at least ${done}.`);

  const picks = (Array.isArray(raw.sessions) ? raw.sessions : []).slice(0, 7).map((x) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    return { templateId: typeof (o.template_id ?? o.templateId) === 'string' ? String(o.template_id ?? o.templateId).slice(0, 100) : '', date: typeof o.date === 'string' ? o.date.trim() : '' };
  });
  if (Number.isInteger(target) && target >= done && picks.length !== target - done)
    errors.push(`sessions must list exactly ${target - done} remaining session${target - done === 1 ? '' : 's'} (${target} this week minus ${done} already completed).`);

  const firstDay = w.today > w.start ? w.today : w.start;
  const completedDates = new Set(w.completed.map((c) => c.date));
  const used = new Set<WeekItem>();
  const dates = new Set<string>();
  const chosen: WeekAdjustmentAction['sessions'] = [];
  for (const p of [...picks].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (!DATE_RE.test(p.date) || p.date < firstDay || p.date > w.end) {
      errors.push(`Date "${p.date.slice(0, 20)}" must be between ${firstDay} and ${w.end} (today or later, this week only).`);
      continue;
    }
    if (dates.has(p.date)) errors.push(`Two sessions on ${p.date}; use one session per day.`);
    dates.add(p.date);
    if (completedDates.has(p.date)) errors.push(`The user already trained on ${p.date}; pick another day.`);
    const pool = w.remaining.filter((r) => r.templateId === p.templateId && !used.has(r));
    const item = pool.find((r) => r.date === p.date) ?? pool[0];
    if (!item) {
      const left = w.remaining.map((r) => `${r.name} [${r.templateId}]`).join(', ') || 'none';
      errors.push(`"${p.templateId}" is not a planned session left this week. Choose from: ${left}.`);
      continue;
    }
    used.add(item);
    chosen.push({ templateId: item.templateId, name: item.name, date: p.date, plannedDate: item.date });
  }
  if (errors.length) return { action: null, errors: [...new Set(errors)].slice(0, 12) };

  const warnings: string[] = [];
  const avail = new Set(ap.availableWeekdays);
  for (const c of chosen) if (avail.size && !avail.has(weekdayOf(c.date))) warnings.push(`${shortDate(c.date)} is not one of your usual training days.`);
  const hardDates = [...chosen.map((c) => c.date), ...w.completed.map((c) => c.date)].sort();
  for (let i = 1; i < hardDates.length; i++) if (addDays(hardDates[i - 1], 1) === hardDates[i]) {
    warnings.push(`Back-to-back days (${datePair(hardDates[i - 1], hardDates[i])}): keep the effort a little lower on the second.`);
    break;
  }
  const action: WeekAdjustmentAction = {
    kind: 'week_adjustment',
    id: ctx.messageId,
    baseProgramId: ap.id,
    baseVersion: ap.currentVersion,
    managedBy: ap.managedBy,
    weekStart: w.start,
    weekEnd: w.end,
    targetSessions: target,
    completed: w.completed.map((c) => ({ date: c.date, name: c.name })),
    sessions: chosen,
    skipped: w.remaining.filter((r) => !used.has(r)).map((r) => ({ templateId: r.templateId, name: r.name, plannedDate: r.date })),
    adjustments: strList(raw.adjustments, 4, 200),
    warnings,
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 300) : '',
  };
  return { action, errors: [] };
}
