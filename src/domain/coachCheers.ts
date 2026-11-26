/**
 * Coach cheers in the workout logger (pure; no React, no network, no AI call — works offline at zero cost).
 *
 *  - cheerForSet: after a set is ticked done, decide the situation from the set just logged (new record,
 *    last set of the workout, top of the rep range, reps below target, last set of an exercise, or general)
 *    and pick one short line (≤ 12 words) in the user's coach style.
 *  - restOverCheer: when the rest timer ends, name the next set ("Rest's up, Bench press set 3: 60 kg × 8. Go when ready.").
 *
 * Facts only: cheers name what just happened (a record, the reps reached, sets or the workout completed) and never give
 * progression advice ("heavier next time", "add weight", "go lighter next time"). Next loads come only from the
 * progression engine (src/domain/progression.ts), shown as "Next:" on the workout summary. Discomfort lines may still
 * say to go easy or swap the exercise in THIS session — that's safety, not progression.
 *
 * Rules: warm-up sets get nothing; an exercise flagged "Felt discomfort" only ever gets caring lines; never a line
 * about body weight or food; the same line is never picked twice in a row (pass the previous line as `last`).
 */
import type { CoachStyle, Exercise, ID, LoggedSet, SessionExercise, WeightUnit, WorkoutSession } from './types';
import { detectRecords } from './stats';
import { displayWeight, fromKg, trimNum } from './units';
import { EN, getLanguage, hasKey, loadText, t, tp, type Language, type PluralKey } from '../i18n';

export type CheerSituation = 'pr' | 'top_of_range' | 'last_set_exercise' | 'last_set_workout' | 'below_target' | 'general' | 'discomfort' | 'rest_over' | 'rest_over_discomfort';

type Lines = Record<CoachStyle, string[]>;

/**
 * How many preset lines each situation/style has. The lines themselves live in the i18n dictionaries
 * (`workout.cheer.<situation>.<style>.<NN>`, NN one-based; lines that say a rep count are plural families with
 * `.one` / `.other`), so English and Icelandic keep the same order and the same selection logic.
 */
const CHEER_COUNTS: Record<CheerSituation, Record<CoachStyle, number>> = {
  pr: { supportive: 16, balanced: 16, strict: 16 },
  top_of_range: { supportive: 15, balanced: 15, strict: 15 },
  last_set_exercise: { supportive: 15, balanced: 15, strict: 15 },
  last_set_workout: { supportive: 15, balanced: 15, strict: 15 },
  below_target: { supportive: 15, balanced: 15, strict: 15 },
  general: { supportive: 16, balanced: 16, strict: 16 },
  discomfort: { supportive: 15, balanced: 15, strict: 15 },
  rest_over: { supportive: 15, balanced: 15, strict: 15 },
  rest_over_discomfort: { supportive: 15, balanced: 15, strict: 15 },
};
const STYLES: CoachStyle[] = ['supportive', 'balanced', 'strict'];
const bySituation = <T,>(f: (situation: CheerSituation, style: CoachStyle) => T): Record<CheerSituation, Record<CoachStyle, T>> =>
  Object.fromEntries(
    (Object.keys(CHEER_COUNTS) as CheerSituation[]).map((sit) => [sit, Object.fromEntries(STYLES.map((st) => [st, f(sit, st)]))]),
  ) as Record<CheerSituation, Record<CoachStyle, T>>;

/** Dictionary key of every preset line (a plural base for lines with a rep count), in the original order. */
export const CHEER_KEYS: Record<CheerSituation, Lines> = bySituation((sit, st) =>
  Array.from({ length: CHEER_COUNTS[sit][st] }, (_, i) => `workout.cheer.${sit}.${st}.${String(i + 1).padStart(2, '0')}`),
);

/**
 * The English source templates ({record} = the record ("60 kg × 8"), {reps} = reps just done, {next} = next exercise
 * name, {set} = next set description), read from the English dictionary. Each list has 15+ lines; every line stays
 * ≤ 12 words with typical names filled in. Display text always goes through `pickLine` in the current language.
 */
export const CHEER_LINES: Record<CheerSituation, Lines> = bySituation((sit, st) =>
  CHEER_KEYS[sit][st].map((k) => (EN as Record<string, string>)[hasKey(k) ? k : `${k}.other`].replace(/\{\{(\w+)\}\}/g, '{$1}')),
);

