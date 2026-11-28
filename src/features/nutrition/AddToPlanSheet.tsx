/**
 * "Add to meal plan…" for one recipe: pick a day this week and a meal slot; the recipe is appended to this week's
 * meal plan (created if there is none yet) with an Undo in the toast. Same flow as the AI recipe cards
 * (src/features/coaching/ai/RecipeCards.tsx), plus the servings and ingredient swaps chosen on the recipe screen.
 */
import { useState } from 'react';
import { Button, NumberInput, Segmented, Select, Sheet } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { newRecord, saveRecord } from '@/db/repo';
import { addDays, formatDate, startOfWeek, todayISO } from '@/lib/dates';
import { MEAL_ORDER, mealLabel, type Swap } from '@/domain/nutrition/recipes';
import { recipeDisplayName } from '@/data/catalogText';
import { useT } from '@/i18n';
import { addPlanItem, removePlanItem, updatePlanItem } from '@/domain/nutrition/mealplan';
import type { ID, MealPlan, MealSlot } from '@/domain/types';
import { useWeekPlan } from './shared';

export function AddToPlanSheet({
  recipe,
  swaps = [],
  onClose,
}: {
  recipe: { id: ID; name: string; meal: MealSlot };
  swaps?: Swap[];
  onClose: () => void;
}) {
  const { account, db } = useApp();
  const toast = useToast();
  const { t, language } = useT();
  const today = todayISO(account.settings.timeZone);
  const weekStart = startOfWeek(today, account.settings.weekStart);
  const plan = useWeekPlan(weekStart);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).filter((x) => x >= today);
  const [date, setDate] = useState(dates[0] ?? today);
  const [slot, setSlot] = useState<MealSlot>(recipe.meal);
  const [servings, setServings] = useState<number | null>(1);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (plan === undefined || !servings || servings <= 0) return;
    setBusy(true);
    try {
      const base: Omit<MealPlan, 'id' | 'createdAt' | 'updatedAt'> =
        plan ?? { weekStart, days: Array.from({ length: 7 }, (_, i) => ({ date: addDays(weekStart, i), items: [] })), shoppingChecked: [] };
      let next = addPlanItem(base, date, slot, recipe.id, servings);
      const added = next.days.find((x) => x.date === date)?.items.at(-1);
      if (added && swaps.length) next = updatePlanItem(next, date, added.id, { swaps });
      const saved = await saveRecord('meal_plans', plan ? ({ ...plan, ...next } as MealPlan) : newRecord(next), db);
      onClose();
      toast.show(t('aiCard.recipe.addedToDay', { recipe: recipeDisplayName(recipe, language), day: formatDate(date, { weekday: 'long' }) }), {
        tone: 'success',
        action: added
          ? { label: t('workout.undo'), onClick: () => void saveRecord('meal_plans', removePlanItem(saved, date, added.id), db).catch(() => undefined) }
          : undefined,
      });
    } catch {
      toast.show(t('aiCard.recipe.addError'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t('nutrition.addToPlan.add_to_meal_plan')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={plan === undefined || !dates.length || !servings} onClick={() => void add()}>
            {t('aiCard.recipe.add')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {dates.length ? (
          <Select label={t('aiCard.recipe.day')} value={date} onChange={(e) => setDate(e.target.value)}>
            {dates.map((x) => (
              <option key={x} value={x}>
                {x === today ? t('nav.today') : formatDate(x, { weekday: 'long', day: 'numeric', month: 'short' })}
              </option>
            ))}
          </Select>
        ) : (
          <p className="text-sm text-muted">{t('aiCard.recipe.weekOver')}</p>
        )}
        <Segmented<MealSlot> label={t('aiCard.recipe.meal')} value={slot} onChange={setSlot} options={MEAL_ORDER.map((m) => ({ value: m, label: mealLabel(m, language) }))} />
        <NumberInput label={t('foodLog.custom.servings')} suffix="×" value={servings} min={0.25} max={12} step={0.25} onChange={setServings} error={servings ? null : t('nutrition.recipe.enter_servings')} />
        {swaps.length > 0 && <p className="text-xs text-muted">{t('nutrition.addToPlan.your_ingredient_swaps_are_kept_in')}</p>}
      </div>
    </Sheet>
  );
}
