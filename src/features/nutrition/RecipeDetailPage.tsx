/**
 * Recipe screen (/nutrition/recipes/:id), laid out for cooking from a phone. In order: time; servings; macros per
 * serving; ingredients with tick-off boxes; numbered "How to make it" steps with tick-off; substitutions; notes; then
 * "Add to meal plan…", "Log this meal" and "Save to favourites". Ticks live in component state only (they reset when
 * you leave). The screen is kept awake while open where the browser supports the Screen Wake Lock API.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CalendarPlus, Check, ChevronLeft, Clock, Minus, NotebookPen, Plus, Repeat2, Star } from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton, Notice, NumberInput, Page, SectionTitle, Select, Sheet, Stat, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { newRecord, saveRecord } from '@/db/repo';
import { todayISO } from '@/lib/dates';
import type { ID, MealSlot } from '@/domain/types';
import { INGREDIENTS_BY_ID } from '@/data/ingredients';
import { RECIPES_BY_ID } from '@/data/recipes';
import {
  ALLERGEN_LABELS, DIET_TAG_LABELS, MEAL_LABELS, MEAL_ORDER, displayMacro, formatGrams, recipeAllergens, recipeDietTags, recipeMinutes,
  recipeNutrition, scaleRecipe, substitutesFor, type Swap,
} from '@/domain/nutrition/recipes';
import { entryFromRecipe } from '@/domain/nutrition/log';
import { holdWakeLock } from '@/features/train/feedback';
import { AllergenNote, macroLine } from './shared';
import { AddToPlanSheet } from './AddToPlanSheet';

export default function RecipeDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const recipe = RECIPES_BY_ID.get(id);
  const back = (
    <IconButton label="Back" onClick={() => nav(-1)}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );
  if (!recipe)
    return (
      <Page title="Recipe" back={back}>
        <EmptyState
          title="Recipe not found"
          body="It may have been renamed or removed."
          action={
            <Link to="/nutrition/recipes" className="text-accent font-medium">
              Browse recipes
            </Link>
          }
        />
      </Page>
    );
  return <RecipeView key={recipe.id} recipeId={recipe.id} back={back} />;
}

/** A tick-off row: a real checkbox with a large tap target; ticked rows are struck through. */
function TickRow({ checked, onChange, label, children, action }: { checked: boolean; onChange: (v: boolean) => void; label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex items-start gap-2 py-2.5">
      <label className="flex flex-1 min-w-0 items-start gap-3 cursor-pointer">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
        <span
          aria-hidden
          className={cx(
            'mt-0.5 shrink-0 size-6 rounded-md border-2 flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
            checked ? 'bg-accent border-accent text-accent-ink' : 'border-line',
          )}
        >
          {checked && <Check className="size-4" />}
        </span>
        <span className={cx('min-w-0 flex-1', checked && 'line-through text-muted')}>{children}</span>
      </label>
      {action}
    </li>
  );
}

