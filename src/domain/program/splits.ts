/**
 * Workout-split catalog: which lifting structures fit a given number of lifting days, the recommended
 * default, and how an explicit choice (OnboardingAnswers.splitPreference) is resolved.
 *
 * The split is decided ONLY from visible inputs (lifting days, available days, goal, explicit choice) —
 * never from the exercise-shuffle variant. Experience changes the wording/recommendation hints and, in
 * the generator, difficulty, sets and volume; it never hides the non-full-body choices.
 *
 * Endurance goal: strength is capped at 2 supporting sessions so the endurance sessions stay fresh
 * (the remaining active days become endurance sessions). With 2 sessions the user can still choose
 * between the full-body "supporting strength" pair and an upper/lower pair.
 */
import type { Experience, OnboardingAnswers, SplitKey } from '@/domain/types';
import { getLanguage, t, tp, type Language } from '@/i18n';
import { SPLITS, splitLabel, type SplitDef } from './templates';

export type SplitFamily = 'full_body' | 'upper_lower' | 'ppl';

export interface SplitOption {
  key: SplitKey;
  label: string;
  /** Short tradeoff for the selector card. */
  tradeoff: string;
  family: SplitFamily;
  recommended: boolean;
}

interface Entry {
  key: SplitKey;
  family: SplitFamily;
  /** Other intents this structure keeps reasonably well when the day count changes. */
  alsoFits?: SplitFamily[];
  tradeoff: (exp: Experience, language: Language) => string;
}

const isNewer = (exp: Experience) => exp === 'new' || exp === 'returning';
const onceWeeklyNote = (exp: Experience, language: Language) => (isNewer(exp) ? ` ${t('program.split.tradeoff.newer', undefined, language)}` : '');
const tr = (key: Parameters<typeof t>[0]) => (_e: Experience, language: Language) => t(key, undefined, language);

/** First entry per day count = recommended default. */
const STRENGTH: Record<number, Entry[]> = {
  1: [{ key: 'fb1', family: 'full_body', alsoFits: ['upper_lower', 'ppl'], tradeoff: tr('program.split.tradeoff.fb1') }],
  2: [
    { key: 'fb2', family: 'full_body', tradeoff: tr('program.split.tradeoff.fb2') },
    { key: 'ul2', family: 'upper_lower', alsoFits: ['ppl'], tradeoff: (e, l) => `${t('program.split.tradeoff.ul2', undefined, l)}${onceWeeklyNote(e, l)}` },
  ],
  3: [
    { key: 'fb3', family: 'full_body', tradeoff: tr('program.split.tradeoff.fb3') },
    { key: 'ulf', family: 'upper_lower', alsoFits: ['full_body'], tradeoff: tr('program.split.tradeoff.ulf') },
    { key: 'ppl3', family: 'ppl', tradeoff: (e, l) => `${t('program.split.tradeoff.ppl3', undefined, l)}${onceWeeklyNote(e, l)}` },
  ],
  4: [
    { key: 'ul4', family: 'upper_lower', alsoFits: ['ppl'], tradeoff: tr('program.split.tradeoff.ul4') },
    { key: 'fb4', family: 'full_body', tradeoff: tr('program.split.tradeoff.fb4') },
  ],
  5: [
    { key: 'ulppl', family: 'ppl', alsoFits: ['upper_lower'], tradeoff: (e, l) => `${t('program.split.tradeoff.ulppl', undefined, l)}${isNewer(e) ? ` ${t('program.split.tradeoff.ulpplNewer', undefined, l)}` : ''}` },
    { key: 'ul5', family: 'upper_lower', alsoFits: ['full_body'], tradeoff: tr('program.split.tradeoff.ul5') },
  ],
  6: [
    { key: 'ppl6', family: 'ppl', alsoFits: ['upper_lower'], tradeoff: tr('program.split.tradeoff.ppl6') },
    { key: 'ul6', family: 'upper_lower', tradeoff: tr('program.split.tradeoff.ul6') },
  ],
};

/** Endurance goal: supporting strength (1–2 sessions). */
const ENDURANCE: Record<number, Entry[]> = {
  1: [{ key: 'es', family: 'full_body', alsoFits: ['upper_lower', 'ppl'], tradeoff: tr('program.split.tradeoff.es1') }],
  2: [
    { key: 'es', family: 'full_body', tradeoff: tr('program.split.tradeoff.es2') },
    { key: 'ul2', family: 'upper_lower', alsoFits: ['ppl'], tradeoff: tr('program.split.tradeoff.esUpperLower') },
  ],
};

const MAX_LIFTING = 6;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Number of available weekdays as the generator counts them (none selected = every day). */
export function availableDayCount(a: Pick<OnboardingAnswers, 'availableWeekdays'>): number {
  const days = new Set((a.availableWeekdays ?? []).filter((d) => d >= 0 && d <= 6));
  return days.size || 7;
}

/**
 * Lifting sessions the plan will actually contain: the requested count, capped to the available days
 * and, for an endurance goal, to 2 supporting sessions. Other active days are not lifting days.
 */
