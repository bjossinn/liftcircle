import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronLeft, Search, Star } from 'lucide-react';
import { Button, Card, ChipGroup, EmptyState, IconButton, Input, Page, Segmented, Toggle, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import type { DietTag, MealSlot } from '@/domain/types';
import { RECIPES } from '@/data/recipes';
import {
  ALLERGEN_LABELS, DIET_TAG_LABELS, MEAL_LABELS, MEAL_ORDER, displayMacro, recipeMatches, recipeMinutes, recipeNutrition,
} from '@/domain/nutrition/recipes';
import { AllergenNote } from './shared';

const FILTER_TAGS: DietTag[] = ['vegetarian', 'vegan', 'pescatarian', 'dairy_free', 'gluten_free', 'high_protein'];

export default function RecipesPage() {
  const nav = useNavigate();
  const { account, updateAccount } = useApp();
  const toast = useToast();
  const diet = account.profile.diet;
  const [q, setQ] = useState('');
  const [meal, setMeal] = useState<MealSlot | 'all'>('all');
  const [tags, setTags] = useState<DietTag[]>(() => diet.tags.filter((t) => FILTER_TAGS.includes(t)));
  const [hideAllergens, setHideAllergens] = useState(diet.allergens.length > 0);
  const [favOnly, setFavOnly] = useState(false);
  const favs = account.favorites.recipes;

  const list = useMemo(
    () =>
      RECIPES.filter((r) =>
        recipeMatches(r, {
          query: q,
          meal: meal === 'all' ? undefined : meal,
          tags,
          excludeAllergens: hideAllergens ? diet.allergens : undefined,
        }),
      ).filter((r) => !favOnly || favs.includes(r.id)),
    [q, meal, tags, hideAllergens, diet.allergens, favOnly, favs],
  );

  async function toggleFav(id: string) {
    try {
      await updateAccount((a) => {
        const cur = a.favorites.recipes;
        return { ...a, favorites: { ...a.favorites, recipes: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } };
      });
    } catch {
      toast.show('Could not update favourites.', { tone: 'error' });
    }
  }
  const clear = () => {
    setQ('');
    setMeal('all');
    setTags([]);
    setFavOnly(false);
  };

  return (
    <Page
      title="Recipes"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="size-4 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
          <Input aria-label="Search recipes or ingredients" placeholder="Search recipes or ingredients" type="search" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <Segmented
          label="Meal"
          size="sm"
          value={meal}
          onChange={setMeal}
          options={[{ value: 'all' as const, label: 'All' }, ...MEAL_ORDER.map((m) => ({ value: m, label: MEAL_LABELS[m] }))]}
        />
        <ChipGroup label="Diet filters" values={tags} onChange={setTags} options={FILTER_TAGS.map((t) => ({ value: t, label: DIET_TAG_LABELS[t] }))} />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={favOnly}
            onClick={() => setFavOnly(!favOnly)}
            className={cx(
              'min-h-11 px-3.5 rounded-full border text-sm inline-flex items-center gap-1.5',
              favOnly ? 'bg-accent-soft border-accent text-accent font-medium' : 'border-line text-ink hover:bg-surface-2',
            )}
          >
            <Star className="size-4" aria-hidden /> Favourites
          </button>
        </div>
        {diet.allergens.length > 0 && (
          <Toggle
            label="Hide recipes with my allergens"
            description={diet.allergens.map((a) => ALLERGEN_LABELS[a]).join(', ')}
            checked={hideAllergens}
            onChange={setHideAllergens}
          />
        )}
        <AllergenNote />
      </div>

      <p className="text-xs text-muted mt-4 mb-2 px-1" aria-live="polite">
        {list.length} recipe{list.length === 1 ? '' : 's'}
      </p>
      <Card>
        {list.length === 0 ? (
          <EmptyState
            title="No recipes match"
            body="Try removing a filter."
            action={
              <Button size="sm" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((r) => {
              const n = recipeNutrition(r).perServing;
              const fav = favs.includes(r.id);
              return (
                <li key={r.id} className="flex items-center pr-1">
                  <Link to={`/nutrition/recipes/${r.id}`} className="flex-1 min-w-0 px-4 py-3 min-h-16 hover:bg-surface-2 rounded-l-2xl">
                    <div className="text-[15px] font-medium">{r.name}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {MEAL_LABELS[r.meal]} · {recipeMinutes(r)} min · {displayMacro(n.kcal, 'kcal')} kcal · {displayMacro(n.protein, 'protein')} g protein per serving
                    </div>
                  </Link>
                  <IconButton label={fav ? `Remove ${r.name} from favourites` : `Add ${r.name} to favourites`} aria-pressed={fav} onClick={() => toggleFav(r.id)}>
                    <Star className={cx('size-5', fav ? 'fill-current text-accent' : 'text-muted')} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </Page>
  );
}
