import type {
  Difficulty, Equipment, Exercise, ExerciseCategory, LimitationArea, LoadConvention, MovementPattern, MuscleGroup, TrackingType,
} from '@/domain/types';

export const MUSCLE_LABELS: Record<MuscleGroup, string> = {
  chest: 'Chest',
  upper_back: 'Upper back',
  lats: 'Lats',
  shoulders: 'Shoulders',
  rear_delts: 'Rear delts',
  biceps: 'Biceps',
  triceps: 'Triceps',
  forearms: 'Forearms',
  quads: 'Quads',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes',
  calves: 'Calves',
  adductors: 'Adductors',
  abs: 'Abs',
  obliques: 'Obliques',
  lower_back: 'Lower back',
  full_body: 'Full body',
  cardio: 'Cardio',
};

export const EQUIPMENT_LABELS: Record<Equipment, string> = {
  barbell: 'Barbell',
  rack: 'Rack',
  bench: 'Bench',
  dumbbell: 'Dumbbells',
  kettlebell: 'Kettlebell',
  machine: 'Machine',
  cable: 'Cable',
  band: 'Band',
  bodyweight: 'Bodyweight',
  pullup_bar: 'Pull-up bar',
  dip_station: 'Dip station',
  ez_bar: 'EZ bar',
  smith: 'Smith machine',
  cardio_machine: 'Cardio machine',
};

export const PATTERN_LABELS: Record<MovementPattern, string> = {
  squat: 'Squat',
  lunge: 'Lunge',
  hinge: 'Hinge',
  horizontal_push: 'Horizontal push',
  vertical_push: 'Vertical push',
  horizontal_pull: 'Horizontal pull',
  vertical_pull: 'Vertical pull',
  trunk: 'Core',
  carry: 'Carry',
  isolation_upper: 'Upper-body isolation',
  isolation_lower: 'Lower-body isolation',
  conditioning: 'Conditioning',
  mobility: 'Mobility',
};

export const TRACKING_LABELS: Record<TrackingType, string> = {
  weight_reps: 'Weight × reps',
  reps: 'Reps only',
  bodyweight_plus: 'Bodyweight + added load',
  assisted: 'Assisted bodyweight',
  duration: 'Duration',
  distance_time: 'Distance / time',
};

export const LOAD_LABELS: Record<LoadConvention, string> = {
  total: 'Total weight',
  per_hand: 'Per hand',
  stack: 'Machine / cable stack',
  added: 'Added load',
  assistance: 'Assistance',
  none: 'No load',
};

export const CATEGORY_LABELS: Record<ExerciseCategory, string> = {
  compound: 'Compound',
  isolation: 'Isolation',
  core: 'Core',
  cardio: 'Cardio',
  mobility: 'Mobility',
};

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  1: 'Beginner-friendly',
  2: 'Intermediate',
  3: 'Technically demanding',
};

export const LIMITATION_LABELS: Record<LimitationArea, string> = {
  knee: 'Knees',
  shoulder: 'Shoulders',
  lower_back: 'Lower back',
  hip: 'Hips',
  wrist: 'Wrists',
  elbow: 'Elbows',
  neck: 'Neck',
  ankle: 'Ankles',
};

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

function implementWord(ex: Exercise): string {
  if (ex.equipment.includes('kettlebell')) return 'kettlebell';
  if (ex.equipment.includes('dumbbell')) return 'dumbbell';
  return 'implement';
}

/**
 * Plain-language explanation of what the entered load and rep numbers mean.
 * Returns null when there is nothing worth explaining.
 */
export function loadConventionNote(ex: Exercise): string | null {
  const parts: string[] = [];
  const w = implementWord(ex);
  switch (ex.load) {
    case 'per_hand':
      if ((ex.implements ?? 1) === 2) parts.push(`${cap(w)} weight is per hand. Enter one ${w}, not the pair.`);
      else parts.push(`Enter the weight of the single ${w} you hold.`);
      break;
    case 'total':
      if (ex.equipment.includes('barbell') || ex.equipment.includes('ez_bar') || ex.equipment.includes('smith'))
        parts.push('Enter the total weight including the bar.');
      else parts.push(`Enter the weight of the ${w}.`);
      break;
    case 'stack':
      parts.push('Weight is the machine or cable stack setting. It isn’t comparable with free weights or other machines.');
      break;
    case 'added':
      parts.push('Enter only the added weight (belt, vest or dumbbell), not your bodyweight. Leave it at 0 for bodyweight sets.');
      break;
    case 'assistance':
      parts.push('Enter the assistance setting. Less assistance means you’re getting stronger.');
      break;
    case 'none':
      if (ex.equipment.includes('band')) parts.push('Band tension isn’t counted as load. Note which band you used.');
      break;
  }
  if (ex.tracking === 'duration') parts.push(ex.unilateral ? 'Time is per side.' : 'Log the time for each set.');
  else if (ex.tracking === 'distance_time') parts.push(ex.unilateral ? 'Log distance and/or time per side.' : 'Log distance and/or time.');
  else if (ex.unilateral) parts.push('Reps are per side.');
  return parts.length ? parts.join(' ') : null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ------------------------------------------------------------- search */

/** Lowercase, strip diacritics, unify punctuation to spaces. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface Indexed {
  name: string;
  aliases: string[];
  primary: string[];
  secondary: string[];
  equipment: string[];
  pattern: string[];
}

const indexCache = new WeakMap<Exercise, Indexed>();
function indexOf(ex: Exercise): Indexed {
  let ix = indexCache.get(ex);
  if (!ix) {
    ix = {
      name: normalizeText(ex.name),
      aliases: ex.aliases.map(normalizeText),
      primary: ex.primaryMuscles.flatMap((m) => [normalizeText(MUSCLE_LABELS[m] ?? m), normalizeText(m)]),
      secondary: ex.secondaryMuscles.flatMap((m) => [normalizeText(MUSCLE_LABELS[m] ?? m), normalizeText(m)]),
      equipment: ex.equipment.flatMap((e) => [normalizeText(EQUIPMENT_LABELS[e] ?? e), normalizeText(e)]),
      pattern: [normalizeText(PATTERN_LABELS[ex.pattern] ?? ex.pattern), normalizeText(ex.pattern), normalizeText(CATEGORY_LABELS[ex.category] ?? ex.category)],
    };
    indexCache.set(ex, ix);
  }
  return ix;
}

const wordStart = (hay: string, q: string) => hay.startsWith(q) || hay.includes(` ${q}`);
/** Simple singular/plural tolerance: "dumbbell" ↔ "dumbbells", "lunges" → "lunge". */
const stem = (t: string) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);

function scoreOne(ix: Indexed, q: string): number {
  if (ix.name.startsWith(q)) return 1000;
  if (wordStart(ix.name, q)) return 900;
  if (ix.name.includes(q)) return 800;
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
  const byName = (a: Exercise, b: Exercise) => a.name.localeCompare(b.name);

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

/** Short one-line description used in lists: "Chest, triceps · Barbell, bench, rack". */
export function exerciseSubtitle(ex: Exercise): string {
  const muscles = ex.primaryMuscles.map((m) => MUSCLE_LABELS[m]).join(', ');
  const eq = ex.equipment.map((e) => EQUIPMENT_LABELS[e]).join(', ');
  return [muscles, eq].filter(Boolean).join(' · ');
}
