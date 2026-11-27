/**
 * Match exercise names from other apps ("Bench Press (Barbell)", "Pull Up (Assisted)") to the exercise library.
 *
 * Order (first hit wins):
 *  1. Known Strong/Hevy names that the rules below would miss or get wrong (KNOWN_NAMES).
 *  2. The whole name against every library name and alias (bundled + the user's custom exercises).
 *  3. "Base (Qualifier)": qualifier + base ("Dumbbell bench press"), then base + qualifier ("Shoulder press machine"),
 *     then the base alone — but only when the library exercise uses the equipment the qualifier names, so
 *     "Bench Press (Smith Machine)" never silently becomes the barbell bench press. A " - variant" suffix
 *     ("Seated Cable Row - V Grip") is dropped as a last try.
 *  4. No match → the caller creates a custom exercise (never dropped).
 *
 * Comparison ignores case, accents, punctuation, spacing ("Pull-up" = "Pull Up" = "pullup") and a plural "s" on each
 * word ("Biceps curl" = "Bicep Curl").
 */
import type { Equipment, Exercise, ID } from '@/domain/types';
import { normalizeText } from '@/data/exerciseMeta';

/** Canonical comparison key: normalized words without a trailing plural "s", joined without spaces. */
export function matchKey(name: string): string {
  return normalizeText(name)
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join('');
}

