/**
 * Recipe cards under an AI reply (ai_messages.action kind 'recipe_suggestions', from find_recipes). Catalog recipes only;
 * macros per serving were computed on the server from ingredient data. Every button acts on this device only:
 *  - Open → the recipe screen (its prep guide; Log this meal is there);
 *  - Add to plan… → pick a day this week and a meal; added to the week's meal plan (Undo in the toast);
 *  - Save → account favourites (toggle, so tapping again undoes it).
 * The card shows only the name, total time and protein per serving — the recipe screen has the rest.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { CalendarPlus, Star } from 'lucide-react';
import { Button, Segmented, Select, Sheet } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { newRecord, saveRecord } from '@/db/repo';
import { addDays, formatDate, startOfWeek, todayISO } from '@/lib/dates';
import { MEAL_LABELS, MEAL_ORDER } from '@/domain/nutrition/recipes';
import { addPlanItem, removePlanItem } from '@/domain/nutrition/mealplan';
import type { RecipeSuggestions } from '@/domain/nutrition/aiActions';
import type { MealPlan, MealSlot } from '@/domain/types';
import { useWeekPlan } from '@/features/nutrition/shared';

type Recipe = RecipeSuggestions['recipes'][number];

export function RecipeCards({ suggestions }: { suggestions: RecipeSuggestions }) {
  const [planFor, setPlanFor] = useState<Recipe | null>(null);
  return (
    <section aria-label="Suggested recipes" className="mt-2 space-y-2">
      {suggestions.recipes.map((r) => (
        <RecipeCard key={r.id} r={r} onPlan={() => setPlanFor(r)} />
      ))}
      {planFor && <AddToPlanSheet r={planFor} onClose={() => setPlanFor(null)} />}
    </section>
  );
}

function RecipeCard({ r, onPlan }: { r: Recipe; onPlan: () => void }) {
  const { account, updateAccount } = useApp();
  const toast = useToast();
  const fav = account.favorites.recipes.includes(r.id);
  async function toggleFav() {
    try {
      await updateAccount((a) => {
        const cur = a.favorites.recipes;
        return { ...a, favorites: { ...a.favorites, recipes: cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id] } };
      });
      toast.show(fav ? 'Removed from favourites' : 'Saved to favourites', { tone: 'success' });
    } catch {
      toast.show('Could not update favourites.', { tone: 'error' });
    }
  }
  return (
    <article aria-label={r.name} data-testid="ai-recipe-card" className="rounded-2xl border border-line bg-surface px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-[15px] min-w-0 break-words">{r.name}</h3>
        <span className="text-xs text-muted shrink-0">
          {MEAL_LABELS[r.meal]} · {r.totalMinutes} min
        </span>
      </div>
      <p className="text-xs text-muted mt-0.5">
        <strong className="text-ink">{Math.round(r.perServing.protein_g)} g protein</strong> per serving
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Link to={`/nutrition/recipes/${encodeURIComponent(r.id)}`} className="inline-flex items-center min-h-9 px-3 rounded-xl border border-line text-sm font-medium hover:bg-surface-2">
          Open
        </Link>
        <Button size="sm" variant="ghost" icon={<CalendarPlus className="size-4" />} onClick={onPlan}>
          Add to plan…
        </Button>
        <Button size="sm" variant="ghost" aria-pressed={fav} icon={<Star className={fav ? 'size-4 fill-current text-accent' : 'size-4'} />} onClick={() => void toggleFav()}>
          {fav ? 'Saved' : 'Save'}
        </Button>
      </div>
    </article>
  );
}

function AddToPlanSheet({ r, onClose }: { r: Recipe; onClose: () => void }) {
  const { account, db } = useApp();
  const toast = useToast();
  const today = todayISO(account.settings.timeZone);
  const weekStart = startOfWeek(today, account.settings.weekStart);
  const plan = useWeekPlan(weekStart);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).filter((x) => x >= today);
  const [date, setDate] = useState(dates[0] ?? today);
  const [slot, setSlot] = useState<MealSlot>(r.meal);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (plan === undefined) return;
    setBusy(true);
    try {
      const base: Omit<MealPlan, 'id' | 'createdAt' | 'updatedAt'> =
        plan ?? { weekStart, days: Array.from({ length: 7 }, (_, i) => ({ date: addDays(weekStart, i), items: [] })), shoppingChecked: [] };
      const next = addPlanItem(base, date, slot, r.id, 1);
      const added = next.days.find((x) => x.date === date)?.items.at(-1);
      const saved = await saveRecord('meal_plans', plan ? ({ ...plan, ...next } as MealPlan) : newRecord(next), db);
      onClose();
      toast.show(`${r.name} added to ${formatDate(date, { weekday: 'long' })}`, {
        tone: 'success',
        action: added
          ? {
              label: 'Undo',
              onClick: () => void saveRecord('meal_plans', removePlanItem(saved, date, added.id), db).catch(() => undefined),
            }
          : undefined,
      });
    } catch {
      toast.show('Could not add it to your plan.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Add ${r.name} to your plan`}
      footer={
        <Button variant="primary" className="w-full" loading={busy} disabled={plan === undefined || !dates.length} onClick={() => void add()}>
          Add to plan
        </Button>
      }
    >
      <div className="space-y-3">
        {dates.length ? (
          <Select label="Day" value={date} onChange={(e) => setDate(e.target.value)}>
            {dates.map((x) => (
              <option key={x} value={x}>
                {x === today ? 'Today' : formatDate(x, { weekday: 'long', day: 'numeric', month: 'short' })}
              </option>
            ))}
          </Select>
        ) : (
          <p className="text-sm text-muted">This week is over.</p>
        )}
        <Segmented<MealSlot> label="Meal" value={slot} onChange={setSlot} options={MEAL_ORDER.map((m) => ({ value: m, label: MEAL_LABELS[m] }))} />
      </div>
    </Sheet>
  );
}
