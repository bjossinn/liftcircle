/**
 * Live-workout context and today-only session adjustments (roadmap item 7). Pure: no Deno, npm or app imports, so the
 * app (src/features/coaching/ai/workoutContext.ts, src/domain/sessionAdjust.ts) and the ai-coach function share it.
 *
 * Flow: a contextual entry point in the workout logger ("Short on time", "Equipment busy", "Explain this") or on the
 * workout summary opens the Coach with a compact snapshot of the workout attached to the message (`workout` in the
 * send body). The server treats it as untrusted DATA (parseWorkoutContext clamps and drops anything malformed), shows it
 * to the model inside <user_data>, and may answer with a `session_adjustment` action: swap one exercise or shorten the
 * remaining sets for TODAY ONLY. The app previews it and, only when the user taps Apply, changes the live session on
 * the device. The saved plan (program template) is never touched; Undo restores what was removed.
 */

export type WorkoutIntent = 'shorten' | 'swap' | 'explain';
export const WORKOUT_INTENTS: readonly WorkoutIntent[] = ['shorten', 'swap', 'explain'];

export interface WorkoutContextSet {
  /** 'warmup' | 'normal' | 'drop' | 'timed' … (anything else reads as 'normal'). */
  type: string;
  done: boolean;
  weightKg?: number | null;
  reps?: number | null;
  durationSec?: number | null;
}

export interface WorkoutContextTarget {
  sets: number;
  repMin: number;
  repMax: number;
  targetRir?: number;
  restSec: number;
  durationSec?: number;
}

export interface WorkoutContextExercise {
  /** The session exercise id (unique within the workout). */
  id: string;
  /** Catalog (or custom) exercise id. */
  exerciseId: string;
  name: string;
  sets: WorkoutContextSet[];
  target?: WorkoutContextTarget;
  /** From the plan slot: 1 main, 2 secondary, 3 accessory (accessories are trimmed first). */
  priority?: 1 | 2 | 3;
  discomfort?: boolean;
}

export interface WorkoutContext {
  sessionId: string;
  status: 'active' | 'completed';
  name: string;
  date: string;
  /** Minutes since the workout started (pauses excluded). */
  elapsedMin: number;
  intent: WorkoutIntent;
  /** shorten: how many minutes the user has left. */
  minutesLeft?: number;
  /** swap / explain: the session exercise the question is about. */
  focusId?: string;
  /** explain: the recommendation the app showed, in the app's own words (e.g. "Add weight → 62.5 kg × 8"). */
  shownTarget?: string;
  exercises: WorkoutContextExercise[];
}

/** A today-only change to the live workout, offered as a card ("Apply to today's workout"). */
export interface SessionAdjustmentAction {
  kind: 'session_adjustment';
  /** = the user message id of the exchange (stable: applying twice is a no-op). */
  id: string;
  sessionId: string;
  change: 'shorten' | 'swap';
  /** shorten: the user's time budget and the estimate for what is left after the change. */
  minutes?: number;
  estimatedMinutes?: number;
  swap?: { sessionExerciseId: string; fromExerciseId: string; fromName: string; toExerciseId: string; toName: string };
  /** Pending working sets removed from the END of an exercise (completed sets are never touched). */
  removeSets: { sessionExerciseId: string; name: string; count: number }[];
  /** Exercises removed for today (only ones with no completed set). */
  dropExercises: { sessionExerciseId: string; name: string }[];
  summary: string;
  warnings: string[];
}

export const WORKOUT_LIMITS = { exercises: 20, sets: 15, name: 80, shownTarget: 160, minMinutes: 5, maxMinutes: 180 } as const;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const num = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined);
const id = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z0-9:_.-]{1,100}$/.test(v) ? v : '');
const optNum = (v: unknown, min: number, max: number): number | null | undefined => (v === null ? null : num(v, min, max));

