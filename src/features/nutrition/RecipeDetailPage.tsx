/**
 * Recipe screen (/nutrition/recipes/:id), laid out for cooking from a phone. In order: time; servings; macros per
 * serving; ingredients with tick-off boxes; numbered "How to make it" steps with tick-off; substitutions; notes; then
 * "Add to meal plan…", "Log this meal" and "Save to favourites". Ticks live in component state only (they reset when
 * you leave). The screen is kept awake while open where the browser supports the Screen Wake Lock API.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
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
  MEAL_ORDER, allergenLabel, dietTagLabel, displayMacro, formatGrams, friendlyAmount, mealLabel, recipeAllergens, recipeDietTags, recipeMinutes,
  recipeNutrition, scaleRecipe, allowedSubstitutes, ingredientAllowed, mainProteinGroup, normalizeProteinPrefs, proteinFitSwaps, proteinGroupLabel, proteinListText, recipeProteinGroups, LEFT_OUT, type Swap,
} from '@/domain/nutrition/recipes';
import { foodDisplayText, foodPrepText, ingredientDisplayName, recipeDisplayName, recipeNotes, recipeSteps } from '@/data/catalogText';
import { listText, useT, type Language } from '@/i18n';
import { entryFromRecipe } from '@/domain/nutrition/log';
import { holdWakeLock } from '@/features/train/feedback';
import { AllergenNote, macroLine } from './shared';
import { AddToPlanSheet } from './AddToPlanSheet';

/** A scaled ingredient's amount in the app language (catalog amount text, else a household measure or grams). */
function amountText(r: ReturnType<typeof scaleRecipe>['ingredients'][number], factor: number, lang: Language): string {
  if (lang === 'en') return r.display;
  if (factor === 1 && !r.swappedFrom && r.ri.display) return foodDisplayText(r.ri.display, lang) ?? r.display;
  return (r.ingredient && friendlyAmount(r.ingredient, r.scaledGrams, lang)) || formatGrams(r.scaledGrams, lang);
}

/** `template` (with "\u0000" where `value` goes) rendered with `value` in bold. */
function withBold(template: string, value: ReactNode): ReactNode {
  const [before, after = ''] = template.split('\u0000');
  return (
    <>
      {before}
      <span className="font-medium">{value}</span>
      {after}
    </>
  );
}

