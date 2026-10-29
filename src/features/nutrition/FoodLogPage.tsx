import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, Copy, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, ChipGroup, EmptyState, IconButton, Input, Notice, NumberInput, Page, Segmented, Select, Sheet, Spinner, Toggle, cx,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { alive, deleteRecord, newRecord, saveRecord } from '@/db/repo';
import { addDays, formatDate, todayISO } from '@/lib/dates';
import type { CustomFood, FoodLogEntry, Ingredient, MealSlot, Recipe, SavedMeal, SyncFields } from '@/domain/types';
import { INGREDIENTS } from '@/data/ingredients';
import { RECIPES } from '@/data/recipes';
import { MEAL_LABELS, MEAL_ORDER, recipeAllergens, recipeNutrition, ALLERGEN_LABELS, displayMacro } from '@/domain/nutrition/recipes';
import {
  dayTotals, entryDraftOf, entryFromCustom, entryFromIngredient, entryFromRecipe, recentItems, type EntryDraft,
} from '@/domain/nutrition/log';
import { macroLine, useDayEntries } from './shared';

type Tab = 'quick' | 'recipes' | 'foods' | 'custom' | 'saved' | 'recent';
const TABS: { id: Tab; label: string }[] = [
  { id: 'quick', label: 'Quick' },
  { id: 'recipes', label: 'Recipes' },
  { id: 'foods', label: 'Foods' },
  { id: 'custom', label: 'Custom foods' },
  { id: 'saved', label: 'Saved meals' },
  { id: 'recent', label: 'Recent' },
];
const STATE_LABEL: Record<Ingredient['state'], string> = { raw: 'raw', dry: 'dry', cooked: 'cooked', as_sold: '' };

function defaultMeal(): MealSlot {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h >= 17 && h < 22) return 'dinner';
  return 'snack';
}

export default function FoodLogPage() {
  const nav = useNavigate();
  const { account, db } = useApp();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const today = todayISO(account.settings.timeZone);
  const date = params.get('date') || today;
  const meal = (MEAL_ORDER as string[]).includes(params.get('meal') ?? '') ? (params.get('meal') as MealSlot) : defaultMeal();
  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'recipes') as Tab;
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => next.set(k, v));
    setParams(next, { replace: true });
  };
  const fullMode = account.nutrition.mode !== 'protein_only';

  async function log(drafts: EntryDraft[], label?: string) {
    try {
      for (const d of drafts) await saveRecord('food_logs', newRecord({ ...d, date, meal }), db);
      toast.show(`${label ?? (drafts.length === 1 ? drafts[0].name : `${drafts.length} items`)} added to ${MEAL_LABELS[meal]}`, {
        tone: 'success',
        action: { label: 'View day', onClick: () => nav(`/nutrition${date === today ? '' : `?date=${date}`}`) },
      });
      return true;
    } catch {
      toast.show('Could not save. Please try again.', { tone: 'error' });
      return false;
    }
  }

  async function copyYesterday() {
    const prev = addDays(date, -1);
    const rows = alive(await db.foodLogs.where('date').equals(prev).toArray()).filter((e) => e.meal === meal);
    if (!rows.length) {
      toast.show(`Nothing logged for ${MEAL_LABELS[meal].toLowerCase()} on ${formatDate(prev)}.`);
      return;
    }
    await log(rows.map(entryDraftOf), `${MEAL_LABELS[meal]} from ${formatDate(prev)}`);
  }

  return (
    <Page
      title="Log food"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="log-date" className="text-sm text-muted shrink-0">
            Date
          </label>
          <input
            id="log-date"
            type="date"
            value={date}
            max={today}
            onChange={(e) => e.target.value && set({ date: e.target.value })}
            className="min-h-11 flex-1 rounded-xl bg-surface-2 border border-line px-3 text-[16px] text-ink focus:border-accent focus:outline-none"
          />
        </div>
        <Segmented label="Meal" value={meal} onChange={(m) => set({ meal: m })} options={MEAL_ORDER.map((m) => ({ value: m, label: MEAL_LABELS[m] }))} />
        <Button variant="outline" size="sm" icon={<Copy className="size-4" />} onClick={copyYesterday} className="self-start">
          Copy {MEAL_LABELS[meal].toLowerCase()} from previous day
        </Button>
        <div role="tablist" aria-label="Ways to log" className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => set({ tab: t.id })}
              className={cx(
                'shrink-0 min-h-11 px-3.5 rounded-full border text-sm transition-colors',
                tab === t.id ? 'bg-accent-soft border-accent text-accent font-medium' : 'border-line text-ink hover:bg-surface-2',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'quick' && <QuickTab onLog={log} fullMode={fullMode} />}
          {tab === 'recipes' && <RecipesTab onLog={log} />}
          {tab === 'foods' && <FoodsTab onLog={log} />}
          {tab === 'custom' && <CustomTab onLog={log} />}
          {tab === 'saved' && <SavedTab onLog={log} date={date} meal={meal} />}
          {tab === 'recent' && <RecentTab onLog={log} today={today} />}
        </div>
      </div>
    </Page>
  );
}

