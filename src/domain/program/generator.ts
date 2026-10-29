/**
 * Deterministic, explainable training-program generator.
 *
 * Same answers + catalog + variant → identical ProgramVersion (no clocks, no randomness).
 * Exercises are selected from catalog metadata (pattern, equipment, difficulty, mainLift, stresses,
 * category); preferred ids in templates.ts are only tie-breakers.
 */
import type {
  ActivityType, Equipment, Exercise, Experience, Goal, ID, ISODate, LimitationArea, MovementPattern, OnboardingAnswers,
  Prescription, ProgramVersion, ScheduleSlot, SessionTemplate,
} from '@/domain/types';
import { toUTCms, WEEKDAY_SHORT } from '@/lib/dates';
import {
  CONDITIONING_PREFER, COVERAGE_GROUPS, MAJOR_MUSCLES, MOBILITY_PREFER, SPLITS, type DayDef, type Priority, type SlotDef, type SplitDef,
  type SplitKey,
} from './templates';
import * as X from './explain';
import { effectiveLiftingDays, resolveSplit, splitFamily, type SplitResolution } from './splits';

export const ALL_EQUIPMENT: Equipment[] = [
  'barbell', 'rack', 'bench', 'dumbbell', 'kettlebell', 'machine', 'cable', 'band', 'bodyweight', 'pullup_bar', 'dip_station', 'ez_bar', 'smith',
  'cardio_machine',
];
/** Monday-first weekday order used for deterministic scheduling. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const ENDURANCE_TYPES: ActivityType[] = ['run', 'cycle', 'swim', 'row', 'hike', 'walk'];
const CARDIO_TYPES: ActivityType[] = ['run', 'cycle', 'swim', 'row', 'hike', 'sport', 'class'];
const MOBILITY_TYPES: ActivityType[] = ['yoga', 'mobility', 'stretch'];
export const ACTIVITY_NAMES: Record<ActivityType, string> = {
  walk: 'Walk', run: 'Run', cycle: 'Ride', hike: 'Hike', swim: 'Swim', row: 'Row', sport: 'Sport', class: 'Fitness class', yoga: 'Yoga',
  mobility: 'Mobility', stretch: 'Stretching', custom: 'Activity',
};

/* ================================================================ context */
interface Ctx {
  a: OnboardingAnswers;
  catalog: Exercise[];
  byId: Map<ID, Exercise>;
  equipment: Set<Equipment>;
  excluded: Set<ID>;
  limits: Set<LimitationArea>;
  enjoyed: Set<ID>;
  experience: Experience;
  beginner: boolean;
  goal: Goal;
  budget: number;
}

export function availableEquipment(a: Pick<OnboardingAnswers, 'equipment' | 'location'>): Set<Equipment> {
  const base = a.equipment.length ? a.equipment : a.location === 'full_gym' ? ALL_EQUIPMENT : [];
  return new Set<Equipment>([...base, 'bodyweight']);
}

