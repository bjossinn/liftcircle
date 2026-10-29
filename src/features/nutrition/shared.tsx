/** Shared hooks and small components for the nutrition screens. */
import { useLiveQuery } from 'dexie-react-hooks';
import { ProgressBar, cx } from '@/components/ui';
import { alive } from '@/db/repo';
import { useApp } from '@/state/app';
import type { AccountState, FoodLogEntry, ISODate, MealPlan, Measurement, NutritionTargets } from '@/domain/types';
import { planPrefsFrom, type PlanPrefs } from '@/domain/nutrition/mealplan';
import { displayMacro } from '@/domain/nutrition/recipes';
import { computeNutritionTargets, type TargetInput } from '@/domain/nutrition/targets';
import { remainingVsTargets, type DayTotals, type MacroKey } from '@/domain/nutrition/log';

export const MACRO_LABEL: Record<MacroKey, string> = { kcal: 'Calories', protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };
export const MACRO_UNIT: Record<MacroKey, string> = { kcal: 'kcal', protein: 'g', carbs: 'g', fat: 'g' };

export function fmtMacro(v: number | undefined | null, key: MacroKey): string {
  if (v == null) return '–';
  return key === 'kcal' ? `${displayMacro(v, key)} kcal` : `${displayMacro(v, key)} g`;
}

/** Latest logged bodyweight in kg; undefined while loading, null if none. */
export function useLatestWeightKg(): number | null | undefined {
  const { db } = useApp();
  return useLiveQuery(async () => {
    const rows = alive(await db.measurements.where('kind').equals('bodyweight').toArray()) as Measurement[];
    if (!rows.length) return null;
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
    return rows[0].value;
  }, [db]);
}

/** Food log entries for one date (live). undefined while loading. */
export function useDayEntries(date: ISODate): FoodLogEntry[] | undefined {
  const { db } = useApp();
  return useLiveQuery(async () => alive(await db.foodLogs.where('date').equals(date).toArray()), [db, date]);
}

/** Build calculator input from the account and latest weight, keeping saved assumptions. */
export function targetInputFrom(account: AccountState, weightKg: number | null | undefined, mode: 'protein_only' | 'full'): TargetInput {
  const p = account.profile;
  const n = account.nutrition;
  const source = n.referenceWeightSource ?? (weightKg == null && p.targetWeightKg ? 'goal' : 'current');
  return {
    age: p.age,
    weightKg: weightKg ?? undefined,
    heightCm: p.heightCm,
    sexParam: p.sexParam,
    activityLevel: p.activityLevel ?? 'light',
    goal: p.goal ?? 'general_fitness',
    mode,
    proteinPerKg: n.proteinPerKg,
    referenceWeightSource: source,
    referenceWeightKg: source === 'goal' ? p.targetWeightKg : source === 'custom' ? n.referenceWeightKg : undefined,
    mealsPerDay: p.diet.mealsPerDay || n.mealsPerDay || 3,
    individualizedNutrition: p.individualizedNutrition,
    activityFactor: n.activityFactor,
    goalAdjustPct: n.goalAdjustPct,
    weightUnit: account.settings.units.weight,
  };
}

export function computeFromAccount(account: AccountState, weightKg: number | null | undefined, mode: 'protein_only' | 'full') {
  return computeNutritionTargets(targetInputFrom(account, weightKg, mode));
}

/** Progress rows for the day: protein always (when targeted), the rest in full/manual modes. */
export function MacroProgress({ totals, targets, compact }: { totals: DayTotals; targets: NutritionTargets; compact?: boolean }) {
  const rows = remainingVsTargets(totals, targets).filter((r) => r.key === 'protein' || targets.mode === 'full' || targets.mode === 'manual');
  const shown = compact ? rows.filter((r) => r.key === 'protein' || r.key === 'kcal') : rows;
  return (
    <div className="flex flex-col gap-3">
      {shown.map((r) => {
        const missing = totals.missing[r.key];
        return (
          <div key={r.key}>
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <span className={cx('font-medium', r.key === 'protein' && !compact ? 'text-[15px]' : 'text-sm')}>{MACRO_LABEL[r.key]}</span>
              <span className="text-sm tabular">
                {r.partial && r.eaten > 0 ? 'at least ' : ''}
                <span className="font-semibold">{displayMacro(r.eaten, r.key)}</span>
                {r.target != null ? <span className="text-muted"> / {r.key === 'kcal' ? `${r.target} kcal` : `${r.target} g`}</span> : <span className="text-muted"> {MACRO_UNIT[r.key]}</span>}
              </span>
            </div>
            {r.target != null && <ProgressBar value={r.eaten} max={r.target} label={`${MACRO_LABEL[r.key]} progress`} tone={r.remaining != null && r.remaining < 0 && r.key === 'kcal' ? 'warn' : 'accent'} />}
            {!compact && (r.remaining != null || missing > 0) && (
              <p className="text-xs text-muted mt-1">
                {r.remaining != null &&
                  (r.remaining > 0
                    ? `${displayMacro(r.remaining, r.key)}${r.key === 'kcal' ? ' kcal' : ' g'} to go`
                    : r.remaining === 0
                      ? 'Target reached'
                      : `${displayMacro(-r.remaining, r.key)}${r.key === 'kcal' ? ' kcal' : ' g'} over target`)}
                {r.remaining != null && missing > 0 && ' · '}
                {missing > 0 && `${missing} item${missing === 1 ? '' : 's'} without a ${r.key === 'kcal' ? 'calorie' : MACRO_LABEL[r.key].toLowerCase()} value`}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AllergenNote({ className }: { className?: string }) {
  return (
    <p className={cx('text-xs text-muted', className)}>
      Allergen and diet filtering is based on generic ingredient data and can't guarantee safety. Always check the labels of packaged foods you buy.
    </p>
  );
}

/** Macros as a compact line: "420 kcal · 32 g protein". Unknown values are shown as "?". */
export function macroLine(e: { kcal?: number; protein?: number; carbs?: number; fat?: number }, full = true): string {
  const parts = [`${e.kcal != null ? displayMacro(e.kcal, 'kcal') : '?'} kcal`, `${e.protein != null ? displayMacro(e.protein, 'protein') : '?'} g protein`];
  if (full && (e.carbs != null || e.fat != null)) parts.push(`${e.carbs != null ? displayMacro(e.carbs, 'carbs') : '?'} C`, `${e.fat != null ? displayMacro(e.fat, 'fat') : '?'} F`);
  return parts.join(' · ');
}

export function prefsFromAccount(account: AccountState, variant = 0): PlanPrefs {
  return planPrefsFrom(account.profile.diet, account.nutrition, account.settings.nutritionEnabled, variant);
}

/** The live plan for a week (most recently edited if several). undefined while loading. */
export function useWeekPlan(weekStart: string): MealPlan | null | undefined {
  const { db } = useApp();
  return useLiveQuery(async () => {
    const rows = alive(await db.mealPlans.where('weekStart').equals(weekStart).toArray());
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    return rows[0] ?? null;
  }, [db, weekStart]);
}