export function effectiveLiftingDays(a: Pick<OnboardingAnswers, 'liftingDaysPerWeek' | 'goal' | 'availableWeekdays'>, availableCount = availableDayCount(a)): number {
  let n = clamp(Math.round(Number(a.liftingDaysPerWeek) || 0), 0, MAX_LIFTING);
  n = Math.min(n, availableCount);
  if (a.goal === 'endurance') n = Math.min(n, 2);
  return n;
}

const entriesFor = (goal: OnboardingAnswers['goal'], liftingDays: number): Entry[] => (goal === 'endurance' ? ENDURANCE : STRENGTH)[liftingDays] ?? [];

/** Selectable structures for this many lifting days, recommended one first (label/tradeoff in the display language). */
export function splitOptions(a: Pick<OnboardingAnswers, 'goal' | 'experience'>, liftingDays: number, language: Language = getLanguage()): SplitOption[] {
  return entriesFor(a.goal, liftingDays).map((e, i) => ({
    key: e.key,
    label: splitLabel(e.key, language),
    tradeoff: e.tradeoff(a.experience, language),
    family: e.family,
    recommended: i === 0,
  }));
}

export function recommendedSplit(a: Pick<OnboardingAnswers, 'goal' | 'experience'>, liftingDays: number): SplitKey | null {
  return entriesFor(a.goal, liftingDays)[0]?.key ?? null;
}

export const isSplitKey = (v: unknown): v is SplitKey => typeof v === 'string' && Object.prototype.hasOwnProperty.call(SPLITS, v);

/** Family of a split key, independent of day count. */
export function splitFamily(key: SplitKey): SplitFamily {
  for (const table of [STRENGTH, ENDURANCE]) for (const list of Object.values(table)) for (const e of list) if (e.key === key) return e.family;
  return 'full_body';
}

export interface SplitResolution {
  key: SplitKey | null;
  /** Split definition sized to the lifting days (null when there are no lifting days). */
  def: SplitDef | null;
  liftingDays: number;
  options: SplitOption[];
  /** The user's explicit, valid choice (if any). */
  requested?: SplitKey;
  /** True when the plan uses exactly the user's explicit choice. */
  explicit: boolean;
  recommended: boolean;
  /**
   * Visible explanation when an explicit choice didn't fit the current days. `message` is canonical English (it is
   * persisted in the version's warnings): display it with `localizeGeneratedText` from ./localize.
   */
  adjustment?: { kind: 'mapped' | 'fallback'; message: string };
}

/**
 * Resolve the structure for `liftingDays` effective lifting sessions. An explicit preference that
 * doesn't fit keeps its intent (same family, else a structure that also fits that intent), otherwise
 * falls back to the recommendation — and says so.
 */
export function resolveSplit(a: Pick<OnboardingAnswers, 'goal' | 'experience' | 'splitPreference'>, liftingDays: number): SplitResolution {
  const entries = entriesFor(a.goal, liftingDays);
  const options = splitOptions(a, liftingDays);
  const requested = isSplitKey(a.splitPreference) ? a.splitPreference : undefined;
  if (!entries.length) return { key: null, def: null, liftingDays, options, requested, explicit: false, recommended: false };
  const sized = (key: SplitKey): SplitDef => (key === 'es' ? { ...SPLITS.es, days: SPLITS.es.days.slice(0, liftingDays) } : SPLITS[key]);
  const result = (key: SplitKey, adjustment?: SplitResolution['adjustment']): SplitResolution => ({
    key,
    def: sized(key),
    liftingDays,
    options,
    requested,
    explicit: !!requested && requested === key,
    recommended: key === entries[0].key,
    adjustment,
  });
  if (!requested) return result(entries[0].key);
  if (entries.some((e) => e.key === requested)) return result(requested);

  const fam = splitFamily(requested);
  const near = entries.find((e) => e.family === fam) ?? entries.find((e) => e.alsoFits?.includes(fam));
  const endurance = a.goal === 'endurance';
  const requestedSplit = SPLITS[requested].label;
  if (near) {
    const base = endurance ? 'program.split.fallbackEndurance' : 'program.split.fallbackLifting';
    return result(near.key, { kind: 'mapped', message: tp(base, liftingDays, { requestedSplit, actualSplit: SPLITS[near.key].label }, 'en') });
  }
  const base = endurance ? 'program.split.recommendedEndurance' : 'program.split.recommendedLifting';
  return result(entries[0].key, {
    kind: 'fallback',
    message: tp(base, liftingDays, { requestedSplit, actualSplit: SPLITS[entries[0].key].label }, 'en'),
  });
}

/** Split key used by a generated version's lifting sessions (template ids are `<split>:<day>`). */
export function splitKeyOfVersion(version: { templates: { id: string; kind: string }[] }): SplitKey | null {
  const key = version.templates.find((t) => t.kind === 'lifting')?.id.split(':')[0];
  return isSplitKey(key) ? key : null;
}