function makeCtx(a: OnboardingAnswers, catalog: Exercise[]): Ctx {
  const sorted = [...catalog].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return {
    a,
    catalog: sorted,
    byId: new Map(sorted.map((e) => [e.id, e])),
    equipment: availableEquipment(a),
    excluded: new Set(a.excludedExerciseIds),
    limits: new Set(a.limitations),
    enjoyed: new Set(a.enjoyedExerciseIds),
    experience: a.experience,
    beginner: a.experience === 'new' || a.experience === 'returning',
    goal: a.goal,
    budget: clamp(Math.round(a.sessionMinutes || 45), 15, 180),
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Hard constraints: equipment, exclusions, limitations, technical difficulty for brand-new lifters. */
export function isEligible(ex: Exercise, ctx: Pick<Ctx, 'equipment' | 'excluded' | 'limits' | 'experience'>): boolean {
  if (ctx.excluded.has(ex.id)) return false;
  if (!ex.equipment.every((e) => ctx.equipment.has(e))) return false;
  if (ex.stresses.some((s) => ctx.limits.has(s))) return false;
  if (ctx.experience === 'new' && ex.difficulty >= 3) return false;
  return true;
}

export function isLoaded(ex: Exercise): boolean {
  return ex.tracking === 'weight_reps' || ex.tracking === 'assisted' || ex.tracking === 'bodyweight_plus' || (ex.tracking === 'distance_time' && ex.load !== 'none');
}
const usesBarbell = (ex?: Exercise) => !!ex && (ex.equipment.includes('barbell') || ex.equipment.includes('smith') || ex.equipment.includes('ez_bar'));

/** Ramp-up sets before working sets: 2 for barbell main lifts, 1 for other loaded main lifts. */
export function warmupSetCount(rx: Pick<Prescription, 'priority'>, ex: Exercise | undefined): number {
  if (!ex || rx.priority !== 1 || ex.tracking !== 'weight_reps') return 0;
  return usesBarbell(ex) ? 2 : 1;
}

/* ===================================================== selection & scoring */
function slotAllows(ex: Exercise, slot: SlotDef, patterns: MovementPattern[]): boolean {
  if (!patterns.includes(ex.pattern)) return false;
  const special = patterns.includes('conditioning') || patterns.includes('mobility');
  if (!special && (ex.category === 'cardio' || ex.category === 'mobility')) return false;
  if (ex.tracking === 'distance_time' && !patterns.includes('carry') && !special) return false;
  if (slot.muscles && !ex.primaryMuscles.some((m) => slot.muscles!.includes(m))) return false;
  return true;
}

function score(ex: Exercise, slot: SlotDef, ctx: Ctx, weekUsed: Set<ID>): number {
  let s = 0;
  const rank = slot.prefer.indexOf(ex.id);
  if (rank >= 0) s += 20 - 2 * rank;
  if (ctx.enjoyed.has(ex.id)) s += 8;
  if (slot.priority === 1) {
    if (ex.mainLift) s += 6;
    else s -= 4;
    if (ex.tracking === 'duration') s -= 6;
  }
  if (slot.priority === 3 && ex.mainLift && ex.category === 'compound') s -= 3;
  if (ctx.experience === 'returning' && ex.difficulty >= 3) s -= 6;
  if (ctx.experience === 'intermediate' && ex.difficulty >= 3) s -= 1;
  if (ctx.beginner && ex.difficulty === 1) s += 1;
  if (weekUsed.has(ex.id)) s -= 5;
  return s;
}

function rankCandidates(slot: SlotDef, ctx: Ctx, sessionUsed: Set<ID>, weekUsed: Set<ID>): Exercise[] {
  for (const patterns of [slot.patterns, slot.fallbackPatterns ?? []]) {
    if (!patterns.length) continue;
    const list = ctx.catalog.filter((ex) => !sessionUsed.has(ex.id) && slotAllows(ex, slot, patterns) && isEligible(ex, ctx));
    if (list.length) {
      return list
        .map((ex) => ({ ex, s: score(ex, slot, ctx, weekUsed) }))
        .sort((x, y) => y.s - x.s || (x.ex.id < y.ex.id ? -1 : 1))
        .map((x) => x.ex);
    }
  }
  return [];
}

const pickIndex = (variant: number, n: number) => (n <= 0 ? -1 : Math.abs(Math.trunc(variant)) % Math.min(3, n));

function alternativesFor(pick: Exercise, ranked: Exercise[], ctx: Ctx): ID[] {
  const out: ID[] = [];
  const add = (id: ID) => {
    if (id !== pick.id && !out.includes(id)) out.push(id);
  };
  for (const ex of ranked.slice(0, 4)) add(ex.id);
  for (const id of pick.substitutions) {
    const s = ctx.byId.get(id);
    if (s && isEligible(s, ctx)) add(id);
  }
  return out.slice(0, 5);
}

/* ============================================================ prescriptions */
interface RxShape {
  sets: number;
  repMin: number;
  repMax: number;
  rir: number;
  rest: number;
  durationSec?: number;
}

function repRange(priority: Priority, ctx: Ctx, ex: Exercise): [number, number] {
  const experienced = !ctx.beginner;
  if (ex.tracking === 'reps' || ex.tracking === 'bodyweight_plus') {
    if (ctx.goal === 'strength' && experienced && priority === 1 && ex.tracking === 'bodyweight_plus') return [4, 6];
    return priority === 3 ? [8, 15] : [6, 12];
  }
  if (ctx.goal === 'endurance') return priority === 3 ? [12, 15] : [8, 12];
  if (ctx.goal === 'strength') {
    if (priority === 1) return experienced ? (ctx.experience === 'advanced' ? [3, 5] : [4, 6]) : [5, 8];
    return priority === 2 ? (experienced ? [6, 10] : [8, 12]) : [10, 15];
  }
  if (priority === 1) return experienced ? [6, 10] : [8, 12];
  return priority === 2 ? [8, 12] : [10, 15];
}

function shape(ex: Exercise, priority: Priority, ctx: Ctx): RxShape {
  const sets = priority === 1 ? (ctx.experience === 'advanced' && ctx.goal === 'strength' ? 4 : 3) : priority === 2 ? (ctx.beginner ? 2 : 3) : ctx.experience === 'advanced' ? 3 : 2;
  const rir = ctx.beginner ? 3 : 2;
  if (ex.tracking === 'duration') {
    return { sets: Math.min(sets, 3), repMin: 1, repMax: 1, rir, rest: 60, durationSec: ctx.beginner ? 20 : 30 };
  }
  if (ex.tracking === 'distance_time') {
    return { sets: Math.min(sets, 3), repMin: 1, repMax: 1, rir, rest: 75, durationSec: ctx.beginner ? 30 : 40 };
  }
  const [repMin, repMax] = repRange(priority, ctx, ex);
  const strengthMain = ctx.goal === 'strength' && !ctx.beginner && priority === 1;
  const rest = ex.category === 'core' ? 60 : priority === 1 ? (strengthMain ? 180 : 150) : priority === 2 ? 120 : 75;
  return { sets, repMin, repMax, rir, rest };
}

function warmupText(ex: Exercise, priority: Priority, calibrate: boolean): string {
  let text: string;
  if (ex.tracking === 'duration' || ex.category === 'core') text = X.WARMUP_NONE;
  else if (priority === 1 && ex.tracking === 'weight_reps')
    text = usesBarbell(ex)
      ? 'Ramp up first: empty bar × 8–10, then about 50 % × 5 and 75 % × 3 of your working weight.'
      : 'Ramp up first: one lighter set of about 8 reps at roughly half your working weight.';
  else if (priority === 1) text = 'Ramp up with one easier set of about 5 reps before your working sets.';
  else if (priority === 2) text = X.WARMUP_SECONDARY;
  else text = X.WARMUP_ACCESSORY;
  if (calibrate)
    text += ` ${X.CALIBRATION_CUE}`;
  return text;
}

function prescribe(ex: Exercise, slot: Pick<SlotDef, 'priority' | 'key'>, ctx: Ctx, templateId: ID, alternatives: ID[]): Prescription {
  const sh = shape(ex, slot.priority, ctx);
  const known = ctx.a.knownLoads?.[ex.id];
  const hasKnown = typeof known === 'number' && isFinite(known) && known >= 0;
  const calibrate = !hasKnown && (ex.tracking === 'weight_reps' || ex.tracking === 'assisted' || (ex.tracking === 'distance_time' && ex.load !== 'none'));
  const rx: Prescription = {
    id: `${templateId}:${slot.key}`,
    exerciseId: ex.id,
    sets: sh.sets,
    repMin: sh.repMin,
    repMax: sh.repMax,
    targetRir: sh.rir,
    restSec: sh.rest,
    warmup: warmupText(ex, slot.priority, calibrate),
    priority: slot.priority,
    alternatives,
  };
  if (sh.durationSec) rx.durationSec = sh.durationSec;
  if (hasKnown) rx.startLoadKg = known;
  if (calibrate) {
    rx.calibrate = true;
    rx.notes = X.CALIBRATION_NOTE;
  } else if (ex.tracking === 'bodyweight_plus' && !hasKnown) {
    rx.notes = 'Start with bodyweight only; add load once every set reaches the top of the range.';
  }
  return rx;
}

/* ================================================================ estimate */
function setupSeconds(ex: Exercise | undefined): number {
  if (!ex) return 60;
  if (usesBarbell(ex) || ex.equipment.includes('rack')) return 120;
  if (ex.equipment.includes('machine') || ex.equipment.includes('cable') || ex.equipment.includes('cardio_machine')) return 60;
  if (ex.equipment.includes('dumbbell') || ex.equipment.includes('kettlebell') || ex.equipment.includes('band')) return 45;
  return 30;
}
function workSeconds(rx: Pick<Prescription, 'repMin' | 'repMax' | 'durationSec'>, ex: Exercise | undefined): number {
  const sides = ex?.unilateral ? 2 : 1;
  if (rx.durationSec) return rx.durationSec * sides + 10;
  const reps = (rx.repMin + rx.repMax) / 2;
  return (reps * 4 + 10) * sides;
}

/**
 * Estimated minutes for a session: general warm-up (5 min for lifting), per-exercise setup,
 * ramp-up sets, working sets and the prescribed rest between them; plus any cardio block.
 */
export function estimateSessionMinutes(t: SessionTemplate, catalog: Exercise[]): number {
  const byId = new Map(catalog.map((e) => [e.id, e]));
  return estimateWith(t, byId);
}
function estimateWith(t: Pick<SessionTemplate, 'kind' | 'exercises' | 'cardio'>, byId: Map<ID, Exercise>): number {
  let sec = 0;
  if (t.exercises.length) sec += t.kind === 'lifting' ? 300 : t.kind === 'conditioning' ? 240 : 60;
  for (const rx of t.exercises) {
    const ex = byId.get(rx.exerciseId);
    const sets = Math.max(0, rx.sets);
    sec += setupSeconds(ex);
    sec += warmupSetCount(rx, ex) * 100;
    sec += sets * workSeconds(rx, ex) + Math.max(0, sets - 1) * rx.restSec;
  }
  if (t.cardio) sec += t.cardio.minutes * 60;
  return Math.ceil(sec / 60);
}

/** Trim to the time budget: priority-3 accessories first (isolation before trunk), then sets, then priority-2. */
function fitToBudget(t: SessionTemplate, budget: number, byId: Map<ID, Exercise>): SessionTemplate {
  let exercises = t.exercises.map((e) => ({ ...e }));
  const trimmed: ID[] = [];
  const est = () => estimateWith({ ...t, exercises }, byId);
  const isTrunk = (rx: Prescription) => {
    const p = byId.get(rx.exerciseId)?.pattern;
    return p === 'trunk' || p === 'carry';
  };
  let guard = 0;
  while (est() > budget && guard++ < 50) {
    // 1) isolation accessories, 2) one set off secondary then main lifts (min 2), 3) trunk accessories, 4) secondary lifts.
    const p3 = [...exercises].reverse().find((r) => r.priority === 3 && !isTrunk(r));
    if (p3) {
      exercises = exercises.filter((r) => r !== p3);
      trimmed.push(p3.exerciseId);
      continue;
    }
    const p2 = [...exercises].reverse().find((r) => r.priority === 2 && r.sets > 2);
    if (p2) {
      p2.sets -= 1;
      continue;
    }
    const p1 = [...exercises].reverse().find((r) => r.priority === 1 && r.sets > 2);
    if (p1) {
      p1.sets -= 1;
      continue;
    }
    const p3t = [...exercises].reverse().find((r) => r.priority === 3);
    if (p3t) {
      exercises = exercises.filter((r) => r !== p3t);
      trimmed.push(p3t.exerciseId);
      continue;
    }
    const lastP2 = [...exercises].reverse().find((r) => r.priority === 2);
    if (lastP2 && exercises.length > 2) {
      exercises = exercises.filter((r) => r !== lastP2);
      trimmed.push(lastP2.exerciseId);
      continue;
    }
    break;
  }
  const out: SessionTemplate = { ...t, exercises, estimatedMinutes: est() };
  if (trimmed.length) out.trimmedExerciseIds = trimmed;
  else delete out.trimmedExerciseIds;
  return out;
}

/* =========================================================== template build */
function buildLiftingTemplate(day: DayDef, split: SplitDef, ctx: Ctx, variant: number, weekUsed: Set<ID>, name?: string): { template: SessionTemplate; gaps: SlotDef[] } {
  const id = `${split.key}:${day.key}`;
  const sessionUsed = new Set<ID>();
  const exercises: Prescription[] = [];
  const gaps: SlotDef[] = [];
  for (const slot of day.slots) {
    const ranked = rankCandidates(slot, ctx, sessionUsed, weekUsed);
    const i = pickIndex(variant, ranked.length);
    if (i < 0) {
      gaps.push(slot);
      continue;
    }
    const pick = ranked[i];
    sessionUsed.add(pick.id);
    weekUsed.add(pick.id);
    exercises.push(prescribe(pick, slot, ctx, id, alternativesFor(pick, ranked, ctx)));
  }
  exercises.sort((x, y) => x.priority - y.priority);
  const template: SessionTemplate = { id, name: name ?? day.name, focus: day.focus, kind: 'lifting', exercises, estimatedMinutes: 0 };
  return { template: fitToBudget(template, ctx.budget, ctx.byId), gaps };
}

function walkTemplate(ctx: Ctx): SessionTemplate {
  const minutes = Math.min(ctx.budget, 30);
  return {
    id: 'act:walk',
    name: 'Easy walk',
    focus: 'Recovery & everyday movement',
    kind: 'walk',
    exercises: [],
    estimatedMinutes: minutes,
    cardio: { activity: 'walk', minutes, intensity: 'easy', notes: 'Easy pace — you could hold a conversation. Any walk counts, split it up if you like.' },
  };
}

function cardioTemplate(ctx: Ctx, activity: ActivityType): SessionTemplate {
  const minutes = Math.min(ctx.budget, 30);
  const intensity = activity === 'sport' || activity === 'class' ? 'moderate' : 'easy';
  return {
    id: 'act:cardio',
    name: `Easy ${ACTIVITY_NAMES[activity].toLowerCase()}`,
    focus: 'Easy cardio',
    kind: 'cardio',
    exercises: [],
    estimatedMinutes: minutes,
    cardio: {
      activity,
      minutes,
      intensity,
      notes: intensity === 'easy' ? 'Keep it easy: you should be able to talk in full sentences.' : 'Enjoy it — keep the effort moderate on the day before a lifting session.',
    },
  };
}

function mobilityTemplate(ctx: Ctx, variant: number, activity?: ActivityType): SessionTemplate {
  const minutes = Math.min(ctx.budget, 20);
  if (activity && activity !== 'mobility') {
    return {
      id: 'act:mobility',
      name: activity === 'yoga' ? 'Easy yoga' : 'Stretching',
      focus: 'Mobility & recovery',
      kind: 'mobility',
      exercises: [],
      estimatedMinutes: minutes,
      cardio: { activity, minutes, intensity: 'easy', notes: 'Gentle and comfortable — no forcing end ranges.' },
    };
  }
  const slot: SlotDef = { key: 'mob', label: 'Mobility', patterns: ['mobility'], fallbackPatterns: ['trunk'], priority: 3, prefer: MOBILITY_PREFER };
  const ranked = rankCandidates(slot, ctx, new Set(), new Set());
  const trunkSlot: SlotDef = { key: 'mobt', label: 'Trunk', patterns: ['trunk'], priority: 3, prefer: ['bird-dog', 'dead-bug'] };
  const trunkRanked = rankCandidates(trunkSlot, ctx, new Set(), new Set());
  const pool = [...ranked.slice(0, 4), ...trunkRanked.slice(0, 1)];
  const rot = pool.length ? Math.abs(variant) % pool.length : 0;
  const chosen = [...pool.slice(rot), ...pool.slice(0, rot)].slice(0, 5);
  if (!chosen.length) {
    return {
      id: 'act:mobility',
      name: 'Mobility',
      focus: 'Mobility & recovery',
      kind: 'mobility',
      exercises: [],
      estimatedMinutes: minutes,
      cardio: { activity: 'mobility', minutes, intensity: 'easy', notes: 'Gentle full-body mobility — move through comfortable ranges.' },
    };
  }
  const exercises: Prescription[] = chosen.map((ex, i) => ({
    id: `act:mobility:${i}`,
    exerciseId: ex.id,
    sets: 2,
    repMin: ex.tracking === 'duration' ? 1 : 6,
    repMax: ex.tracking === 'duration' ? 1 : 10,
    durationSec: ex.tracking === 'duration' ? 30 : undefined,
    targetRir: 3,
    restSec: 20,
    warmup: 'Move slowly and stay in a comfortable range.',
    priority: 3,
    alternatives: pool.filter((p) => p.id !== ex.id).map((p) => p.id).slice(0, 3),
  }));
  for (const rx of exercises) if (rx.durationSec === undefined) delete rx.durationSec;
  const t: SessionTemplate = { id: 'act:mobility', name: 'Mobility', focus: 'Mobility & recovery', kind: 'mobility', exercises, estimatedMinutes: 0 };
  return { ...t, estimatedMinutes: estimateWith(t, ctx.byId) };
}

function conditioningTemplate(ctx: Ctx, variant: number): SessionTemplate | null {
  const slot: SlotDef = { key: 'cond', label: 'Conditioning', patterns: ['conditioning'], priority: 3, prefer: CONDITIONING_PREFER };
  const ranked = rankCandidates(slot, ctx, new Set(), new Set());
  if (!ranked.length) return null;
  const rot = Math.abs(variant) % ranked.length;
  const chosen = [...ranked.slice(rot), ...ranked.slice(0, rot)].slice(0, 2);
  const exercises: Prescription[] = chosen.map((ex, i) => ({
    id: `act:conditioning:${i}`,
    exerciseId: ex.id,
    sets: 5,
    repMin: ex.tracking === 'reps' ? 8 : 1,
    repMax: ex.tracking === 'reps' ? 12 : 1,
    ...(ex.tracking === 'reps' ? {} : { durationSec: 40 }),
    targetRir: 3,
    restSec: 80,
    warmup: i === 0 ? 'Start with 3–5 minutes of easy movement, then build up gradually.' : 'Keep the effort moderate — challenging but controlled.',
    priority: 3,
    alternatives: ranked.filter((r) => r.id !== ex.id).map((r) => r.id).slice(0, 3),
  }));
  const t: SessionTemplate = { id: 'act:conditioning', name: 'Conditioning intervals', focus: 'Conditioning', kind: 'conditioning', exercises, estimatedMinutes: 0 };
  return fitToBudget({ ...t, estimatedMinutes: estimateWith(t, ctx.byId) }, Math.min(ctx.budget, 30), ctx.byId);
}

function enduranceActivity(a: OnboardingAnswers): ActivityType {
  return a.endurance?.activity ?? a.preferredActivities.find((t) => ENDURANCE_TYPES.includes(t)) ?? 'run';
}

function enduranceTemplates(ctx: Ctx, count: number): SessionTemplate[] {
  const a = ctx.a;
  const activity = enduranceActivity(a);
  const label = ACTIVITY_NAMES[activity];
  const recent = a.endurance?.recentMinutes;
  const dist = a.endurance?.recentDistanceKm;
  const base = clamp(Math.round(recent ?? 20), 10, ctx.budget);
  const distText = dist ? ` (around ${Math.round(dist * 10) / 10} km is a good guide)` : '';
  const easyNotes = recent
    ? `Easy, conversational effort for about ${base} min${distText}. When it feels comfortable, add about 5–10 % next week; hold steady every 4th week.`
    : dist
      ? `Easy, conversational effort covering about ${Math.round(dist * 10) / 10} km. Log your time so the plan can build from it.`
      : 'Calibration: go easy for about 20 minutes at a pace where you can talk. Log time and distance — we’ll build from there.';
  const out: SessionTemplate[] = [];
  const easy: SessionTemplate = {
    id: 'end:easy',
    name: `Easy ${label.toLowerCase()}`,
    focus: 'Endurance — easy',
    kind: 'cardio',
    exercises: [],
    estimatedMinutes: base,
    cardio: { activity, minutes: base, intensity: 'easy', notes: easyNotes },
  };
  out.push(easy);
  if (count >= 2) {
    const longMin = Math.min(ctx.budget, Math.max(base + 5, Math.round((base * 1.25) / 5) * 5));
    out.push({
      id: 'end:long',
      name: `Longer ${label.toLowerCase()}`,
      focus: 'Endurance — longer easy',
      kind: 'cardio',
      exercises: [],
      estimatedMinutes: longMin,
      cardio: { activity, minutes: longMin, intensity: 'easy', notes: 'Same easy effort, a little longer. Slow down if you can’t talk comfortably.' },
    });
  }
  if (count >= 3 && !ctx.beginner) {
    out.push({
      id: 'end:steady',
      name: `Steady ${label.toLowerCase()}`,
      focus: 'Endurance — steady',
      kind: 'cardio',
      exercises: [],
      estimatedMinutes: base,
      cardio: { activity, minutes: base, intensity: 'moderate', notes: 'After 10 easy minutes, hold a steady “comfortably hard” effort, then ease off for the last 5.' },
    });
  }
  return out;
}

/* ================================================================ schedule */
const circDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 7;
  return Math.min(d, 7 - d);
};
const orderKey = (days: number[]) => [...days].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
export const sortWeekdays = orderKey;

export function consecutivePairs(days: number[]): [number, number][] {
  const set = new Set(days);
  if (set.size >= 7) return [...set].map((d) => [d, (d + 1) % 7] as [number, number]);
  return orderKey([...set])
    .filter((d) => set.has((d + 1) % 7))
    .map((d) => [d, (d + 1) % 7] as [number, number]);
}

function subsets(items: number[], k: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, acc: number[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < items.length; i++) rec(i + 1, [...acc, items[i]]);
  };
  rec(0, []);
  return out;
}