/** Defensive parse of a client-sent workout snapshot: unknown fields are dropped, sizes and numbers clamped. */
export function parseWorkoutContext(raw: unknown): WorkoutContext | null {
  const o = obj(raw);
  if (!o) return null;
  const sessionId = id(o.sessionId);
  const intent = WORKOUT_INTENTS.includes(o.intent as WorkoutIntent) ? (o.intent as WorkoutIntent) : null;
  if (!sessionId || !intent || !Array.isArray(o.exercises)) return null;
  const exercises: WorkoutContextExercise[] = [];
  for (const r of o.exercises.slice(0, WORKOUT_LIMITS.exercises)) {
    const e = obj(r);
    if (!e || !id(e.id) || !id(e.exerciseId)) continue;
    const t = obj(e.target);
    const target: WorkoutContextTarget | undefined = t && num(t.sets, 1, 20) != null
      ? {
          sets: Math.round(num(t.sets, 1, 20)!),
          repMin: Math.round(num(t.repMin, 0, 100) ?? 0),
          repMax: Math.round(num(t.repMax, 0, 100) ?? 0),
          ...(num(t.targetRir, 0, 10) != null ? { targetRir: num(t.targetRir, 0, 10) } : {}),
          restSec: Math.round(num(t.restSec, 0, 900) ?? 90),
          ...(num(t.durationSec, 1, 7200) != null ? { durationSec: Math.round(num(t.durationSec, 1, 7200)!) } : {}),
        }
      : undefined;
    const sets = (Array.isArray(e.sets) ? e.sets : []).slice(0, WORKOUT_LIMITS.sets).map((x): WorkoutContextSet => {
      const s = obj(x) ?? {};
      return {
        type: ['warmup', 'normal', 'drop', 'timed', 'failure'].includes(s.type as string) ? (s.type as string) : 'normal',
        done: s.done === true,
        ...(optNum(s.weightKg, -500, 1000) !== undefined ? { weightKg: optNum(s.weightKg, -500, 1000) } : {}),
        ...(optNum(s.reps, 0, 1000) !== undefined ? { reps: optNum(s.reps, 0, 1000) } : {}),
        ...(optNum(s.durationSec, 0, 36000) !== undefined ? { durationSec: optNum(s.durationSec, 0, 36000) } : {}),
      };
    });
    exercises.push({
      id: id(e.id),
      exerciseId: id(e.exerciseId),
      name: str(e.name, WORKOUT_LIMITS.name) || 'Exercise',
      sets,
      ...(target ? { target } : {}),
      ...(e.priority === 1 || e.priority === 2 || e.priority === 3 ? { priority: e.priority } : {}),
      ...(e.discomfort === true ? { discomfort: true } : {}),
    });
  }
  const minutesLeft = num(o.minutesLeft, WORKOUT_LIMITS.minMinutes, WORKOUT_LIMITS.maxMinutes);
  const focusId = id(o.focusId);
  const shownTarget = str(o.shownTarget, WORKOUT_LIMITS.shownTarget);
  return {
    sessionId,
    status: o.status === 'completed' ? 'completed' : 'active',
    name: str(o.name, WORKOUT_LIMITS.name) || 'Workout',
    date: typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : '',
    elapsedMin: Math.round(num(o.elapsedMin, 0, 24 * 60) ?? 0),
    intent,
    ...(minutesLeft != null ? { minutesLeft: Math.round(minutesLeft) } : {}),
    ...(focusId && exercises.some((e) => e.id === focusId) ? { focusId } : {}),
    ...(shownTarget ? { shownTarget } : {}),
    exercises,
  };
}

/* ------------------------------------------------------------------ time estimate */
const isWorking = (s: WorkoutContextSet) => s.type !== 'warmup';
/** Seconds for one working set: the work itself plus the prescribed rest after it (generator.ts-style estimate). */
export function setSeconds(t: WorkoutContextTarget | undefined): number {
  const work = t?.durationSec ? t.durationSec + 10 : (((t?.repMin ?? 8) + (t?.repMax ?? 12)) / 2) * 4 + 10;
  return Math.round(work + (t?.restSec ?? 90));
}
/** Moving to a new exercise (set-up, a ramp-up set). */
export const EXERCISE_SETUP_SEC = 90;

export function pendingWorking(e: WorkoutContextExercise): number {
  return e.sets.filter((s) => !s.done && isWorking(s)).length;
}

/** Rough minutes for everything still to do. */
export function remainingMinutes(ctx: WorkoutContext): number {
  let sec = 0;
  for (const e of ctx.exercises) {
    const n = pendingWorking(e);
    if (!n) continue;
    if (!e.sets.some((s) => s.done)) sec += EXERCISE_SETUP_SEC;
    sec += n * setSeconds(e.target);
  }
  return Math.ceil(sec / 60);
}