/** Strong / Hevy names (as matchKey) → library id, where the generic rules can't tell. */
const KNOWN_NAMES: Record<string, ID> = Object.fromEntries(
  (
    [
      ['Bicep Curl (Barbell)', 'barbell-curl'],
      ['Bicep Curl (EZ Bar)', 'barbell-curl'],
      ['EZ Bar Biceps Curl', 'barbell-curl'],
      ['Curl (Barbell)', 'barbell-curl'],
      ['Bicep Curl (Band)', 'band-curl'],
      ['Hammer Curl (Dumbbell)', 'hammer-curl'],
      ['Incline Bench Press (Dumbbell)', 'incline-dumbbell-press'],
      ['Incline Bench Press (Barbell)', 'incline-barbell-press'],
      ['Bench Press (Dumbbell)', 'dumbbell-bench-press'],
      ['Chest Press (Machine)', 'machine-chest-press'],
      ['Shoulder Press (Machine)', 'machine-shoulder-press'],
      ['Seated Shoulder Press (Machine)', 'machine-shoulder-press'],
      ['Overhead Press (Dumbbell)', 'dumbbell-overhead-press'],
      ['Seated Overhead Press (Dumbbell)', 'seated-dumbbell-shoulder-press'],
      ['Shoulder Press (Dumbbell)', 'seated-dumbbell-shoulder-press'],
      ['Squat (Barbell)', 'barbell-back-squat'],
      ['Back Squat (Barbell)', 'barbell-back-squat'],
      ['Squat (Bodyweight)', 'bodyweight-squat'],
      ['Air Squat', 'bodyweight-squat'],
      ['Goblet Squat (Kettlebell)', 'goblet-squat'],
      ['Goblet Squat (Dumbbell)', 'goblet-squat'],
      ['Deadlift (Barbell)', 'conventional-deadlift'],
      ['Romanian Deadlift (Dumbbell)', 'dumbbell-romanian-deadlift'],
      ['Stiff Leg Deadlift (Barbell)', 'romanian-deadlift'],
      ['Hip Thrust (Barbell)', 'barbell-hip-thrust'],
      ['Bent Over Row (Barbell)', 'barbell-row'],
      ['Bent Over Row (Dumbbell)', 'dumbbell-bent-over-row'],
      ['Dumbbell Row', 'one-arm-dumbbell-row'],
      ['Single Arm Dumbbell Row', 'one-arm-dumbbell-row'],
      ['Seated Row (Cable)', 'seated-cable-row'],
      ['Seated Cable Row - V Grip (Cable)', 'seated-cable-row'],
      ['Seated Cable Row - Bar Grip', 'seated-cable-row'],
      ['Seated Row (Machine)', 'machine-row'],
      ['Lat Pulldown (Cable)', 'lat-pulldown'],
      ['Lat Pulldown (Machine)', 'lat-pulldown'],
      ['Lat Pulldown - Close Grip (Cable)', 'lat-pulldown'],
      ['Pull Up (Assisted)', 'assisted-pull-up'],
      ['Assisted Pull Up', 'assisted-pull-up'],
      ['Pull Up (Band)', 'band-assisted-pull-up'],
      ['Pull Up (Weighted)', 'weighted-pull-up'],
      ['Weighted Pull Up', 'weighted-pull-up'],
      ['Chin Up (Assisted)', 'assisted-pull-up'],
      ['Dip (Weighted)', 'weighted-dip'],
      ['Chest Dip (Weighted)', 'weighted-dip'],
      ['Triceps Dip', 'dip'],
      ['Chest Dip', 'dip'],
      ['Triceps Pushdown (Cable - Straight Bar)', 'triceps-pushdown'],
      ['Triceps Rope Pushdown', 'triceps-pushdown'],
      ['Triceps Pushdown (Band)', 'band-triceps-pushdown'],
      ['Triceps Extension (Dumbbell)', 'overhead-dumbbell-triceps-extension'],
      ['Overhead Triceps Extension (Dumbbell)', 'overhead-dumbbell-triceps-extension'],
      ['Skullcrusher (Barbell)', 'skull-crusher'],
      ['Skullcrusher (EZ Bar)', 'skull-crusher'],
      ['Lying Triceps Extension (Barbell)', 'skull-crusher'],
      ['Lateral Raise (Dumbbell)', 'dumbbell-lateral-raise'],
      ['Lateral Raise (Cable)', 'cable-lateral-raise'],
      ['Lateral Raise (Band)', 'band-lateral-raise'],
      ['Reverse Fly (Dumbbell)', 'rear-delt-fly'],
      ['Rear Delt Reverse Fly (Dumbbell)', 'rear-delt-fly'],
      ['Chest Fly (Dumbbell)', 'dumbbell-fly'],
      ['Chest Fly (Cable)', 'cable-fly'],
      ['Cable Crossover', 'cable-fly'],
      ['Face Pull (Cable)', 'face-pull'],
      ['Leg Extension (Machine)', 'leg-extension'],
      ['Leg Curl (Machine)', 'lying-leg-curl'],
      ['Lying Leg Curl (Machine)', 'lying-leg-curl'],
      ['Seated Leg Curl (Machine)', 'seated-leg-curl'],
      ['Leg Press (Machine)', 'leg-press'],
      ['Leg Press Horizontal (Machine)', 'leg-press'],
      ['Hack Squat (Machine)', 'hack-squat'],
      ['Standing Calf Raise (Machine)', 'standing-calf-raise'],
      ['Calf Raise (Machine)', 'standing-calf-raise'],
      ['Seated Calf Raise (Machine)', 'seated-calf-raise'],
      ['Seated Calf Raise (Plate Loaded)', 'seated-calf-raise'],
      ['Lunge (Dumbbell)', 'dumbbell-reverse-lunge'],
      ['Reverse Lunge (Dumbbell)', 'dumbbell-reverse-lunge'],
      ['Walking Lunge (Dumbbell)', 'walking-lunge'],
      ['Step Up (Dumbbell)', 'dumbbell-step-up'],
      ['Bulgarian Split Squat (Dumbbell)', 'bulgarian-split-squat'],
      ['Hanging Knee Raise', 'hanging-knee-raise'],
      ['Knee Raise (Captain’s Chair)', 'hanging-knee-raise'],
      ['Farmers Walk', 'farmer-carry'],
      ['Farmer’s Walk (Dumbbell)', 'farmer-carry'],
      ['Kettlebell Swing', 'kettlebell-swing'],
      ['Back Extension (Hyperextension)', 'back-extension'],
      ['Hyperextension', 'back-extension'],
      ['Push Up', 'push-up'],
      ['Rowing (Machine)', 'rowing-machine'],
      ['Rowing Machine', 'rowing-machine'],
      ['Cycling (Indoor)', 'stationary-bike'],
      ['Bike (Stationary)', 'stationary-bike'],
      ['Spinning', 'stationary-bike'],
      ['Treadmill Walk (Incline)', 'incline-treadmill-walk'],
      ['Plank', 'plank'],
      ['Side Plank', 'side-plank'],
      ['Burpee', 'burpee'],
      ['Jumping Jack', 'jumping-jack'],
      ['Mountain Climber', 'mountain-climber'],
    ] as [string, ID][]
  ).map(([name, id]) => [matchKey(name), id]),
);

