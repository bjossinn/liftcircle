/**
 * Protein, energy and macro targets — pure, documented, testable.
 *
 * Evidence vs product defaults:
 * - Protein 1.6–2.2 g/kg/day is a practical planning range for healthy adults doing resistance training
 *   (Morton et al. 2018, BJSM). 1.8 g/kg is a product default inside that range, not an individual requirement.
 * - Resting energy uses the Mifflin–St Jeor equation (Mifflin et al. 1990).
 * - Activity multipliers (1.2 … 1.9) and goal adjustments (+5 % / −10 %) are standard, adjustable
 *   starting assumptions, not measurements.
 * - Fat ≈ 27.5 % of energy (inside a common 25–30 % allocation) with a 0.6 g/kg floor; carbohydrate is the remainder.
 */
import type { ActivityLevel, Goal, NutritionTargets, SexParam, WeightUnit } from '@/domain/types';
import { formatWeight, round } from '@/domain/units';

export const PROTEIN_RANGE = { min: 1.6, max: 2.2, default: 1.8 } as const;
/** Inputs outside this are rejected as typos rather than silently used. */
export const PROTEIN_PER_KG_LIMITS = { min: 0.8, max: 3.0 } as const;

export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very: 1.725,
  extra: 1.9,
};
export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary: 'Mostly sitting',
  light: 'Lightly active',
  moderate: 'Moderately active',
  very: 'Very active',
  extra: 'Extra active',
};

/** Starting energy adjustment by goal, in percent of estimated maintenance. */
export const GOAL_ADJUST_PCT: Record<Goal, number> = {
  general_fitness: 0,
  strength: 0,
  endurance: 0,
  build_muscle: 5,
  lose_fat: -10,
};
export const GOAL_LABELS: Record<Goal, string> = {
  general_fitness: 'General fitness',
  strength: 'Strength',
  endurance: 'Endurance',
  build_muscle: 'Build muscle',
  lose_fat: 'Lose fat',
};
/** Adjustments beyond this are clamped: avoid aggressive targets. */
export const GOAL_ADJUST_LIMITS = { min: -20, max: 15 } as const;

export const FAT_SHARE = 0.275;
export const FAT_FLOOR_G_PER_KG = 0.6;
export const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 } as const;

export interface TargetInput {
  age?: number;
  weightKg?: number;
  heightCm?: number;
  sexParam?: SexParam;
  activityLevel: ActivityLevel;
  goal: Goal;
  mode: 'protein_only' | 'full';
  proteinPerKg?: number;
  referenceWeightKg?: number;
  referenceWeightSource?: 'current' | 'goal' | 'custom';
  mealsPerDay: number;
  individualizedNutrition?: boolean;
  goalAdjustPct?: number;
  activityFactor?: number;
  /** Display unit for weights inside explanation strings (default kg). */
  weightUnit?: WeightUnit;
}

/** Daily protein target in grams (rounded to whole grams). 100 kg × 1.8 = 180 g. */
export function proteinTarget(referenceKg: number, perKg: number = PROTEIN_RANGE.default): number {
  return Math.round(round(referenceKg * perKg, 4));
}

/** Mifflin–St Jeor resting energy (kcal/day), unrounded. */
export function mifflinStJeor(p: { weightKg: number; heightCm: number; age: number; sex: SexParam }): number {
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
  return p.sex === 'male' ? base + 5 : base - 161;
}

export interface MacroSplit {
  proteinG: number;
  fatG: number;
  carbsG: number | null;
  /** 4P + 4C + 9F with the rounded grams. */
  energyKcal: number;
  warnings: string[];
  incompatible: boolean;
}

