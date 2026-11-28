import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Beef, BookOpen, CalendarDays, ChevronLeft, ChevronRight, Pencil, Plus, ShoppingCart, Target, Trash2, Utensils,
} from 'lucide-react';
import {
  Button, Card, IconButton, Input, Notice, NumberInput, Page, SectionTitle, Select, Sheet, Spinner,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { TopActions } from '@/app/TopActions';
import { useApp } from '@/state/app';
import { deleteRecord, newRecord, saveRecord } from '@/db/repo';
import { addDays, formatDate, todayISO } from '@/lib/dates';
import { formatWeight } from '@/domain/units';
import type { FoodLogEntry, MealSlot } from '@/domain/types';
import { INGREDIENTS_BY_ID } from '@/data/ingredients';
import { MEAL_ORDER, displayMacro, formatFraction, mealLabel } from '@/domain/nutrition/recipes';
import { ingredientDisplayName, pieceLabel, recipeDisplayName } from '@/data/catalogText';
import { numberText, useT, type Language } from '@/i18n';
import {
  dayTotals, entryFromIngredient, groupByMeal, proteinDistribution, proteinGapSuggestions, rescaleEntry, targetFor, type GapSuggestion,
} from '@/domain/nutrition/log';
import { MacroProgress, computeFromAccount, entryDisplayName, macroLine, useDayEntries, useLatestWeightKg } from './shared';

/** "2 eggs" / "150 g" for a food suggestion, in the app language. */
function gapAmount(s: GapSuggestion, lang: Language): string {
  if (lang === 'en' || s.grams == null) return s.amount;
  const piece = INGREDIENTS_BY_ID.get(s.id)?.units?.piece;
  const n = piece ? s.grams / piece : 0;
  const label = piece ? pieceLabel(s.id, n, lang) : undefined;
  return label ? `${formatFraction(n)} ${label}` : `${numberText(s.grams, 2, false, lang)} g`;
}

export default function NutritionPage() {
  const { account } = useApp();
  const enabled = account.settings.nutritionEnabled && account.nutrition.mode !== 'none';
  const { t } = useT();
  return (
    <Page title={t('today.nutrition')} actions={<TopActions />}>
      {enabled ? <DayView /> : <OptIn />}
    </Page>
  );
}

/* ------------------------------------------------------------------ opt-in */
function OptIn() {
  const { account, updateAccount } = useApp();
  const weight = useLatestWeightKg();
  const toast = useToast();
  const nav = useNavigate();
  const { t } = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const p = account.profile;
  const restricted = p.individualizedNutrition ? 'individualized' : p.age != null && p.age < 18 ? 'under_18' : null;

  async function enable(mode: 'protein_only' | 'full' | 'log_only') {
    setBusy(mode);
    try {
      if (mode === 'log_only') {
        await updateAccount((a) => ({
          ...a,
          settings: { ...a.settings, nutritionEnabled: true },
          nutrition: { ...a.nutrition, mode: 'manual', proteinG: undefined, calories: undefined, carbsG: undefined, fatG: undefined, updatedAt: Date.now() },
        }));
        toast.show(t('nutrition.home.food_logging_is_on_you_can'), { tone: 'success' });
        return;
      }
      const res = computeFromAccount(account, weight, mode);
      await updateAccount((a) => ({ ...a, settings: { ...a.settings, nutritionEnabled: true }, nutrition: res.targets }));
      if (res.warnings.length || res.targets.autoDisabledReason) {
        toast.show(res.targets.autoDisabledReason ? t('nutrition.home.logging_is_on_set_your_own') : t('nutrition.home.some_details_are_missing_for_your'), {
          tone: 'warn',
          action: { label: t('nutrition.home.review'), onClick: () => nav('/nutrition/targets') },
        });
      } else {
        toast.show(t('nutrition.home.targets_set_you_can_review_the'), { tone: 'success', action: { label: t('nutrition.home.review'), onClick: () => nav('/nutrition/targets') } });
      }
    } catch {
      toast.show(t('foodLog.saveError'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <div className="size-12 rounded-2xl bg-accent-soft text-accent flex items-center justify-center mb-3">
          <Utensils className="size-6" aria-hidden />
        </div>
        <h2 className="text-lg font-semibold">{t('nutrition.home.nutrition_is_optional')}</h2>
        <p className="text-sm text-muted mt-1">{t('nutrition.home.track_just_protein_or_protein_plus')}</p>
        {restricted && (
          <Notice tone="info" className="mt-3">
            {restricted === 'under_18'
              ? t('nutrition.home.automatic_calorie_and_weight_targets_are')
              : t('nutrition.home.because_your_needs_are_individual_we')}
          </Notice>
        )}
        <div className="flex flex-col gap-2 mt-4">
          {!restricted && (
            <>
              <Button variant="primary" block loading={busy === 'protein_only'} onClick={() => enable('protein_only')} icon={<Beef className="size-4" />}>
                {t('nutrition.home.protein_target_only')}
              </Button>
              <Button block loading={busy === 'full'} onClick={() => enable('full')}>
                {t('nutrition.home.protein_calories_macros')}
              </Button>
            </>
          )}
          <Button variant={restricted ? 'primary' : 'ghost'} block loading={busy === 'log_only'} onClick={() => enable('log_only')}>
            {t('nutrition.home.just_log_food_no_targets')}
          </Button>
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3">
        <NavTile to="/nutrition/recipes" icon={<BookOpen className="size-5" />} label={t('nutrition.home.browse_recipes')} />
        <NavTile to="/nutrition/plan" icon={<CalendarDays className="size-5" />} label={t('nutrition.home.meal_plan')} />
      </div>
    </div>
  );
}

function NavTile({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  return (
    <Link to={to} className="flex items-center gap-3 rounded-2xl bg-surface border border-line px-4 min-h-14 hover:bg-surface-2 transition-colors">
      <span className="text-accent">{icon}</span>
      <span className="text-sm font-medium">{label}</span>
    </Link>
  );
}

/* ---------------------------------------------------------------- day view */
function DayView() {
  const { account, updateAccount } = useApp();
  const toast = useToast();
  const nav = useNavigate();
  const { t, tp, language, locale } = useT();
  const [params, setParams] = useSearchParams();
  const today = todayISO(account.settings.timeZone);
  const date = params.get('date') || today;
  const entries = useDayEntries(date);
  const weight = useLatestWeightKg();
  const [editing, setEditing] = useState<FoodLogEntry | null>(null);
  const targets = account.nutrition;
  const unit = account.settings.units.weight;
  const diet = account.profile.diet;

  const totals = useMemo(() => dayTotals(entries ?? []), [entries]);
  const grouped = useMemo(() => groupByMeal(entries ?? []), [entries]);
  const proteinGoal = targetFor(targets, 'protein');
  const kcalGoal = targetFor(targets, 'kcal');
  const gap = proteinGoal != null ? proteinGoal - totals.protein : 0;
  const suggestions = useMemo(
    () =>
      gap >= 10
        ? proteinGapSuggestions(gap, {
            tags: diet.tags,
            allergens: diet.allergens,
            dislikedIngredientIds: diet.dislikedIngredientIds,
            excludedProteins: diet.proteinPrefs?.excluded,
            remainingKcal: kcalGoal != null && totals.missing.kcal === 0 ? kcalGoal - totals.kcal : undefined,
          })
        : [],
    [gap, diet, kcalGoal, totals],
  );

  const setDate = (d: string) => setParams(d === today ? {} : { date: d }, { replace: true });
  const staleWeight =
    (targets.mode === 'protein_only' || targets.mode === 'full') &&
    targets.referenceWeightSource === 'current' &&
    weight != null &&
    targets.referenceWeightKg != null &&
    Math.abs(weight - targets.referenceWeightKg) >= 1;

  async function updateForWeight() {
    const mode = targets.mode === 'full' ? 'full' : 'protein_only';
    const res = computeFromAccount(account, weight, mode);
    await updateAccount((a) => ({ ...a, nutrition: res.targets }));
    toast.show(t('nutrition.home.targets_updated_for_your_latest_weight'), { tone: 'success' });
  }

  async function remove(e: FoodLogEntry) {
    try {
      await deleteRecord('food_logs', e.id);
      toast.show(t('nutrition.home.removed_x', { name: entryDisplayName(e, language) }), {
        action: { label: t('workout.undo'), onClick: () => void saveRecord('food_logs', { ...e, deletedAt: undefined }) },
      });
    } catch {
      toast.show(t('nutrition.home.could_not_remove_please_try_again'), { tone: 'error' });
    }
  }

  async function logSuggestion(id: string, grams: number) {
    const ing = INGREDIENTS_BY_ID.get(id);
    if (!ing) return;
    await saveRecord('food_logs', newRecord({ ...entryFromIngredient(ing, grams), date, meal: 'snack' as MealSlot }));
    toast.show(t('nutrition.home.added_x_to_snack', { food: ingredientDisplayName(ing, language) }), { tone: 'success' });
  }

  const perMeal = proteinGoal ? proteinDistribution(proteinGoal, targets.mealsPerDay) : null;
  const noTargets = proteinGoal == null && kcalGoal == null;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3">
        <IconButton label={t('nutrition.home.previous_day')} onClick={() => setDate(addDays(date, -1))}>
          <ChevronLeft className="size-5" />
        </IconButton>
        <div className="text-center">
          <div className="font-semibold">{date === today ? t('nav.today') : date === addDays(today, -1) ? t('format.relative.yesterday') : formatDate(date)}</div>
          {date !== today && (
            <button type="button" className="text-xs text-accent min-h-6" onClick={() => setDate(today)}>
              {t('nutrition.home.back_to_today')}
            </button>
          )}
        </div>
        <IconButton label={t('nutrition.home.next_day')} onClick={() => setDate(addDays(date, 1))} disabled={date >= today}>
          <ChevronRight className="size-5" />
        </IconButton>
      </div>

      <Card className="p-4">
        {entries === undefined ? (
          <Spinner />
        ) : (
          <>
            <MacroProgress totals={totals} targets={targets} />
            {noTargets && (
              <p className="text-sm text-muted mt-3">
                {t('nutrition.home.no_targets_set')}{' '}
                <Link to="/nutrition/targets" className="text-accent font-medium">
                  {t('nutrition.home.add_targets')}
                </Link>
              </p>
            )}
            {perMeal && (
              <p className="text-xs text-muted mt-3">
                {tp('nutrition.home.spread', perMeal.length, { grams: perMeal[0] })}
              </p>
            )}
            <div className="flex gap-2 mt-4">
              <Button variant="primary" className="flex-1" icon={<Plus className="size-4" />} onClick={() => nav(`/nutrition/log?date=${date}`)}>
                {t('today.logFood')}
              </Button>
              <Button className="flex-1" onClick={() => nav(`/nutrition/log?date=${date}&tab=quick`)}>
                {t('nutrition.home.quick_add')}
              </Button>
            </div>
          </>
        )}
      </Card>

      {staleWeight && (
        <Notice className="mt-3">
          {t('nutrition.home.your_targets_use', { target: formatWeight(targets.referenceWeightKg, unit), latest: formatWeight(weight, unit) })}{' '}
          <button type="button" className="text-accent font-medium min-h-9" onClick={updateForWeight}>
            {t('nutrition.home.update_targets')}
          </button>
        </Notice>
      )}

      {grouped.map(({ meal, entries: list }) => {
        const mt = dayTotals(list);
        return (
          <section key={meal} aria-labelledby={`meal-${meal}`}>
            <SectionTitle
              id={`meal-${meal}`}
              action={
                <IconButton label={t('nutrition.home.add_to_x', { meal: mealLabel(meal, language) })} size="sm" onClick={() => nav(`/nutrition/log?date=${date}&meal=${meal}`)}>
                  <Plus className="size-5" />
                </IconButton>
              }
            >
              {mealLabel(meal, language)}
              {list.length > 0 && (
                <span className="normal-case tracking-normal font-normal ml-2">
                  {t('nutrition.home.meal_totals', {
                    kcal: `${mt.missing.kcal ? '≥' : ''}${numberText(mt.kcal)}`,
                    protein: `${mt.missing.protein ? '≥' : ''}${numberText(displayMacro(mt.protein, 'protein'))}`,
                  })}
                </span>
              )}
            </SectionTitle>
            <Card>
              {list.length === 0 ? (
                <button
                  type="button"
                  className="w-full text-left px-4 min-h-12 text-sm text-muted hover:bg-surface-2 rounded-2xl"
                  onClick={() => nav(`/nutrition/log?date=${date}&meal=${meal}`)}
                >
                  {t('exercise.library.nothing_logged_yet')}
                </button>
              ) : (
                <ul className="divide-y divide-line">
                  {list.map((e) => {
                    const name = entryDisplayName(e, language);
                    return (
                    <li key={e.id} className="flex items-center gap-1 pl-4 pr-1 py-2 min-h-14">
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-medium truncate">{name}</div>
                        <div className="text-xs text-muted truncate">
                          {e.servings != null ? `${tp('nutrition.home.servings_amount', e.servings)} · ` : e.grams != null ? `${numberText(e.grams)} g · ` : ''}
                          {macroLine(e, targets.mode !== 'protein_only')}
                        </div>
                      </div>
                      <IconButton label={t('foodLog.editNamed', { name })} size="sm" onClick={() => setEditing(e)}>
                        <Pencil className="size-4" />
                      </IconButton>
                      <IconButton label={t('foodLog.deleteNamed', { name })} size="sm" onClick={() => remove(e)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </section>
        );
      })}

      {suggestions.length > 0 && (
        <section aria-labelledby="gap-title">
          <SectionTitle id="gap-title">{t('nutrition.home.ideas_for_the_last', { grams: displayMacro(gap, 'protein') })}</SectionTitle>
          <Card>
            <ul className="divide-y divide-line">
              {suggestions.map((s) => {
                const foodText =
                  s.kind === 'food'
                    ? t('nutrition.home.gap_food', { amount: gapAmount(s, language), food: ingredientDisplayName(s.id, language, s.name).toLocaleLowerCase(locale) })
                    : recipeDisplayName(s.id, language, s.name);
                const meta = { protein: displayMacro(s.protein, 'protein'), kcal: s.kcal };
                return (
                <li key={`${s.kind}:${s.id}`} className="flex items-center gap-2 pl-4 pr-2 py-2 min-h-14">
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium truncate">
                      {foodText}
                    </div>
                    <div className="text-xs text-muted">{t(s.kind === 'recipe' ? 'nutrition.home.gap_recipe_meta' : 'nutrition.home.gap_food_meta', meta)}</div>
                  </div>
                  {s.kind === 'food' ? (
                    <Button size="sm" onClick={() => logSuggestion(s.id, s.grams!)} aria-label={t('nutrition.home.log_x_x', { food: foodText })}>
                      {t('foodLog.log')}
                    </Button>
                  ) : (
                    <Link to={`/nutrition/recipes/${s.id}`} className="text-sm text-accent font-medium px-3 min-h-9 inline-flex items-center">
                      {t('program.view')}
                    </Link>
                  )}
                </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted px-4 pb-3">{t('nutrition.home.everyday_foods_work_well_protein_powders')}</p>
          </Card>
        </section>
      )}

      <SectionTitle>{t('nutrition.home.plan_tools')}</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <NavTile to="/nutrition/recipes" icon={<BookOpen className="size-5" />} label={t('foodLog.tab.recipes')} />
        <NavTile to="/nutrition/plan" icon={<CalendarDays className="size-5" />} label={t('nutrition.home.meal_plan')} />
        <NavTile to="/nutrition/shopping" icon={<ShoppingCart className="size-5" />} label={t('nutrition.mealPlan.shopping_list')} />
        <NavTile to="/nutrition/targets" icon={<Target className="size-5" />} label={t('nutrition.home.targets')} />
      </div>

      <EntryEditor entry={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

/* ------------------------------------------------------------ entry editor */
function EntryEditor({ entry, onClose }: { entry: FoodLogEntry | null; onClose: () => void }) {
  const { t } = useT();
  return (
    <Sheet open={!!entry} onClose={onClose} title={t('nutrition.home.edit_entry')}>
      {entry && <EntryForm key={entry.id} entry={entry} onDone={onClose} />}
    </Sheet>
  );
}

function EntryForm({ entry, onDone }: { entry: FoodLogEntry; onDone: () => void }) {
  const toast = useToast();
  const { t, language } = useT();
  const [draft, setDraft] = useState<FoodLogEntry>(entry);
  const [busy, setBusy] = useState(false);
  const amountKey = draft.servings != null ? 'servings' : draft.grams != null ? 'grams' : null;

  async function save() {
    if (!draft.name.trim()) return;
    setBusy(true);
    try {
      await saveRecord('food_logs', { ...draft, name: draft.name.trim() });
      toast.show(t('nutrition.home.entry_updated'), { tone: 'success' });
      onDone();
    } catch {
      toast.show(t('foodLog.saveError'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  const setMacro = (k: 'kcal' | 'protein' | 'carbs' | 'fat') => (v: number | null) => setDraft((d) => ({ ...d, [k]: v ?? undefined }));

  return (
    <div className="flex flex-col gap-3">
      <Input label={t('workout.custom.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} error={draft.name.trim() ? null : t('foodLog.custom.nameRequired')} />
      <Select label={t('aiCard.recipe.meal')} value={draft.meal} onChange={(e) => setDraft({ ...draft, meal: e.target.value as MealSlot })}>
        {MEAL_ORDER.map((m) => (
          <option key={m} value={m}>
            {mealLabel(m, language)}
          </option>
        ))}
      </Select>
      {amountKey && (
        <NumberInput
          label={amountKey === 'servings' ? t('foodLog.custom.servings') : t('nutrition.home.amount_g')}
          hint={t('nutrition.home.changing_the_amount_rescales_the_values')}
          value={draft[amountKey]}
          min={amountKey === 'servings' ? 0.25 : 1}
          max={amountKey === 'servings' ? 20 : 5000}
          suffix={amountKey === 'servings' ? '×' : 'g'}
          onChange={(v) => {
            const old = draft[amountKey];
            if (v == null || !old) return;
            setDraft((d) => rescaleEntry(d, v / old));
          }}
        />
      )}
      <div className="grid grid-cols-2 gap-3">
        <NumberInput label={t('aiCard.macro.calories')} suffix="kcal" value={draft.kcal} min={0} max={10000} decimals={false} onChange={setMacro('kcal')} placeholder={t('settings.unknown')} />
        <NumberInput label={t('progress.protein')} suffix="g" value={draft.protein} min={0} max={1000} onChange={setMacro('protein')} placeholder={t('settings.unknown')} />
        <NumberInput label={t('aiCard.macro.carbs')} suffix="g" value={draft.carbs} min={0} max={2000} onChange={setMacro('carbs')} placeholder={t('settings.unknown')} />
        <NumberInput label={t('aiCard.macro.fat')} suffix="g" value={draft.fat} min={0} max={1000} onChange={setMacro('fat')} placeholder={t('settings.unknown')} />
      </div>
      <p className="text-xs text-muted">{t('nutrition.home.leave_a_value_empty_if_you')}</p>
      <div className="flex gap-2 justify-end pt-1">
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={save} loading={busy} disabled={!draft.name.trim()}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