/**
 * Fit what is left of today's workout into `minutes`. Main and secondary lifts (and exercises without a plan priority)
 * share the time first, round-robin in priority then session order, so each keeps sets for as long as time allows;
 * accessories only get time that's left after that, so they are the first to go. Completed sets are never touched.
 */
export function planShorten(ctx: WorkoutContext, minutes: number): { removeSets: SessionAdjustmentAction['removeSets']; dropExercises: SessionAdjustmentAction['dropExercises']; estimatedMinutes: number; fits: boolean } {
  const budget = Math.max(0, minutes) * 60;
  const items = ctx.exercises
    .map((e, order) => ({ e, order, pending: pendingWorking(e), kept: 0, started: e.sets.some((s) => s.done), cost: setSeconds(e.target) }))
    .filter((x) => x.pending > 0)
    .sort((a, b) => (a.e.priority ?? 2) - (b.e.priority ?? 2) || a.order - b.order);
  let used = 0;
  // Main and secondary lifts share the time first (round-robin, so each keeps some sets); accessories get what's left.
  const tiers = [items.filter((x) => (x.e.priority ?? 2) < 3), items.filter((x) => x.e.priority === 3)];
  for (const tier of tiers) {
    for (let progress = true; progress; ) {
      progress = false;
      for (const x of tier) {
        if (x.kept >= x.pending) continue;
        const add = x.cost + (x.kept === 0 && !x.started ? EXERCISE_SETUP_SEC : 0);
        if (used + add > budget) continue;
        used += add;
        x.kept++;
        progress = true;
      }
    }
  }
  const removeSets: SessionAdjustmentAction['removeSets'] = [];
  const dropExercises: SessionAdjustmentAction['dropExercises'] = [];
  for (const x of [...items].sort((a, b) => a.order - b.order)) {
    if (x.kept >= x.pending) continue;
    if (x.kept === 0 && !x.started) dropExercises.push({ sessionExerciseId: x.e.id, name: x.e.name });
    else removeSets.push({ sessionExerciseId: x.e.id, name: x.e.name, count: x.pending - x.kept });
  }
  return { removeSets, dropExercises, estimatedMinutes: Math.ceil(used / 60), fits: removeSets.length === 0 && dropExercises.length === 0 };
}

/* ------------------------------------------------------------------ prompt */
const fmtKg = (kg: number, unit: 'kg' | 'lb') => (unit === 'lb' ? `${Math.round((kg / 0.45359237) * 10) / 10} lb` : `${Math.round(kg * 100) / 100} kg`);

function setText(s: WorkoutContextSet, unit: 'kg' | 'lb'): string {
  const parts: string[] = [];
  if (s.weightKg != null) parts.push(fmtKg(s.weightKg, unit));
  if (s.reps != null) parts.push(`${s.reps} reps`);
  if (s.durationSec != null) parts.push(`${s.durationSec} s`);
  return `${s.type === 'warmup' ? 'warm-up ' : ''}${parts.join(' × ') || 'not filled in'}`;
}

/** The workout as lines for the <user_data kind="workout"> section (names already neutralized by the caller). */
export function workoutLines(ctx: WorkoutContext, unit: 'kg' | 'lb', clean: (s: string) => string = (s) => s): string[] {
  const head =
    ctx.status === 'completed'
      ? `Workout just finished: ${clean(ctx.name)}${ctx.date ? ` (${ctx.date})` : ''}, ${ctx.elapsedMin} min.`
      : `Workout in progress right now: ${clean(ctx.name)}${ctx.date ? ` (${ctx.date})` : ''}, started ${ctx.elapsedMin} min ago. About ${remainingMinutes(ctx)} min of work is left as planned.`;
  const lines = [head, 'Exercises in order ([session exercise id] name (exercise id): target; logged sets):'];
  for (const e of ctx.exercises) {
    const t = e.target;
    const target = t
      ? `${t.sets} × ${t.durationSec ? `${t.durationSec} s` : t.repMin === t.repMax ? t.repMin : `${t.repMin}–${t.repMax}`}${t.targetRir != null ? `, ${t.targetRir} RIR` : ''}, rest ${t.restSec} s`
      : 'free logging';
    const done = e.sets.filter((s) => s.done);
    const working = e.sets.filter(isWorking).length;
    const doneWorking = done.filter(isWorking).length;
    const pr = e.priority === 1 ? ', main lift' : e.priority === 3 ? ', accessory' : '';
    lines.push(
      `- [${e.id}] ${clean(e.name)} (${e.exerciseId}): ${target}${pr}; ${doneWorking} of ${working} working sets done${done.length ? ` (${done.map((s) => setText(s, unit)).join(', ')})` : ''}${e.discomfort ? '; discomfort flagged' : ''}`,
    );
  }
  if (ctx.intent === 'shorten' && ctx.minutesLeft) lines.push(`The user has about ${ctx.minutesLeft} minutes left.`);
  const focus = ctx.focusId ? ctx.exercises.find((e) => e.id === ctx.focusId) : undefined;
  if (focus) lines.push(`The question is about: [${focus.id}] ${clean(focus.name)}.`);
  if (ctx.shownTarget) lines.push(`The app showed this recommendation: ${clean(ctx.shownTarget)}`);
  return lines;
}

