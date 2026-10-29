import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ChevronLeft, Clock, Minus, Plus, Repeat2, Star, Users } from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton, Notice, NumberInput, Page, SectionTitle, Select, Sheet, Stat, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { newRecord, saveRecord } from '@/db/repo';
import { todayISO } from '@/lib/dates';
import type { ID, MealSlot } from '@/domain/types';
import { INGREDIENTS_BY_ID } from '@/data/ingredients';
import { RECIPES_BY_ID } from '@/data/recipes';
import {
  ALLERGEN_LABELS, DIET_TAG_LABELS, MEAL_LABELS, MEAL_ORDER, displayMacro, formatGrams, recipeAllergens, recipeDietTags, recipeNutrition,
  scaleRecipe, substitutesFor, type Swap,
} from '@/domain/nutrition/recipes';
import { entryFromRecipe } from '@/domain/nutrition/log';
import { AllergenNote, macroLine } from './shared';

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

function RecipeView({ recipeId, back }: { recipeId: ID; back: ReactNode }) {
  const recipe = RECIPES_BY_ID.get(recipeId)!;
  const { account, updateAccount } = useApp();
  const toast = useToast();
  const [servings, setServings] = useState(recipe.servings);
  const [swaps, setSwaps] = useState<Swap[]>([]);
  const [swapFor, setSwapFor] = useState<ID | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const fav = account.favorites.recipes.includes(recipe.id);

  const nutrition = useMemo(() => recipeNutrition(recipe, { servings, swaps }), [recipe, servings, swaps]);
  const scaled = useMemo(() => scaleRecipe(recipe, servings, swaps), [recipe, servings, swaps]);
  const allergens = recipeAllergens(recipe, swaps);
  const tags = recipeDietTags(recipe, swaps);
  const clash = allergens.filter((a) => account.profile.diet.allergens.includes(a));
  const ps = nutrition.perServing;

  async function toggleFav() {
    await updateAccount((a) => {
      const cur = a.favorites.recipes;
      return { ...a, favorites: { ...a.favorites, recipes: cur.includes(recipe.id) ? cur.filter((x) => x !== recipe.id) : [...cur, recipe.id] } };
    });
    toast.show(fav ? 'Removed from favourites' : 'Added to favourites');
  }
  const setSwap = (from: ID, to: ID | null) => setSwaps((s) => [...s.filter((x) => x.from !== from), ...(to && to !== from ? [{ from, to }] : [])]);

  return (
    <Page
      back={back}
      actions={
        <IconButton label={fav ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={fav} onClick={toggleFav}>
          <Star className={cx('size-5', fav ? 'fill-current text-accent' : '')} />
        </IconButton>
      }
    >
      <h1 className="text-2xl font-bold tracking-tight">{recipe.name}</h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted mt-1">
        <span>{MEAL_LABELS[recipe.meal]}</span>
        <span className="inline-flex items-center gap-1">
          <Clock className="size-4" aria-hidden /> {recipe.prepMinutes} min prep{recipe.cookMinutes ? ` · ${recipe.cookMinutes} min cook` : ''}
        </span>
        <span className="inline-flex items-center gap-1">
          <Users className="size-4" aria-hidden /> makes {recipe.servings}
        </span>
      </div>
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

      <Card className="p-4 mt-4">
        <div className="grid grid-cols-4 gap-2">
          <Stat label="kcal" value={displayMacro(ps.kcal, 'kcal')} />
          <Stat label="Protein" value={`${displayMacro(ps.protein, 'protein')} g`} />
          <Stat label="Carbs" value={`${displayMacro(ps.carbs, 'carbs')} g`} />
          <Stat label="Fat" value={`${displayMacro(ps.fat, 'fat')} g`} />
        </div>
        <p className="text-xs text-muted mt-2">Per serving, estimated from generic ingredient data{swaps.length ? ' with your swaps' : ''}. Fibre about {displayMacro(ps.fiber ?? 0, 'fiber')} g.</p>
      </Card>

      <SectionTitle>Ingredients</SectionTitle>
      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium" id="servings-label">
            Servings
          </span>
          <div className="flex items-center gap-2" role="group" aria-labelledby="servings-label">
            <IconButton label="Fewer servings" onClick={() => setServings((s) => Math.max(1, s - 1))} disabled={servings <= 1} className="border border-line">
              <Minus className="size-4" />
            </IconButton>
            <span className="w-8 text-center text-lg font-semibold tabular" aria-live="polite">
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
        <ul className="mt-3 divide-y divide-line">
          {scaled.ingredients.map((r) => {
            const original = r.swappedFrom ?? r.ingredientId;
            const subs = substitutesFor(recipe, original);
            return (
              <li key={original} className="flex items-start gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[15px]">
                    <span className="font-medium">{r.display}</span> {r.ingredient?.name.toLowerCase() ?? r.ingredientId}
                    {r.ri.optional && <span className="text-muted"> (optional)</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {formatGrams(r.scaledGrams)}
                    {r.ri.prep && !r.swappedFrom ? ` · ${r.ri.prep}` : ''}
                    {r.swappedFrom ? ` · swapped for ${INGREDIENTS_BY_ID.get(r.swappedFrom)?.name.toLowerCase()}` : ''}
                  </div>
                </div>
                {subs.length > 0 && (
                  <Button size="sm" variant="ghost" icon={<Repeat2 className="size-4" />} onClick={() => setSwapFor(original)} aria-label={`Swap ${r.ingredient?.name ?? ''}`}>
                    Swap
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <SectionTitle>Method</SectionTitle>
      <Card className="p-4">
        <ol className="flex flex-col gap-3">
          {recipe.steps.map((s, i) => (
            <li key={i} className="flex gap-3">
              <span className="shrink-0 size-7 rounded-full bg-surface-3 text-sm font-semibold flex items-center justify-center" aria-hidden>
                {i + 1}
              </span>
              <span className="text-[15px] pt-0.5">
                <span className="sr-only">Step {i + 1}: </span>
                {s}
              </span>
            </li>
          ))}
        </ol>
        {recipe.notes && <p className="text-sm text-muted mt-4">{recipe.notes}</p>}
      </Card>
      <AllergenNote className="mt-3 px-1" />

      <div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] mt-4">
        <Button variant="primary" size="lg" block onClick={() => setLogOpen(true)}>
          Log this meal
        </Button>
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
