import type {
  Difficulty, Equipment, Exercise, ExerciseCategory, LimitationArea, LoadConvention, MovementPattern, MuscleGroup, TrackingType,
} from '@/domain/types';
import { getLanguage, localeFor, t, tKey, type Language, type MessageKey } from '@/i18n';
import { exerciseAliases, exerciseDisplayName } from './catalogText';
import { LANGUAGES } from '../../supabase/functions/_shared/i18n/core';

/*
 * Display labels for catalog metadata. Each record reads the approved dictionary (workout.meta.*) in the app's CURRENT
 * language on every lookup, so existing `MUSCLE_LABELS[m]` callers render Icelandic when the UI is Icelandic and the
 * same English as before otherwise. Keys (enum values) never change. Use the *Label(value, lang) functions to ask for
 * a specific language.
 */
type MetaGroup = 'muscle' | 'equipment' | 'pattern' | 'tracking' | 'load' | 'category' | 'difficulty' | 'limitation';

const metaKey = (group: MetaGroup, value: string | number) => `workout.meta.${group}.${value}` as MessageKey;

/** Label of one metadata value in `lang` (default: the current language). Unknown values are returned as given. */
export function metaLabel(group: MetaGroup, value: string | number, lang: Language = getLanguage()): string {
  return tKey(metaKey(group, value), String(value), undefined, lang);
}

function liveLabels<K extends string | number>(group: MetaGroup, values: readonly K[]): Record<K, string> {
  const o = {} as Record<K, string>;
  for (const v of values) Object.defineProperty(o, v, { enumerable: true, get: () => metaLabel(group, v) });
  return Object.freeze(o);
}

export const MUSCLE_LABELS: Record<MuscleGroup, string> = liveLabels<MuscleGroup>('muscle', [
  'chest', 'upper_back', 'lats', 'shoulders', 'rear_delts', 'biceps', 'triceps', 'forearms', 'quads', 'hamstrings', 'glutes',
  'calves', 'adductors', 'abs', 'obliques', 'lower_back', 'full_body', 'cardio',
]);

export const EQUIPMENT_LABELS: Record<Equipment, string> = liveLabels<Equipment>('equipment', [
  'barbell', 'rack', 'bench', 'dumbbell', 'kettlebell', 'machine', 'cable', 'band', 'bodyweight', 'pullup_bar', 'dip_station',
  'ez_bar', 'smith', 'cardio_machine',
]);

export const PATTERN_LABELS: Record<MovementPattern, string> = liveLabels<MovementPattern>('pattern', [
  'squat', 'lunge', 'hinge', 'horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull', 'trunk', 'carry',
  'isolation_upper', 'isolation_lower', 'conditioning', 'mobility',
]);

export const TRACKING_LABELS: Record<TrackingType, string> = liveLabels<TrackingType>('tracking', [
  'weight_reps', 'reps', 'bodyweight_plus', 'assisted', 'duration', 'distance_time',
]);

export const LOAD_LABELS: Record<LoadConvention, string> = liveLabels<LoadConvention>('load', ['total', 'per_hand', 'stack', 'added', 'assistance', 'none']);

export const CATEGORY_LABELS: Record<ExerciseCategory, string> = liveLabels<ExerciseCategory>('category', ['compound', 'isolation', 'core', 'cardio', 'mobility']);

export const DIFFICULTY_LABELS: Record<Difficulty, string> = liveLabels<Difficulty>('difficulty', [1, 2, 3]);

export const LIMITATION_LABELS: Record<LimitationArea, string> = liveLabels<LimitationArea>('limitation', [
  'knee', 'shoulder', 'lower_back', 'hip', 'wrist', 'elbow', 'neck', 'ankle',
]);

export const muscleLabel = (m: MuscleGroup, lang?: Language) => metaLabel('muscle', m, lang);
export const equipmentLabel = (e: Equipment, lang?: Language) => metaLabel('equipment', e, lang);
export const patternLabel = (p: MovementPattern, lang?: Language) => metaLabel('pattern', p, lang);
export const trackingLabel = (x: TrackingType, lang?: Language) => metaLabel('tracking', x, lang);
export const loadLabel = (l: LoadConvention, lang?: Language) => metaLabel('load', l, lang);
export const categoryLabel = (c: ExerciseCategory, lang?: Language) => metaLabel('category', c, lang);
export const difficultyLabel = (d: Difficulty, lang?: Language) => metaLabel('difficulty', d, lang);
export const limitationLabel = (l: LimitationArea, lang?: Language) => metaLabel('limitation', l, lang);

/** Load conventions that make sense for each tracking type (first = default). */
export const LOADS_FOR_TRACKING: Record<TrackingType, LoadConvention[]> = {
  weight_reps: ['total', 'per_hand', 'stack'],
  reps: ['none'],
  bodyweight_plus: ['added'],
  assisted: ['assistance'],
  duration: ['none', 'total', 'per_hand'],
  distance_time: ['none', 'per_hand', 'total'],
};

