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
import { SPLITS, type SplitDef } from './templates';

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
  tradeoff: (exp: Experience) => string;
}

const isNewer = (exp: Experience) => exp === 'new' || exp === 'returning';
const onceWeeklyNote = (exp: Experience) => (isNewer(exp) ? ' Newer lifters usually learn the lifts faster with more frequent practice.' : '');

/** First entry per day count = recommended default. */
const STRENGTH: Record<number, Entry[]> = {
  1: [{ key: 'fb1', family: 'full_body', alsoFits: ['upper_lower', 'ppl'], tradeoff: () => 'One session that practises every major movement — the only structure that covers everything on one day.' }],
  2: [
    { key: 'fb2', family: 'full_body', tradeoff: () => 'Each muscle group twice a week, and missing a session still leaves a complete workout.' },
    { key: 'ul2', family: 'upper_lower', alsoFits: ['ppl'], tradeoff: (e) => `More work per muscle in each session, but each muscle group is trained once a week.${onceWeeklyNote(e)}` },
  ],
  3: [
    { key: 'fb3', family: 'full_body', tradeoff: () => 'Main lifts practised three times a week with shorter sessions — the easiest to recover from.' },
    { key: 'ulf', family: 'upper_lower', alsoFits: ['full_body'], tradeoff: () => 'An upper, a lower and a full-body day — more work per session, upper and lower body each trained twice.' },
    { key: 'ppl3', family: 'ppl', tradeoff: (e) => `Most work per muscle in each session, but each muscle group is trained once a week and a missed day skips a whole area.${onceWeeklyNote(e)}` },
  ],
  4: [
    { key: 'ul4', family: 'upper_lower', alsoFits: ['ppl'], tradeoff: () => 'Each muscle group twice a week with focused sessions and a recovery day for each half.' },
    { key: 'fb4', family: 'full_body', tradeoff: () => 'Four shorter full-body sessions — frequent practice of every lift; handy when sessions are short.' },
  ],
  5: [
    { key: 'ulppl', family: 'ppl', alsoFits: ['upper_lower'], tradeoff: (e) => `Upper/lower plus push, pull and legs — high frequency and volume.${isNewer(e) ? ' Demanding to recover from when you’re newer.' : ''}` },
    { key: 'ul5', family: 'upper_lower', alsoFits: ['full_body'], tradeoff: () => 'Upper/lower twice plus a full-body day — twice-weekly frequency with less specialised days.' },
  ],
  6: [
    { key: 'ppl6', family: 'ppl', alsoFits: ['upper_lower'], tradeoff: () => 'Push, pull and legs twice each — high volume; needs good sleep and recovery.' },
    { key: 'ul6', family: 'upper_lower', tradeoff: () => 'Upper and lower three times each — high frequency with moderate work per session.' },
  ],
};

/** Endurance goal: supporting strength (1–2 sessions). */
const ENDURANCE: Record<number, Entry[]> = {
  1: [{ key: 'es', family: 'full_body', alsoFits: ['upper_lower', 'ppl'], tradeoff: () => 'One short full-body session for legs, hips, trunk and posture.' }],
  2: [
    { key: 'es', family: 'full_body', tradeoff: () => 'Two short full-body sessions that support your main activity without heavy leg fatigue on any one day.' },
    { key: 'ul2', family: 'upper_lower', alsoFits: ['ppl'], tradeoff: () => 'Legs and hips get one focused session, so the other strength day leaves your legs fresh for key sessions.' },
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

/** Selectable structures for this many lifting days, recommended one first. */
export function splitOptions(a: Pick<OnboardingAnswers, 'goal' | 'experience'>, liftingDays: number): SplitOption[] {
  return entriesFor(a.goal, liftingDays).map((e, i) => ({
    key: e.key,
    label: SPLITS[e.key].label,
    tradeoff: e.tradeoff(a.experience),
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
  /** Visible explanation when an explicit choice didn't fit the current days. */
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
  const what = a.goal === 'endurance' ? `${liftingDays} supporting strength day${liftingDays === 1 ? '' : 's'} with an endurance goal` : `${liftingDays} lifting day${liftingDays === 1 ? '' : 's'}`;
  const reqLabel = SPLITS[requested].label;
  if (near) {
    return result(near.key, { kind: 'mapped', message: `${reqLabel} doesn’t fit ${what}, so the plan uses the closest structure: ${SPLITS[near.key].label}.` });
  }
  return result(entries[0].key, {
    kind: 'fallback',
    message: `${reqLabel} doesn’t fit ${what}, so the plan uses the recommended ${SPLITS[entries[0].key].label}. You can pick another structure.`,
  });
}

/** Split key used by a generated version's lifting sessions (template ids are `<split>:<day>`). */
export function splitKeyOfVersion(version: { templates: { id: string; kind: string }[] }): SplitKey | null {
  const key = version.templates.find((t) => t.kind === 'lifting')?.id.split(':')[0];
  return isSplitKey(key) ? key : null;
}
