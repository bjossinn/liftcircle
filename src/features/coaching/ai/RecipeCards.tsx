/**
 * Recipe cards under an AI reply (ai_messages.action kind 'recipe_suggestions', from find_recipes). Catalog recipes only;
 * macros per serving were computed on the server from ingredient data. Every button acts on this device only:
 *  - Open → the recipe screen (its prep guide; Log this meal is there);
 *  - Add to plan… → pick a day this week and a meal; added to the week's meal plan (Undo in the toast);
 *  - Save → account favourites (toggle, so tapping again undoes it).
 * The card shows only the name, total time and protein per serving — the recipe screen has the rest — plus, when the
 * suggestion left an optional ingredient out or swapped one ("pancakes without raspberries"), a line saying so (1.0.3);
 * Open and Add to plan carry those swaps.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { CalendarPlus, Star } from 'lucide-react';
import { Button, Segmented, Select, Sheet } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { newRecord, saveRecord } from '@/db/repo';
import { addDays, formatDate, startOfWeek, todayISO } from '@/lib/dates';
import { LEFT_OUT, MEAL_ORDER, mealLabel, type Swap } from '@/domain/nutrition/recipes';
import { getLanguage, listText, locale, t as tr, useT, type Language } from '@/i18n';
import { ingredientDisplayName, recipeDisplayName } from '@/data/catalogText';
import { addPlanItem, removePlanItem, updatePlanItem } from '@/domain/nutrition/mealplan';
import { INGREDIENTS_BY_ID } from '@/data/ingredients';
import type { RecipeSuggestions } from '@/domain/nutrition/aiActions';
import type { MealPlan, MealSlot } from '@/domain/types';
import { useWeekPlan } from '@/features/nutrition/shared';
import { recipeLink } from '@/features/nutrition/recipeLink';

type Recipe = RecipeSuggestions['recipes'][number];

const ingName = (id: string, lang: Language) =>
  (INGREDIENTS_BY_ID.has(id) ? ingredientDisplayName(id, lang) : id).replace(/\s*\(.*\)\s*$/, '');
/** "Without blueberries · Strawberries instead of raspberries" / "Sleppt: … · Skipt út: … → …" (empty when the recipe
 *  is shown as written). Ingredient names are shown in the app language (catalog display text). */
export function changesText(r: Pick<Recipe, 'omit' | 'swaps'>, lang: Language = getLanguage()): string {
  const lower = (x: string) => x.toLocaleLowerCase(locale(lang));
  const parts = [
    ...(r.omit?.length ? [tr('aiCard.recipe.omitted', { ingredients: listText(r.omit.map((x) => lower(ingName(x, lang))), lang) }, lang)] : []),
    ...(r.swaps ?? []).map((s) => tr('aiCard.recipe.swap', { to: ingName(s.to, lang), from: lower(ingName(s.from, lang)) }, lang)),
  ];
  return parts.join(' · ');
}
/** The card's changes as recipe swaps: substitutes, plus optional ingredients left out (LEFT_OUT). These travel with
 *  Open (recipe screen → Log this meal / Add to meal plan) and Add to plan (plan item → nutrition, shopping list). */
export function cardSwaps(r: Pick<Recipe, 'omit' | 'swaps'>): Swap[] {
  return [...(r.swaps ?? []), ...(r.omit ?? []).filter((x) => !r.swaps?.some((s) => s.from === x)).map((from) => ({ from, to: LEFT_OUT }))];
}
/** Recipe screen link; swaps travel as ?swap=from:to,… (the recipe screen accepts only substitutes it lists). */
export function recipeHref(r: Pick<Recipe, 'id' | 'omit' | 'swaps'>): string {
  return recipeLink(r.id, cardSwaps(r));
}

export function RecipeCards({ suggestions }: { suggestions: RecipeSuggestions }) {
  const { t } = useT();
  const [planFor, setPlanFor] = useState<Recipe | null>(null);
  return (
    <section aria-label={t('aiCard.recipes.title')} className="mt-2 space-y-2">
      {suggestions.recipes.map((r) => (
        <RecipeCard key={r.id} r={r} onPlan={() => setPlanFor(r)} />
      ))}
      {planFor && <AddToPlanSheet r={planFor} onClose={() => setPlanFor(null)} />}
    </section>
  );
}

