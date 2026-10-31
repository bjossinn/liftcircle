import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Drumstick, History, Minus, Pencil, Plus, RefreshCw, Scale, Settings2, ShoppingCart, Shuffle, Trash2 } from 'lucide-react';
import {
  Button, Card, ChipGroup, ConfirmDialog, EmptyState, IconButton, ListRow, Notice, NumberInput, Page, SectionTitle, Segmented, Select, Sheet, Spinner,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { useLiveQuery } from 'dexie-react-hooks';
import { alive, kvGet, kvSet, newRecord, saveRecord } from '@/db/repo';
import { addDays, formatDate, startOfWeek, todayISO } from '@/lib/dates';
import type { Allergen, BudgetPref, DietPrefs, DietTag, ID, MealPlan, MealPlanExtra, MealPlanItem, MealSlot } from '@/domain/types';
import { INGREDIENTS, INGREDIENTS_BY_ID } from '@/data/ingredients';
import { RECIPES, RECIPES_BY_ID } from '@/data/recipes';
import {
  ALLERGEN_LABELS, DIET_TAG_LABELS, MEAL_LABELS, MEAL_ORDER, allowedSubstitutes, displayMacro, recipeMatches, recipeMinutes,
} from '@/domain/nutrition/recipes';
import {
  addPlanItem, allowedAddOns, balancePlan, extraText, generateMealPlan, planItemNutrition, planStatus, planWarnings, PORTION_STEP, PROTEIN_ADDONS,
  rankedCandidates, removePlanItem, replacePlanDay, swapMeal, updatePlanItem, type PlanDayStatus, type PlanPrefs,
} from '@/domain/nutrition/mealplan';
import { AllergenNote, prefsFromAccount, useWeekPlan } from './shared';
import { ProteinPicker, ProteinsForm, proteinPrefsSummary } from './ProteinPicker';

const VARIANT_KEY = 'nutrition:planVariant';

export default function MealPlanPage() {
  const nav = useNavigate();
  const { account, db } = useApp();
  const toast = useToast();
  const today = todayISO(account.settings.timeZone);
  const thisWeek = startOfWeek(today, account.settings.weekStart);
  // ?week=YYYY-MM-DD (e.g. from the AI coach's "Customize first") opens that week.
  const [params] = useSearchParams();
  const [weekStart, setWeekStart] = useState(() => {
    const w = params.get('week');
    return w && /^\d{4}-\d{2}-\d{2}$/.test(w) ? startOfWeek(w, account.settings.weekStart) : thisWeek;
  });
  const plan = useWeekPlan(weekStart);
  const [showEarlier, setShowEarlier] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Today first: days already past go in a collapsed "Earlier this week" section at the end. A week that is
  // entirely past (or entirely ahead) shows in date order.
  const { upcoming, earlier } = useMemo(() => {
    const idx = plan ? plan.days.map((_, i) => i) : [];
    const ahead = idx.filter((i) => plan!.days[i].date >= today);
    return ahead.length ? { upcoming: ahead, earlier: idx.filter((i) => plan!.days[i].date < today) } : { upcoming: idx, earlier: [] as number[] };
  }, [plan, today]);
  const [busy, setBusy] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [proteinsOpen, setProteinsOpen] = useState(false);
  const [editing, setEditing] = useState<{ date: string; item: MealPlanItem } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const prefs = useMemo(() => prefsFromAccount(account), [account]);
  // Warnings, totals and gaps are derived from the saved plan and current settings, so they survive a reload
  // and update after swaps, portion changes, substitutions, edits and target changes.
  const warnings = useMemo(() => (plan ? planWarnings(plan, prefs) : []), [plan, prefs]);
  const status = useMemo(() => (plan ? planStatus(plan, prefs) : null), [plan, prefs]);
  const energyTarget = prefs.kcalTarget != null;
  const canBalanceAll = !!status?.days.some((d) => d.balanced);

  async function save(next: MealPlan) {
    try {
      await saveRecord('meal_plans', next, db);
    } catch {
      toast.show('Could not save the plan. Please try again.', { tone: 'error' });
    }
  }

  /** `diet` overrides the saved preferences (used right after saving new protein choices, before the account state updates). */
  async function generate(existing: MealPlan | null, diet?: DietPrefs) {
    setBusy(true);
    try {
      const variant = ((await kvGet<number>(VARIANT_KEY, db)) ?? 0) + (existing ? 1 : 0);
      await kvSet(VARIANT_KEY, variant, db);
      const source = diet ? { ...account, profile: { ...account.profile, diet } } : account;
      const { plan: draft } = generateMealPlan(weekStart, prefsFromAccount(source, variant));
      await saveRecord('meal_plans', existing ? { ...existing, ...draft } : newRecord(draft), db);
      toast.show(existing ? 'New plan generated' : 'Plan ready', { tone: 'success' });
    } catch {
      toast.show('Could not create the plan. Please try again.', { tone: 'error' });
    } finally {
      setBusy(false);
      setConfirmRegen(false);
    }
  }

  const renderDay = (dayIdx: number) => {
    if (!plan || !status) return null;
    const day = plan.days[dayIdx];
    const st = status.days[dayIdx];
    const n = st.totals;
    return (
      <section key={day.date} aria-labelledby={`d-${day.date}`}>
        <SectionTitle
          id={`d-${day.date}`}
          action={
            <IconButton label={`Add a meal on ${formatDate(day.date)}`} size="sm" onClick={() => setAdding(day.date)}>
              <Plus className="size-5" />
            </IconButton>
          }
        >
          {day.date === today ? 'Today' : formatDate(day.date, { weekday: 'long', day: 'numeric', month: 'short' })}
        </SectionTitle>
        <Card>
          {day.items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">No meals planned.</p>
          ) : (
            <ul className="divide-y divide-line">
              {[...day.items]
                .sort((a, b) => MEAL_ORDER.indexOf(a.slot) - MEAL_ORDER.indexOf(b.slot))
                .map((it) => {
                  const r = RECIPES_BY_ID.get(it.recipeId);
                  if (!r) return null;
                  const m = planItemNutrition(it, RECIPES_BY_ID);
                  return (
                    <li key={it.id} className="flex items-center gap-1 pl-4 pr-1 py-2 min-h-16">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-muted">{MEAL_LABELS[it.slot]}</div>
                        <Link to={`/nutrition/recipes/${r.id}`} className="text-[15px] font-medium hover:underline block truncate">
                          {r.name}
                        </Link>
                        {it.extras?.length ? (
                          <div className="text-xs text-accent">+ {it.extras.map((e) => extraText(e)).join(', ')}</div>
                        ) : null}
                        <div className="text-xs text-muted">
                          {it.servings} serving{it.servings === 1 ? '' : 's'} · {displayMacro(m.protein, 'protein')} g protein · {displayMacro(m.kcal, 'kcal')} kcal
                          {it.swaps?.length ? ' · with swaps' : ''}
                        </div>
                      </div>
                      <IconButton label={`Swap ${r.name} for another recipe`} size="sm" onClick={() => save(swapMeal(plan, day.date, it.id, prefs))}>
                        <Shuffle className="size-4" />
                      </IconButton>
                      <IconButton label={`Edit ${r.name}`} size="sm" onClick={() => setEditing({ date: day.date, item: it })}>
                        <Pencil className="size-4" />
                      </IconButton>
                    </li>
                  );
                })}
            </ul>
          )}
          <div className="px-4 py-2.5 border-t border-line text-xs text-muted tabular">
            <span className={st.state === 'on_target' ? 'text-accent font-medium' : st.state === 'short' || st.state === 'over' ? 'text-warn font-medium' : ''}>
              {st.state === 'on_target' && <CheckCircle2 className="inline size-3.5 mr-1 -mt-0.5" aria-hidden />}
              Day total: {displayMacro(n.protein, 'protein')}
              {st.proteinTarget != null ? ` / ${st.proteinTarget}` : ''} g protein
            </span>
            {' · '}
            {displayMacro(n.kcal, 'kcal')}
            {st.kcalTarget != null ? ` / ${st.kcalTarget}` : ''} kcal{st.kcalTarget == null ? ' (for information)' : ''} · {displayMacro(n.carbs, 'carbs')} g carbs ·{' '}
            {displayMacro(n.fat, 'fat')} g fat
          </div>
          {st.message && <DayGap status={st} onBalance={st.balanced ? () => save(replacePlanDay(plan, st.balanced!)) : undefined} />}
        </Card>
      </section>
    );
  };

  const back = (
    <IconButton label="Back" onClick={() => nav(-1)}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );

  return (
    <Page
      title="Meal plan"
      back={back}
      actions={
        <>
          <IconButton label="Past meal plans" onClick={() => setHistoryOpen(true)}>
            <History className="size-5" />
          </IconButton>
          <IconButton label="Plan preferences" onClick={() => setPrefsOpen(true)}>
            <Settings2 className="size-5" />
          </IconButton>
        </>
      }
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <IconButton label="Previous week" onClick={() => setWeekStart(addDays(weekStart, -7))}>
          <ChevronLeft className="size-5" />
        </IconButton>
        <div className="text-center">
          <div className="font-semibold">{weekStart === thisWeek ? 'This week' : weekStart === addDays(thisWeek, 7) ? 'Next week' : `Week of ${formatDate(weekStart)}`}</div>
          <div className="text-xs text-muted">
            {formatDate(weekStart, { day: 'numeric', month: 'short' })} – {formatDate(addDays(weekStart, 6), { day: 'numeric', month: 'short' })}
          </div>
        </div>
        <IconButton label="Next week" onClick={() => setWeekStart(addDays(weekStart, 7))}>
          <ChevronRight className="size-5" />
        </IconButton>
      </div>
      {weekStart !== thisWeek && (
        <div className="flex justify-center -mt-1 mb-3">
          <Button size="sm" variant="ghost" onClick={() => setWeekStart(thisWeek)}>
            Back to this week
          </Button>
        </div>
      )}

      {plan === undefined ? (
        <Spinner />
      ) : plan === null ? (
        <Card>
          <EmptyState
            icon={<Shuffle className="size-6" />}
            title="No plan for this week"
            body={<PrefsSummary diet={account.profile.diet} />}
            action={
              <div className="flex flex-col gap-2 w-full max-w-xs">
                <Button variant="primary" loading={busy} onClick={() => generate(null)}>
                  Generate a week plan
                </Button>
                <Button variant="ghost" icon={<Drumstick className="size-4" />} onClick={() => setProteinsOpen(true)}>
                  Proteins
                </Button>
                <Button variant="ghost" onClick={() => setPrefsOpen(true)}>
                  Adjust preferences
                </Button>
              </div>
            }
          />
        </Card>
      ) : (
        <>
          {status && prefs.proteinTarget != null && status.withTarget > 0 && (
            <Notice tone={status.onTarget === status.withTarget ? 'accent' : 'warn'} className="mb-2">
              <p>
                <span className="font-semibold">
                  {status.onTarget} of {status.withTarget} day{status.withTarget === 1 ? '' : 's'}
                </span>{' '}
                within ±{status.days.find((d) => d.tolerance != null)?.tolerance ?? 0} g of your {prefs.proteinTarget} g protein target
                {energyTarget ? ` and ${prefs.kcalTarget} kcal energy target` : ''}.
              </p>
              {!energyTarget && (
                <p className="text-xs text-muted mt-1">You're tracking protein only, so calories are shown for information and the plan doesn't aim for an energy target.</p>
              )}
              {canBalanceAll && (
                <Button className="mt-2" icon={<Scale className="size-4" />} onClick={() => save(balancePlan(plan, prefs))}>
                  Balance all days
                </Button>
              )}
            </Notice>
          )}
          {warnings.map((w) => (
            <Notice key={w} tone="warn" className="mb-2">
              {w}
            </Notice>
          ))}
          <div className="flex gap-2">
            <Link to={`/nutrition/shopping?week=${weekStart}`} className="flex-1 inline-flex items-center justify-center gap-2 min-h-11 rounded-xl bg-accent text-accent-ink font-semibold px-4">
              <ShoppingCart className="size-4" aria-hidden /> Shopping list
            </Link>
            <IconButton label="Proteins" className="border border-line" onClick={() => setProteinsOpen(true)}>
              <Drumstick className="size-5" />
            </IconButton>
            <Button icon={<RefreshCw className="size-4" />} onClick={() => setConfirmRegen(true)}>
              Regenerate
            </Button>
          </div>
          {upcoming.map((dayIdx) => renderDay(dayIdx))}
          {earlier.length > 0 && (
            <button
              type="button"
              aria-expanded={showEarlier}
              onClick={() => setShowEarlier((v) => !v)}
              className="mt-4 w-full flex items-center justify-between gap-2 min-h-11 px-4 rounded-xl border border-line text-sm font-medium hover:bg-surface-2"
            >
              <span>
                Earlier this week · {earlier.length} day{earlier.length === 1 ? '' : 's'}
              </span>
              <ChevronDown className={`size-4 text-muted transition-transform${showEarlier ? ' rotate-180' : ''}`} aria-hidden />
            </button>
          )}
          {showEarlier && earlier.map((dayIdx) => renderDay(dayIdx))}
          <p className="text-xs text-muted mt-4 px-1">
            Plans are a starting point built from your preferences and approximate targets. Portions and protein sides are adjusted to bring each day close
            to your protein target; change them to suit your appetite.
          </p>
          <AllergenNote className="mt-2 px-1" />
        </>
      )}

      <ConfirmDialog
        open={confirmRegen}
        title="Generate a new plan?"
        body="This replaces this week's meals and clears shopping list ticks."
        confirmLabel="Generate"
        busy={busy}
        onConfirm={() => generate(plan ?? null)}
        onCancel={() => setConfirmRegen(false)}
      />
      <Sheet open={!!editing} onClose={() => setEditing(null)} title="Edit meal">
        {editing && plan && (
          <ItemEditor
            key={editing.item.id}
            item={plan.days.find((d) => d.date === editing.date)?.items.find((i) => i.id === editing.item.id) ?? editing.item}
            prefs={prefs}
            onChange={(patch) => save(updatePlanItem(plan, editing.date, editing.item.id, patch))}
            onSwapMeal={() => save(swapMeal(plan, editing.date, editing.item.id, prefs))}
            onRemove={() => {
              void save(removePlanItem(plan, editing.date, editing.item.id));
              setEditing(null);
            }}
            onDone={() => setEditing(null)}
          />
        )}
      </Sheet>
      <Sheet open={!!adding} onClose={() => setAdding(null)} title="Add a meal">
        {adding && plan && (
          <AddMeal
            onAdd={(slot, recipeId) => {
              void save(addPlanItem(plan, adding, slot, recipeId));
              setAdding(null);
            }}
          />
        )}
      </Sheet>
      <PrefsSheet open={prefsOpen} onClose={() => setPrefsOpen(false)} />
      <Sheet open={proteinsOpen} onClose={() => setProteinsOpen(false)} title="Proteins">
        {proteinsOpen && (
          <ProteinsForm
            hasPlan={!!plan}
            busy={busy}
            onRebuild={async (diet) => {
              await generate(plan ?? null, diet);
              setProteinsOpen(false);
            }}
            onDone={() => setProteinsOpen(false)}
          />
        )}
      </Sheet>
      <Sheet open={historyOpen} onClose={() => setHistoryOpen(false)} title="Past meal plans">
        {historyOpen && (
          <PastPlans
            thisWeek={thisWeek}
            current={weekStart}
            onPick={(w) => {
              setWeekStart(w);
              setShowEarlier(false);
              setHistoryOpen(false);
            }}
          />
        )}
      </Sheet>
    </Page>
  );
}