/** Default smallest load step for a convention (kg and lb). */
export function defaultIncrement(load: LoadConvention): { kg: number; lb: number } | undefined {
  switch (load) {
    case 'total':
    case 'added':
      return { kg: 2.5, lb: 5 };
    case 'per_hand':
      return { kg: 2, lb: 5 };
    case 'stack':
    case 'assistance':
      return { kg: 5, lb: 10 };
    default:
      return undefined;
  }
}

type Implement = 'Dumbbell' | 'Kettlebell' | 'Implement';
function implementOf(ex: Exercise): Implement {
  if (ex.equipment.includes('kettlebell')) return 'Kettlebell';
  if (ex.equipment.includes('dumbbell')) return 'Dumbbell';
  return 'Implement';
}
const PER_HAND_PAIR: Record<Implement, MessageKey> = {
  Dumbbell: 'workout.loadNote.perHandDumbbells',
  Kettlebell: 'workout.loadNote.perHandKettlebells',
  Implement: 'workout.loadNote.perHandImplement',
};

/**
 * Plain-language explanation of what the entered load and rep numbers mean, in `lang` (default: the current language).
 * Complete approved sentences per equipment (no translated noun spliced into a template). Null when there is nothing
 * worth explaining.
 */
export function loadConventionNote(ex: Exercise, lang: Language = getLanguage()): string | null {
  const keys: MessageKey[] = [];
  const w = implementOf(ex);
  switch (ex.load) {
    case 'per_hand':
      keys.push((ex.implements ?? 1) === 2 ? PER_HAND_PAIR[w] : (`workout.loadNote.single${w}` as MessageKey));
      break;
    case 'total':
      if (ex.equipment.includes('barbell') || ex.equipment.includes('ez_bar') || ex.equipment.includes('smith')) keys.push('workout.loadNote.includingBar');
      else keys.push(`workout.loadNote.total${w}` as MessageKey);
      break;
    case 'stack':
      keys.push('workout.loadNote.machine');
      break;
    case 'added':
      keys.push('workout.loadNote.added');
      break;
    case 'assistance':
      keys.push('workout.loadNote.assistance');
      break;
    case 'none':
      if (ex.equipment.includes('band')) keys.push('workout.loadNote.band');
      break;
  }
  if (ex.tracking === 'duration') keys.push(ex.unilateral ? 'workout.loadNote.timePerSide' : 'workout.loadNote.timePerSet');
  else if (ex.tracking === 'distance_time') keys.push(ex.unilateral ? 'workout.loadNote.distanceTimePerSide' : 'workout.loadNote.distanceTime');
  else if (ex.unilateral) keys.push('workout.loadNote.repsPerSide');
  return keys.length ? keys.map((k) => t(k, undefined, lang)).join(' ') : null;
}

/* ------------------------------------------------------------- search */

/**
 * Lowercase, strip diacritics, unify punctuation to spaces. Icelandic letters without a decomposition are folded
 * first (þ → th, ð → d, æ → ae) so "þríhöfði" and "hnébeygja" are searchable; English text is unaffected.
 */
