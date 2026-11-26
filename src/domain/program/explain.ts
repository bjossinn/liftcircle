/**
 * Plain-language rationale text for generated programs. Kept separate so wording can change
 * without touching the selection logic. Everything here describes product defaults as defaults.
 */
import type { Equipment, Experience, Goal, LimitationArea, Prescription } from '@/domain/types';
import { weekdayShort } from '@/lib/dates';
import { PROGRESSION_STRINGS, progressionRuleText } from '@/domain/progression';
import { getLanguage, listText as localeListText, t, type Language } from '@/i18n';
import { localizeGeneratedText } from './localize';

/*
 * Language: functions that build text the generator STORES (rationale, cues, notes) are called by the generator with
 * 'en' — stored plan text is canonical English and is localized at render time (see ./localize.ts). Functions that
 * only build display text default to the current UI language.
 */

/** English RIR explanation (canonical; part of stored rationale). Display: `rirPlain()`. */
export const RIR_PLAIN = t('program.explain.rir', undefined, 'en');
export const rirPlain = (language: Language = getLanguage()) => t('program.explain.rir', undefined, language);

export function rirPhrase(rir: number, language: Language = getLanguage()): string {
  if (rir <= 0) return t('program.explain.rirZero', undefined, language);
  if (rir === 1) return t('program.explain.rirOne', undefined, language);
  return t('program.explain.rirMany', { count: rir }, language);
}

/** English goal phrases (canonical, used inside stored rationale and by coach tools). Display: `goalText()`. */
export const GOAL_TEXT: Record<Goal, string> = {
  build_muscle: 'build muscle',
  strength: 'get stronger',
  lose_fat: 'lose fat while keeping muscle',
  general_fitness: 'improve general fitness',
  endurance: 'improve endurance',
};
export const goalText = (goal: Goal, language: Language = getLanguage()) => t(`program.goalText.${goal}`, undefined, language);

/** English experience phrases (canonical). Display: `experienceText()`. */
export const EXPERIENCE_TEXT: Record<Experience, string> = {
  new: 'new to lifting',
  returning: 'returning after a break',
  intermediate: 'intermediate',
  advanced: 'advanced',
};
export const experienceText = (exp: Experience, language: Language = getLanguage()) => t(`program.experienceText.${exp}`, undefined, language);

export const EQUIPMENT_TEXT: Record<Equipment, string> = {
  barbell: 'barbell',
  rack: 'squat rack',
  bench: 'bench',
  dumbbell: 'dumbbells',
  kettlebell: 'kettlebell',
  machine: 'machines',
  cable: 'cables',
  band: 'bands',
  bodyweight: 'bodyweight',
  pullup_bar: 'pull-up bar',
  dip_station: 'dip station',
  ez_bar: 'EZ bar',
  smith: 'Smith machine',
  cardio_machine: 'cardio machines',
};

export const LIMITATION_TEXT: Record<LimitationArea, string> = {
  knee: 'knees',
  shoulder: 'shoulders',
  lower_back: 'lower back',
  hip: 'hips',
  wrist: 'wrists',
  elbow: 'elbows',
  neck: 'neck',
  ankle: 'ankles',
};

/** Localized conjunction list ("A, B and C" / "A, B og C"): Intl.ListFormat, never a hand-built English " and ". */
export function listText(items: readonly string[], language: Language = getLanguage()): string {
  return localeListText(items, language);
}

/** Monday-first, localized short weekday list: "Mon, Wed and Fri" / "mán., mið. og fös.". */
export function weekdaysText(days: number[], language: Language = getLanguage()): string {
  const order = [1, 2, 3, 4, 5, 6, 0];
  return listText([...days].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((d) => weekdayShort(d, language)), language);
}

export function repRangeText(rx: Pick<Prescription, 'repMin' | 'repMax' | 'durationSec'>, language: Language = getLanguage()): string {
  if (rx.durationSec) return t('program.explain.seconds', { seconds: rx.durationSec }, language);
  return rx.repMin === rx.repMax ? `${rx.repMin}` : t('program.explain.repRange', { min: rx.repMin, max: rx.repMax }, language);
}

export function prescriptionText(rx: Prescription, language: Language = getLanguage()): string {
  return t('program.explain.prescription', { sets: rx.sets, reps: repRangeText(rx, language), rir: rx.targetRir, rest: restText(rx.restSec, language) }, language);
}

export function restText(sec: number, language: Language = getLanguage()): string {
  if (sec < 60) return t('program.explain.restSeconds', { seconds: sec }, language);
  const m = sec / 60;
  return Number.isInteger(m)
    ? t('program.explain.restMinutes', { minutes: m }, language)
    : t('program.explain.restMinutesSeconds', { minutes: Math.floor(m), secondsPadded: String(sec % 60).padStart(2, '0') }, language);
}

/* ---- rationale lines the generator stores: canonical English by default ('en'), localized on display. */
export function repsRationale(goal: Goal, experience: Experience, language: Language = 'en'): string {
  const experienced = experience === 'intermediate' || experience === 'advanced';
  if (goal === 'strength' && experienced) return t('program.explain.repsStrength', undefined, language);
  if (goal === 'strength') return t('program.explain.repsBeginner', undefined, language);
  if (goal === 'endurance') return t('program.explain.repsEndurance', undefined, language);
  return t('program.explain.repsDefault', undefined, language);
}