/** Choose lifting weekdays: preferred days first, then spread out; back-to-back avoided when possible. */
function pickLiftingDays(avail: number[], preferred: number[], count: number, beginner: boolean, fullBody: boolean): number[] {
  if (count <= 0) return [];
  const ordered = orderKey(avail);
  if (count >= ordered.length) return ordered;
  const prefSet = new Set(preferred.filter((d) => avail.includes(d)));
  let best: number[] = [];
  let bestScore = -Infinity;
  let bestKey = '';
  for (const sub of subsets(ordered, count)) {
    let s = 0;
    for (const d of sub) if (prefSet.has(d)) s += 20;
    const pairs = consecutivePairs(sub).length;
    s -= pairs * (beginner ? 8 : fullBody ? 3 : 1);
    // three in a row
    for (const d of sub) if (sub.includes((d + 1) % 7) && sub.includes((d + 2) % 7)) s -= 4;
    let minGap = 7;
    for (const x of sub) for (const y of sub) if (x !== y) minGap = Math.min(minGap, circDist(x, y));
    s += minGap * 1.5;
    const key = orderKey(sub).map((d) => WEEK_ORDER.indexOf(d)).join(',');
    if (s > bestScore || (s === bestScore && key < bestKey)) {
      best = sub;
      bestScore = s;
      bestKey = key;
    }
  }
  return orderKey(best);
}