const PLACEHOLDERS = { record: '', reps: '', next: '', set: '' };
/** One preset line in `language`, placeholders filled (missing ones are empty); rep-count lines pick .one/.other. */
function lineText(key: string, vars: Record<string, string | number>, language: Language): string {
  const params = { ...PLACEHOLDERS, ...vars };
  return hasKey(key) ? t(key, params, language) : tp(key as PluralKey, Number(vars.reps), params, language);
}

/** Pick a line for a situation/style, filling {placeholders}, never the same line as `last`. */
export function pickLine(
  situation: CheerSituation,
  style: CoachStyle,
  vars: Record<string, string | number>,
  last?: string | null,
  rand: () => number = Math.random,
  language: Language = getLanguage(),
): string {
  const options = CHEER_KEYS[situation][style].map((k) => lineText(k, vars, language));
  const pool = options.filter((l) => l !== last);
  const list = pool.length ? pool : options;
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}

const isWarmup = (s: LoggedSet) => s.type === 'warmup';

/** "62.5 kg" / "62,5 kg": a load in the display unit (the entered value when it was entered in that unit). */
const weightText = (kg: number, unit: WeightUnit, entered: LoggedSet['entered'], language: Language) =>
  loadText(displayWeight(kg, unit, entered), unit, language);

/** "1:30 min" / "45 s" (the records' duration format), localized. */
function durationText(sec: number, language: Language): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? t('format.minutes', { count: `${m}:${String(s).padStart(2, '0')}` }, language) : t('workout.cheer.nextSet.seconds', { seconds: s }, language);
}

/** A record line without its "{{exercise}}: " lead-in (every summary.recordLine.* template starts with it). */
const withoutExercise = (line: string) => line.replace(/^: /, '');

/**
 * A new record set by exactly this set, compared with history and the earlier sets of this workout (existing stats
 * rules), as the short detail a cheer names ("60 kg × 8", "est. 1RM 75.3 kg (Epley)", "12 reps in a set").
 * Built from the record's kind and the set's own values — never by parsing the (possibly translated) record label.
 */
export function recordForSet(
  session: WorkoutSession,
  seId: ID,
  setId: ID,
  history: WorkoutSession[],
  byId: Map<ID, Exercise>,
  unit: WeightUnit,
  language: Language = getLanguage(),
): string | null {
  const se = session.exercises.find((e) => e.id === seId);
  const set = se?.sets.find((x) => x.id === setId);
  if (!se || !set || isWarmup(set)) return null;
  const only: WorkoutSession = { ...session, id: `${session.id}#cheer`, status: 'completed', exercises: [{ ...se, sets: [set] }] };
  const before: WorkoutSession = {
    ...session,
    status: 'completed',
    exercises: session.exercises.map((e) => ({ ...e, sets: e.sets.filter((x) => x.completed && x.id !== setId) })),
  };
  const hit = detectRecords(only, [...history.filter((h) => h.id !== session.id), before], byId, unit).find((r) => r.exerciseId === se.exerciseId);
  if (!hit) return null;
  const line = { exercise: '' };
  switch (hit.kind) {
    case 'heaviest': {
      const load = weightText(hit.value, unit, set.entered, language);
      return set.reps ? `${load} × ${set.reps}` : load;
    }
    case 'e1rm':
      return t('workout.cheer.record.estimatedOneRepMax', { value: `${loadText(Number(trimNum(fromKg(hit.value, unit), 1)), unit, language)} (Epley)` }, language);
    case 'reps_at_weight':
      return tp('summary.record.repsAtLoad', hit.value, { reps: hit.value, load: weightText(set.weightKg ?? 0, unit, set.entered, language) }, language);
    case 'most_reps':
      return withoutExercise(tp('summary.recordLine.mostReps', hit.value, { ...line, reps: hit.value }, language));
    case 'longest_duration':
      return withoutExercise(t('summary.recordLine.longest', { ...line, duration: durationText(hit.value, language) }, language));
    case 'least_assistance':
      return withoutExercise(
        hit.value === 0
          ? t('summary.recordLine.noAssistance', line, language)
          : t('summary.recordLine.leastAssistance', { ...line, load: weightText(hit.value, unit, set.entered, language) }, language),
      );
    default:
      return hit.label;
  }
}

export interface SetCheerInput {
  /** The session AFTER the set was ticked done. */
  session: WorkoutSession;
  seId: ID;
  setId: ID;
  style?: CoachStyle;
  history: WorkoutSession[];
  byId: Map<ID, Exercise>;
  unit: WeightUnit;
  last?: string | null;
  rand?: () => number;
  /** Defaults to the current app language. */
  language?: Language;
}

export interface Cheer {
  situation: CheerSituation;
  line: string;
}