export function effortRationale(experience: Experience, language: Language = 'en'): string {
  const start = experience === 'new' || experience === 'returning' ? 3 : 2;
  return t('program.explain.startingEffort', { rirPhrase: rirPhrase(start, language), rir: start, rirExplanation: rirPlain(language) }, language);
}

export const CALIBRATION_RATIONALE = t('program.explain.calibrationRationale', undefined, 'en');

/* ---- per-exercise cues (generator writes them in English; plan screens de-duplicate and localize them for display) */
export const WARMUP_NONE = t('program.explain.warmupNone', undefined, 'en');
export const WARMUP_SECONDARY = t('program.explain.warmupSecondary', undefined, 'en');
export const WARMUP_ACCESSORY = t('program.explain.warmupAccessory', undefined, 'en');
export const CALIBRATION_CUE = t('program.explain.calibrationCue', undefined, 'en');
export const CALIBRATION_NOTE = t('program.explain.calibrationNote', undefined, 'en');
/** Shown once per session instead of on every exercise (English constants kept for compatibility; display uses the functions). */
export const SESSION_CALIBRATION_TIP = t('program.explain.sessionCalibration', undefined, 'en');
export const SESSION_WARMUP_TIP = t('program.explain.sessionWarmup', undefined, 'en');
export const sessionCalibrationTip = (language: Language = getLanguage()) => t('program.explain.sessionCalibration', undefined, language);
export const sessionWarmupTip = (language: Language = getLanguage()) => t('program.explain.sessionWarmup', undefined, language);

/**
 * What to show on an exercise row: the warm-up cue without the repeated calibration sentence, or null
 * when it's one of the generic cues covered by the session-level tip. Custom (coach/user) text is kept as written;
 * recognised generated cues are shown in the current language. (Stored cues are compared as exact English.)
 */
export function exerciseCue(rx: Pick<Prescription, 'warmup'>, language: Language = getLanguage()): { cue: string | null; generic: boolean } {
  const cue = (rx.warmup ?? '').replace(CALIBRATION_CUE, '').trim();
  if (!cue) return { cue: null, generic: false };
  if (cue === WARMUP_NONE || cue === WARMUP_SECONDARY || cue === WARMUP_ACCESSORY) return { cue: null, generic: true };
  return { cue: localizeGeneratedText(cue, language), generic: false };
}
/** Exercise note worth showing on the row (the default calibration note is covered by the session tip). */
export function exerciseNote(rx: Pick<Prescription, 'notes'>, language: Language = getLanguage()): string | null {
  return rx.notes && rx.notes !== CALIBRATION_NOTE ? localizeGeneratedText(rx.notes, language) : null;
}

export const DURATION_RATIONALE = t('program.explain.durationRationale', undefined, 'en');

/**
 * How load progression works for this user: worded by the progression engine itself (one rule, one description).
 * The generator stores it in English; display passes the UI language (falls back to English until the engine has it).
 */
export function progressionRationale(beginner: boolean, language: Language = 'en'): string {
  const rule = progressionRuleText as (beginner: boolean, lang?: string) => string;
  return language in PROGRESSION_STRINGS ? rule(beginner, language) : rule(beginner);
}

/** The progression sentence generated plans saved before 1.0.3 (kept only to recognise it in stored rationale). */
const LEGACY_PROGRESSION_RATIONALE =
  'Progression uses double progression: when you reach the top of the rep range on every set at the target effort in two sessions (if you don’t log effort, we ask you to confirm it first), we suggest the smallest practical load increase and you start again near the bottom of the range.';

/** True for the progression sentence the generator writes (any version) — never for a coach's own notes. */
export function isGeneratedProgressionText(r: string): boolean {
  return r === LEGACY_PROGRESSION_RATIONALE || r === progressionRuleText(true) || r === progressionRuleText(false);
}

/**
 * A saved plan's rationale for display: the generated progression sentence is replaced by the engine's CURRENT text
 * for this user (plans store text, and the rule or the user's experience level may have changed since). Other
 * recognised generated lines are shown in the current language; everything else, including human-coach notes, is
 * shown as saved.
 */
export function currentRationale(rationale: readonly string[], beginner: boolean, language: Language = getLanguage()): string[] {
  return rationale.map((r) => (isGeneratedProgressionText(r) ? progressionRationale(beginner, language) : localizeGeneratedText(r, language)));
}

/** English names of limitation areas used inside the stored limitation rationale. */
export function limitationRationale(limits: LimitationArea[], language: Language = 'en'): string {
  const areas = language === 'en' ? limits.map((l) => LIMITATION_TEXT[l]) : limits.map((l) => lowerInitial(t(`workout.meta.limitation.${l}`, undefined, language), language));
  return t('program.explain.limitationRationale', { areas: listText(areas, language) }, language);
}

export function blockRationale(weeks: number, reviewWeek: number, language: Language = 'en'): string {
  return t('program.explain.blockRationale', { weeks, reviewWeek }, language);
}

/** Lower-cases a label's first letter for use inside a sentence; leaves acronyms ("EZ-stöng") alone. */
export function lowerInitial(s: string, language: Language = getLanguage()): string {
  if (s.length > 1 && s[1] !== s[1].toLocaleLowerCase(language === 'is' ? 'is-IS' : 'en-GB')) return s;
  return s.charAt(0).toLocaleLowerCase(language === 'is' ? 'is-IS' : 'en-GB') + s.slice(1);
}