/** Greedy spread: each pick maximises distance from already-scheduled days. */
function spreadPick(candidates: number[], fixed: number[], count: number): number[] {
  const chosen: number[] = [];
  const remaining = orderKey(candidates);
  while (chosen.length < count && remaining.length) {
    let bestI = 0;
    let bestD = -1;
    remaining.forEach((c, i) => {
      const others = [...fixed, ...chosen];
      const d = others.length ? Math.min(...others.map((o) => circDist(o, c))) : 7;
      if (d > bestD) {
        bestD = d;
        bestI = i;
      }
    });
    chosen.push(remaining.splice(bestI, 1)[0]);
  }
  return orderKey(chosen);
}

/* ============================================================ split choice */
export interface SplitChoice {
  split: SplitDef | null;
  liftingDays: number;
  exerciseVariant: number;
  warnings: string[];
  /** Resolved structure (catalog in splits.ts). */
  resolution: SplitResolution;
}

/**
 * Lifting structure from VISIBLE inputs only: lifting days (capped to available days; endurance goal →
 * at most 2 supporting sessions), goal and the explicit `splitPreference` (absent = recommended default).
 * `variant` never changes the split — it is passed through to shuffle exercises within it.
 */
export function chooseSplit(a: OnboardingAnswers, variant = 0, availableCount = 7): SplitChoice {
  const warnings: string[] = [];
  const beginner = a.experience === 'new' || a.experience === 'returning';
  const requested = clamp(Math.round(a.liftingDaysPerWeek), 0, 6);
  if (requested > availableCount) {
    warnings.push(`You asked for ${requested} lifting days but marked ${availableCount} available day${availableCount === 1 ? '' : 's'}, so the plan uses ${availableCount}.`);
  }
  const lifting = effectiveLiftingDays(a, availableCount);
  const capped = Math.min(requested, availableCount);
  if (a.goal === 'endurance') {
    if (capped > 2)
      warnings.push(`With an endurance-first goal we suggest 2 supporting strength sessions rather than ${capped}, so your key sessions stay fresh. You can add more sessions in your program.`);
    if (lifting === 0) warnings.push('One or two short strength sessions a week can support your endurance training — add one any time.');
  } else if (lifting === 0) {
    warnings.push('This plan has no lifting days. Strength training about twice a week is a common recommendation for general health — you can add it later.');
  } else if (lifting === 5 && beginner) {
    warnings.push('For someone newer or returning to lifting, 4 days (upper/lower) is usually easier to recover from. We built the 5-day plan you chose — consider 4 days if you feel run down.');
  } else if (lifting >= 6) {
    if (beginner)
      warnings.push('Six lifting days is a lot when you’re new or returning — 3–4 days usually gives similar progress with more recovery. We kept your choice; you can lower it any time.');
    else if (a.experience === 'intermediate') warnings.push('Six lifting days needs good sleep and recovery. If sessions start to feel flat, drop to 4–5 days.');
  }
  const resolution = resolveSplit(a, lifting);
  if (resolution.adjustment) warnings.unshift(resolution.adjustment.message);
  return { split: resolution.def, liftingDays: lifting, exerciseVariant: variant, warnings, resolution };
}