/** Allocate fat and carbs around a protein target. Never returns negative carbohydrate. */
export function allocateMacros(calories: number, proteinG: number, fatFloorKg: number): MacroSplit {
  const warnings: string[] = [];
  const fatFromShare = Math.round((calories * FAT_SHARE) / KCAL_PER_G.fat);
  const fatFloor = Math.round(fatFloorKg * FAT_FLOOR_G_PER_KG);
  const fatG = Math.max(fatFromShare, fatFloor);
  const leftover = calories - proteinG * KCAL_PER_G.protein - fatG * KCAL_PER_G.fat;
  if (leftover < 0) {
    warnings.push(
      `Protein (${proteinG} g = ${proteinG * 4} kcal) plus the minimum fat (${fatG} g = ${fatG * 9} kcal) already exceeds ${calories} kcal. ` +
        'These targets are incompatible: lower the protein per kg, raise calories, or set targets manually.',
    );
    return { proteinG, fatG, carbsG: null, energyKcal: proteinG * 4 + fatG * 9, warnings, incompatible: true };
  }
  const carbsG = Math.round(leftover / KCAL_PER_G.carbs);
  if (carbsG < 50) warnings.push(`Only about ${carbsG} g carbohydrate is left after protein and fat. That is very low for most training; consider adjusting.`);
  return { proteinG, fatG, carbsG, energyKcal: proteinG * 4 + carbsG * 4 + fatG * 9, warnings, incompatible: false };
}

/** Check user-entered macros against calories (4/4/9). */
export function reconcileMacros(m: { calories?: number; proteinG?: number; carbsG?: number; fatG?: number }): {
  energyKcal: number | null;
  diffKcal: number | null;
  ok: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const parts = [m.proteinG, m.carbsG, m.fatG];
  if ([m.proteinG, m.carbsG, m.fatG, m.calories].some((v) => v != null && (v < 0 || !isFinite(v)))) {
    return { energyKcal: null, diffKcal: null, ok: false, warnings: ['Targets cannot be negative.'] };
  }
  if (parts.some((v) => v == null) || m.calories == null) {
    // Partial targets are allowed; only check that what's given doesn't exceed calories.
    if (m.calories != null) {
      const known = (m.proteinG ?? 0) * 4 + (m.carbsG ?? 0) * 4 + (m.fatG ?? 0) * 9;
      if (known > m.calories * 1.05)
        warnings.push(`The macros you entered add up to ${Math.round(known)} kcal, more than your ${m.calories} kcal target.`);
      return { energyKcal: null, diffKcal: null, ok: warnings.length === 0, warnings };
    }
    return { energyKcal: null, diffKcal: null, ok: true, warnings };
  }
  const energy = m.proteinG! * 4 + m.carbsG! * 4 + m.fatG! * 9;
  const diff = energy - m.calories;
  // Tolerance: 5 % or 25 kcal, whichever is larger (rounding and label noise).
  const tol = Math.max(25, m.calories * 0.05);
  const ok = Math.abs(diff) <= tol;
  if (!ok)
    warnings.push(
      `Protein ${m.proteinG} g × 4 + carbs ${m.carbsG} g × 4 + fat ${m.fatG} g × 9 = ${Math.round(energy)} kcal, ` +
        `which is ${Math.abs(Math.round(diff))} kcal ${diff > 0 ? 'above' : 'below'} your ${m.calories} kcal target.`,
    );
  return { energyKcal: energy, diffKcal: diff, ok, warnings };
}

const fmtKg = (kg: number, unit: WeightUnit) => formatWeight(round(kg, 1), unit);

/**
 * Compute targets and a human-readable explanation of every step.
 * Rules: under 18 → no automatic calorie / weight-loss prescription (and no adult protein prescription);
 * individualized nutrition → nothing generated, manual targets only; missing inputs → explain and allow manual.
 */