function RecipeView({ recipeId, back }: { recipeId: ID; back: ReactNode }) {
  const recipe = RECIPES_BY_ID.get(recipeId)!;
  const { account, updateAccount } = useApp();
  const toast = useToast();
  const [servings, setServings] = useState(recipe.servings);
  const [swaps, setSwaps] = useState<Swap[]>([]);
  const [swapFor, setSwapFor] = useState<ID | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [haveIngredients, setHaveIngredients] = useState<ID[]>([]);
  const [doneSteps, setDoneSteps] = useState<number[]>([]);
  const fav = account.favorites.recipes.includes(recipe.id);

  // Keep the screen on while cooking. The helper re-acquires the lock when the page becomes visible again
  // (browsers drop it when hidden) and releases it on unmount.
  useEffect(() => holdWakeLock(), []);

  const nutrition = useMemo(() => recipeNutrition(recipe, { servings, swaps }), [recipe, servings, swaps]);
  const scaled = useMemo(() => scaleRecipe(recipe, servings, swaps), [recipe, servings, swaps]);
  const allergens = recipeAllergens(recipe, swaps);
  const tags = recipeDietTags(recipe, swaps);
  const clash = allergens.filter((a) => account.profile.diet.allergens.includes(a));
  const ps = nutrition.perServing;
  const ingName = (id: ID) => INGREDIENTS_BY_ID.get(id)?.name.toLowerCase() ?? id;

  async function toggleFav() {
    try {
      await updateAccount((a) => {
        const cur = a.favorites.recipes;
        return { ...a, favorites: { ...a.favorites, recipes: cur.includes(recipe.id) ? cur.filter((x) => x !== recipe.id) : [...cur, recipe.id] } };
      });
      toast.show(fav ? 'Removed from favourites' : 'Saved to favourites', { tone: 'success' });
    } catch {
      toast.show('Could not update favourites.', { tone: 'error' });
    }
  }
  const setSwap = (from: ID, to: ID | null) => setSwaps((s) => [...s.filter((x) => x.from !== from), ...(to && to !== from ? [{ from, to }] : [])]);
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v));

  return (
    <Page
      back={back}
      actions={
        <IconButton label={fav ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={fav} onClick={() => void toggleFav()}>
          <Star className={cx('size-5', fav ? 'fill-current text-accent' : '')} />
        </IconButton>
      }
    >
      <h1 className="text-2xl font-bold tracking-tight">{recipe.name}</h1>
      <p className="text-sm text-muted mt-1">
        {MEAL_LABELS[recipe.meal]} · makes {recipe.servings} serving{recipe.servings === 1 ? '' : 's'}
      </p>
      <div className="flex flex-wrap gap-1.5 mt-3">
        {tags.map((t) => (
          <Badge key={t} tone="accent">
            {DIET_TAG_LABELS[t]}
          </Badge>
        ))}
        {allergens.map((a) => (
          <Badge key={a} tone={clash.includes(a) ? 'danger' : 'warn'}>
            Contains {ALLERGEN_LABELS[a].toLowerCase()}
          </Badge>
        ))}
      </div>
      {clash.length > 0 && (
        <Notice tone="danger" className="mt-3">
          Contains {clash.map((a) => ALLERGEN_LABELS[a].toLowerCase()).join(', ')}, which {clash.length === 1 ? 'is' : 'are'} in your allergy settings. Try a swap below, or choose another recipe.
        </Notice>
      )}

      <section aria-labelledby="recipe-time" data-section="time">
        <SectionTitle id="recipe-time">Time</SectionTitle>
        <Card className="p-4 flex items-center gap-3">
          <Clock className="size-5 text-muted shrink-0" aria-hidden />
          <div>
            <div className="text-lg font-semibold tabular">{recipeMinutes(recipe)} min</div>
            <div className="text-xs text-muted">
              {recipe.prepMinutes} min prep{recipe.cookMinutes ? ` + ${recipe.cookMinutes} min cook` : ' · no cooking'}
            </div>
          </div>
        </Card>
      </section>

      <section aria-labelledby="recipe-servings" data-section="servings">
        <SectionTitle id="recipe-servings">Servings</SectionTitle>
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Cooking for</span>
            <div className="flex items-center gap-2" role="group" aria-label="Servings">
              <IconButton label="Fewer servings" onClick={() => setServings((s) => Math.max(1, s - 1))} disabled={servings <= 1} className="border border-line">
                <Minus className="size-4" />
              </IconButton>
              <span className="w-8 text-center text-lg font-semibold tabular" aria-live="polite" data-testid="servings-value">
                {servings}
              </span>
              <IconButton label="More servings" onClick={() => setServings((s) => Math.min(12, s + 1))} disabled={servings >= 12} className="border border-line">
                <Plus className="size-4" />
              </IconButton>
            </div>
          </div>
          <p className="text-xs text-muted mt-1">
            Whole recipe: {displayMacro(nutrition.total.kcal, 'kcal')} kcal · {displayMacro(nutrition.total.protein, 'protein')} g protein
          </p>
        </Card>
      </section>

      <section aria-labelledby="recipe-macros" data-section="macros">
        <SectionTitle id="recipe-macros">Per serving</SectionTitle>
        <Card className="p-4">
          <div className="grid grid-cols-4 gap-2">
            <Stat label="kcal" value={displayMacro(ps.kcal, 'kcal')} />
            <Stat label="Protein" value={`${displayMacro(ps.protein, 'protein')} g`} />
            <Stat label="Carbs" value={`${displayMacro(ps.carbs, 'carbs')} g`} />
            <Stat label="Fat" value={`${displayMacro(ps.fat, 'fat')} g`} />
          </div>
          <p className="text-xs text-muted mt-2">
            Estimated from generic ingredient data{swaps.length ? ' with your swaps' : ''}. Fibre about {displayMacro(ps.fiber ?? 0, 'fiber')} g.
          </p>
        </Card>
      </section>

      <section aria-labelledby="recipe-ingredients" data-section="ingredients">
        <SectionTitle
          id="recipe-ingredients"
          action={<span className="text-xs text-muted tabular">{haveIngredients.length} of {scaled.ingredients.length} ticked</span>}
        >
          Ingredients
        </SectionTitle>
        <Card className="px-4 py-1">
          <ul className="divide-y divide-line">
            {scaled.ingredients.map((r) => {
              const original = r.swappedFrom ?? r.ingredientId;
              const subs = substitutesFor(recipe, original);
              const name = r.ingredient?.name.toLowerCase() ?? r.ingredientId;
              return (
                <TickRow
                  key={original}
                  checked={haveIngredients.includes(original)}
                  onChange={(on) => setHaveIngredients((l) => toggle(l, original, on))}
                  label={`${r.display} ${name}`}
                  action={
                    subs.length > 0 ? (
                      <Button size="sm" variant="ghost" icon={<Repeat2 className="size-4" />} onClick={() => setSwapFor(original)} aria-label={`Swap ${r.ingredient?.name ?? ''}`}>
                        Swap
                      </Button>
                    ) : undefined
                  }
                >
                  <span className="block text-[15px]">
                    <span className="font-medium">{r.display}</span> {name}
                    {r.ri.optional && <span className="text-muted"> (optional)</span>}
                  </span>
                  <span className="block text-xs text-muted">
                    {formatGrams(r.scaledGrams)}
                    {r.ri.prep && !r.swappedFrom ? ` · ${r.ri.prep}` : ''}
                    {r.swappedFrom ? ` · swapped for ${ingName(r.swappedFrom)}` : ''}
                  </span>
                </TickRow>
              );
            })}
          </ul>
        </Card>
      </section>

      <section aria-labelledby="recipe-steps" data-section="steps">
        <SectionTitle id="recipe-steps">How to make it</SectionTitle>
        <Card className="px-4 py-1">
          <ol className="divide-y divide-line">
            {recipe.steps.map((s, i) => (
              <TickRow key={i} checked={doneSteps.includes(i)} onChange={(on) => setDoneSteps((l) => toggle(l, i, on))} label={`Step ${i + 1} done`}>
                <span className="flex gap-3">
                  <span className="shrink-0 size-7 rounded-full bg-surface-3 text-sm font-semibold flex items-center justify-center no-underline" aria-hidden>
                    {i + 1}
                  </span>
                  <span className="text-[15px] pt-0.5">
                    <span className="sr-only">Step {i + 1}: </span>
                    {s}
                  </span>
                </span>
              </TickRow>
            ))}
          </ol>
        </Card>
      </section>

      {recipe.substitutions.length > 0 && (
        <section aria-labelledby="recipe-subs" data-section="substitutions">
          <SectionTitle id="recipe-subs">Substitutions</SectionTitle>
          <Card className="px-4 py-1">
            <ul className="divide-y divide-line">
              {recipe.substitutions.map((s) => {
                const current = swaps.find((x) => x.from === s.ingredientId)?.to;
                return (
                  <li key={s.ingredientId} className="flex items-center gap-2 py-2.5">
                    <span className="flex-1 min-w-0 text-sm">
                      Instead of <span className="font-medium">{ingName(s.ingredientId)}</span>: {s.alternatives.map(ingName).join(' or ')}
                      {current && <span className="block text-xs text-accent">Using {ingName(current)}</span>}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setSwapFor(s.ingredientId)} aria-label={`Choose a substitute for ${ingName(s.ingredientId)}`}>
                      Choose
                    </Button>
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      )}

      {recipe.notes && (
        <section aria-labelledby="recipe-notes" data-section="notes">
          <SectionTitle id="recipe-notes">Notes</SectionTitle>
          <Card className="p-4">
            <p className="text-sm">{recipe.notes}</p>
          </Card>
        </section>
      )}
      <AllergenNote className="mt-3 px-1" />

      <div className="flex flex-col gap-2 mt-4 sticky bottom-[calc(76px+env(safe-area-inset-bottom))]">
        <Button variant="primary" size="lg" block icon={<NotebookPen className="size-5" />} onClick={() => setLogOpen(true)}>
          Log this meal
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" icon={<CalendarPlus className="size-4" />} onClick={() => setPlanOpen(true)}>
            Add to meal plan…
          </Button>
          <Button variant="secondary" aria-pressed={fav} icon={<Star className={cx('size-4', fav && 'fill-current text-accent')} />} onClick={() => void toggleFav()}>
            {fav ? 'Saved' : 'Save to favourites'}
          </Button>
        </div>
      </div>

      <Sheet open={swapFor !== null} onClose={() => setSwapFor(null)} title="Swap ingredient">
        {swapFor && (
          <SwapChooser
            original={swapFor}
            current={swaps.find((s) => s.from === swapFor)?.to ?? swapFor}
            options={substitutesFor(recipe, swapFor)}
            onPick={(to) => {
              setSwap(swapFor, to);
              setSwapFor(null);
            }}
          />
        )}
      </Sheet>
      <LogSheet open={logOpen} onClose={() => setLogOpen(false)} recipeId={recipe.id} swaps={swaps} />
      {planOpen && <AddToPlanSheet recipe={recipe} swaps={swaps} onClose={() => setPlanOpen(false)} />}
    </Page>
  );
}

function SwapChooser({ original, current, options, onPick }: { original: ID; current: ID; options: ID[]; onPick: (to: ID) => void }) {
  const all = [original, ...options];
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="Choose an ingredient">
      {all.map((id) => {
        const ing = INGREDIENTS_BY_ID.get(id);
        if (!ing) return null;
        const on = id === current;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(id)}
            className={cx('text-left rounded-xl border px-4 py-3 min-h-14', on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}
          >
            <div className="font-medium">
              {ing.name}
              {id === original && <span className="text-muted font-normal"> (original)</span>}
            </div>
            <div className="text-xs text-muted">
              per 100 g: {ing.per100g.kcal} kcal · {ing.per100g.protein} g protein
              {ing.allergens.length ? ` · contains ${ing.allergens.map((a) => ALLERGEN_LABELS[a].toLowerCase()).join(', ')}` : ''}
            </div>
          </button>
        );
      })}
      <p className="text-xs text-muted">Nutrition, allergens and the shopping list update with your swap.</p>
    </div>
  );
}

function LogSheet({ open, onClose, recipeId, swaps }: { open: boolean; onClose: () => void; recipeId: ID; swaps: Swap[] }) {
  const recipe = RECIPES_BY_ID.get(recipeId)!;
  const { account, db } = useApp();
  const toast = useToast();
  const nav = useNavigate();
  const today = todayISO(account.settings.timeZone);
  const [date, setDate] = useState(today);
  const [meal, setMeal] = useState<MealSlot>(recipe.meal);
  const [servings, setServings] = useState<number | null>(1);
  const [busy, setBusy] = useState(false);
  const draft = servings ? entryFromRecipe(recipe, servings, swaps) : null;

  async function submit() {
    if (!draft) return;
    setBusy(true);
    try {
      const name = swaps.length ? `${recipe.name} (with swaps)` : recipe.name;
      await saveRecord('food_logs', newRecord({ ...draft, name, date, meal }), db);
      toast.show(`Logged to ${MEAL_LABELS[meal]}`, { tone: 'success', action: { label: 'View day', onClick: () => nav(`/nutrition${date === today ? '' : `?date=${date}`}`) } });
      onClose();
    } catch {
      toast.show('Could not save. Please try again.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Log this meal"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!draft}>
            Log
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="log-recipe-date" className="text-sm font-medium">
              Date
            </label>
            <input
              id="log-recipe-date"
              type="date"
              value={date}
              max={today}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="min-h-11 rounded-xl bg-surface-2 border border-line px-3 text-[16px] text-ink focus:border-accent focus:outline-none"
            />
          </div>
          <Select label="Meal" value={meal} onChange={(e) => setMeal(e.target.value as MealSlot)}>
            {MEAL_ORDER.map((m) => (
              <option key={m} value={m}>
                {MEAL_LABELS[m]}
              </option>
            ))}
          </Select>
        </div>
        <NumberInput label="Servings eaten" suffix="×" value={servings} min={0.25} max={12} onChange={setServings} error={servings ? null : 'Enter servings'} />
        {draft && <p className="text-sm">{macroLine(draft)}</p>}
      </div>
    </Sheet>
  );
}
