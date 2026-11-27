/**
 * Log food. Lands on Recent (Quick protein first, then recently logged items); every other way to log stays one tab
 * away. All writes go through one `log()` handler: a synchronous in-flight guard, ids allocated once, the whole batch
 * stored with its outbox ops in one transaction (all-or-nothing), and success shown only after the local commit.
 * Offline success means local success; nothing claims cloud synchronization.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, Copy, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, ChipGroup, EmptyState, IconButton, Input, Notice, NumberInput, Page, Segmented, Select, Sheet, Spinner, Toggle, cx,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { alive, deleteRecord, newRecord, saveRecord, saveRecordsAtomic } from '@/db/repo';
import type { LiftDb } from '@/db/db';
import { addDays, formatDate, todayISO } from '@/lib/dates';
import type { CustomFood, FoodLogEntry, Ingredient, MealSlot, Recipe, SavedMeal, SyncFields } from '@/domain/types';
import { INGREDIENTS } from '@/data/ingredients';
import { RECIPES } from '@/data/recipes';
import { MEAL_ORDER, allergenLabel, displayMacro, mealLabel, recipeAllergens, recipeNutrition } from '@/domain/nutrition/recipes';
import {
  QUICK_PROTEIN_PRESETS, dayTotals, defaultMealAt, entryDraftOf, entryFromCustom, entryFromIngredient, entryFromRecipe, hourIn, normalizeLogDate,
  normalizeMeal, quickProteinDraft, recentItems, recentKey, type EntryDraft, type MacroKey,
} from '@/domain/nutrition/log';
import { hasKey, listText, numberText, tp as tpNow, useT, type MessageKey } from '@/i18n';
import { MACRO_LABEL, macroLine, useDayEntries } from './shared';

type Tab = 'recent' | 'quick' | 'foods' | 'recipes' | 'custom' | 'saved';
/** Display order; every id keeps its existing meaning (`quick` is the manual macro form). */
const TABS: { id: Tab; label: MessageKey }[] = [
  { id: 'recent', label: 'foodLog.tab.recent' },
  { id: 'quick', label: 'foodLog.tab.quick' },
  { id: 'foods', label: 'foodLog.tab.foods' },
  { id: 'recipes', label: 'foodLog.tab.recipes' },
  { id: 'custom', label: 'foodLog.tab.custom' },
  { id: 'saved', label: 'foodLog.tab.saved' },
];
const QUICK_PROTEIN_INPUT_ID = 'food-log-quick-protein';

/** Live query that reports a failed read instead of throwing during render. */
type Loaded<T> = { ok: true; value: T } | { ok: false };
async function guarded<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

/** Log a batch; `label` names it in the confirmation. Resolves true only after the local transaction committed. */
type LogFn = (drafts: EntryDraft[], label?: string) => Promise<boolean>;