/** The cheer for a set that was just ticked done, or null (warm-up, set not done, unknown set). */
export function cheerForSet(i: SetCheerInput): Cheer | null {
  const style = i.style ?? 'supportive';
  const idx = i.session.exercises.findIndex((e) => e.id === i.seId);
  const se = i.session.exercises[idx];
  const set = se?.sets.find((x) => x.id === i.setId);
  if (!se || !set || !set.completed || isWarmup(set)) return null;
  const language = i.language ?? getLanguage();
  const say = (situation: CheerSituation, vars: Record<string, string | number> = {}): Cheer => ({ situation, line: pickLine(situation, style, vars, i.last, i.rand, language) });

  if (se.discomfort) return say('discomfort');
  const record = recordForSet(i.session, i.seId, i.setId, i.history, i.byId, i.unit, language);
  if (record) return say('pr', { record });

  const working = (e: SessionExercise) => e.sets.filter((x) => !isWarmup(x));
  const allDone = i.session.exercises.every((e) => working(e).every((x) => x.completed));
  if (allDone) return say('last_set_workout');

  const rx = se.prescription;
  const repBased = !!rx && !rx.durationSec && set.reps != null;
  if (repBased && rx!.repMax > 0 && set.reps! >= rx!.repMax) return say('top_of_range', { reps: set.reps! });
  if (repBased && rx!.repMin > 0 && set.reps! < rx!.repMin) return say('below_target');

  if (working(se).every((x) => x.completed)) {
    const next = i.session.exercises.slice(idx + 1).concat(i.session.exercises.slice(0, idx)).find((e) => working(e).some((x) => !x.completed));
    const name = next ? i.byId.get(next.exerciseId)?.name : undefined;
    if (name) return say('last_set_exercise', { next: name });
  }
  return say('general');
}

export interface NextSet {
  seId: ID;
  exerciseName: string;
  /** 1-based number among the exercise's working sets. */
  number: number;
  label: string;
  /** "60 kg × 8" / "8 reps" / "30 s", or '' when nothing is known yet. */
  detail: string;
  discomfort: boolean;
}

/** The next set to do: the rested-for exercise first if it still has sets left, then in workout order. */
export function nextSet(session: WorkoutSession, byId: Map<ID, Exercise>, unit: WeightUnit, preferSeId?: ID, language: Language = getLanguage()): NextSet | null {
  const order = [...session.exercises];
  const pref = preferSeId ? order.findIndex((e) => e.id === preferSeId) : -1;
  const candidates = pref >= 0 ? [order[pref], ...order.slice(pref + 1), ...order.slice(0, pref)] : order;
  for (const se of candidates) {
    const working = se.sets.filter((x) => !isWarmup(x));
    const n = working.findIndex((x) => !x.completed);
    if (n < 0) continue;
    const s = working[n];
    const name = byId.get(se.exerciseId)?.name ?? t('workout.cheer.nextExercise', undefined, language);
    const rx = se.prescription;
    const load = s.weightKg != null && s.weightKg > 0 ? weightText(s.weightKg, unit, s.entered, language) : null;
    const reps = s.reps ?? (rx && !rx.durationSec ? rx.repMin === rx.repMax ? rx.repMin : null : null);
    const dur = s.durationSec ?? rx?.durationSec ?? null;
    const what = load && reps ? `${load} × ${reps}` : load ? load : reps ? tp('workout.cheer.nextSet.reps', reps, { reps }, language) : dur ? t('workout.cheer.nextSet.seconds', { seconds: dur }, language) : '';
    const label = what
      ? t('workout.cheer.nextSet.labelWithDetail', { exercise: name, setNumber: n + 1, detail: what }, language)
      : t('workout.cheer.nextSet.label', { exercise: name, setNumber: n + 1 }, language);
    return { seId: se.id, exerciseName: name, number: n + 1, label, detail: what, discomfort: !!se.discomfort };
  }
  return null;
}

/** "Rest's up, Bench press set 3: 60 kg × 8. Go when ready." — or null when every set is done. */
export function restOverCheer(
  session: WorkoutSession,
  byId: Map<ID, Exercise>,
  unit: WeightUnit,
  style: CoachStyle = 'supportive',
  last?: string | null,
  rand?: () => number,
  language: Language = getLanguage(),
): Cheer | null {
  const n = nextSet(session, byId, unit, session.rest?.forExerciseId, language);
  if (!n) return null;
  const situation: CheerSituation = n.discomfort ? 'rest_over_discomfort' : 'rest_over';
  return { situation, line: pickLine(situation, style, { set: n.label }, last, rand, language) };
}
