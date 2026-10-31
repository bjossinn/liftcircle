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
import { MEAL_LABELS, MEAL_ORDER, displayMacro } from '@/domain/nutrition/recipes';
import {
  dayTotals, entryFromIngredient, groupByMeal, proteinDistribution, proteinGapSuggestions, rescaleEntry, targetFor,
} from '@/domain/nutrition/log';
import { MacroProgress, computeFromAccount, macroLine, useDayEntries, useLatestWeightKg } from './shared';

export default function NutritionPage() {
  const { account } = useApp();
  const enabled = account.settings.nutritionEnabled && account.nutrition.mode !== 'none';
  return (
    <Page title="Nutrition" actions={<TopActions />}>
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
        toast.show('Food logging is on. You can add targets any time.', { tone: 'success' });
        return;
      }
      const res = computeFromAccount(account, weight, mode);
      await updateAccount((a) => ({ ...a, settings: { ...a.settings, nutritionEnabled: true }, nutrition: res.targets }));
      if (res.warnings.length || res.targets.autoDisabledReason) {
        toast.show(res.targets.autoDisabledReason ? 'Logging is on. Set your own targets if you want them.' : 'Some details are missing for your targets.', {
          tone: 'warn',
          action: { label: 'Review', onClick: () => nav('/nutrition/targets') },
        });
      } else {
        toast.show('Targets set. You can review the calculation any time.', { tone: 'success', action: { label: 'Review', onClick: () => nav('/nutrition/targets') } });
      }
    } catch {
      toast.show('Could not save. Please try again.', { tone: 'error' });
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
        <h2 className="text-lg font-semibold">Nutrition is optional</h2>
        <p className="text-sm text-muted mt-1">
          Track just protein, or protein plus calories and macros. Everything works without it, and you can turn it off later.
        </p>
        {restricted && (
          <Notice tone="info" className="mt-3">
            {restricted === 'under_18'
              ? 'Automatic calorie and weight targets are for adults, so you can log food and set your own targets instead.'
              : 'Because your needs are individual, we won’t generate targets. You can log food and set targets with your healthcare professional.'}
          </Notice>
        )}
        <div className="flex flex-col gap-2 mt-4">
          {!restricted && (
            <>
              <Button variant="primary" block loading={busy === 'protein_only'} onClick={() => enable('protein_only')} icon={<Beef className="size-4" />}>
                Protein target only
              </Button>
              <Button block loading={busy === 'full'} onClick={() => enable('full')}>
                Protein, calories & macros
              </Button>
            </>
          )}
          <Button variant={restricted ? 'primary' : 'ghost'} block loading={busy === 'log_only'} onClick={() => enable('log_only')}>
            Just log food (no targets)
          </Button>
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3">
        <NavTile to="/nutrition/recipes" icon={<BookOpen className="size-5" />} label="Browse recipes" />
        <NavTile to="/nutrition/plan" icon={<CalendarDays className="size-5" />} label="Meal plan" />
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
    toast.show('Targets updated for your latest weight.', { tone: 'success' });
  }

  async function remove(e: FoodLogEntry) {
    try {
      await deleteRecord('food_logs', e.id);
      toast.show(`Removed ${e.name}`, {
        action: { label: 'Undo', onClick: () => void saveRecord('food_logs', { ...e, deletedAt: undefined }) },
      });
    } catch {
      toast.show('Could not remove. Please try again.', { tone: 'error' });
    }
  }

  async function logSuggestion(id: string, grams: number) {
    const ing = INGREDIENTS_BY_ID.get(id);
    if (!ing) return;
    await saveRecord('food_logs', newRecord({ ...entryFromIngredient(ing, grams), date, meal: 'snack' as MealSlot }));
    toast.show(`Added ${ing.name} to Snack`, { tone: 'success' });
  }

  const perMeal = proteinGoal ? proteinDistribution(proteinGoal, targets.mealsPerDay) : null;
  const noTargets = proteinGoal == null && kcalGoal == null;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3">
        <IconButton label="Previous day" onClick={() => setDate(addDays(date, -1))}>
          <ChevronLeft className="size-5" />
        </IconButton>
        <div className="text-center">
          <div className="font-semibold">{date === today ? 'Today' : date === addDays(today, -1) ? 'Yesterday' : formatDate(date)}</div>
          {date !== today && (
            <button type="button" className="text-xs text-accent min-h-6" onClick={() => setDate(today)}>
              Back to today
            </button>
          )}
        </div>
        <IconButton label="Next day" onClick={() => setDate(addDays(date, 1))} disabled={date >= today}>
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
                No targets set.{' '}
                <Link to="/nutrition/targets" className="text-accent font-medium">
                  Add targets
                </Link>
              </p>
            )}
            {perMeal && (
              <p className="text-xs text-muted mt-3">
                Spread over {perMeal.length} meal{perMeal.length === 1 ? '' : 's'}: about {perMeal[0]} g protein each. An even spread is a convenient habit, not a rule.
              </p>
            )}
            <div className="flex gap-2 mt-4">
              <Button variant="primary" className="flex-1" icon={<Plus className="size-4" />} onClick={() => nav(`/nutrition/log?date=${date}`)}>
                Log food
              </Button>
              <Button className="flex-1" onClick={() => nav(`/nutrition/log?date=${date}&tab=quick`)}>
                Quick add
              </Button>
            </div>
          </>
        )}
      </Card>

      {staleWeight && (
        <Notice className="mt-3">
          Your targets use {formatWeight(targets.referenceWeightKg, unit)}; your latest weight is {formatWeight(weight, unit)}.{' '}
          <button type="button" className="text-accent font-medium min-h-9" onClick={updateForWeight}>
            Update targets
          </button>
        </Notice>
      )}

      {grouped.map(({ meal, entries: list }) => {
        const t = dayTotals(list);
        return (
          <section key={meal} aria-labelledby={`meal-${meal}`}>
            <SectionTitle
              id={`meal-${meal}`}
              action={
                <IconButton label={`Add to ${MEAL_LABELS[meal]}`} size="sm" onClick={() => nav(`/nutrition/log?date=${date}&meal=${meal}`)}>
                  <Plus className="size-5" />
                </IconButton>
              }
            >
              {MEAL_LABELS[meal]}
              {list.length > 0 && (
                <span className="normal-case tracking-normal font-normal ml-2">
                  {t.missing.kcal ? '≥' : ''}
                  {t.kcal} kcal · {t.missing.protein ? '≥' : ''}
                  {displayMacro(t.protein, 'protein')} g protein
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
                  Nothing logged yet
                </button>
              ) : (
                <ul className="divide-y divide-line">
                  {list.map((e) => (
                    <li key={e.id} className="flex items-center gap-1 pl-4 pr-1 py-2 min-h-14">
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-medium truncate">{e.name}</div>
                        <div className="text-xs text-muted truncate">
                          {e.servings != null ? `${e.servings} serving${e.servings === 1 ? '' : 's'} · ` : e.grams != null ? `${e.grams} g · ` : ''}
                          {macroLine(e, targets.mode !== 'protein_only')}
                        </div>
                      </div>
                      <IconButton label={`Edit ${e.name}`} size="sm" onClick={() => setEditing(e)}>
                        <Pencil className="size-4" />
                      </IconButton>
                      <IconButton label={`Delete ${e.name}`} size="sm" onClick={() => remove(e)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        );
      })}

      {suggestions.length > 0 && (
        <section aria-labelledby="gap-title">
          <SectionTitle id="gap-title">Ideas for the last {displayMacro(gap, 'protein')} g protein</SectionTitle>
          <Card>
            <ul className="divide-y divide-line">
              {suggestions.map((s) => (
                <li key={`${s.kind}:${s.id}`} className="flex items-center gap-2 pl-4 pr-2 py-2 min-h-14">
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium truncate">
                      {s.kind === 'food' ? `${s.amount} ${s.name.toLowerCase()}` : s.name}
                    </div>
                    <div className="text-xs text-muted">
                      {s.kind === 'recipe' ? 'Recipe · ' : ''}≈ {displayMacro(s.protein, 'protein')} g protein · {s.kcal} kcal
                    </div>
                  </div>
                  {s.kind === 'food' ? (
                    <Button size="sm" onClick={() => logSuggestion(s.id, s.grams!)} aria-label={`Log ${s.amount} ${s.name}`}>
                      Log
                    </Button>
                  ) : (
                    <Link to={`/nutrition/recipes/${s.id}`} className="text-sm text-accent font-medium px-3 min-h-9 inline-flex items-center">
                      View
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted px-4 pb-3">Everyday foods work well. Protein powders are optional, and higher intake isn't automatically better.</p>
          </Card>
        </section>
      )}

      <SectionTitle>Plan & tools</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <NavTile to="/nutrition/recipes" icon={<BookOpen className="size-5" />} label="Recipes" />
        <NavTile to="/nutrition/plan" icon={<CalendarDays className="size-5" />} label="Meal plan" />
        <NavTile to="/nutrition/shopping" icon={<ShoppingCart className="size-5" />} label="Shopping list" />
        <NavTile to="/nutrition/targets" icon={<Target className="size-5" />} label="Targets" />
      </div>

      <EntryEditor entry={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

/* ------------------------------------------------------------ entry editor */
function EntryEditor({ entry, onClose }: { entry: FoodLogEntry | null; onClose: () => void }) {
  return (
    <Sheet open={!!entry} onClose={onClose} title="Edit entry">
      {entry && <EntryForm key={entry.id} entry={entry} onDone={onClose} />}
    </Sheet>
  );
}

function EntryForm({ entry, onDone }: { entry: FoodLogEntry; onDone: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<FoodLogEntry>(entry);
  const [busy, setBusy] = useState(false);
  const amountKey = draft.servings != null ? 'servings' : draft.grams != null ? 'grams' : null;

  async function save() {
    if (!draft.name.trim()) return;
    setBusy(true);
    try {
      await saveRecord('food_logs', { ...draft, name: draft.name.trim() });
      toast.show('Entry updated', { tone: 'success' });
      onDone();
    } catch {
      toast.show('Could not save. Please try again.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  const setMacro = (k: 'kcal' | 'protein' | 'carbs' | 'fat') => (v: number | null) => setDraft((d) => ({ ...d, [k]: v ?? undefined }));

  return (
    <div className="flex flex-col gap-3">
      <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} error={draft.name.trim() ? null : 'Enter a name'} />
      <Select label="Meal" value={draft.meal} onChange={(e) => setDraft({ ...draft, meal: e.target.value as MealSlot })}>
        {MEAL_ORDER.map((m) => (
          <option key={m} value={m}>
            {MEAL_LABELS[m]}
          </option>
        ))}
      </Select>
      {amountKey && (
        <NumberInput
          label={amountKey === 'servings' ? 'Servings' : 'Amount (g)'}
          hint="Changing the amount rescales the values below."
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
        <NumberInput label="Calories" suffix="kcal" value={draft.kcal} min={0} max={10000} decimals={false} onChange={setMacro('kcal')} placeholder="Unknown" />
        <NumberInput label="Protein" suffix="g" value={draft.protein} min={0} max={1000} onChange={setMacro('protein')} placeholder="Unknown" />
        <NumberInput label="Carbs" suffix="g" value={draft.carbs} min={0} max={2000} onChange={setMacro('carbs')} placeholder="Unknown" />
        <NumberInput label="Fat" suffix="g" value={draft.fat} min={0} max={1000} onChange={setMacro('fat')} placeholder="Unknown" />
      </div>
      <p className="text-xs text-muted">Leave a value empty if you don't know it. It counts as unknown, not zero.</p>
      <div className="flex gap-2 justify-end pt-1">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save} loading={busy} disabled={!draft.name.trim()}>
          Save
        </Button>
      </div>
    </div>
  );
}