export function normalizeText(s: string): string {
  return s
    .replace(/[þÞ]/g, 'th')
    .replace(/[ðÐ]/g, 'd')
    .replace(/[æÆ]/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface Indexed {
  /** Catalog English name. */
  name: string;
  /** Name shown in each app language (the translation for catalog exercises, the typed name for custom ones). */
  byLang: Record<Language, string>;
  aliases: string[];
  primary: string[];
  secondary: string[];
  equipment: string[];
  pattern: string[];
}

/**
 * Everyday Icelandic words for a muscle that the dictionary supplies as limitation labels ("Axlir" for the shoulders,
 * "Mjóbak" for the lower back). Used only as extra search terms.
 */
const MUSCLE_SEARCH_EXTRA: Partial<Record<MuscleGroup, LimitationArea>> = { shoulders: 'shoulder', lower_back: 'lower_back' };

/**
 * Search terms for one metadata value: the label in EVERY app language plus the raw enum value, so English aliases
 * keep working in Icelandic and Icelandic words ("axlir", "teygja", "hnébeygja") find the English catalog. Catalog
 * exercise names and aliases are indexed the same way (see indexOf).
 */
function terms(group: MetaGroup, value: string): string[] {
  const out = new Set<string>([normalizeText(value)]);
  for (const lang of LANGUAGES) out.add(normalizeText(metaLabel(group, value, lang)));
  if (group === 'muscle') {
    const extra = MUSCLE_SEARCH_EXTRA[value as MuscleGroup];
    if (extra) for (const lang of LANGUAGES) out.add(normalizeText(metaLabel('limitation', extra, lang)));
  }
  return [...out];
}

const indexCache = new WeakMap<Exercise, Indexed>();
function indexOf(ex: Exercise): Indexed {
  let ix = indexCache.get(ex);
  if (!ix) {
    ix = {
      // Catalog exercises: the name and aliases in every app language (plus the English), so "bekkpressa" and
      // "bench press" both match whatever the UI language is. Custom exercises: what the user typed.
      name: normalizeText(ex.name),
      byLang: Object.fromEntries(LANGUAGES.map((lang) => [lang, normalizeText(exerciseDisplayName(ex, undefined, lang))])) as Record<Language, string>,
      aliases: [
        ...new Set(
          [...ex.aliases, ...LANGUAGES.flatMap((lang) => [exerciseDisplayName(ex, undefined, lang), ...exerciseAliases(ex, lang)])].map(normalizeText),
        ),
      ].filter(Boolean),
      primary: ex.primaryMuscles.flatMap((m) => terms('muscle', m)),
      secondary: ex.secondaryMuscles.flatMap((m) => terms('muscle', m)),
      equipment: ex.equipment.flatMap((e) => terms('equipment', e)),
      pattern: [...terms('pattern', ex.pattern), ...terms('category', ex.category)],
    };
    indexCache.set(ex, ix);
  }
  return ix;
}

const wordStart = (hay: string, q: string) => hay.startsWith(q) || hay.includes(` ${q}`);
/** Simple singular/plural tolerance: "dumbbell" ↔ "dumbbells", "lunges" → "lunge". */
const stem = (t: string) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);

/** Names that rank as a name match: the one shown in the UI language and the catalog English. Names in the other
 * languages rank as aliases (they are indexed in `aliases`). */
function scoreOne(ix: Indexed, q: string, lang: Language = getLanguage()): number {
  const names = ix.byLang[lang] === ix.name ? [ix.name] : [ix.byLang[lang], ix.name];
  if (names.some((n) => n.startsWith(q))) return 1000;
  if (names.some((n) => wordStart(n, q))) return 900;
  if (names.some((n) => n.includes(q))) return 800;
  if (ix.aliases.some((a) => a.startsWith(q) || a === q)) return 700;
  if (ix.aliases.some((a) => a.includes(q))) return 600;
  if (ix.primary.some((m) => wordStart(m, q))) return 500;
  if (ix.equipment.some((e) => wordStart(e, q))) return 450;
  if (ix.pattern.some((p) => wordStart(p, q))) return 420;
  if (ix.secondary.some((m) => wordStart(m, q))) return 400;
  return 0;
}

function scoreToken(ix: Indexed, t: string): number {
  const s = scoreOne(ix, t);
  if (s) return s;
  const st = stem(t);
  return st !== t ? scoreOne(ix, st) : 0;
}

/**
 * Search by name, aliases, muscles, equipment and movement pattern.
 * Case- and diacritic-insensitive. Ranking: name prefix > name contains > alias > muscle/equipment/pattern.
 * Multi-word queries match when every word matches somewhere; the whole phrase matching ranks first.
 */
export function searchExercises(
  list: Exercise[],
  query: string,
  filters?: { muscle?: MuscleGroup; equipment?: Equipment; pattern?: MovementPattern },
): Exercise[] {
  const filtered = list.filter((ex) => {
    if (filters?.muscle && !ex.primaryMuscles.includes(filters.muscle) && !ex.secondaryMuscles.includes(filters.muscle)) return false;
    if (filters?.equipment && !ex.equipment.includes(filters.equipment)) return false;
    if (filters?.pattern && ex.pattern !== filters.pattern) return false;
    return true;
  });
  const q = normalizeText(query);
  const lang = getLanguage();
  const collator = new Intl.Collator(localeFor(lang));
  const shown = new Map<Exercise, string>();
  const label = (e: Exercise) => {
    let n = shown.get(e);
    if (n == null) shown.set(e, (n = exerciseDisplayName(e, undefined, lang)));
    return n;
  };
  const byName = (a: Exercise, b: Exercise) => collator.compare(label(a), label(b));

  if (!q) {
    const m = filters?.muscle;
    return [...filtered].sort((a, b) => {
      if (m) {
        const pa = a.primaryMuscles.includes(m) ? 0 : 1;
        const pb = b.primaryMuscles.includes(m) ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      return byName(a, b);
    });
  }

  const tokens = q.split(' ').filter(Boolean);
  const scored: { ex: Exercise; score: number }[] = [];
  for (const ex of filtered) {
    const ix = indexOf(ex);
    let score = scoreToken(ix, q);
    if (!score && tokens.length > 1) {
      // Every token has to match something; rank by the weakest token match.
      let min = Infinity;
      for (const t of tokens) {
        const s = scoreToken(ix, t);
        if (!s) {
          min = 0;
          break;
        }
        min = Math.min(min, s);
      }
      score = min === Infinity ? 0 : min * 0.5;
    }
    if (score > 0) scored.push({ ex, score });
  }
  scored.sort((a, b) => b.score - a.score || byName(a.ex, b.ex));
  return scored.map((s) => s.ex);
}

/** Short one-line description used in lists: "Chest, triceps · Barbell, bench, rack" (labels in `lang`). */
export function exerciseSubtitle(ex: Exercise, lang: Language = getLanguage()): string {
  const muscles = ex.primaryMuscles.map((m) => muscleLabel(m, lang)).join(', ');
  const eq = ex.equipment.map((e) => equipmentLabel(e, lang)).join(', ');
  return [muscles, eq].filter(Boolean).join(' · ');
}