/** What the model should do for this kind of contextual request (outside <user_data>; built from enums only). */
export function workoutInstruction(ctx: WorkoutContext): string {
  const where = ctx.status === 'completed' ? 'their workout summary' : 'the workout screen, mid-workout';
  const base = `The newest message was sent from ${where}, with a snapshot of that workout attached (<user_data kind="workout">). Use it: you know which exercises are done, what is left and the targets. Changes you suggest are for TODAY'S WORKOUT ONLY: the saved plan, its templates and future sessions never change.`;
  if (ctx.intent === 'shorten') {
    return `${base} The user is short on time${ctx.minutesLeft ? ` (about ${ctx.minutesLeft} minutes left)` : ''}. Call propose_session_adjustment with change "shorten"${ctx.minutesLeft ? ` and minutes ${ctx.minutesLeft}` : ''}: the server keeps the main lifts and trims accessories and later sets to fit. Short on time is a normal reason in every coach style: be practical, never guilt. Then reply in one or two short lines; the card lists the changes ("Apply to today's workout").`;
  }
  if (ctx.intent === 'swap') {
    return `${base} The equipment for the exercise in question is busy. Call exercise_alternatives for its exercise id, pick the best alternative that trains the same thing, then call propose_session_adjustment with change "swap", session_exercise_id and to_exercise_id. Reply in one or two short lines naming the swap; the card shows it ("Apply to today's workout").`;
  }
  return `${base} The user asked to explain a recommendation. Explain in plain words why the app suggests it, using the "Next targets" lines and the logged sets (effort, reps against the target range, discomfort). Quote the app's numbers exactly; never invent a different next weight. Don't change anything and don't call propose_session_adjustment.`;
}

/** One-line description of a session adjustment (fallback reply text and summaries). */
export function describeSessionAdjustment(a: Pick<SessionAdjustmentAction, 'change' | 'swap' | 'removeSets' | 'dropExercises' | 'minutes' | 'estimatedMinutes'>, lang: 'en' | 'is' = 'en'): string {
  if (a.change === 'swap' && a.swap) {
    return lang === 'is'
      ? `Í dag: ${a.swap.toName} í stað ${a.swap.fromName}. Ýttu á „Apply to today's workout“ til að breyta æfingunni í dag. Planið breytist ekki.`
      : `For today: ${a.swap.toName} instead of ${a.swap.fromName}. Tap Apply to today's workout to make the swap. Your plan stays the same.`;
  }
  const sets = a.removeSets.reduce((n, r) => n + r.count, 0);
  const bits: string[] = [];
  if (a.dropExercises.length) bits.push(lang === 'is' ? `sleppa ${a.dropExercises.map((d) => d.name).join(', ')}` : `skip ${a.dropExercises.map((d) => d.name).join(', ')}`);
  if (sets) bits.push(lang === 'is' ? `${sets} færri sett` : `${sets} fewer set${sets === 1 ? '' : 's'}`);
  const est = a.estimatedMinutes != null ? (lang === 'is' ? ` (um ${a.estimatedMinutes} mín. eftir)` : ` (about ${a.estimatedMinutes} min left)`) : '';
  return lang === 'is'
    ? `Styttri æfing í dag: ${bits.join(' og ') || 'engar breytingar'}${est}. Ýttu á „Apply to today's workout“. Planið breytist ekki.`
    : `A shorter workout for today: ${bits.join(' and ') || 'no changes'}${est}. Tap Apply to today's workout to use it. Your plan stays the same.`;
}