/** Weeks before this one that have a saved plan, newest first. Tapping one opens that week on this screen. */
function PastPlans({ thisWeek, current, onPick }: { thisWeek: string; current: string; onPick: (weekStart: string) => void }) {
  const { db } = useApp();
  const weeks = useLiveQuery(async () => {
    const rows = alive(await db.mealPlans.where('weekStart').below(thisWeek).toArray());
    const latest = new Map<string, MealPlan>();
    for (const r of rows) if (!latest.has(r.weekStart) || latest.get(r.weekStart)!.updatedAt < r.updatedAt) latest.set(r.weekStart, r);
    return [...latest.values()].sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
  }, [db, thisWeek]);
  if (weeks === undefined) return <Spinner />;
  if (weeks.length === 0) return <p className="text-sm text-muted">No earlier meal plans yet. Plans you make are kept here after their week ends.</p>;
  return (
    <ul className="-mx-4 divide-y divide-line">
      {weeks.map((p) => {
        const meals = p.days.reduce((n, d) => n + d.items.length, 0);
        const label = p.weekStart === addDays(thisWeek, -7) ? 'Last week' : `Week of ${formatDate(p.weekStart, { day: 'numeric', month: 'short' })}`;
        return (
          <li key={p.weekStart}>
            <ListRow
              title={label}
              subtitle={`${formatDate(p.weekStart, { day: 'numeric', month: 'short' })} – ${formatDate(addDays(p.weekStart, 6), { day: 'numeric', month: 'short' })} · ${meals} meal${meals === 1 ? '' : 's'}${p.weekStart === current ? ' · showing' : ''}`}
              right={<ChevronRight className="size-4" />}
              onClick={() => onPick(p.weekStart)}
            />
          </li>
        );
      })}
    </ul>
  );
}