/* ============================================================== generator */
export function generateProgram(answers: OnboardingAnswers, catalog: Exercise[], opts: { startDate: ISODate; variant?: number }): ProgramVersion {
  const variant = Math.max(0, Math.trunc(opts.variant ?? 0));
  const ctx = makeCtx(answers, catalog);
  const avail = orderKey([...new Set((answers.availableWeekdays.length ? answers.availableWeekdays : [0, 1, 2, 3, 4, 5, 6]).filter((d) => d >= 0 && d <= 6))]);
  const choice = chooseSplit(answers, variant, avail.length);
  const warnings = [...choice.warnings];
  const rationale: string[] = [];
  const lifting = choice.liftingDays;
  let total = clamp(Math.round(answers.totalDaysPerWeek || lifting || 1), 1, 7);
  if (total < lifting) total = lifting;
  if (total > avail.length) {
    warnings.push(`You wanted ${total} active days but marked ${avail.length} available, so the plan uses ${avail.length}.`);
    total = avail.length;
  }

  /* ---- weekdays */
  const fullBody = !!choice.split && splitFamily(choice.split.key) === 'full_body';
  const liftDays = pickLiftingDays(avail, answers.preferredLiftingWeekdays, lifting, ctx.beginner, fullBody);
  const extraCount = Math.max(0, total - liftDays.length);
  const extraDays = spreadPick(avail.filter((d) => !liftDays.includes(d)), liftDays, extraCount);

  /* ---- lifting templates */
  const templates: SessionTemplate[] = [];
  const schedule: ScheduleSlot[] = [];
  const weekUsed = new Set<ID>();
  if (choice.split) {
    choice.split.days.forEach((day) => {
      templates.push(buildLiftingTemplate(day, choice.split!, ctx, choice.exerciseVariant, weekUsed).template);
    });
    liftDays.forEach((d, i) => schedule.push({ weekday: d, templateId: templates[i % templates.length].id }));
  }

  /* ---- other activity days */
  const extraKinds: string[] = [];
  if (extraDays.length) {
    let seq: SessionTemplate[] = [];
    if (answers.goal === 'endurance') {
      seq = enduranceTemplates(ctx, extraDays.length);
      // easy sessions fill the week; the longer session goes last (often the weekend), steady in the middle.
      const easy = seq.find((t) => t.id === 'end:easy')!;
      const long = seq.find((t) => t.id === 'end:long');
      const steady = seq.find((t) => t.id === 'end:steady');
      const assigned: SessionTemplate[] = extraDays.map(() => easy);
      if (long) assigned[assigned.length - 1] = long;
      if (steady && assigned.length >= 3) assigned[Math.floor((assigned.length - 1) / 2)] = steady;
      seq.forEach((t) => templates.push(t));
      extraDays.forEach((d, i) => schedule.push({ weekday: d, templateId: assigned[i].id }));
    } else {
      const prefs = [...new Set(answers.preferredActivities)];
      const cardioPref = prefs.find((t) => CARDIO_TYPES.includes(t));
      const mobilityPref = prefs.find((t) => MOBILITY_TYPES.includes(t));
      if (cardioPref) seq.push(cardioTemplate(ctx, cardioPref));
      if ((answers.goal === 'general_fitness' || answers.goal === 'lose_fat') && answers.experience !== 'new' && extraDays.length >= 2) {
        const cond = conditioningTemplate(ctx, variant);
        if (cond) seq.push(cond);
      }
      seq.push(walkTemplate(ctx));
      seq.push(mobilityTemplate(ctx, variant, mobilityPref));
      const used = new Map<ID, SessionTemplate>();
      extraDays.forEach((d, i) => {
        const t = seq[i % seq.length];
        used.set(t.id, t);
        schedule.push({ weekday: d, templateId: t.id });
      });
      seq.filter((t) => used.has(t.id)).forEach((t) => templates.push(t));
    }
    for (const t of templates) if (t.kind !== 'lifting' && schedule.some((s) => s.templateId === t.id)) extraKinds.push(t.name.toLowerCase());
  }
  schedule.sort((x, y) => WEEK_ORDER.indexOf(x.weekday) - WEEK_ORDER.indexOf(y.weekday));

  /* ---- rationale */
  const goalLine = `Built to help you ${X.GOAL_TEXT[answers.goal]}${answers.secondaryGoal && answers.secondaryGoal !== answers.goal ? ` (with ${X.GOAL_TEXT[answers.secondaryGoal]} as a secondary goal)` : ''}, for someone ${X.EXPERIENCE_TEXT[answers.experience]}.`;
  rationale.push(goalLine);
  if (choice.split && answers.goal !== 'endurance') {
    const days = `${lifting} lifting day${lifting === 1 ? '' : 's'} a week`;
    const others = choice.resolution.options.length > 1;
    const why = choice.resolution.explicit && !choice.resolution.recommended
      ? `You chose this structure for ${days}.`
      : `This is our recommended product default for ${days}${others ? ' — you can choose another structure' : ''}.`;
    rationale.push(`${choice.split.label}: ${choice.split.description} ${why}`);
  }
  if (answers.goal === 'endurance') {
    const act = ACTIVITY_NAMES[enduranceActivity(answers)].toLowerCase();
    const endCount = extraDays.length;
    rationale.push(
      endCount
        ? `Built around your ${act}: ${endCount} session${endCount === 1 ? '' : 's'} a week, ${answers.endurance?.recentMinutes ? `starting from your recent comfortable ${answers.endurance.recentMinutes} minutes` : 'starting with a gentle calibration session'} and progressing gradually.`
        : `There were no free days left for ${act} sessions — reduce lifting days or add available days to make room.`,
    );
    if (choice.split) rationale.push(`${lifting} supporting strength session${lifting === 1 ? '' : 's'} (${choice.split.label}): ${choice.split.description}`);
  }
  if (liftDays.length) {
    rationale.push(`Lifting on ${X.weekdaysText(liftDays)}${extraDays.length ? `; ${answers.goal === 'endurance' ? 'endurance sessions' : 'easier days'} on ${X.weekdaysText(extraDays)}` : ''} — only days you said you’re available.`);
  } else if (extraDays.length) {
    rationale.push(`Sessions on ${X.weekdaysText(extraDays)} — only days you said you’re available.`);
  }
  if (extraDays.length && liftDays.length && answers.goal !== 'endurance') {
    rationale.push(`You wanted ${total} active days: ${liftDays.length} are lifting days and ${extraDays.length} ${extraDays.length === 1 ? 'is an easier day' : 'are easier days'} (${X.listText([...new Set(extraKinds)])}), so hard sessions stay spaced out.`);
  }
  const eq = [...ctx.equipment].filter((e) => e !== 'bodyweight');
  rationale.push(
    eq.length >= ALL_EQUIPMENT.length - 1
      ? 'You have a full gym, so exercises use standard gym equipment — main lifts favour free weights you can progress in small steps.'
      : eq.length
        ? `Every exercise uses only equipment you have (${X.listText(eq.map((e) => X.EQUIPMENT_TEXT[e]))}) or your bodyweight.`
        : 'Every exercise uses only your bodyweight — no equipment needed.',
  );
  const lift = templates.filter((t) => t.kind === 'lifting');
  if (lift.length) {
    const mins = lift.map((t) => t.estimatedMinutes);
    const lo = Math.min(...mins);
    const hi = Math.max(...mins);
    rationale.push(`Sessions are planned to fit your ${ctx.budget} minutes (estimated ${lo === hi ? `${lo}` : `${lo}–${hi}`} min). ${X.DURATION_RATIONALE}`);
    rationale.push(X.repsRationale(answers.goal, answers.experience));
    rationale.push(X.effortRationale(answers.experience));
    const anyCal = lift.some((t) => t.exercises.some((e) => e.calibrate));
    const anyKnown = lift.some((t) => t.exercises.some((e) => e.startLoadKg != null));
    if (anyCal) rationale.push(X.CALIBRATION_RATIONALE);
    if (anyKnown) rationale.push('Lifts where you told us a comfortable load start from that load.');

    // coverage across the week
    const patterns = new Set<MovementPattern>();
    for (const t of lift) for (const rx of t.exercises) {
      const ex = ctx.byId.get(rx.exerciseId);
      if (ex) patterns.add(ex.pattern);
    }
    const covered = COVERAGE_GROUPS.filter((g) => g.patterns.some((p) => patterns.has(p)));
    const missing = COVERAGE_GROUPS.filter((g) => !g.patterns.some((p) => patterns.has(p)));
    if (covered.length) rationale.push(`Across the week you practise: ${X.listText(covered.map((g) => g.label))}.`);
    for (const g of missing) {
      const trimmedOnly = lift.some((t) => (t.trimmedExerciseIds ?? []).some((id) => g.patterns.includes(ctx.byId.get(id)?.pattern as MovementPattern)));
      warnings.push(
        trimmedOnly
          ? `No ${g.label} work this week — it was trimmed to fit ${ctx.budget}-minute sessions. Longer sessions or one more day would bring it back.`
          : `No ${g.label} exercise fits your equipment, exclusions and the areas you asked us to go easy on${g.key === 'vpull' ? ' (a pull-up bar or a band would add one)' : ''}. Add or swap one in your program if you can.`,
      );
    }

    // muscle frequency
    const freq = MAJOR_MUSCLES.map((m) => ({
      m,
      n: schedule.filter((s) => {
        const t = templates.find((x) => x.id === s.templateId);
        return t?.kind === 'lifting' && t.exercises.some((rx) => ctx.byId.get(rx.exerciseId)?.primaryMuscles.some((pm) => m.muscles.includes(pm)));
      }).length,
    }));
    if (liftDays.length === 1) {
      rationale.push('With one lifting day each major muscle group is trained once a week — a solid start. A second day would allow the commonly recommended twice-weekly practice.');
    } else {
      const once = freq.filter((f) => f.n < 2);
      if (!once.length) rationale.push(`Each major muscle group is trained about ${Math.min(...freq.map((f) => f.n))}× or more a week.`);
      else warnings.push(`Compromise: ${X.listText(once.map((f) => f.m.label.toLowerCase()))} ${once.length === 1 ? 'is' : 'are'} trained ${once.every((f) => f.n === 0) ? 'less than once' : 'about once'} a week in this plan${choice.split?.key === 'es' ? ' to keep the focus on your main activity' : ''}.`);
    }

    // time budget
    const trimmedAny = lift.filter((t) => t.trimmedExerciseIds?.length);
    if (trimmedAny.length)
      warnings.push(`To fit ${ctx.budget} minutes we removed some lower-priority accessories (${X.listText(trimmedAny.map((t) => t.name))}). They’re listed with each session if you have extra time.`);
    const over = lift.filter((t) => t.estimatedMinutes > ctx.budget);
    if (over.length) warnings.push(`${X.listText(over.map((t) => t.name))} may run a little over ${ctx.budget} minutes even after trimming — shorten rests slightly or drop a set.`);
  }

  // back-to-back lifting
  const pairs = consecutivePairs(liftDays);
  if (pairs.length && ctx.beginner) {
    const pref = new Set(answers.preferredLiftingWeekdays);
    const byChoice = pairs.every(([x, y]) => pref.has(x) && pref.has(y));
    const pairText = X.listText(pairs.map(([x, y]) => `${WEEKDAY_SHORT[x]}–${WEEKDAY_SHORT[y]}`));
    warnings.push(
      byChoice
        ? `Your preferred days put lifting back-to-back (${pairText}). That’s fine, but newer lifters usually recover better with a rest day between — you can move a session in your program.`
        : `Your available days make back-to-back lifting unavoidable (${pairText}). Keep the second day conservative and stop sets with 3 reps in reserve.`,
    );
  } else if (pairs.length && fullBody) {
    warnings.push('Some full-body sessions are on back-to-back days. Keep effort conservative on the second day.');
  }

  if (answers.limitations.length) rationale.push(X.limitationRationale(answers.limitations));
  if (answers.excludedExerciseIds.length) rationale.push(`${answers.excludedExerciseIds.length} exercise${answers.excludedExerciseIds.length === 1 ? '' : 's'} you excluded ${answers.excludedExerciseIds.length === 1 ? 'is' : 'are'} never selected.`);
  const enjoyedIn = [...ctx.enjoyed].filter((id) => templates.some((t) => t.exercises.some((rx) => rx.exerciseId === id)));
  if (enjoyedIn.length) rationale.push(`Includes exercises you enjoy: ${X.listText(enjoyedIn.map((id) => ctx.byId.get(id)?.name ?? id))}.`);
  if (answers.goal === 'lose_fat') rationale.push('Lifting helps you keep muscle while losing fat; walking and everyday movement add to energy use without competing with recovery.');

  const weeks = ctx.beginner ? 6 : 8;
  const reviewWeek = weeks;
  rationale.push(X.blockRationale(weeks, reviewWeek));
  if (lift.length) rationale.push(X.PROGRESSION_RATIONALE);
  if (answers.limitations.length) warnings.push('If an exercise causes pain, stop it and flag discomfort — we’ll hold its progression and suggest alternatives. This app doesn’t diagnose injuries.');

  return {
    version: 1,
    // Derived from the start date (not the clock) so generation stays deterministic; createProgram stamps the real time.
    createdAt: toUTCms(opts.startDate),
    reason: variant ? `Generated from onboarding (exercises shuffled ${variant}×)` : 'Generated from onboarding',
    templates,
    schedule,
    weeks,
    reviewWeek,
    rationale,
    warnings,
  };
}