function RecipeCard({ r, onPlan }: { r: Recipe; onPlan: () => void }) {
  const { t, language } = useT();
  const { account, updateAccount } = useApp();
  const toast = useToast();
  const fav = account.favorites.recipes.includes(r.id);
  const name = recipeDisplayName(r.id, language, r.name);
  const changes = changesText(r, language);
  async function toggleFav() {
    try {
      await updateAccount((a) => {
        const cur = a.favorites.recipes;
        return { ...a, favorites: { ...a.favorites, recipes: cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id] } };
      });
      toast.show(fav ? t('aiCard.recipe.favRemoved') : t('aiCard.recipe.favSaved'), { tone: 'success' });
    } catch {
      toast.show(t('aiCard.recipe.favError'), { tone: 'error' });
    }
  }
  return (
    <article aria-label={name} data-testid="ai-recipe-card" className="rounded-2xl border border-line bg-surface px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-[15px] min-w-0 break-words">{name}</h3>
        <span className="text-xs text-muted shrink-0">
          {t('aiCard.recipe.time', { meal: mealLabel(r.meal, language), minutes: r.totalMinutes })}
        </span>
      </div>
      <p className="text-xs text-muted mt-0.5">
        {t('aiCard.recipe.proteinServing', { protein: Math.round(r.perServing.protein_g) })}
      </p>
      {changes && <p className="text-xs text-muted mt-0.5" data-testid="ai-recipe-changes">{changes}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Link to={recipeHref(r)} className="inline-flex items-center min-h-9 px-3 rounded-xl border border-line text-sm font-medium hover:bg-surface-2">
          {t('aiCard.recipe.open')}
        </Link>
        <Button size="sm" variant="ghost" icon={<CalendarPlus className="size-4" />} onClick={onPlan}>
          {t('aiCard.recipe.addToPlan')}
        </Button>
        <Button size="sm" variant="ghost" aria-pressed={fav} icon={<Star className={fav ? 'size-4 fill-current text-accent' : 'size-4'} />} onClick={() => void toggleFav()}>
          {fav ? t('aiCard.recipe.saved') : t('aiCard.recipe.save')}
        </Button>
      </div>
    </article>
  );
}

function AddToPlanSheet({ r, onClose }: { r: Recipe; onClose: () => void }) {
  const { t, language } = useT();
  const { account, db } = useApp();
  const toast = useToast();
  const today = todayISO(account.settings.timeZone);
  const weekStart = startOfWeek(today, account.settings.weekStart);
  const plan = useWeekPlan(weekStart);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).filter((x) => x >= today);
  const [date, setDate] = useState(dates[0] ?? today);
  const [slot, setSlot] = useState<MealSlot>(r.meal);
  const [busy, setBusy] = useState(false);
  const name = recipeDisplayName(r.id, language, r.name);

  async function add() {
    if (plan === undefined) return;
    setBusy(true);
    try {
      const base: Omit<MealPlan, 'id' | 'createdAt' | 'updatedAt'> =
        plan ?? { weekStart, days: Array.from({ length: 7 }, (_, i) => ({ date: addDays(weekStart, i), items: [] })), shoppingChecked: [] };
      let next = addPlanItem(base, date, slot, r.id, 1);
      const added = next.days.find((x) => x.date === date)?.items.at(-1);
      const swaps = cardSwaps(r);
      if (added && swaps.length) next = updatePlanItem(next, date, added.id, { swaps });
      const saved = await saveRecord('meal_plans', plan ? ({ ...plan, ...next } as MealPlan) : newRecord(next), db);
      onClose();
      toast.show(t('aiCard.recipe.addedToDay', { recipe: name, day: formatDate(date, { weekday: 'long' }) }), {
        tone: 'success',
        action: added
          ? {
              label: t('aiCard.undo'),
              onClick: () => void saveRecord('meal_plans', removePlanItem(saved, date, added.id), db).catch(() => undefined),
            }
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
      title={t('aiCard.recipe.addTitle', { recipe: name })}
      footer={
        <Button variant="primary" className="w-full" loading={busy} disabled={plan === undefined || !dates.length} onClick={() => void add()}>
          {t('aiCard.recipe.add')}
        </Button>
      }
    >
      <div className="space-y-3">
        {dates.length ? (
          <Select label={t('aiCard.recipe.day')} value={date} onChange={(e) => setDate(e.target.value)}>
            {dates.map((x) => (
              <option key={x} value={x}>
                {x === today ? t('aiCard.recipe.today') : formatDate(x, { weekday: 'long', day: 'numeric', month: 'short' })}
              </option>
            ))}
          </Select>
        ) : (
          <p className="text-sm text-muted">{t('aiCard.recipe.weekOver')}</p>
        )}
        <Segmented<MealSlot> label={t('aiCard.recipe.meal')} value={slot} onChange={setSlot} options={MEAL_ORDER.map((m) => ({ value: m, label: mealLabel(m, language) }))} />
      </div>
    </Sheet>
  );
}