export function computeNutritionTargets(input: TargetInput): { targets: NutritionTargets; explanation: string[]; warnings: string[] } {
  const unit = input.weightUnit ?? 'kg';
  const explanation: string[] = [];
  const warnings: string[] = [];
  const mealsPerDay = Math.min(6, Math.max(1, Math.round(input.mealsPerDay || 3)));
  const perKgRaw = input.proteinPerKg ?? PROTEIN_RANGE.default;
  const perKg = Math.min(PROTEIN_PER_KG_LIMITS.max, Math.max(PROTEIN_PER_KG_LIMITS.min, perKgRaw));
  const base: NutritionTargets = { mode: input.mode, proteinPerKg: perKg, mealsPerDay, autoDisabledReason: null, updatedAt: Date.now() };

  if (input.individualizedNutrition) {
    explanation.push(
      'You told us your nutrition needs individual guidance (for example pregnancy, breastfeeding or a medical condition), so LiftCircle does not generate targets.',
      'You can still log food and set your own targets, ideally with your healthcare professional or a registered dietitian.',
    );
    return { targets: { ...base, mode: 'manual', autoDisabledReason: 'individualized' }, explanation, warnings };
  }
  if (input.age != null && input.age < 18) {
    explanation.push(
      'Automatic calorie, weight-loss and protein targets are designed for adults, so they are turned off for under-18s.',
      'You can still log food and set your own targets. A doctor or registered dietitian can help with what suits you.',
    );
    return { targets: { ...base, mode: 'manual', autoDisabledReason: 'under_18' }, explanation, warnings };
  }

  /* ---------------- protein */
  if (perKgRaw !== perKg) warnings.push(`Protein per kg was limited to ${perKg} g/kg (allowed ${PROTEIN_PER_KG_LIMITS.min}–${PROTEIN_PER_KG_LIMITS.max}).`);
  const source = input.referenceWeightSource ?? (input.referenceWeightKg != null && input.weightKg == null ? 'custom' : 'current');
  const refKg = source === 'current' ? input.weightKg : input.referenceWeightKg;
  const sourceLabel = source === 'current' ? 'your current weight' : source === 'goal' ? 'the goal weight you chose' : 'a reference weight you entered';
  let proteinG: number | undefined;
  if (refKg == null || !(refKg > 0)) {
    warnings.push(
      source === 'current'
        ? 'Add your current weight (or choose a reference weight) to calculate a protein target. You can also set one manually.'
        : 'Enter the reference weight you want to use, or set a protein target manually.',
    );
  } else {
    proteinG = proteinTarget(refKg, perKg);
    explanation.push(`Reference weight: ${fmtKg(refKg, unit)} (${sourceLabel}). We never estimate an "ideal weight".`);
    explanation.push(
      `Protein: ${round(refKg, 1)} kg × ${perKg} g/kg = ${proteinG} g per day. ` +
        `${PROTEIN_RANGE.min}–${PROTEIN_RANGE.max} g/kg is a practical range for adults who lift; ${PROTEIN_RANGE.default} g/kg is our editable starting point, not an exact requirement.`,
    );
    if (perKg > PROTEIN_RANGE.max) warnings.push(`${perKg} g/kg is above the ${PROTEIN_RANGE.max} g/kg range. Higher intake isn't automatically better.`);
    if (perKg < PROTEIN_RANGE.min) explanation.push(`${perKg} g/kg is below the ${PROTEIN_RANGE.min}–${PROTEIN_RANGE.max} g/kg range often used for muscle growth. That's your choice to make.`);
    const per = Math.round(proteinG / mealsPerDay);
    explanation.push(`Spread across ${mealsPerDay} meal${mealsPerDay === 1 ? '' : 's'}: about ${per} g each.`);
  }
  const targets: NutritionTargets = { ...base, proteinG, referenceWeightKg: refKg, referenceWeightSource: source };
  if (input.age == null) explanation.push('Age not provided: these targets assume you are an adult (18+).');

  if (input.mode === 'protein_only') return { targets, explanation, warnings };

  /* ---------------- energy */
  const missing: string[] = [];
  if (input.weightKg == null) missing.push('current weight');
  if (input.heightCm == null) missing.push('height');
  if (input.age == null) missing.push('age');
  if (input.sexParam == null) missing.push('the sex option for the equation');
  if (missing.length) {
    warnings.push(
      `A calorie estimate needs ${missing.join(', ')}. Add ${missing.length === 1 ? 'it' : 'them'} to get an estimate, or set calories and macros manually.`,
    );
    return { targets, explanation, warnings };
  }
  const w = input.weightKg!;
  const h = input.heightCm!;
  const a = input.age!;
  const sex = input.sexParam!;
  const resting = mifflinStJeor({ weightKg: w, heightCm: h, age: a, sex });
  explanation.push(
    `Resting energy (Mifflin–St Jeor, ${sex}): 10 × ${round(w, 1)} kg + 6.25 × ${round(h, 1)} cm − 5 × ${a} y ${sex === 'male' ? '+ 5' : '− 161'} = ${Math.round(resting)} kcal. This is energy at rest, not your total daily use.`,
  );
  const stdFactor = ACTIVITY_FACTORS[input.activityLevel];
  let factor = input.activityFactor ?? stdFactor;
  if (!(factor >= 1.0 && factor <= 2.5)) {
    warnings.push('Activity factor must be between 1.0 and 2.5; using the standard value instead.');
    factor = stdFactor;
  }
  const maintenance = resting * factor;
  explanation.push(
    `Estimated maintenance: ${Math.round(resting)} × ${factor} (${factor === stdFactor ? `standard multiplier for "${ACTIVITY_LABELS[input.activityLevel]}"` : 'your custom activity factor'}) = ${Math.round(maintenance)} kcal. Activity multipliers are rough assumptions; adjust if your trend says otherwise.`,
  );
  let adj = input.goalAdjustPct ?? GOAL_ADJUST_PCT[input.goal];
  if (adj < GOAL_ADJUST_LIMITS.min || adj > GOAL_ADJUST_LIMITS.max) {
    const clamped = Math.min(GOAL_ADJUST_LIMITS.max, Math.max(GOAL_ADJUST_LIMITS.min, adj));
    warnings.push(`Goal adjustment limited to ${clamped}% to avoid an aggressive target.`);
    adj = clamped;
  }
  const calories = Math.round((maintenance * (1 + adj / 100)) / 10) * 10;
  explanation.push(
    `Goal (${GOAL_LABELS[input.goal]}): ${adj > 0 ? '+' : ''}${adj}% → about ${calories} kcal per day. This is an adjustable starting assumption, not a guaranteed rate of change. Exercise calories are not added back automatically.`,
  );

  const pG = proteinG ?? proteinTarget(w, perKg);
  if (proteinG == null) explanation.push(`For macros, protein uses your current weight: ${pG} g.`);
  const split = allocateMacros(calories, pG, refKg ?? w);
  warnings.push(...split.warnings);
  explanation.push(
    `Fat: the larger of ${Math.round(FAT_SHARE * 100 * 10) / 10}% of calories and ${FAT_FLOOR_G_PER_KG} g/kg → ${split.fatG} g (${split.fatG * 9} kcal).`,
  );
  if (split.carbsG != null) {
    explanation.push(`Carbohydrate: the remaining energy ÷ 4 → ${split.carbsG} g.`);
    explanation.push(
      `Check: ${pG} × 4 + ${split.carbsG} × 4 + ${split.fatG} × 9 = ${split.energyKcal} kcal (target ${calories} kcal).`,
    );
  }
  return {
    targets: {
      ...targets,
      ...(proteinG == null ? { proteinG: pG, referenceWeightKg: w, referenceWeightSource: 'current' as const } : {}),
      calories,
      restingKcal: Math.round(resting),
      activityFactor: factor,
      goalAdjustPct: adj,
      fatG: split.incompatible ? undefined : split.fatG,
      carbsG: split.carbsG ?? undefined,
    },
    explanation,
    warnings,
  };
}