/** Rebuild selected sessions with a different exercise variant, keeping ids, names and the schedule. */
export function regenerateTemplates(version: ProgramVersion, templateIds: ID[], answers: OnboardingAnswers, catalog: Exercise[], variant: number): ProgramVersion {
  const ctx = makeCtx(answers, catalog);
  const ids = new Set(templateIds);
  const weekUsed = new Set<ID>();
  for (const t of version.templates) if (!ids.has(t.id)) t.exercises.forEach((rx) => weekUsed.add(rx.exerciseId));
  const names: string[] = [];
  const templates = version.templates.map((t) => {
    if (!ids.has(t.id)) return t;
    const rebuilt = rebuildTemplate(t, ctx, variant, weekUsed);
    if (rebuilt !== t) names.push(t.name);
    return rebuilt;
  });
  return { ...version, templates, reason: names.length ? `Regenerated ${X.listText(names)}` : version.reason };
}

function rebuildTemplate(t: SessionTemplate, ctx: Ctx, variant: number, weekUsed: Set<ID>): SessionTemplate {
  const [splitKey, dayKey] = t.id.split(':');
  const split = SPLITS[splitKey as SplitKey];
  const day = split?.days.find((d) => d.key === dayKey);
  if (split && day) {
    const { template } = buildLiftingTemplate(day, split, ctx, variant, weekUsed, t.name);
    return { ...template, focus: t.focus };
  }
  if (t.id === 'act:mobility' && t.exercises.length) return { ...mobilityTemplate(ctx, variant), name: t.name };
  if (t.id === 'act:conditioning') return conditioningTemplate(ctx, variant) ?? t;
  if (t.kind !== 'lifting' || !t.exercises.length) return t;
  // Custom / manual session: swap each exercise for another that does the same job.
  const sessionUsed = new Set<ID>();
  const exercises = t.exercises.map((rx) => {
    const cur = ctx.byId.get(rx.exerciseId);
    if (!cur) return rx;
    const isolation = cur.pattern === 'isolation_upper' || cur.pattern === 'isolation_lower';
    const slot: SlotDef = { key: rx.id, label: cur.name, patterns: [cur.pattern], muscles: isolation ? cur.primaryMuscles : undefined, priority: rx.priority, prefer: [cur.id, ...cur.substitutions] };
    const ranked = rankCandidates(slot, ctx, sessionUsed, weekUsed);
    const i = pickIndex(variant, ranked.length);
    if (i < 0) return rx;
    const pick = ranked[i];
    sessionUsed.add(pick.id);
    weekUsed.add(pick.id);
    return { ...rx, exerciseId: pick.id, alternatives: alternativesFor(pick, ranked, ctx), warmup: warmupText(pick, rx.priority, !rx.startLoadKg && isLoaded(pick) && pick.tracking !== 'bodyweight_plus'), startLoadKg: pick.id === rx.exerciseId ? rx.startLoadKg : ctx.a.knownLoads?.[pick.id] };
  });
  const next = { ...t, exercises };
  return { ...next, estimatedMinutes: estimateWith(next, ctx.byId) };
}