export default function RecipeDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { t } = useT();
  const recipe = RECIPES_BY_ID.get(id);
  const back = (
    <IconButton label={t('common.back')} onClick={() => nav(-1)}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );
  if (!recipe)
    return (
      <Page title={t('aiCard.mealPlan.recipeFallback')} back={back}>
        <EmptyState
          title={t('nutrition.recipe.recipe_not_found')}
          body={t('nutrition.recipe.it_may_have_been_renamed_or')}
          action={
            <Link to="/nutrition/recipes" className="text-accent font-medium">
              {t('nutrition.home.browse_recipes')}
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
            checked ? 'bg-ember border-edge text-accent-ink' : 'border-line',
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

/** Parse "from:to,from:to" into swaps the recipe itself offers, or an OPTIONAL ingredient left out (`from:__left_out__`);
 *  anything else is ignored. */
export function linkSwaps(recipe: { ingredients: { ingredientId: ID; optional?: boolean }[]; substitutions: { ingredientId: ID; alternatives: ID[] }[] }, raw: string | null): Swap[] {
  const out: Swap[] = [];
  for (const pair of (raw ?? '').split(',').slice(0, 10)) {
    const [from, to] = pair.split(':');
    if (!from || !to || out.some((s) => s.from === from)) continue;
    if (to === LEFT_OUT) {
      if (recipe.ingredients.some((i) => i.ingredientId === from && i.optional)) out.push({ from, to });
      continue;
    }
    if (!INGREDIENTS_BY_ID.has(to) || !recipe.ingredients.some((i) => i.ingredientId === from)) continue;
    if (!recipe.substitutions.some((s) => s.ingredientId === from && s.alternatives.includes(to))) continue;
    out.push({ from, to });
  }
  return out;
}

function RecipeView({ recipeId, back }: { recipeId: ID; back: ReactNode }) {
  const recipe = RECIPES_BY_ID.get(recipeId)!;
  const { account, updateAccount } = useApp();
  const toast = useToast();
  const { t, tp, language, locale } = useT();
  const [servings, setServings] = useState(recipe.servings);
  const diet = account.profile.diet;
  const excluded = useMemo(() => normalizeProteinPrefs(diet.proteinPrefs).excluded, [diet.proteinPrefs]);
  // Proteins marked "not for me" are swapped for an allowed substitute up front (the same swap the meal planner makes).
  const autoSwaps = useMemo(
    () => proteinFitSwaps(recipe, excluded, (i) => ingredientAllowed(i, { tags: diet.tags.filter((t) => t !== 'high_protein'), allergens: diet.allergens, disliked: diet.dislikedIngredientIds })) ?? [],
    [recipe, excluded, diet],
  );
  // Swaps from a training assistant recipe card (?swap=from:to,…, 1.0.3): only substitutes this recipe lists are taken.
  const [params] = useSearchParams();
  const linkedSwaps = useMemo(() => linkSwaps(recipe, params.get('swap')), [recipe, params]);
  const [swaps, setSwaps] = useState<Swap[]>(() => [...linkedSwaps, ...autoSwaps.filter((a) => !linkedSwaps.some((l) => l.from === a.from))]);
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
  const proteinClash = excluded.filter((g) => recipeProteinGroups(recipe, swaps).includes(g));
  const mainExcluded = (() => {
    const g = mainProteinGroup(recipe);
    return g && excluded.includes(g) ? g : null;
  })();
  const ps = nutrition.perServing;
  const lower = (x: string) => x.toLocaleLowerCase(locale);
  const ingName = (id: ID) => (INGREDIENTS_BY_ID.has(id) ? lower(ingredientDisplayName(id, language)) : id);
  const allergenText = (list: typeof allergens) => listText(list.map((a) => lower(allergenLabel(a, language))), language);
  const name = recipeDisplayName(recipe, language);

  async function toggleFav() {
    try {
      await updateAccount((a) => {
        const cur = a.favorites.recipes;
        return { ...a, favorites: { ...a.favorites, recipes: cur.includes(recipe.id) ? cur.filter((x) => x !== recipe.id) : [...cur, recipe.id] } };
      });
      toast.show(fav ? t('aiCard.recipe.favRemoved') : t('aiCard.recipe.favSaved'), { tone: 'success' });
    } catch {
      toast.show(t('aiCard.recipe.favError'), { tone: 'error' });
    }
  }
  const setSwap = (from: ID, to: ID | null) => setSwaps((s) => [...s.filter((x) => x.from !== from), ...(to && to !== from ? [{ from, to }] : [])]);
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v));

  return (
    <Page
      back={back}
      actions={
        <IconButton label={fav ? t('exercise.detail.remove_from_favourites') : t('exercise.detail.add_to_favourites')} aria-pressed={fav} onClick={() => void toggleFav()}>
          <Star className={cx('size-5', fav ? 'fill-current text-accent' : '')} />
        </IconButton>
      }
    >
      <h1 className="text-2xl font-bold tracking-tight">{name}</h1>
      <p className="text-sm text-muted mt-1">{tp('nutrition.recipe.meta_makes', recipe.servings, { meal: mealLabel(recipe.meal, language) })}</p>
      <div className="flex flex-wrap gap-1.5 mt-3">
        {tags.map((tag) => (
          <Badge key={tag} tone="accent">
            {dietTagLabel(tag, language)}
          </Badge>
        ))}
        {allergens.map((a) => (
          <Badge key={a} tone={clash.includes(a) ? 'danger' : 'warn'}>
            {t('nutrition.recipe.contains_allergen', { allergen: lower(allergenLabel(a, language)) })}
          </Badge>
        ))}
      </div>
      {clash.length > 0 && (
        <Notice tone="danger" className="mt-3">
          {tp('nutrition.recipe.allergy_clash', clash.length, { allergens: allergenText(clash) })}
        </Notice>
      )}

      {proteinClash.length > 0 && (
        <Notice tone="warn" className="mt-3">
          {mainExcluded
            ? t('nutrition.recipe.this_recipe_is_built_around_x', { protein: lower(proteinGroupLabel(mainExcluded, language)) })
            : t('nutrition.recipe.uses_x_which_you_marked_not', { proteins: proteinListText(proteinClash, language) })}
        </Notice>
      )}
      {swaps.some((s) => s.to === LEFT_OUT) && (
        <div data-testid="left-out">
          <Notice className="mt-3">
            {t('nutrition.recipe.left_out', { ingredients: listText(swaps.filter((s) => s.to === LEFT_OUT).map((s) => ingName(s.from)), language) })}{' '}
            <button type="button" className="underline" onClick={() => setSwaps((l) => l.filter((s) => s.to !== LEFT_OUT))}>
              {t('nutrition.recipe.add_back')}
            </button>
          </Notice>
        </div>
      )}
      {autoSwaps.length > 0 && proteinClash.length === 0 && (
        <Notice className="mt-3">
          {t('nutrition.recipe.made_with', { swaps: listText(autoSwaps.map((s) => t('aiCard.recipe.swap', { to: ingName(s.to), from: ingName(s.from) })), language) })}
        </Notice>
      )}

      <section aria-labelledby="recipe-time" data-section="time">
        <SectionTitle id="recipe-time">{t('summary.time')}</SectionTitle>
        <Card className="p-4 flex items-center gap-3">
          <Clock className="size-5 text-muted shrink-0" aria-hidden />
          <div>
            <div className="text-lg font-semibold tabular">{t('nutrition.recipe.total_minutes', { minutes: recipeMinutes(recipe) })}</div>
            <div className="text-xs text-muted">
              {recipe.cookMinutes
                ? t('nutrition.recipe.prep_cook', { prep: recipe.prepMinutes, cook: recipe.cookMinutes })
                : t('nutrition.recipe.prep_no_cook', { prep: recipe.prepMinutes })}
            </div>
          </div>
        </Card>
      </section>

      <section aria-labelledby="recipe-servings" data-section="servings">
        <SectionTitle id="recipe-servings">{t('foodLog.custom.servings')}</SectionTitle>
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t('nutrition.recipe.cooking_for')}</span>
            <div className="flex items-center gap-2" role="group" aria-label={t('foodLog.custom.servings')}>
              <IconButton label={t('nutrition.mealPlan.fewer_servings')} onClick={() => setServings((s) => Math.max(1, s - 1))} disabled={servings <= 1} className="border border-line">
                <Minus className="size-4" />
              </IconButton>
              <span className="w-8 text-center text-lg font-semibold tabular" aria-live="polite" data-testid="servings-value">
                {servings}
              </span>
              <IconButton label={t('nutrition.mealPlan.more_servings')} onClick={() => setServings((s) => Math.min(12, s + 1))} disabled={servings >= 12} className="border border-line">
                <Plus className="size-4" />
              </IconButton>
            </div>
          </div>
          <p className="text-xs text-muted mt-1">
            {t('nutrition.recipe.whole_recipe', { kcal: displayMacro(nutrition.total.kcal, 'kcal'), protein: displayMacro(nutrition.total.protein, 'protein') })}
          </p>
        </Card>
      </section>

      <section aria-labelledby="recipe-macros" data-section="macros">
        <SectionTitle id="recipe-macros">{t('nutrition.recipe.per_serving')}</SectionTitle>
        <Card className="p-4">
          <div className="grid grid-cols-4 gap-2">
            <Stat label="kcal" value={displayMacro(ps.kcal, 'kcal')} />
            <Stat label={t('progress.protein')} value={`${displayMacro(ps.protein, 'protein')} g`} />
            <Stat label={t('aiCard.macro.carbs')} value={`${displayMacro(ps.carbs, 'carbs')} g`} />
            <Stat label={t('aiCard.macro.fat')} value={`${displayMacro(ps.fat, 'fat')} g`} />
          </div>
          <p className="text-xs text-muted mt-2">
            {t(swaps.length ? 'nutrition.recipe.estimated_swaps' : 'nutrition.recipe.estimated', { fibre: displayMacro(ps.fiber ?? 0, 'fiber') })}
          </p>
        </Card>
      </section>

      <section aria-labelledby="recipe-ingredients" data-section="ingredients">
        <SectionTitle
          id="recipe-ingredients"
          action={<span className="text-xs text-muted tabular">{t('nutrition.recipe.ticked', { done: haveIngredients.length, total: scaled.ingredients.length })}</span>}
        >
          {t('nutrition.recipe.ingredients')}
        </SectionTitle>
        <Card className="px-4 py-1">
          <ul className="divide-y divide-line">
            {scaled.ingredients.map((r) => {
              const original = r.swappedFrom ?? r.ingredientId;
              const subs = allowedSubstitutes(recipe, original, excluded);
              const ingLabel = r.ingredient ? lower(ingredientDisplayName(r.ingredient, language)) : r.ingredientId;
              const amount = amountText(r, scaled.factor, language);
              const prep = r.ri.prep && !r.swappedFrom ? foodPrepText(r.ri.prep, language) : undefined;
              return (
                <TickRow
                  key={original}
                  checked={haveIngredients.includes(original)}
                  onChange={(on) => setHaveIngredients((l) => toggle(l, original, on))}
                  label={`${amount} ${ingLabel}`}
                  action={
                    subs.length > 0 ? (
                      <Button size="sm" variant="ghost" icon={<Repeat2 className="size-4" />} onClick={() => setSwapFor(original)} aria-label={t('nutrition.recipe.swap_x', { ingredient: r.ingredient ? ingredientDisplayName(r.ingredient, language) : '' })}>
                        {t('program.swap')}
                      </Button>
                    ) : undefined
                  }
                >
                  <span className="block text-[15px]">
                    <span className="font-medium">{amount}</span> {ingLabel}
                    {r.ri.optional && <span className="text-muted"> {t('coaching.request.optional')}</span>}
                  </span>
                  <span className="block text-xs text-muted">
                    {formatGrams(r.scaledGrams, language)}
                    {prep ? ` · ${prep}` : ''}
                    {r.swappedFrom ? ` · ${t('nutrition.recipe.swapped_for_x', { ingredient: ingName(r.swappedFrom) })}` : ''}
                  </span>
                </TickRow>
              );
            })}
          </ul>
        </Card>
      </section>

      <section aria-labelledby="recipe-steps" data-section="steps">
        <SectionTitle id="recipe-steps">{t('nutrition.recipe.how_to_make_it')}</SectionTitle>
        <Card className="px-4 py-1">
          <ol className="divide-y divide-line">
            {recipeSteps(recipe, language).map((s, i) => (
              <TickRow key={i} checked={doneSteps.includes(i)} onChange={(on) => setDoneSteps((l) => toggle(l, i, on))} label={t('nutrition.recipe.step_x_done', { step: i + 1 })}>
                <span className="flex gap-3">
                  <span className="shrink-0 size-7 rounded-full bg-surface-3 text-sm font-semibold flex items-center justify-center no-underline" aria-hidden>
                    {i + 1}
                  </span>
                  <span className="text-[15px] pt-0.5">
                    <span className="sr-only">{t('nutrition.recipe.step', { step: i + 1 })} </span>
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
          <SectionTitle id="recipe-subs">{t('nutrition.recipe.substitutions')}</SectionTitle>
          <Card className="px-4 py-1">
            <ul className="divide-y divide-line">
              {recipe.substitutions.map((s) => {
                const current = swaps.find((x) => x.from === s.ingredientId)?.to;
                return (
                  <li key={s.ingredientId} className="flex items-center gap-2 py-2.5">
                    <span className="flex-1 min-w-0 text-sm">
                      {withBold(
                        t('nutrition.recipe.instead_of', { ingredient: '\u0000', alternatives: listText(s.alternatives.map(ingName), language, 'disjunction') }),
                        ingName(s.ingredientId),
                      )}
                      {current && (
                        <span className="block text-xs text-accent">
                          {current === LEFT_OUT ? t('nutrition.mealPlan.left_out') : t('nutrition.recipe.using_x', { ingredient: ingName(current) })}
                        </span>
                      )}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setSwapFor(s.ingredientId)} aria-label={t('nutrition.recipe.choose_a_substitute_for_x', { ingredient: ingName(s.ingredientId) })}>
                      {t('nutrition.recipe.choose')}
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
          <SectionTitle id="recipe-notes">{t('workout.custom.notes')}</SectionTitle>
          <Card className="p-4">
            <p className="text-sm">{recipeNotes(recipe, language)}</p>
          </Card>
        </section>
      )}
      <AllergenNote className="mt-3 px-1" />

      <div className="flex flex-col gap-2 mt-4 sticky bottom-[calc(76px+env(safe-area-inset-bottom))]">
        <Button variant="primary" size="lg" block icon={<NotebookPen className="size-5" />} onClick={() => setLogOpen(true)}>
          {t('nutrition.recipe.log_this_meal')}
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" icon={<CalendarPlus className="size-4" />} onClick={() => setPlanOpen(true)}>
            {t('nutrition.recipe.add_to_meal_plan')}
          </Button>
          <Button variant="secondary" aria-pressed={fav} icon={<Star className={cx('size-4', fav && 'fill-current text-accent')} />} onClick={() => void toggleFav()}>
            {fav ? t('aiCard.recipe.saved') : t('nutrition.recipe.save_to_favourites')}
          </Button>
        </div>
      </div>

      <Sheet open={swapFor !== null} onClose={() => setSwapFor(null)} title={t('nutrition.recipe.swap_ingredient')}>
        {swapFor && (
          <SwapChooser
            original={swapFor}
            current={swaps.find((s) => s.from === swapFor)?.to ?? swapFor}
            options={allowedSubstitutes(recipe, swapFor, excluded)}
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
  const { t, language, locale } = useT();
  const all = [original, ...options];
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label={t('nutrition.recipe.choose_an_ingredient')}>
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
              {ingredientDisplayName(ing, language)}
              {id === original && <span className="text-muted font-normal"> {t('nutrition.mealPlan.original')}</span>}
            </div>
            <div className="text-xs text-muted">
              {ing.allergens.length
                ? t('nutrition.recipe.per_100_g_contains', {
                    kcal: ing.per100g.kcal,
                    protein: ing.per100g.protein,
                    allergens: listText(ing.allergens.map((a) => allergenLabel(a, language).toLocaleLowerCase(locale)), language),
                  })
                : t('nutrition.recipe.per_100_g', { kcal: ing.per100g.kcal, protein: ing.per100g.protein })}
            </div>
          </button>
        );
      })}
      <p className="text-xs text-muted">{t('nutrition.recipe.nutrition_allergens_and_the_shopping_list')}</p>
    </div>
  );
}

function LogSheet({ open, onClose, recipeId, swaps }: { open: boolean; onClose: () => void; recipeId: ID; swaps: Swap[] }) {
  const recipe = RECIPES_BY_ID.get(recipeId)!;
  const { account, db } = useApp();
  const toast = useToast();
  const nav = useNavigate();
  const { t, language } = useT();
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
      toast.show(t('nutrition.recipe.logged_to_x', { meal: mealLabel(meal, language) }), { tone: 'success', action: { label: t('foodLog.viewDay'), onClick: () => nav(`/nutrition${date === today ? '' : `?date=${date}`}`) } });
      onClose();
    } catch {
      toast.show(t('foodLog.saveError'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('nutrition.recipe.log_this_meal')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!draft}>
            {t('foodLog.log')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="log-recipe-date" className="text-sm font-medium">
              {t('progress.date')}
            </label>
            <input
              id="log-recipe-date"
              type="date"
              value={date}
              max={today}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="min-h-11 rounded-xl bg-field border border-line-input px-3 text-[16px] text-ink focus:border-accent"
            />
          </div>
          <Select label={t('aiCard.recipe.meal')} value={meal} onChange={(e) => setMeal(e.target.value as MealSlot)}>
            {MEAL_ORDER.map((m) => (
              <option key={m} value={m}>
                {mealLabel(m, language)}
              </option>
            ))}
          </Select>
        </div>
        <NumberInput label={t('foodLog.recipes.servingsEaten')} suffix="×" value={servings} min={0.25} max={12} onChange={setServings} error={servings ? null : t('nutrition.recipe.enter_servings')} />
        {draft && <p className="text-sm">{macroLine(draft)}</p>}
      </div>
    </Sheet>
  );
}
