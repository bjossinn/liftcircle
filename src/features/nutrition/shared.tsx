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
import { getLanguage, numberText, t, useT, type Language } from '@/i18n';
import { INGREDIENTS_BY_ID } from '@/data/ingredients';
import { RECIPES_BY_ID } from '@/data/recipes';
import { ingredientDisplayName, recipeDisplayName } from '@/data/catalogText';

/** Macro display names in the current language (read at render). */
export const MACRO_LABEL: Readonly<Record<MacroKey, string>> = {
  get kcal() {
    return t('aiCard.macro.calories');
  },
  get protein() {
    return t('aiCard.macro.protein');
  },
  get carbs() {
    return t('aiCard.macro.carbs');
  },
  get fat() {
    return t('aiCard.macro.fat');
  },
};
export const MACRO_UNIT: Record<MacroKey, string> = { kcal: 'kcal', protein: 'g', carbs: 'g', fat: 'g' };

export function fmtMacro(v: number | undefined | null, key: MacroKey): string {
  if (v == null) return '–';
  return key === 'kcal' ? `${numberText(displayMacro(v, key))} kcal` : `${numberText(displayMacro(v, key))} g`;
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
  const { t, tp, language } = useT();
  // "at least {{amount}}" with the amount in bold: split the sentence around the amount.
  const [atLeastBefore, atLeastAfter] = t('aiCard.macro.atLeast', { amount: '\u0000' }).split('\u0000');
  return (
    <div className="flex flex-col gap-3">
      {shown.map((r) => {
        const missing = totals.missing[r.key];
        return (
          <div key={r.key}>
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <span className={cx('font-medium', r.key === 'protein' && !compact ? 'text-[15px]' : 'text-sm')}>{MACRO_LABEL[r.key]}</span>
              <span className="text-sm tabular">
                {r.partial && r.eaten > 0 ? atLeastBefore : ''}
                <span className="font-semibold">{numberText(displayMacro(r.eaten, r.key))}</span>
                {r.partial && r.eaten > 0 ? atLeastAfter : ''}
                {r.target != null ? <span className="text-muted"> / {`${numberText(r.target)} ${MACRO_UNIT[r.key]}`}</span> : <span className="text-muted"> {MACRO_UNIT[r.key]}</span>}
              </span>
            </div>
            {r.target != null && <ProgressBar value={r.eaten} max={r.target} label={t('aiCard.macro.progress', { macro: MACRO_LABEL[r.key] })} tone={r.remaining != null && r.remaining < 0 && r.key === 'kcal' ? 'warn' : 'accent'} />}
            {!compact && (r.remaining != null || missing > 0) && (
              <p className="text-xs text-muted mt-1">
                {r.remaining != null &&
                  (r.remaining > 0
                    ? t('aiCard.macro.remaining', { amount: displayMacro(r.remaining, r.key), unit: MACRO_UNIT[r.key] })
                    : r.remaining === 0
                      ? t('aiCard.macro.targetReached')
                      : t('aiCard.macro.overTarget', { amount: displayMacro(-r.remaining, r.key), unit: MACRO_UNIT[r.key] }))}
                {r.remaining != null && missing > 0 && ' · '}
                {missing > 0 &&
                  tp('aiCard.macro.missing', missing, {
                    macro: language === 'en' && r.key === 'kcal' ? 'calorie' : MACRO_LABEL[r.key].toLocaleLowerCase(language),
                  })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AllergenNote({ className }: { className?: string }) {
  const { t } = useT();
  return (
    <p className={cx('text-xs text-muted', className)}>
      {t('aiCard.nutrition.allergenNote')}
    </p>
  );
}

/** Macros as a compact line: "420 kcal · 32 g protein". Unknown values are shown as "?". */
export function macroLine(e: { kcal?: number; protein?: number; carbs?: number; fat?: number }, full = true): string {
  const amount = (v: number | undefined, key: MacroKey) => (v != null ? numberText(displayMacro(v, key)) : '?');
  const parts = [`${amount(e.kcal, 'kcal')} kcal`, t('aiCard.macro.lineProtein', { amount: amount(e.protein, 'protein') })];
  if (full && (e.carbs != null || e.fat != null))
    parts.push(t('aiCard.macro.lineCarbs', { amount: amount(e.carbs, 'carbs') }), t('aiCard.macro.lineFat', { amount: amount(e.fat, 'fat') }));
  return parts.join(' · ');
}

/** Suffix the recipe screen adds to the stored name when a recipe is logged with swaps (stored data, English). */
const WITH_SWAPS = ' (with swaps)';

/**
 * Name to show for a logged entry. The stored name stays as stored; when the entry refers to a bundled recipe or
 * ingredient and its name is still the catalog name (not renamed by the user), the localized catalog name is shown.
 */
export function entryDisplayName(e: Pick<FoodLogEntry, 'name' | 'source'>, lang: Language = getLanguage()): string {
  const ref = e.source?.refId;
  if (!ref) return e.name;
  if (e.source.kind === 'recipe') {
    const r = RECIPES_BY_ID.get(ref);
    if (!r) return e.name;
    if (e.name === r.name) return recipeDisplayName(r, lang);
    if (e.name === r.name + WITH_SWAPS) return t('nutrition.recipe.with_swaps_name', { name: recipeDisplayName(r, lang) }, lang);
    return e.name;
  }
  if (e.source.kind === 'ingredient') {
    const ing = INGREDIENTS_BY_ID.get(ref);
    return ing && e.name === ing.name ? ingredientDisplayName(ing, lang) : e.name;
  }
  return e.name;
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