/** Human-friendly program name for a generated version. */
export function suggestProgramName(answers: OnboardingAnswers | null, version: ProgramVersion): string {
  if (answers?.goal === 'endurance') return `${ACTIVITY_NAMES[enduranceActivity(answers)]} plan + strength`;
  const key = version.templates.find((t) => t.kind === 'lifting')?.id.split(':')[0] as SplitKey | undefined;
  if (key && SPLITS[key]) return SPLITS[key].label;
  return version.templates.length ? 'Activity plan' : 'My program';
}

/** Blank lifting session for manual routines / custom splits. */
export function emptyTemplate(id: ID, name: string): SessionTemplate {
  return { id, name, focus: 'Custom', kind: 'lifting', exercises: [], estimatedMinutes: 0 };
}

/** A sensible default prescription when the user adds an exercise by hand. */
export function defaultPrescription(ex: Exercise, slotId: ID, experience: Experience = 'intermediate', goal: Goal = 'build_muscle', priority: Priority = 2): Prescription {
  const ctx = makeCtx(
    {
      displayName: '', units: { weight: 'kg', length: 'cm', distance: 'km' }, goal, experience, totalDaysPerWeek: 3, liftingDaysPerWeek: 3, availableWeekdays: [],
      preferredLiftingWeekdays: [], sessionMinutes: 60, location: 'full_gym', equipment: [], preferredActivities: [], enjoyedExerciseIds: [], excludedExerciseIds: [],
      limitations: [], activityLevel: 'moderate', wantsNutrition: false, diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 },
    },
    [ex],
  );
  const rx = prescribe(ex, { key: 'x', priority }, ctx, 'x', ex.substitutions.slice(0, 4));
  return { ...rx, id: slotId };
}