function PrefsSummary({ diet }: { diet: DietPrefs }) {
  const bits = [
    `${diet.mealsPerDay || 3} meals a day`,
    `up to ${diet.maxCookMinutes || 30} min`,
    diet.budget === 'low' ? 'budget-friendly' : diet.budget === 'medium' ? 'moderate budget' : null,
    ...diet.tags.map((t) => DIET_TAG_LABELS[t].toLowerCase()),
    diet.allergens.length ? `avoiding ${diet.allergens.map((a) => ALLERGEN_LABELS[a].toLowerCase()).join(', ')}` : null,
    proteinPrefsSummary(diet.proteinPrefs) || null,
  ].filter(Boolean);
  return <>We'll build seven days from the starter recipes: {bits.join(', ')}.</>;
}

/** The visible gap for one day, why it exists, and practical changes (derived from the saved plan). */
function DayGap({ status, onBalance }: { status: PlanDayStatus; onBalance?: () => void }) {
  return (
    <div className="px-4 py-3 border-t border-line bg-warn-soft text-sm" role="status">
      <p>{status.message}</p>
      {status.suggestions.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-muted space-y-1">
          {status.suggestions.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
      {onBalance && (
        <Button className="mt-2" icon={<Scale className="size-4" />} onClick={onBalance}>
          Balance this day
        </Button>
      )}
    </div>
  );
}

function ItemEditor({
  item, prefs, onChange, onSwapMeal, onRemove, onDone,
}: { item: MealPlanItem; prefs: PlanPrefs; onChange: (p: Partial<MealPlanItem>) => void; onSwapMeal: () => void; onRemove: () => void; onDone: () => void }) {
  const r = RECIPES_BY_ID.get(item.recipeId);
  const sideOptions = useMemo(
    () => allowedAddOns(item.slot, prefs).filter((a) => a.minutes === 0 || (r ? recipeMinutes(r) : 0) + a.minutes <= prefs.maxCookMinutes),
    [item.slot, prefs, r],
  );
  const [sideId, setSideId] = useState<ID>('');
  if (!r) return null;
  const swaps = item.swaps ?? [];
  const m = planItemNutrition(item, RECIPES_BY_ID);
  const subs = (id: ID) => allowedSubstitutes(r, id, prefs.proteinExcluded);
  const swappable = r.ingredients.filter((i) => subs(i.ingredientId).length > 0 || swaps.some((s) => s.from === i.ingredientId));
  const extras = item.extras ?? [];
  const setExtras = (next: MealPlanExtra[]) => onChange({ extras: next });
  const chosenSide = sideOptions.some((a) => a.ingredientId === sideId) ? sideId : sideOptions.find((a) => !extras.some((e) => e.ingredientId === a.ingredientId))?.ingredientId ?? '';
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="font-semibold">{r.name}</div>
        <div className="text-sm text-muted">
          {displayMacro(m.protein, 'protein')} g protein · {displayMacro(m.kcal, 'kcal')} kcal · {displayMacro(m.carbs, 'carbs')} g carbs · {displayMacro(m.fat, 'fat')} g fat
          {extras.length ? ' (including sides)' : ''}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium" id="plan-serv">
          Servings
        </span>
        <div className="flex items-center gap-2" role="group" aria-labelledby="plan-serv">
          <IconButton label="Fewer servings" className="border border-line" disabled={item.servings <= 0.5} onClick={() => onChange({ servings: Math.max(0.5, item.servings - PORTION_STEP) })}>
            <Minus className="size-4" />
          </IconButton>
          <span className="w-10 text-center font-semibold tabular" aria-live="polite">
            {item.servings}
          </span>
          <IconButton label="More servings" className="border border-line" disabled={item.servings >= 6} onClick={() => onChange({ servings: Math.min(6, item.servings + PORTION_STEP) })}>
            <Plus className="size-4" />
          </IconButton>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Protein sides</h3>
        {extras.length === 0 && <p className="text-xs text-muted">None. Add one to raise this meal's protein without adding a meal.</p>}
        {extras.map((e, i) => {
          const amounts = PROTEIN_ADDONS.find((a) => a.ingredientId === e.ingredientId)?.amounts ?? [e.grams];
          const down = [...amounts].reverse().find((g) => g < e.grams);
          const up = amounts.find((g) => g > e.grams);
          const text = extraText(e);
          return (
            <div key={`${e.ingredientId}-${i}`} className="flex items-center gap-1">
              <span className="flex-1 text-sm">{text}</span>
              <IconButton label={`Less ${text}`} size="sm" className="border border-line" disabled={down == null} onClick={() => down != null && setExtras(extras.map((x, k) => (k === i ? { ...x, grams: down } : x)))}>
                <Minus className="size-4" />
              </IconButton>
              <IconButton label={`More ${text}`} size="sm" className="border border-line" disabled={up == null} onClick={() => up != null && setExtras(extras.map((x, k) => (k === i ? { ...x, grams: up } : x)))}>
                <Plus className="size-4" />
              </IconButton>
              <IconButton label={`Remove ${text}`} size="sm" onClick={() => setExtras(extras.filter((_, k) => k !== i))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          );
        })}
        {sideOptions.length > 0 ? (
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Select label="Add a protein side" value={chosenSide} onChange={(ev) => setSideId(ev.target.value)}>
                {sideOptions.map((a) => (
                  <option key={a.ingredientId} value={a.ingredientId}>
                    {INGREDIENTS_BY_ID.get(a.ingredientId)?.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              disabled={!chosenSide}
              onClick={() => {
                const a = sideOptions.find((x) => x.ingredientId === chosenSide);
                if (!a) return;
                const grams = a.amounts[Math.floor((a.amounts.length - 1) / 2)];
                const existing = extras.findIndex((x) => x.ingredientId === a.ingredientId);
                setExtras(existing >= 0 ? extras : [...extras, { ingredientId: a.ingredientId, grams }]);
              }}
            >
              Add
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">No protein sides fit your allergy, diet, protein and budget settings for this meal.</p>
        )}
      </div>
      {swappable.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Ingredient swaps</h3>
          {swappable.map((ri) => {
            const cur = swaps.find((s) => s.from === ri.ingredientId)?.to ?? ri.ingredientId;
            return (
              <Select
                key={ri.ingredientId}
                label={INGREDIENTS_BY_ID.get(ri.ingredientId)?.name}
                value={cur}
                onChange={(e) => {
                  const to = e.target.value;
                  const rest = swaps.filter((s) => s.from !== ri.ingredientId);
                  onChange({ swaps: to === ri.ingredientId ? rest : [...rest, { from: ri.ingredientId, to }] });
                }}
              >
                <option value={ri.ingredientId}>{INGREDIENTS_BY_ID.get(ri.ingredientId)?.name} (original)</option>
                {[...new Set([...subs(ri.ingredientId), ...(cur !== ri.ingredientId ? [cur] : [])])].map((a) => (
                  <option key={a} value={a}>
                    {INGREDIENTS_BY_ID.get(a)?.name}
                  </option>
                ))}
              </Select>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap gap-2 justify-between pt-1">
        <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={onRemove}>
          Remove
        </Button>
        <div className="flex gap-2">
          <Button icon={<Shuffle className="size-4" />} onClick={onSwapMeal}>
            Different recipe
          </Button>
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function AddMeal({ onAdd }: { onAdd: (slot: MealSlot, recipeId: ID) => void }) {
  const { account } = useApp();
  const [slot, setSlot] = useState<MealSlot>('snack');
  const prefs = useMemo(() => prefsFromAccount(account), [account]);
  const options = useMemo(() => {
    const ranked = rankedCandidates(slot, { ...prefs, maxCookMinutes: 999 }).recipes;
    return ranked.length ? ranked : RECIPES.filter((r) => recipeMatches(r, { excludeAllergens: prefs.allergens, tags: prefs.tags, excludeProteinGroups: prefs.proteinExcluded }));
  }, [slot, prefs]);
  const [recipeId, setRecipeId] = useState<ID>('');
  const chosen = options.some((o) => o.id === recipeId) ? recipeId : options[0]?.id ?? '';
  return (
    <div className="flex flex-col gap-3">
      <Segmented label="Meal" value={slot} onChange={setSlot} options={MEAL_ORDER.map((m) => ({ value: m, label: MEAL_LABELS[m] }))} />
      {options.length === 0 ? (
        <p className="text-sm text-muted">No recipes match your diet, allergy and protein settings for this meal.</p>
      ) : (
        <Select label="Recipe" value={chosen} onChange={(e) => setRecipeId(e.target.value)}>
          {options.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      )}
      <Button variant="primary" disabled={!chosen} onClick={() => onAdd(slot, chosen)}>
        Add to day
      </Button>
    </div>
  );
}

const DIET_OPTIONS: DietTag[] = ['vegetarian', 'vegan', 'pescatarian', 'dairy_free', 'gluten_free', 'high_protein'];

function PrefsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Plan preferences">
      {open && <PrefsForm onDone={onClose} />}
    </Sheet>
  );
}

function PrefsForm({ onDone }: { onDone: () => void }) {
  const { account, updateAccount } = useApp();
  const toast = useToast();
  const [d, setD] = useState<DietPrefs>(account.profile.diet);
  const [dislikeQuery, setDislikeQuery] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await updateAccount((a) => ({ ...a, profile: { ...a.profile, diet: d }, nutrition: { ...a.nutrition, mealsPerDay: d.mealsPerDay } }));
      toast.show('Preferences saved. Regenerate the plan to apply them.', { tone: 'success' });
      onDone();
    } catch {
      toast.show('Could not save. Please try again.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  const dislikeMatches = dislikeQuery.trim()
    ? INGREDIENTS.filter((i) => i.name.toLowerCase().includes(dislikeQuery.trim().toLowerCase()) && !d.dislikedIngredientIds.includes(i.id)).slice(0, 6)
    : [];
  return (
    <div className="flex flex-col gap-4">
      <NumberInput label="Meals per day" value={d.mealsPerDay} decimals={false} min={1} max={6} onChange={(v) => v != null && setD({ ...d, mealsPerDay: v })} hint="4 or more adds snacks." />
      <Select label="Maximum cooking time" value={String(d.maxCookMinutes)} onChange={(e) => setD({ ...d, maxCookMinutes: Number(e.target.value) })}>
        {[15, 20, 30, 45, 60, 90].map((m) => (
          <option key={m} value={m}>
            {m} minutes
          </option>
        ))}
      </Select>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Budget</span>
        <Segmented<BudgetPref>
          label="Budget"
          value={d.budget}
          onChange={(budget) => setD({ ...d, budget })}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'any', label: 'Any' },
          ]}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Diet</span>
        <ChipGroup label="Diet" values={d.tags} onChange={(tags) => setD({ ...d, tags })} options={DIET_OPTIONS.map((t) => ({ value: t, label: DIET_TAG_LABELS[t] }))} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Allergies & intolerances to avoid</span>
        <ChipGroup<Allergen>
          label="Allergens"
          values={d.allergens}
          onChange={(allergens) => setD({ ...d, allergens })}
          options={(Object.keys(ALLERGEN_LABELS) as Allergen[]).map((a) => ({ value: a, label: ALLERGEN_LABELS[a] }))}
        />
      </div>
      <div className="flex flex-col gap-1.5" role="group" aria-labelledby="prefs-proteins">
        <span id="prefs-proteins" className="text-sm font-medium">
          Proteins
        </span>
        <ProteinPicker value={d.proteinPrefs} onChange={(proteinPrefs) => setD({ ...d, proteinPrefs })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="dislike-q" className="text-sm font-medium">
          Ingredients you'd rather skip
        </label>
        {d.dislikedIngredientIds.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {d.dislikedIngredientIds.map((id) => (
              <button
                key={id}
                type="button"
                className="min-h-9 px-3 rounded-full border border-line text-sm inline-flex items-center gap-1 hover:bg-surface-2"
                onClick={() => setD({ ...d, dislikedIngredientIds: d.dislikedIngredientIds.filter((x) => x !== id) })}
                aria-label={`Remove ${INGREDIENTS_BY_ID.get(id)?.name ?? id}`}
              >
                {INGREDIENTS_BY_ID.get(id)?.name ?? id} ×
              </button>
            ))}
          </div>
        )}
        <input
          id="dislike-q"
          type="search"
          placeholder="Search ingredients"
          value={dislikeQuery}
          onChange={(e) => setDislikeQuery(e.target.value)}
          className="w-full min-h-11 rounded-xl bg-surface-2 border border-line px-3 text-[16px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
        />
        {dislikeMatches.length > 0 && (
          <ul className="rounded-xl border border-line divide-y divide-line">
            {dislikeMatches.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  className="w-full text-left px-3 min-h-11 text-sm hover:bg-surface-2"
                  onClick={() => {
                    setD({ ...d, dislikedIngredientIds: [...d.dislikedIngredientIds, i.id] });
                    setDislikeQuery('');
                  }}
                >
                  {i.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <AllergenNote />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save} loading={busy}>
          Save
        </Button>
      </div>
    </div>
  );
}