export default function FoodLogPage() {
  const nav = useNavigate();
  const { account, db } = useApp();
  const toast = useToast();
  const { t, language } = useT();
  const [params, setParams] = useSearchParams();
  const tz = account.settings.timeZone;
  const today = todayISO(tz);
  // A valid deep link wins; an invalid or future date becomes today, an invalid meal the default (before render/write).
  const date = normalizeLogDate(params.get('date'), today);
  const meal = normalizeMeal(params.get('meal'), defaultMealAt(hourIn(tz)));
  const tab = (TABS.some((x) => x.id === params.get('tab')) ? params.get('tab') : 'recent') as Tab;
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    // Keep the date and meal explicit when changing tabs, so they survive the switch.
    next.set('date', date);
    next.set('meal', meal);
    Object.entries(patch).forEach(([k, v]) => next.set(k, v));
    setParams(next, { replace: true });
  };
  const fullMode = account.nutrition.mode !== 'protein_only';

  // The DB this page currently writes to; an account switch replaces it, and stale feedback is suppressed.
  const dbRef = useRef<LiftDb>(db);
  dbRef.current = db;
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [focusProtein, setFocusProtein] = useState(false);

  /** The shared in-flight guard: acquired synchronously (before any await), released on every exit. */
  const acquire = () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    return true;
  };
  const release = () => {
    inFlight.current = false;
    setPending(false);
  };

  /** Writes one batch atomically (with its outbox ops) and confirms it. The caller holds the guard. */
  async function commit(drafts: EntryDraft[], label: string | undefined, targetDb: LiftDb, at: { date: string; meal: MealSlot; today: string }): Promise<boolean> {
    const name = label ?? (drafts.length === 1 ? drafts[0].name : tpNow('foodLog.itemCount', drafts.length));
    const records = drafts.map((d) => newRecord<Omit<FoodLogEntry, keyof SyncFields>>({ ...entryDraftOf(d), date: at.date, meal: at.meal }));
    try {
      await saveRecordsAtomic(records.map((record) => ({ entity: 'food_logs' as const, record })), targetDb);
      if (dbRef.current === targetDb)
        toast.show(t('foodLog.added', { name, meal: mealLabel(at.meal, language), date: formatDate(at.date) }), {
          tone: 'success',
          action: { label: t('foodLog.viewDay'), onClick: () => nav(`/nutrition${at.date === at.today ? '' : `?date=${at.date}`}`) },
        });
      return true;
    } catch {
      if (dbRef.current === targetDb) toast.show(t('foodLog.saveError'), { tone: 'error' });
      return false;
    }
  }

  const log: LogFn = async (drafts, label) => {
    if (!drafts.length || !acquire()) return false;
    // Capture everything the write and its feedback depend on.
    try {
      return await commit(drafts, label, db, { date, meal, today });
    } finally {
      release();
    }
  };

  /** Copy this meal from the previous day: the guard is held across the read AND the write, so overlapping taps can't duplicate. */
  async function copyYesterday() {
    if (!acquire()) return;
    const targetDb = db;
    const at = { date, meal, today };
    const prev = addDays(at.date, -1);
    try {
      let rows: FoodLogEntry[];
      try {
        rows = alive(await targetDb.foodLogs.where('date').equals(prev).toArray()).filter((e) => e.meal === at.meal);
      } catch {
        if (dbRef.current === targetDb) toast.show(t('foodLog.loadError'), { tone: 'error' });
        return;
      }
      if (dbRef.current !== targetDb) return;
      if (!rows.length) {
        toast.show(t('foodLog.copyEmpty', { date: formatDate(prev) }));
        return;
      }
      await commit(rows.map(entryDraftOf), t('foodLog.copyLabel'), targetDb, at);
    } finally {
      release();
    }
  }

  // Tabs: roving focus with Arrow/Home/End; Enter/Space activate (native button behaviour).
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = TABS.length - 1;
    if (j < 0) return;
    e.preventDefault();
    const next = TABS[j].id;
    set({ tab: next });
    tabRefs.current[next]?.focus();
  };

  const otherAmount = () => {
    setFocusProtein(true);
    set({ tab: 'quick' });
  };

  return (
    <Page
      title={t('today.logFood')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="log-date" className="text-sm text-muted shrink-0">
            {t('progress.date')}
          </label>
          <input
            id="log-date"
            type="date"
            value={date}
            max={today}
            onChange={(e) => e.target.value && set({ date: normalizeLogDate(e.target.value, today) })}
            className="min-h-11 flex-1 rounded-xl bg-field border border-line-input px-3 text-[16px] text-ink focus:border-accent"
          />
        </div>
        <Segmented label={t('aiCard.recipe.meal')} value={meal} onChange={(m) => set({ meal: m })} options={MEAL_ORDER.map((m) => ({ value: m, label: mealLabel(m, language) }))} />
        <Button variant="outline" size="sm" icon={<Copy className="size-4" />} onClick={copyYesterday} disabled={pending} className="self-start">
          {t('foodLog.copyPrevious')}
        </Button>
        <div role="tablist" aria-label={t('foodLog.ways')} className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
          {TABS.map((x, i) => (
            <button
              key={x.id}
              ref={(el) => {
                tabRefs.current[x.id] = el;
              }}
              role="tab"
              type="button"
              id={`tab-${x.id}`}
              aria-selected={tab === x.id}
              aria-controls={`panel-${x.id}`}
              tabIndex={tab === x.id ? 0 : -1}
              onClick={() => set({ tab: x.id })}
              onKeyDown={(e) => onTabKey(e, i)}
              className={cx(
                'shrink-0 min-h-11 px-3.5 rounded-full border text-sm transition-colors',
                tab === x.id ? 'bg-accent-soft border-accent text-accent font-medium' : 'border-line text-ink hover:bg-surface-2',
              )}
            >
              {t(x.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
          {tab === 'recent' && <RecentTab onLog={log} today={today} pending={pending} onOther={otherAmount} />}
          {tab === 'quick' && <QuickTab onLog={log} fullMode={fullMode} pending={pending} focusProtein={focusProtein} onFocused={() => setFocusProtein(false)} />}
          {tab === 'foods' && <FoodsTab onLog={log} pending={pending} />}
          {tab === 'recipes' && <RecipesTab onLog={log} pending={pending} />}
          {tab === 'custom' && <CustomTab onLog={log} pending={pending} />}
          {tab === 'saved' && <SavedTab onLog={log} date={date} meal={meal} pending={pending} />}
        </div>
      </div>
    </Page>
  );
}

/* ------------------------------------------------------------ quick protein */
function QuickProtein({ onLog, pending, onOther }: { onLog: LogFn; pending: boolean; onOther: () => void }) {
  const { t } = useT();
  return (
    <Card as="section" aria-labelledby="quick-protein-title" className="p-4 flex flex-col gap-3">
      <div>
        <h2 id="quick-protein-title" className="text-sm font-semibold">
          {t('foodLog.quickProtein.title')}
        </h2>
        <p className="text-xs text-muted mt-0.5">{t('foodLog.quickProtein.help')}</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {QUICK_PROTEIN_PRESETS.map((g) => (
          <Button
            key={g}
            variant="outline"
            disabled={pending}
            aria-label={t('foodLog.quickProtein.add', { grams: g })}
            onClick={() => void onLog([quickProteinDraft(g, t('foodLog.quickProtein.entryName', { grams: g }))])}
          >
            {`+${numberText(g)} g`}
          </Button>
        ))}
      </div>
      <Button variant="ghost" size="sm" className="self-start" onClick={onOther}>
        {t('foodLog.quickProtein.other')}
      </Button>
    </Card>
  );
}

/* ------------------------------------------------------------------- recent */
function RecentTab({ onLog, today, pending, onOther }: { onLog: LogFn; today: string; pending: boolean; onOther: () => void }) {
  const { db } = useApp();
  const { t } = useT();
  // The Recent window is independent of the selected log date: the last 30 days through today, inclusive.
  const res = useLiveQuery(
    () =>
      guarded(async () => {
        const rows = await db.foodLogs.where('date').between(addDays(today, -30), today, true, true).toArray();
        return recentItems(alive(rows) as FoodLogEntry[], 25);
      }),
    [db, today],
  );
  return (
    <div className="flex flex-col gap-3">
      <QuickProtein onLog={onLog} pending={pending} onOther={onOther} />
      {res === undefined ? (
        <Spinner label={t('common.loading')} />
      ) : !res.ok ? (
        <Notice tone="warn">{t('foodLog.loadError')}</Notice>
      ) : !res.value.length ? (
        <Card>
          <EmptyState title={t('foodLog.recent.empty')} body={t('foodLog.recent.emptyHelp')} />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {res.value.map((e) => (
              <li key={recentKey(e)} className="flex items-center gap-2 pl-4 pr-2 py-2 min-h-14">
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium truncate">{e.name}</div>
                  <div className="text-xs text-muted truncate">
                    {e.servings != null ? `${numberText(e.servings)}× · ` : e.grams != null ? `${numberText(e.grams)} g · ` : ''}
                    {macroLine(e)}
                  </div>
                </div>
                <Button size="sm" disabled={pending} onClick={() => void onLog([entryDraftOf(e)])} aria-label={t('foodLog.recent.again', { name: e.name })}>
                  {t('foodLog.add')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- quick */
type Macros = Record<MacroKey, number | null>;
const EMPTY: Macros = { kcal: null, protein: null, carbs: null, fat: null };

function QuickTab({ onLog, fullMode, pending, focusProtein, onFocused }: { onLog: LogFn; fullMode: boolean; pending: boolean; focusProtein: boolean; onFocused: () => void }) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [m, setM] = useState<Macros>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!focusProtein) return;
    document.getElementById(QUICK_PROTEIN_INPUT_ID)?.focus();
    onFocused();
  }, [focusProtein, onFocused]);
  async function submit() {
    if (m.kcal == null && m.protein == null) {
      setError(t('foodLog.quick.required'));
      return;
    }
    setError(null);
    const d: EntryDraft = { name: name.trim() || t('foodLog.quick.entryName'), source: { kind: 'quick' } };
    if (m.kcal != null) d.kcal = m.kcal;
    if (m.protein != null) d.protein = m.protein;
    if (m.carbs != null) d.carbs = m.carbs;
    if (m.fat != null) d.fat = m.fat;
    // On failure the input stays as typed so it can be retried.
    if (await onLog([d])) {
      setName('');
      setM(EMPTY);
    }
  }
  return (
    <Card className="p-4 flex flex-col gap-3">
      <Input label={t('foodLog.quick.description')} placeholder={t('foodLog.quick.placeholder')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      <div className="grid grid-cols-2 gap-3">
        <NumberInput label={MACRO_LABEL.kcal} suffix="kcal" decimals={false} min={0} max={10000} value={m.kcal} onChange={(v) => setM((x) => ({ ...x, kcal: v }))} />
        <NumberInput id={QUICK_PROTEIN_INPUT_ID} label={MACRO_LABEL.protein} suffix="g" min={0} max={1000} value={m.protein} onChange={(v) => setM((x) => ({ ...x, protein: v }))} />
        {fullMode && (
          <>
            <NumberInput label={t('foodLog.quick.carbsOptional')} suffix="g" min={0} max={2000} value={m.carbs} onChange={(v) => setM((x) => ({ ...x, carbs: v }))} />
            <NumberInput label={t('foodLog.quick.fatOptional')} suffix="g" min={0} max={1000} value={m.fat} onChange={(v) => setM((x) => ({ ...x, fat: v }))} />
          </>
        )}
      </div>
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <p className="text-xs text-muted">{t('foodLog.unknownHelp')}</p>
      <Button variant="primary" onClick={submit} loading={pending} disabled={pending} icon={<Plus className="size-4" />}>
        {t('foodLog.add')}
      </Button>
    </Card>
  );
}

/* ------------------------------------------------------------------ recipes */
function RecipesTab({ onLog, pending }: { onLog: LogFn; pending: boolean }) {
  const { account } = useApp();
  const { t, tp, language } = useT();
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
      <SearchBox value={q} onChange={setQ} label={t('foodLog.recipes.search')} />
      <Card className="mt-3">
        {list.length === 0 ? (
          <EmptyState title={t('foodLog.recipes.empty')} body={t('foodLog.recipes.emptyHelp')} />
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
                        {mealLabel(r.meal, language)} · {t('foodLog.recipes.perServing', { macros: macroLine({ kcal: n.kcal, protein: n.protein }, false) })}
                      </div>
                    </div>
                    {clash.length > 0 && (
                      <Badge tone="warn">{t('foodLog.recipes.contains', { allergens: listText(clash.map((a) => allergenLabel(a, language)), language) })}</Badge>
                    )}
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
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!(servings > 0) || pending}
              loading={pending}
              onClick={async () => {
                if (picked && (await onLog([entryFromRecipe(picked, servings)]))) setPicked(null);
              }}
            >
              {t('foodLog.log')}
            </Button>
          </>
        }
      >
        {picked && preview && (
          <div className="flex flex-col gap-3">
            <NumberInput label={t('foodLog.recipes.servingsEaten')} value={servings} min={0.25} max={10} suffix="×" onChange={(v) => v != null && setServings(v)} />
            <ChipGroup label={t('foodLog.recipes.portions')} single values={[servings]} onChange={(v) => setServings(v[0])} options={[0.5, 1, 1.5, 2].map((x) => ({ value: x, label: `${numberText(x)}×` }))} />
            <p className="text-sm">{macroLine(preview)}</p>
            <p className="text-xs text-muted">{tp('foodLog.recipes.estimate', picked.servings)}</p>
            <Link to={`/nutrition/recipes/${picked.id}`} className="text-sm text-accent font-medium min-h-11 inline-flex items-center self-start">
              {t('foodLog.recipes.view')}
            </Link>
          </div>
        )}
      </Sheet>
    </>
  );
}

/* -------------------------------------------------------------------- foods */
function FoodsTab({ onLog, pending }: { onLog: LogFn; pending: boolean }) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Ingredient | null>(null);
  const [grams, setGrams] = useState<number | null>(100);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return INGREDIENTS.filter((i) => i.id !== 'spices' && (!s || i.name.toLowerCase().includes(s))).sort((a, b) => a.name.localeCompare(b.name));
  }, [q]);
  const unitChips = picked
    ? (Object.entries(picked.units ?? {}) as [string, number][]).map(([u, g]) => {
        const key = `foodLog.foods.measure.${u}`;
        return { value: g, label: hasKey(key) ? t(key, { grams: g }) : `1 ${u} (${numberText(g)} g)` };
      })
    : [];
  const preview = picked && grams ? entryFromIngredient(picked, grams) : null;
  const state = picked && picked.state !== 'as_sold' ? picked.state : null;
  return (
    <>
      <SearchBox value={q} onChange={setQ} label={t('foodLog.foods.search')} />
      <Card className="mt-3">
        {list.length === 0 ? (
          <EmptyState title={t('foodLog.foods.empty')} body={t('foodLog.foods.emptyHelp')} />
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
                    <div className="text-xs text-muted">{t('foodLog.foods.per100g', { macros: macroLine({ kcal: i.per100g.kcal, protein: i.per100g.protein }, false) })}</div>
                  </div>
                  {i.state !== 'as_sold' && <Badge>{t(`foodLog.foods.state.${i.state}`)}</Badge>}
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
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!grams || pending}
              loading={pending}
              onClick={async () => {
                if (picked && grams && (await onLog([entryFromIngredient(picked, grams)]))) setPicked(null);
              }}
            >
              {t('foodLog.log')}
            </Button>
          </>
        }
      >
        {picked && (
          <div className="flex flex-col gap-3">
            <NumberInput label={t('foodLog.foods.amount')} suffix="g" value={grams} min={1} max={3000} onChange={setGrams} />
            {unitChips.length > 0 && <ChipGroup label={t('foodLog.foods.measures')} single values={[grams ?? 0]} onChange={(v) => setGrams(v[0])} options={unitChips} />}
            {preview && <p className="text-sm">{macroLine(preview)}</p>}
            {state && <Notice>{t(`foodLog.foods.stateHelp.${state}`)}</Notice>}
            <p className="text-xs text-muted">{t('foodLog.foods.source', { source: picked.source })}</p>
          </div>
        )}
      </Sheet>
    </>
  );
}

/* ------------------------------------------------------------- custom foods */
/** "100 g" / "2 servings" in the current language (serving is a localized noun after the count-neutral prefix). */
function perUnitText(amount: number, unit: CustomFood['per']['unit']): string {
  return unit === 'serving' ? tpNow('foodLog.custom.serving', amount) : unit;
}

function CustomTab({ onLog, pending }: { onLog: LogFn; pending: boolean }) {
  const { db } = useApp();
  const toast = useToast();
  const { t } = useT();
  const res = useLiveQuery(() => guarded(async () => alive(await db.customFoods.toArray()).sort((a, b) => a.name.localeCompare(b.name))), [db]);
  const [editing, setEditing] = useState<CustomFood | 'new' | null>(null);
  const [picked, setPicked] = useState<CustomFood | null>(null);
  const [amount, setAmount] = useState<number | null>(null);

  async function remove(f: CustomFood) {
    try {
      await deleteRecord('custom_foods', f.id, db);
    } catch {
      toast.show(t('foodLog.deleteError'), { tone: 'error' });
      return;
    }
    toast.show(t('foodLog.deleted', { name: f.name }), {
      action: {
        label: t('aiCard.undo'),
        onClick: () => void saveRecord('custom_foods', { ...f, deletedAt: undefined }, db).catch(() => toast.show(t('foodLog.undoError'), { tone: 'error' })),
      },
    });
  }

  return (
    <>
      <Button block icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
        {t('foodLog.custom.new')}
      </Button>
      <Card className="mt-3">
        {res === undefined ? (
          <Spinner label={t('common.loading')} />
        ) : !res.ok ? (
          <Notice tone="warn">{t('foodLog.loadError')}</Notice>
        ) : res.value.length === 0 ? (
          <EmptyState title={t('foodLog.custom.empty')} body={t('foodLog.custom.emptyHelp')} />
        ) : (
          <ul className="divide-y divide-line">
            {res.value.map((f) => (
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
                    {t('foodLog.custom.per', { amount: numberText(f.per.amount), unit: perUnitText(f.per.amount, f.per.unit), macros: macroLine(f.macros) })} ·{' '}
                    {t(f.isLabel ? 'foodLog.custom.label' : 'foodLog.custom.estimate')}
                  </div>
                </button>
                <IconButton label={t('foodLog.editNamed', { name: f.name })} size="sm" onClick={() => setEditing(f)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton label={t('foodLog.deleteNamed', { name: f.name })} size="sm" onClick={() => void remove(f)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? t('foodLog.custom.new') : t('foodLog.custom.edit')}>
        {editing !== null && <CustomFoodForm key={editing === 'new' ? 'new' : editing.id} food={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Sheet>
      <Sheet
        open={!!picked}
        onClose={() => setPicked(null)}
        title={picked?.name ?? ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPicked(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!amount || pending}
              loading={pending}
              onClick={async () => {
                if (picked && amount && (await onLog([entryFromCustom(picked, amount)]))) setPicked(null);
              }}
            >
              {t('foodLog.log')}
            </Button>
          </>
        }
      >
        {picked && (
          <div className="flex flex-col gap-3">
            <NumberInput
              label={picked.per.unit === 'serving' ? t('foodLog.custom.servings') : t('foodLog.custom.amountUnit', { unit: picked.per.unit })}
              suffix={picked.per.unit === 'serving' ? '×' : picked.per.unit}
              value={amount}
              min={0.1}
              max={5000}
              onChange={setAmount}
            />
            {amount ? <p className="text-sm">{macroLine(entryFromCustom(picked, amount))}</p> : null}
            <p className="text-xs text-muted">{t(picked.isLabel ? 'foodLog.custom.fromLabel' : 'foodLog.custom.fromEstimate')}</p>
          </div>
        )}
      </Sheet>
    </>
  );
}

function CustomFoodForm({ food, onDone }: { food: CustomFood | null; onDone: () => void }) {
  const { db } = useApp();
  const toast = useToast();
  const { t } = useT();
  const [name, setName] = useState(food?.name ?? '');
  const [brand, setBrand] = useState(food?.brand ?? '');
  const [perAmount, setPerAmount] = useState<number | null>(food?.per.amount ?? 100);
  const [perUnit, setPerUnit] = useState<CustomFood['per']['unit']>(food?.per.unit ?? 'g');
  const [m, setM] = useState<Macros>({ kcal: food?.macros.kcal ?? null, protein: food?.macros.protein ?? null, carbs: food?.macros.carbs ?? null, fat: food?.macros.fat ?? null });
  const [isLabel, setIsLabel] = useState(food?.isLabel ?? true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameErr = !name.trim() ? t('foodLog.custom.nameRequired') : null;
  const amountErr = !perAmount ? t('foodLog.custom.amountRequired') : null;
  const valuesErr = m.kcal == null && m.protein == null ? t('foodLog.custom.macrosRequired') : null;

  async function save() {
    setTried(true);
    if (nameErr || amountErr || valuesErr || busy) return;
    setBusy(true);
    const macros: CustomFood['macros'] = {};
    (['kcal', 'protein', 'carbs', 'fat'] as const).forEach((k) => {
      if (m[k] != null) macros[k] = m[k]!;
    });
    const fields = { name: name.trim(), brand: brand.trim() || undefined, per: { amount: perAmount!, unit: perUnit }, macros, isLabel };
    try {
      await saveRecord('custom_foods', food ? { ...food, ...fields } : newRecord(fields), db);
      toast.show(food ? t('foodLog.custom.updated') : t('foodLog.custom.saved'), { tone: 'success' });
      onDone();
    } catch {
      toast.show(t('foodLog.saveError'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  const unknown = t('settings.unknown');
  return (
    <div className="flex flex-col gap-3">
      <Input label={t('program.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} error={tried ? nameErr : null} />
      <Input label={t('foodLog.custom.brand')} value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={60} />
      <div className="grid grid-cols-2 gap-3">
        <NumberInput label={t('foodLog.custom.valuesPer')} value={perAmount} min={0.1} max={5000} onChange={setPerAmount} error={tried ? amountErr : null} />
        <Select label={t('foodLog.custom.unit')} value={perUnit} onChange={(e) => setPerUnit(e.target.value as CustomFood['per']['unit'])}>
          <option value="g">{t('foodLog.custom.grams')}</option>
          <option value="ml">{t('foodLog.custom.millilitres')}</option>
          <option value="serving">{t('foodLog.custom.servings')}</option>
        </Select>
        <NumberInput label={MACRO_LABEL.kcal} suffix="kcal" decimals={false} min={0} max={10000} value={m.kcal} onChange={(v) => setM((x) => ({ ...x, kcal: v }))} placeholder={unknown} />
        <NumberInput label={MACRO_LABEL.protein} suffix="g" min={0} max={1000} value={m.protein} onChange={(v) => setM((x) => ({ ...x, protein: v }))} placeholder={unknown} />
        <NumberInput label={MACRO_LABEL.carbs} suffix="g" min={0} max={2000} value={m.carbs} onChange={(v) => setM((x) => ({ ...x, carbs: v }))} placeholder={unknown} />
        <NumberInput label={MACRO_LABEL.fat} suffix="g" min={0} max={1000} value={m.fat} onChange={(v) => setM((x) => ({ ...x, fat: v }))} placeholder={unknown} />
      </div>
      {tried && valuesErr && (
        <p className="text-sm text-danger" role="alert">
          {valuesErr}
        </p>
      )}
      <Toggle label={t('foodLog.custom.labelValues')} description={t('foodLog.custom.labelHelp')} checked={isLabel} onChange={setIsLabel} />
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={save} loading={busy}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- saved meals */
/** "≥420 kcal · at least 32 g protein": known sums, marked as lower bounds when some items lack the value. */
function savedMealSummary(items: EntryDraft[], t: ReturnType<typeof useT>['t']): string {
  const tot = dayTotals(items);
  const kcal = `${numberText(tot.kcal)} kcal`;
  const protein = t('aiCard.macro.lineProtein', { amount: numberText(displayMacro(tot.protein, 'protein')) });
  return [tot.missing.kcal ? t('aiCard.macro.atLeast', { amount: kcal }) : kcal, tot.missing.protein ? t('aiCard.macro.atLeast', { amount: protein }) : protein].join(' · ');
}

function SavedTab({ onLog, date, meal, pending }: { onLog: LogFn; date: string; meal: MealSlot; pending: boolean }) {
  const { db } = useApp();
  const toast = useToast();
  const { t, tp, language } = useT();
  const res = useLiveQuery(() => guarded(async () => alive(await db.savedMeals.toArray()).sort((a, b) => a.name.localeCompare(b.name))), [db]);
  const dayEntries = useDayEntries(date);
  const current = (dayEntries ?? []).filter((e) => e.meal === meal);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function saveCurrent() {
    if (!current.length || busy) return;
    setBusy(true);
    try {
      // The default name is localized once, at creation; it is never renamed later.
      const rec: Omit<SavedMeal, keyof SyncFields> = { name: name.trim() || t('foodLog.saved.defaultName'), items: current.map(entryDraftOf) };
      await saveRecord('saved_meals', newRecord(rec), db);
      toast.show(t('foodLog.saved.saved', { name: rec.name }), { tone: 'success' });
      setName('');
    } catch {
      toast.show(t('foodLog.saveError'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  async function remove(sm: SavedMeal) {
    try {
      await deleteRecord('saved_meals', sm.id, db);
    } catch {
      toast.show(t('foodLog.deleteError'), { tone: 'error' });
      return;
    }
    toast.show(t('foodLog.deleted', { name: sm.name }), {
      action: {
        label: t('aiCard.undo'),
        onClick: () => void saveRecord('saved_meals', { ...sm, deletedAt: undefined }, db).catch(() => toast.show(t('foodLog.undoError'), { tone: 'error' })),
      },
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="p-4 flex flex-col gap-3">
        <h3 className="text-sm font-semibold">
          {t('foodLog.saved.title')} <span className="text-muted font-normal">· {mealLabel(meal, language)}</span>
        </h3>
        {current.length === 0 ? (
          <p className="text-sm text-muted">{t('foodLog.saved.first')}</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              {tp('foodLog.itemCount', current.length)} · {t('foodLog.saved.items', { items: listText(current.map((e) => e.name), language) })}
            </p>
            <Input label={t('program.name')} placeholder={t('foodLog.saved.defaultName')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            <Button onClick={saveCurrent} loading={busy}>
              {t('foodLog.saved.save')}
            </Button>
          </>
        )}
      </Card>
      <Card>
        {res === undefined ? (
          <Spinner label={t('common.loading')} />
        ) : !res.ok ? (
          <Notice tone="warn">{t('foodLog.loadError')}</Notice>
        ) : res.value.length === 0 ? (
          <EmptyState title={t('foodLog.saved.empty')} body={t('foodLog.saved.emptyHelp')} />
        ) : (
          <ul className="divide-y divide-line">
            {res.value.map((sm) => (
              <li key={sm.id} className="flex items-center gap-1 pl-4 pr-1 py-2 min-h-14">
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium truncate">{sm.name}</div>
                  <div className="text-xs text-muted truncate">
                    {tp('foodLog.itemCount', sm.items.length)} · {savedMealSummary(sm.items, t)}
                  </div>
                </div>
                <Button size="sm" disabled={pending} onClick={() => void onLog(sm.items.map(entryDraftOf), sm.name)} aria-label={t('foodLog.logNamed', { name: sm.name })}>
                  {t('foodLog.log')}
                </Button>
                <IconButton label={t('foodLog.deleteNamed', { name: sm.name })} size="sm" onClick={() => void remove(sm)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
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
