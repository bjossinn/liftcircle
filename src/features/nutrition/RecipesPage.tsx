import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronLeft, Drumstick, Search, Star, Timer } from 'lucide-react';
import { Button, Card, ChipGroup, EmptyState, IconButton, Input, Page, Segmented, Sheet, Toggle, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import type { DietTag, MealSlot, ProteinGroup, Recipe } from '@/domain/types';
import { RECIPES } from '@/data/recipes';
import {
  MEAL_ORDER, PROTEIN_GROUPS, QUICK_MINUTES, allergenLabel, dietTagLabel, displayMacro, featuredProteinGroups, likedBonus, mealLabel,
  normalizeProteinPrefs, proteinGroupLabel, proteinListText, recipeMatches, recipeMinutes, recipeNutrition,
} from '@/domain/nutrition/recipes';
import { ingredientDisplayName, recipeDisplayName } from '@/data/catalogText';
import { listText, locale as localeOf, useT, type Language } from '@/i18n';
import { AllergenNote } from './shared';
import { ProteinsForm } from './ProteinPicker';

/** Per-recipe values the list needs, computed once (the catalogue is static), so filtering ~250 recipes stays instant. */
let INDEX: Map<string, { kcal: number; protein: number; featured: ProteinGroup[] }> | null = null;
function recipeIndex() {
  INDEX ??= new Map(
    RECIPES.map((r) => {
      const n = recipeNutrition(r).perServing;
      return [r.id, { kcal: n.kcal, protein: n.protein, featured: featuredProteinGroups(r) }];
    }),
  );
  return INDEX;
}
/** Groups that some recipe features, in the standard order (the filter row offers only these). */
const FILTER_PROTEINS = PROTEIN_GROUPS.filter((g) => RECIPES.some((r) => recipeIndex().get(r.id)!.featured.includes(g)));
const PAGE = 60;

const FILTER_TAGS: DietTag[] = ['vegetarian', 'vegan', 'pescatarian', 'dairy_free', 'gluten_free', 'high_protein'];

/** Search also matches the recipe and ingredient names shown in the app language (the catalog search is English). */
function localizedMatch(r: Recipe, query: string, lang: Language): boolean {
  if (lang === 'en') return false;
  const loc = localeOf(lang);
  const q = query.trim().toLocaleLowerCase(loc);
  if (!q) return false;
  const has = (text: string) => text.toLocaleLowerCase(loc).includes(q);
  return has(recipeDisplayName(r, lang)) || r.ingredients.some((i) => has(ingredientDisplayName(i.ingredientId, lang)));
}

export default function RecipesPage() {
  const nav = useNavigate();
  const { account, updateAccount } = useApp();
  const toast = useToast();
  const { t, tp, language } = useT();
  const diet = account.profile.diet;
  const [q, setQ] = useState('');
  const [meal, setMeal] = useState<MealSlot | 'all'>('all');
  const [tags, setTags] = useState<DietTag[]>(() => diet.tags.filter((t) => FILTER_TAGS.includes(t)));
  const [hideAllergens, setHideAllergens] = useState(diet.allergens.length > 0);
  const [favOnly, setFavOnly] = useState(false);
  const [quick, setQuick] = useState(false);
  const [proteins, setProteins] = useState<ProteinGroup[]>([]);
  const [hideExcluded, setHideExcluded] = useState(true);
  const [proteinsOpen, setProteinsOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const favs = account.favorites.recipes;
  const pp = useMemo(() => normalizeProteinPrefs(diet.proteinPrefs), [diet.proteinPrefs]);

  const list = useMemo(() => {
    const idx = recipeIndex();
    const filters = {
      meal: meal === 'all' ? undefined : meal,
      tags,
      excludeAllergens: hideAllergens ? diet.allergens : undefined,
      maxMinutes: quick ? QUICK_MINUTES : undefined,
      excludeProteinGroups: hideExcluded ? pp.excluded : undefined,
    };
    const out = RECIPES.filter(
      (r) =>
        (!favOnly || favs.includes(r.id)) &&
        (!proteins.length || idx.get(r.id)!.featured.some((g) => proteins.includes(g))) &&
        (recipeMatches(r, { query: q, ...filters }) || (localizedMatch(r, q, language) && recipeMatches(r, filters))),
    );
    // Recipes with proteins you like come first (stable otherwise).
    if (!pp.liked.length) return out;
    const liked = (r: Recipe) => likedBonus(r, pp.liked);
    return out.map((r, i) => ({ r, i, s: liked(r) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.r);
  }, [q, meal, tags, hideAllergens, diet.allergens, favOnly, favs, quick, proteins, hideExcluded, pp, language]);

  async function toggleFav(id: string) {
    try {
      await updateAccount((a) => {
        const cur = a.favorites.recipes;
        return { ...a, favorites: { ...a.favorites, recipes: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } };
      });
    } catch {
      toast.show(t('aiCard.recipe.favError'), { tone: 'error' });
    }
  }
  const clear = () => {
    setQ('');
    setMeal('all');
    setTags([]);
    setFavOnly(false);
    setQuick(false);
    setProteins([]);
    setShown(PAGE);
  };
  const chip = (on: boolean) =>
    cx(
      'min-h-11 px-3.5 rounded-full border text-sm inline-flex items-center gap-1.5',
      on ? 'bg-accent-soft border-accent text-accent font-medium' : 'border-line text-ink hover:bg-surface-2',
    );

  return (
    <Page
      title={t('foodLog.tab.recipes')}
      actions={
        <IconButton label={t('nutrition.recipes.your_proteins')} onClick={() => setProteinsOpen(true)}>
          <Drumstick className="size-5" />
        </IconButton>
      }
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="size-4 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
          <Input aria-label={t('nutrition.recipes.search_recipes_or_ingredients')} placeholder={t('nutrition.recipes.search_recipes_or_ingredients')} type="search" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <Segmented
          label={t('aiCard.recipe.meal')}
          size="sm"
          value={meal}
          onChange={setMeal}
          options={[{ value: 'all' as const, label: t('common.all') }, ...MEAL_ORDER.map((m) => ({ value: m, label: mealLabel(m, language) }))]}
        />
        <ChipGroup label={t('nutrition.recipes.diet_filters')} values={tags} onChange={setTags} options={FILTER_TAGS.map((tag) => ({ value: tag, label: dietTagLabel(tag, language) }))} />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={favOnly}
            onClick={() => setFavOnly(!favOnly)}
            className={chip(favOnly)}
          >
            <Star className="size-4" aria-hidden /> {t('workout.picker.favourites')}
          </button>
          <button type="button" role="checkbox" aria-checked={quick} onClick={() => setQuick(!quick)} className={chip(quick)}>
            <Timer className="size-4" aria-hidden /> {t('nutrition.recipes.quick', { minutes: QUICK_MINUTES })}
          </button>
        </div>
        <ChipGroup<ProteinGroup>
          label={t('nutrition.recipes.protein_filters')}
          values={proteins}
          onChange={(v) => {
            setProteins(v);
            setShown(PAGE);
          }}
          options={FILTER_PROTEINS.filter((g) => !(hideExcluded && pp.excluded.includes(g))).map((g) => ({ value: g, label: proteinGroupLabel(g, language) }))}
        />
        {pp.excluded.length > 0 && (
          <Toggle
            label={t('nutrition.recipes.hide_proteins_ive_excluded')}
            description={t('nutrition.recipes.not_for_me_x', { proteins: proteinListText(pp.excluded, language) })}
            checked={hideExcluded}
            onChange={setHideExcluded}
          />
        )}
        {diet.allergens.length > 0 && (
          <Toggle
            label={t('nutrition.recipes.hide_recipes_with_my_allergens')}
            description={listText(diet.allergens.map((a) => allergenLabel(a, language)), language)}
            checked={hideAllergens}
            onChange={setHideAllergens}
          />
        )}
        <AllergenNote />
      </div>

      <p className="text-xs text-muted mt-4 mb-2 px-1" aria-live="polite">
        {tp('nutrition.recipes.count', list.length)}
      </p>
      <Card>
        {list.length === 0 ? (
          <EmptyState
            title={t('nutrition.recipes.no_recipes_match')}
            body={t('nutrition.recipes.try_removing_a_filter')}
            action={
              <Button size="sm" onClick={clear}>
                {t('coaching.directory.clear_filters')}
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.slice(0, shown).map((r) => {
              const n = recipeIndex().get(r.id)!;
              const fav = favs.includes(r.id);
              const name = recipeDisplayName(r, language);
              return (
                <li key={r.id} className="flex items-center pr-1">
                  <Link to={`/nutrition/recipes/${r.id}`} className="flex-1 min-w-0 px-4 py-3 min-h-16 hover:bg-surface-2 rounded-l-2xl">
                    <div className="text-[15px] font-medium">{name}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {t('nutrition.recipes.meta', { meal: mealLabel(r.meal, language), minutes: recipeMinutes(r), kcal: displayMacro(n.kcal, 'kcal'), protein: displayMacro(n.protein, 'protein') })}
                    </div>
                  </Link>
                  <IconButton label={fav ? t('nutrition.recipes.remove_x_from_favourites', { name }) : t('nutrition.recipes.add_x_to_favourites', { name })} aria-pressed={fav} onClick={() => toggleFav(r.id)}>
                    <Star className={cx('size-5', fav ? 'fill-current text-accent' : 'text-muted')} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {list.length > shown && (
        <div className="flex justify-center mt-3">
          <Button onClick={() => setShown(shown + PAGE)}>{t('nutrition.recipes.show_more', { count: list.length - shown })}</Button>
        </div>
      )}
      <Sheet open={proteinsOpen} onClose={() => setProteinsOpen(false)} title={t('nutrition.mealPlan.proteins')}>
        {proteinsOpen && <ProteinsForm hasPlan={false} busy={false} onRebuild={() => {}} onDone={() => setProteinsOpen(false)} />}
      </Sheet>
    </Page>
  );
}