type LogFn = (drafts: EntryDraft[], label?: string) => Promise<boolean>;

/* -------------------------------------------------------------------- quick */
function QuickTab({ onLog, fullMode }: { onLog: LogFn; fullMode: boolean }) {
  const [name, setName] = useState('');
  const [m, setM] = useState<{ kcal: number | null; protein: number | null; carbs: number | null; fat: number | null }>({ kcal: null, protein: null, carbs: null, fat: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (m.kcal == null && m.protein == null) {
      setError('Enter calories or protein (or both).');
      return;
    }
    setError(null);
    setBusy(true);
    const d: EntryDraft = { name: name.trim() || 'Quick entry', source: { kind: 'quick' } };
    if (m.kcal != null) d.kcal = m.kcal;
    if (m.protein != null) d.protein = m.protein;
    if (m.carbs != null) d.carbs = m.carbs;
    if (m.fat != null) d.fat = m.fat;
    const ok = await onLog([d]);
    setBusy(false);
    if (ok) {
      setName('');
      setM({ kcal: null, protein: null, carbs: null, fat: null });
    }
  }
  return (
    <Card className="p-4 flex flex-col gap-3">
      <Input label="Description (optional)" placeholder="e.g. Lunch at the canteen" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      <div className="grid grid-cols-2 gap-3">
        <NumberInput label="Calories" suffix="kcal" decimals={false} min={0} max={10000} value={m.kcal} onChange={(v) => setM({ ...m, kcal: v })} />
        <NumberInput label="Protein" suffix="g" min={0} max={1000} value={m.protein} onChange={(v) => setM({ ...m, protein: v })} />
        {fullMode && (
          <>
            <NumberInput label="Carbs (optional)" suffix="g" min={0} max={2000} value={m.carbs} onChange={(v) => setM({ ...m, carbs: v })} />
            <NumberInput label="Fat (optional)" suffix="g" min={0} max={1000} value={m.fat} onChange={(v) => setM({ ...m, fat: v })} />
          </>
        )}
      </div>
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <p className="text-xs text-muted">Values you leave empty are counted as unknown, not zero.</p>
      <Button variant="primary" onClick={submit} loading={busy} icon={<Plus className="size-4" />}>
        Add
      </Button>
    </Card>
  );
}

/* ------------------------------------------------------------------ recipes */
function RecipesTab({ onLog }: { onLog: LogFn }) {
  const { account } = useApp();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Recipe | null>(null);
  const [servings, setServings] = useState<number>(1);
  const allergens = account.profile.diet.allergens;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const favs = account.favorites.recipes;
    return RECIPES.filter((r) => !s || r.name.toLowerCase().includes(s)).sort((a, b) => Number(favs.includes(b.id)) - Number(favs.includes(a.id)));
  }, [q, account.favorites.recipes]);
  const preview = picked ? entryFromRecipe(picked, servings) : null;
  return (
    <>
      <SearchBox value={q} onChange={setQ} label="Search recipes" />
      <Card className="mt-3">
        {list.length === 0 ? (
          <EmptyState title="No recipes found" body="Try a different word." />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((r) => {
              const n = recipeNutrition(r).perServing;
              const clash = recipeAllergens(r).filter((a) => allergens.includes(a));
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className="w-full text-left flex items-center gap-3 px-4 py-3 min-h-14 hover:bg-surface-2"
                    onClick={() => {
                      setPicked(r);
                      setServings(1);
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-medium truncate">{r.name}</div>
                      <div className="text-xs text-muted">
                        {MEAL_LABELS[r.meal]} · per serving {displayMacro(n.kcal, 'kcal')} kcal · {displayMacro(n.protein, 'protein')} g protein
                      </div>
                    </div>
                    {clash.length > 0 && <Badge tone="warn">Contains {clash.map((a) => ALLERGEN_LABELS[a].toLowerCase()).join(', ')}</Badge>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Sheet
        open={!!picked}
        onClose={() => setPicked(null)}
        title={picked?.name ?? ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPicked(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!(servings > 0)}
              onClick={async () => {
                if (picked && (await onLog([entryFromRecipe(picked, servings)]))) setPicked(null);
              }}
            >
              Log
            </Button>
          </>
        }
      >
        {picked && preview && (
          <div className="flex flex-col gap-3">
            <NumberInput label="Servings eaten" value={servings} min={0.25} max={10} suffix="×" onChange={(v) => v != null && setServings(v)} />
            <ChipGroup label="Common portions" single values={[servings]} onChange={(v) => setServings(v[0])} options={[0.5, 1, 1.5, 2].map((x) => ({ value: x, label: `${x}×` }))} />
            <p className="text-sm">{macroLine(preview)}</p>
            <p className="text-xs text-muted">Estimated from generic ingredient data. The recipe makes {picked.servings} serving{picked.servings === 1 ? '' : 's'}.</p>
            <Link to={`/nutrition/recipes/${picked.id}`} className="text-sm text-accent font-medium">
              View recipe
            </Link>
          </div>
        )}
      </Sheet>
    </>
  );
}

/* -------------------------------------------------------------------- foods */
function FoodsTab({ onLog }: { onLog: LogFn }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Ingredient | null>(null);
  const [grams, setGrams] = useState<number | null>(100);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return INGREDIENTS.filter((i) => i.id !== 'spices' && (!s || i.name.toLowerCase().includes(s))).sort((a, b) => a.name.localeCompare(b.name));
  }, [q]);
  const unitChips = picked
    ? (Object.entries(picked.units ?? {}) as [string, number][]).map(([u, g]) => ({ value: g, label: `1 ${u === 'piece' ? 'piece' : u} (${g} g)` }))
    : [];
  const preview = picked && grams ? entryFromIngredient(picked, grams) : null;
  return (
    <>
      <SearchBox value={q} onChange={setQ} label="Search foods" />
      <Card className="mt-3">
        {list.length === 0 ? (
          <EmptyState title="No foods found" body="Try another word, or create a custom food." />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  className="w-full text-left flex items-center gap-3 px-4 py-3 min-h-14 hover:bg-surface-2"
                  onClick={() => {
                    setPicked(i);
                    setGrams(i.units?.piece ?? 100);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium truncate">{i.name}</div>
                    <div className="text-xs text-muted">
                      per 100 g: {i.per100g.kcal} kcal · {i.per100g.protein} g protein
                    </div>
                  </div>
                  {STATE_LABEL[i.state] && <Badge>{STATE_LABEL[i.state]}</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Sheet
        open={!!picked}
        onClose={() => setPicked(null)}
        title={picked?.name ?? ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPicked(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!grams}
              onClick={async () => {
                if (picked && grams && (await onLog([entryFromIngredient(picked, grams)]))) setPicked(null);
              }}
            >
              Log
            </Button>
          </>
        }
      >
        {picked && (
          <div className="flex flex-col gap-3">
            <NumberInput label="Amount" suffix="g" value={grams} min={1} max={3000} onChange={setGrams} />
            {unitChips.length > 0 && <ChipGroup label="Household measures" single values={[grams ?? 0]} onChange={(v) => setGrams(v[0])} options={unitChips} />}
            {preview && <p className="text-sm">{macroLine(preview)}</p>}
            {picked.state !== 'as_sold' && (
              <Notice>
                Values are for the food {STATE_LABEL[picked.state]}. Weigh it {STATE_LABEL[picked.state]} for the best estimate.
              </Notice>
            )}
            <p className="text-xs text-muted">Source: {picked.source}</p>
          </div>
        )}
      </Sheet>
    </>
  );
}

/* ------------------------------------------------------------- custom foods */
function CustomTab({ onLog }: { onLog: LogFn }) {
  const { db } = useApp();
  const toast = useToast();
  const foods = useLiveQuery(async () => alive(await db.customFoods.toArray()).sort((a, b) => a.name.localeCompare(b.name)), [db]);
  const [editing, setEditing] = useState<CustomFood | 'new' | null>(null);
  const [picked, setPicked] = useState<CustomFood | null>(null);
  const [amount, setAmount] = useState<number | null>(null);

  async function remove(f: CustomFood) {
    await deleteRecord('custom_foods', f.id, db);
    toast.show(`Deleted ${f.name}`, { action: { label: 'Undo', onClick: () => void saveRecord('custom_foods', { ...f, deletedAt: undefined }, db) } });
  }

  return (
    <>
      <Button block icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
        New custom food
      </Button>
      <Card className="mt-3">
        {foods === undefined ? (
          <Spinner />
        ) : foods.length === 0 ? (
          <EmptyState title="No custom foods yet" body="Add foods you eat often, using the values from the package label." />
        ) : (
          <ul className="divide-y divide-line">
            {foods.map((f) => (
              <li key={f.id} className="flex items-center gap-1 pr-1">
                <button
                  type="button"
                  className="flex-1 min-w-0 text-left px-4 py-3 min-h-14 hover:bg-surface-2"
                  onClick={() => {
                    setPicked(f);
                    setAmount(f.per.amount);
                  }}
                >
                  <div className="text-[15px] font-medium truncate">
                    {f.name}
                    {f.brand && <span className="text-muted font-normal"> · {f.brand}</span>}
                  </div>
                  <div className="text-xs text-muted truncate">
                    per {f.per.amount} {f.per.unit === 'serving' ? `serving${f.per.amount === 1 ? '' : 's'}` : f.per.unit}: {macroLine(f.macros)} · {f.isLabel ? 'label' : 'estimate'}
                  </div>
                </button>
                <IconButton label={`Edit ${f.name}`} size="sm" onClick={() => setEditing(f)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton label={`Delete ${f.name}`} size="sm" onClick={() => remove(f)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'New custom food' : 'Edit custom food'}>
        {editing !== null && <CustomFoodForm key={editing === 'new' ? 'new' : editing.id} food={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Sheet>
      <Sheet
        open={!!picked}
        onClose={() => setPicked(null)}
        title={picked?.name ?? ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPicked(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!amount}
              onClick={async () => {
                if (picked && amount && (await onLog([entryFromCustom(picked, amount)]))) setPicked(null);
              }}
            >
              Log
            </Button>
          </>
        }
      >
        {picked && (
          <div className="flex flex-col gap-3">
            <NumberInput
              label={picked.per.unit === 'serving' ? 'Servings' : `Amount (${picked.per.unit})`}
              suffix={picked.per.unit === 'serving' ? '×' : picked.per.unit}
              value={amount}
              min={0.1}
              max={5000}
              onChange={setAmount}
            />
            {amount ? <p className="text-sm">{macroLine(entryFromCustom(picked, amount))}</p> : null}
            <p className="text-xs text-muted">{picked.isLabel ? 'Values from a package label.' : 'Values are your estimate.'} Missing values stay unknown.</p>
          </div>
        )}
      </Sheet>
    </>
  );
}

function CustomFoodForm({ food, onDone }: { food: CustomFood | null; onDone: () => void }) {
  const { db } = useApp();
  const toast = useToast();
  const [name, setName] = useState(food?.name ?? '');
  const [brand, setBrand] = useState(food?.brand ?? '');
  const [perAmount, setPerAmount] = useState<number | null>(food?.per.amount ?? 100);
  const [perUnit, setPerUnit] = useState<CustomFood['per']['unit']>(food?.per.unit ?? 'g');
  const [m, setM] = useState({ kcal: food?.macros.kcal ?? null, protein: food?.macros.protein ?? null, carbs: food?.macros.carbs ?? null, fat: food?.macros.fat ?? null });
  const [isLabel, setIsLabel] = useState(food?.isLabel ?? true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameErr = !name.trim() ? 'Enter a name' : null;
  const amountErr = !perAmount ? 'Enter an amount' : null;
  const valuesErr = m.kcal == null && m.protein == null ? 'Enter at least calories or protein' : null;

  async function save() {
    setTried(true);
    if (nameErr || amountErr || valuesErr) return;
    setBusy(true);
    const macros: CustomFood['macros'] = {};
    (['kcal', 'protein', 'carbs', 'fat'] as const).forEach((k) => {
      if (m[k] != null) macros[k] = m[k]!;
    });
    const fields = { name: name.trim(), brand: brand.trim() || undefined, per: { amount: perAmount!, unit: perUnit }, macros, isLabel };
    try {
      await saveRecord('custom_foods', food ? { ...food, ...fields } : newRecord(fields), db);
      toast.show(food ? 'Custom food updated' : 'Custom food saved', { tone: 'success' });
      onDone();
    } catch {
      toast.show('Could not save. Please try again.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} error={tried ? nameErr : null} />
      <Input label="Brand (optional)" value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={60} />
      <div className="grid grid-cols-2 gap-3">
        <NumberInput label="Values per" value={perAmount} min={0.1} max={5000} onChange={setPerAmount} error={tried ? amountErr : null} />
        <Select label="Unit" value={perUnit} onChange={(e) => setPerUnit(e.target.value as CustomFood['per']['unit'])}>
          <option value="g">grams</option>
          <option value="ml">millilitres</option>
          <option value="serving">servings</option>
        </Select>
        <NumberInput label="Calories" suffix="kcal" decimals={false} min={0} max={10000} value={m.kcal} onChange={(v) => setM({ ...m, kcal: v })} placeholder="Unknown" />
        <NumberInput label="Protein" suffix="g" min={0} max={1000} value={m.protein} onChange={(v) => setM({ ...m, protein: v })} placeholder="Unknown" />
        <NumberInput label="Carbs" suffix="g" min={0} max={2000} value={m.carbs} onChange={(v) => setM({ ...m, carbs: v })} placeholder="Unknown" />
        <NumberInput label="Fat" suffix="g" min={0} max={1000} value={m.fat} onChange={(v) => setM({ ...m, fat: v })} placeholder="Unknown" />
      </div>
      {tried && valuesErr && (
        <p className="text-sm text-danger" role="alert">
          {valuesErr}
        </p>
      )}
      <Toggle label="Values from a package label" description="Turn off if these are your own estimate." checked={isLabel} onChange={setIsLabel} />
      <div className="flex gap-2 justify-end">
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

/* ------------------------------------------------------------- saved meals */
function SavedTab({ onLog, date, meal }: { onLog: LogFn; date: string; meal: MealSlot }) {
  const { db } = useApp();
  const toast = useToast();
  const meals = useLiveQuery(async () => alive(await db.savedMeals.toArray()).sort((a, b) => a.name.localeCompare(b.name)), [db]);
  const dayEntries = useDayEntries(date);
  const current = (dayEntries ?? []).filter((e) => e.meal === meal);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function saveCurrent() {
    if (!current.length) return;
    setBusy(true);
    try {
      const rec: Omit<SavedMeal, keyof SyncFields> = { name: name.trim() || `My ${MEAL_LABELS[meal].toLowerCase()}`, items: current.map(entryDraftOf) };
      await saveRecord('saved_meals', newRecord(rec), db);
      toast.show(`Saved “${rec.name}”`, { tone: 'success' });
      setName('');
    } catch {
      toast.show('Could not save. Please try again.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  async function remove(sm: SavedMeal) {
    await deleteRecord('saved_meals', sm.id, db);
    toast.show(`Deleted ${sm.name}`, { action: { label: 'Undo', onClick: () => void saveRecord('saved_meals', { ...sm, deletedAt: undefined }, db) } });
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="p-4 flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Save this {MEAL_LABELS[meal].toLowerCase()} as a meal</h3>
        {current.length === 0 ? (
          <p className="text-sm text-muted">Log some items to {MEAL_LABELS[meal].toLowerCase()} first, then save them together for next time.</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              {current.length} item{current.length === 1 ? '' : 's'}: {current.map((e) => e.name).join(', ')}
            </p>
            <Input label="Name" placeholder={`My ${MEAL_LABELS[meal].toLowerCase()}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            <Button onClick={saveCurrent} loading={busy}>
              Save meal
            </Button>
          </>
        )}
      </Card>
      <Card>
        {meals === undefined ? (
          <Spinner />
        ) : meals.length === 0 ? (
          <EmptyState title="No saved meals" body="Saved meals let you log a usual breakfast or lunch in one tap." />
        ) : (
          <ul className="divide-y divide-line">
            {meals.map((sm) => {
              const t = dayTotals(sm.items);
              return (
                <li key={sm.id} className="flex items-center gap-1 pl-4 pr-1 py-2 min-h-14">
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium truncate">{sm.name}</div>
                    <div className="text-xs text-muted truncate">
                      {sm.items.length} item{sm.items.length === 1 ? '' : 's'} · {t.missing.kcal ? '≥' : ''}
                      {t.kcal} kcal · {t.missing.protein ? '≥' : ''}
                      {displayMacro(t.protein, 'protein')} g protein
                    </div>
                  </div>
                  <Button size="sm" onClick={() => onLog(sm.items.map(entryDraftOf), sm.name)} aria-label={`Log ${sm.name}`}>
                    Log
                  </Button>
                  <IconButton label={`Delete ${sm.name}`} size="sm" onClick={() => remove(sm)}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------- recent */
function RecentTab({ onLog, today }: { onLog: LogFn; today: string }) {
  const { db } = useApp();
  const items = useLiveQuery(async () => {
    const rows = await db.foodLogs.where('date').between(addDays(today, -30), today, true, true).toArray();
    return recentItems(alive(rows) as FoodLogEntry[], 25);
  }, [db, today]);
  if (items === undefined) return <Spinner />;
  if (!items.length) return <EmptyState title="Nothing recent" body="Items you log will show up here for one-tap re-logging." />;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {items.map((e) => (
          <li key={e.id} className="flex items-center gap-2 pl-4 pr-2 py-2 min-h-14">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-medium truncate">{e.name}</div>
              <div className="text-xs text-muted truncate">
                {e.servings != null ? `${e.servings}× · ` : e.grams != null ? `${e.grams} g · ` : ''}
                {macroLine(e)}
              </div>
            </div>
            <Button size="sm" onClick={() => onLog([entryDraftOf(e)])} aria-label={`Log ${e.name} again`}>
              Add
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="relative">
      <Search className="size-4 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
      <Input aria-label={label} placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} className="pl-9" type="search" />
    </div>
  );
}