/** Qualifier words ("Dumbbell", "Cable - Straight Bar", "Smith Machine") → equipment they name. */
const QUALIFIER_EQUIPMENT: [RegExp, Equipment[]][] = [
  [/\bsmith\b/, ['smith']],
  [/\bez ?bar\b/, ['ez_bar', 'barbell']],
  [/\bbarbell\b|\bolympic\b/, ['barbell', 'ez_bar']],
  [/\bdumbbells?\b/, ['dumbbell']],
  [/\bkettlebells?\b/, ['kettlebell']],
  [/\bcable\b/, ['cable']],
  [/\bmachine\b|\bplate loaded\b|\blever\b/, ['machine']],
  [/\bbands?\b/, ['band']],
  [/\bbody ?weight\b/, ['bodyweight', 'pullup_bar', 'dip_station']],
];

/** Equipment named by a qualifier; empty when the qualifier isn't an equipment word ("Standing", "Wide Grip"). */
export function qualifierEquipment(qualifier: string): Equipment[] {
  const q = normalizeText(qualifier);
  return [...new Set(QUALIFIER_EQUIPMENT.filter(([re]) => re.test(q)).flatMap(([, eq]) => eq))];
}

/** "Bench Press (Barbell)" → { base: "Bench Press", qualifier: "Barbell" }. */
export function splitQualifier(name: string): { base: string; qualifier: string | null } {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(name.trim());
  return m && m[1] ? { base: m[1], qualifier: m[2] } : { base: name.trim(), qualifier: null };
}

export interface ExerciseMatcher {
  match(name: string): Exercise | null;
}

/** Build a matcher over the library (bundled exercises first, then custom ones). */
export function createMatcher(library: Exercise[]): ExerciseMatcher {
  const byId = new Map(library.map((e) => [e.id, e]));
  const index = new Map<string, Exercise>();
  // Names win over aliases: index all names first, then aliases where the key is still free.
  for (const e of library) {
    const k = matchKey(e.name);
    if (k && !index.has(k)) index.set(k, e);
  }
  for (const e of library) {
    for (const a of e.aliases ?? []) {
      const k = matchKey(a);
      if (k && !index.has(k)) index.set(k, e);
    }
  }
  const lookup = (s: string) => (s ? index.get(matchKey(s)) ?? null : null);

  const compatible = (ex: Exercise, qualifier: string) => {
    const q = normalizeText(qualifier);
    if (/\bassist/.test(q)) return ex.tracking === 'assisted';
    if (/\bweighted\b/.test(q)) return ex.tracking === 'bodyweight_plus';
    const eq = qualifierEquipment(qualifier);
    return eq.length > 0 && ex.equipment.some((e) => eq.includes(e));
  };

  const matchBase = (base: string, qualifier: string | null): Exercise | null => {
    if (!qualifier) return lookup(base);
    const hit = lookup(`${qualifier} ${base}`) ?? lookup(`${base} ${qualifier}`);
    if (hit) return hit;
    const plain = lookup(base);
    return plain && compatible(plain, qualifier) ? plain : null;
  };

  return {
    match(name: string): Exercise | null {
      const trimmed = name.trim();
      if (!trimmed) return null;
      // Custom exercises with exactly this name (e.g. created by an earlier import) win over the known-name table.
      const exact = lookup(trimmed);
      if (exact?.custom) return exact;
      const known = KNOWN_NAMES[matchKey(trimmed)];
      if (known && byId.has(known)) return byId.get(known)!;
      if (exact) return exact;
      const { base, qualifier } = splitQualifier(trimmed);
      const hit = matchBase(base, qualifier);
      if (hit) return hit;
      // "Seated Cable Row - V Grip (Cable)" → "Seated Cable Row (Cable)"
      const dash = base.split(/\s+[-–]\s+/)[0];
      if (dash !== base) return matchBase(dash, qualifier) ?? (qualifier ? null : lookup(dash));
      return null;
    },
  };
}
