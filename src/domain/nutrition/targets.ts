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
import { numberText, t, tp, type MessageKey } from '@/i18n';

/** Numbers inside explanation sentences: up to 3 decimals ("1.375"), never grouped. */
const num = (v: number) => numberText(v, 3);
const signed = (v: number) => `${v > 0 ? '+' : ''}${num(v)}`;

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

/** "Mostly sitting" in the app language (ACTIVITY_LABELS stays the canonical English). */
export function activityLabel(level: ActivityLevel): string {
  return t(`nutrition.targets.activity.${level}` as MessageKey);
}

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
/** "Strength" in the app language (GOAL_LABELS stays the canonical English). */
export function goalLabel(goal: Goal): string {
  return t(`nutrition.targets.goal.${goal}` as MessageKey);
}
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
      t('nutrition.calc.incompatible', { protein: num(proteinG), proteinKcal: num(proteinG * 4), fat: num(fatG), fatKcal: num(fatG * 9), kcal: num(calories) }),
    );
    return { proteinG, fatG, carbsG: null, energyKcal: proteinG * 4 + fatG * 9, warnings, incompatible: true };
  }
  const carbsG = Math.round(leftover / KCAL_PER_G.carbs);
  if (carbsG < 50) warnings.push(t('nutrition.calc.low_carbs', { grams: num(carbsG) }));
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
    return { energyKcal: null, diffKcal: null, ok: false, warnings: [t('nutrition.calc.negative')] };
  }
  if (parts.some((v) => v == null) || m.calories == null) {
    // Partial targets are allowed; only check that what's given doesn't exceed calories.
    if (m.calories != null) {
      const known = (m.proteinG ?? 0) * 4 + (m.carbsG ?? 0) * 4 + (m.fatG ?? 0) * 9;
      if (known > m.calories * 1.05)
        warnings.push(t('nutrition.calc.partial_over', { kcal: num(Math.round(known)), target: num(m.calories) }));
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
      t(diff > 0 ? 'nutrition.calc.mismatch_above' : 'nutrition.calc.mismatch_below', {
        protein: num(m.proteinG!), carbs: num(m.carbsG!), fat: num(m.fatG!), kcal: num(Math.round(energy)), diff: num(Math.abs(Math.round(diff))), target: num(m.calories),
      }),
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
    explanation.push(t('nutrition.calc.individualized_1'), t('nutrition.calc.individualized_2'));
    return { targets: { ...base, mode: 'manual', autoDisabledReason: 'individualized' }, explanation, warnings };
  }
  if (input.age != null && input.age < 18) {
    explanation.push(t('nutrition.calc.under18_1'), t('nutrition.calc.under18_2'));
    return { targets: { ...base, mode: 'manual', autoDisabledReason: 'under_18' }, explanation, warnings };
  }

  /* ---------------- protein */
  if (perKgRaw !== perKg) warnings.push(t('nutrition.calc.per_kg_limited', { perKg: num(perKg), min: num(PROTEIN_PER_KG_LIMITS.min), max: num(PROTEIN_PER_KG_LIMITS.max) }));
  const source = input.referenceWeightSource ?? (input.referenceWeightKg != null && input.weightKg == null ? 'custom' : 'current');
  const refKg = source === 'current' ? input.weightKg : input.referenceWeightKg;
  const sourceLabel = t(`nutrition.calc.source.${source}`);
  let proteinG: number | undefined;
  if (refKg == null || !(refKg > 0)) {
    warnings.push(
      source === 'current'
        ? t('nutrition.calc.need_current_weight')
        : t('nutrition.calc.need_reference_weight'),
    );
  } else {
    proteinG = proteinTarget(refKg, perKg);
    const range = { min: num(PROTEIN_RANGE.min), max: num(PROTEIN_RANGE.max), default: num(PROTEIN_RANGE.default) };
    explanation.push(t('nutrition.calc.reference_weight', { weight: fmtKg(refKg, unit), source: sourceLabel }));
    explanation.push(t('nutrition.calc.protein', { kg: num(round(refKg, 1)), perKg: num(perKg), grams: num(proteinG), ...range }));
    if (perKg > PROTEIN_RANGE.max) warnings.push(t('nutrition.calc.above_range', { perKg: num(perKg), max: range.max }));
    if (perKg < PROTEIN_RANGE.min) explanation.push(t('nutrition.calc.below_range', { perKg: num(perKg), min: range.min, max: range.max }));
    const per = Math.round(proteinG / mealsPerDay);
    explanation.push(tp('nutrition.calc.spread', mealsPerDay, { grams: num(per) }));
  }
  const targets: NutritionTargets = { ...base, proteinG, referenceWeightKg: refKg, referenceWeightSource: source };
  if (input.age == null) explanation.push(t('nutrition.calc.age_missing'));

  if (input.mode === 'protein_only') return { targets, explanation, warnings };

  /* ---------------- energy */
  const missing: string[] = [];
  if (input.weightKg == null) missing.push(t('nutrition.calc.missing_item.weight'));
  if (input.heightCm == null) missing.push(t('nutrition.calc.missing_item.height'));
  if (input.age == null) missing.push(t('nutrition.calc.missing_item.age'));
  if (input.sexParam == null) missing.push(t('nutrition.calc.missing_item.sex'));
  if (missing.length) {
    warnings.push(tp('nutrition.calc.missing', missing.length, { items: missing.join(', ') }));
    return { targets, explanation, warnings };
  }
  const w = input.weightKg!;
  const h = input.heightCm!;
  const a = input.age!;
  const sex = input.sexParam!;
  const resting = mifflinStJeor({ weightKg: w, heightCm: h, age: a, sex });
  explanation.push(
    t('nutrition.calc.resting', {
      sex: t(`nutrition.calc.sex.${sex}`),
      kg: num(round(w, 1)),
      cm: num(round(h, 1)),
      age: num(a),
      sexTerm: sex === 'male' ? '+ 5' : '− 161',
      kcal: num(Math.round(resting)),
    }),
  );
  const stdFactor = ACTIVITY_FACTORS[input.activityLevel];
  let factor = input.activityFactor ?? stdFactor;
  if (!(factor >= 1.0 && factor <= 2.5)) {
    warnings.push(t('nutrition.calc.factor_invalid'));
    factor = stdFactor;
  }
  const maintenance = resting * factor;
  explanation.push(
    t('nutrition.calc.maintenance', {
      resting: num(Math.round(resting)),
      factor: num(factor),
      factorSource: factor === stdFactor ? t('nutrition.calc.factor_standard', { activity: activityLabel(input.activityLevel) }) : t('nutrition.calc.factor_custom'),
      kcal: num(Math.round(maintenance)),
    }),
  );
  let adj = input.goalAdjustPct ?? GOAL_ADJUST_PCT[input.goal];
  if (adj < GOAL_ADJUST_LIMITS.min || adj > GOAL_ADJUST_LIMITS.max) {
    const clamped = Math.min(GOAL_ADJUST_LIMITS.max, Math.max(GOAL_ADJUST_LIMITS.min, adj));
    warnings.push(t('nutrition.calc.goal_limited', { pct: num(clamped) }));
    adj = clamped;
  }
  const calories = Math.round((maintenance * (1 + adj / 100)) / 10) * 10;
  explanation.push(
    t('nutrition.calc.goal', { goal: goalLabel(input.goal), pct: signed(adj), kcal: num(calories) }),
  );

  const pG = proteinG ?? proteinTarget(w, perKg);
  if (proteinG == null) explanation.push(t('nutrition.calc.macro_protein', { grams: num(pG) }));
  const split = allocateMacros(calories, pG, refKg ?? w);
  warnings.push(...split.warnings);
  explanation.push(
    t('nutrition.calc.fat', { share: num(Math.round(FAT_SHARE * 100 * 10) / 10), floor: num(FAT_FLOOR_G_PER_KG), grams: num(split.fatG), kcal: num(split.fatG * 9) }),
  );
  if (split.carbsG != null) {
    explanation.push(t('nutrition.calc.carbs', { grams: num(split.carbsG) }));
    explanation.push(
      t('nutrition.calc.check', { protein: num(pG), carbs: num(split.carbsG), fat: num(split.fatG), kcal: num(split.energyKcal), target: num(calories) }),
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
