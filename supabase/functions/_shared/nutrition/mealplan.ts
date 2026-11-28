/**
 * SHARED by the app (src/domain/nutrition/mealplan.ts re-exports it) and the ai-coach function (propose_meal_plan builds
 * plans with it) — one implementation, so the same inputs give the same plan in both places.
 * Deterministic weekly meal plans.
 * Same inputs → same plan. Allergens, diet tags and disliked ingredients are hard filters
 * (never relaxed); cooking time is relaxed with a warning only if nothing else fits.
 *
 * After meals are chosen, every day is reconciled with the declared objective — the protein target, plus an
 * energy target only when the user actually has one (full/manual mode; protein-only never gets an invented one):
 * - portions are scaled in quarter servings within bounds,
 * - a protein side from the ingredient catalogue can be added to an existing meal (meal count unchanged),
 * - while generating, a meal can be swapped for a higher-protein recipe that meets the same constraints.
 * If the constraints make the target unreachable, the remaining gap is reported per day. Status, gaps and
 * warnings are derived from the saved plan plus current settings, so they are identical after a reload.
 */
import type {
  Allergen, BudgetPref, DietPrefs, DietTag, ID, ISODate, Ingredient, Macros, MealPlanContent, MealPlanExtra, MealPlanItem, MealSlot,
  NutritionTargetsLike, ProteinGroup, Recipe,
} from './types.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { catalog } from './catalog.ts';
// @ts-ignore see above
import { addMacros, allergenLabel, ingredientFitsProteinPrefs, likedBonus, normalizeProteinPrefs, proteinFitSwaps, proteinListText, recipeProteinGroups, dietTagLabel, displayMacro, formatFraction, formatGrams, friendlyAmount, ingredientAllowed, macrosForGrams, MEAL_LABELS, recipeAllergens, recipeCostTier, recipeDietTags, recipeMatches, recipeMinutes, recipeNutrition, resolveIngredients, roundMacros, satisfiesTag, ZERO_MACROS, type IngredientIndex, type Swap, } from './recipes.ts';
// @ts-ignore see above
import { listText, localeFor, numberText, sharedT, type Language, type SharedKey } from '../i18n/core.ts';

const round = (n: number, decimals = 2) => {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
};
const addDays = (date: ISODate, n: number): ISODate => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Same output as the app's formatDate (en-GB, UTC calendar date). */
const formatDate = (date: ISODate, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

export interface PlanPrefs {
  tags: DietTag[];
  allergens: Allergen[];
  dislikedIngredientIds: ID[];
  maxCookMinutes: number;
  budget: BudgetPref;
  mealsPerDay: number;
  /** Daily energy target. Only set when the user has one (full/manual mode); never derived in protein-only mode. */
  kcalTarget?: number;
  /** Daily protein target in grams. */
  proteinTarget?: number;
  /** Rotates choices for "regenerate" while staying deterministic. */
  variant?: number;
  /** Proteins to prefer (ranked higher; others still appear for variety). */
  proteinLiked?: ProteinGroup[];
  /** Proteins marked "not for me": never used in meals, swaps or protein sides. */
  proteinExcluded?: ProteinGroup[];
}

export interface PlanContext {
  recipes?: Recipe[];
  byId?: IngredientIndex;
  /**
   * Language of the warning and day-status texts (planWarnings, planDayStatus, planStatus). Default English; the server
   * never sets it, so its output is unchanged. Planning itself never depends on it.
   */
  lang?: Language;
  /** Recipe name shown in those texts (the app passes its localized catalog name). Default `r.name`. */
  recipeName?: (r: Recipe) => string;
  /** "on Monday" / "á mánudaginn" for a plan date, a whole phrase (the app passes weekdayOn). Default English. */
  weekdayOn?: (date: ISODate) => string;
}

export type PlanDraft = MealPlanContent;
export type PlanDay = PlanDraft['days'][number];

/**
 * Planner preferences from saved settings. Energy targets are used only in full/manual mode, so a stale
 * calorie value left over from an earlier mode is never applied to a protein-only plan.
 */
export function planPrefsFrom(diet: DietPrefs, targets: NutritionTargetsLike, nutritionEnabled: boolean, variant = 0): PlanPrefs {
  const withTargets = nutritionEnabled && targets.mode !== 'none';
  const energy = withTargets && (targets.mode === 'full' || targets.mode === 'manual') && targets.calories && targets.calories > 0 ? targets.calories : undefined;
  return {
    // "High protein" is treated as a ranking preference, not a hard filter.
    tags: diet.tags.filter((x) => x !== 'high_protein'),
    allergens: diet.allergens,
    dislikedIngredientIds: diet.dislikedIngredientIds,
    maxCookMinutes: diet.maxCookMinutes || 30,
    budget: diet.budget,
    mealsPerDay: diet.mealsPerDay || 3,
    kcalTarget: energy,
    proteinTarget: withTargets && targets.proteinG && targets.proteinG > 0 ? targets.proteinG : undefined,
    variant,
    ...proteinPrefsFields(diet),
  };
}

/** Protein preference fields for PlanPrefs; nothing at all when the user has none (old data plans exactly as before). */
export function proteinPrefsFields(diet: Pick<DietPrefs, 'proteinPrefs'>): Pick<PlanPrefs, 'proteinLiked' | 'proteinExcluded'> {
  const p = normalizeProteinPrefs(diet.proteinPrefs);
  return { ...(p.liked.length ? { proteinLiked: p.liked } : {}), ...(p.excluded.length ? { proteinExcluded: p.excluded } : {}) };
}

/** The swaps a planned recipe needs to fit the user's protein exclusions ([] when none are needed). */
export function planSwapsFor(recipe: Recipe, prefs: PlanPrefs, byId: IngredientIndex = catalog().byId): Swap[] {
  const allowed = (ing: Ingredient) => ingredientAllowed(ing, { tags: prefs.tags, allergens: prefs.allergens, disliked: prefs.dislikedIngredientIds });
  return proteinFitSwaps(recipe, prefs.proteinExcluded, allowed, byId) ?? [];
}
/** A plan item's recipe fields, with the protein swaps only when there are any (keeps the saved shape unchanged otherwise). */
function withRecipe(recipe: Recipe, prefs: PlanPrefs, byId: IngredientIndex): { recipeId: ID; swaps?: Swap[] } {
  const swaps = planSwapsFor(recipe, prefs, byId);
  return swaps.length ? { recipeId: recipe.id, swaps } : { recipeId: recipe.id };
}

/** Meal slots for a number of meals per day (1–6). */
export function slotsForMeals(mealsPerDay: number): MealSlot[] {
  const n = Math.min(6, Math.max(1, Math.round(mealsPerDay)));
  const map: Record<number, MealSlot[]> = {
    1: ['dinner'],
    2: ['lunch', 'dinner'],
    3: ['breakfast', 'lunch', 'dinner'],
    4: ['breakfast', 'lunch', 'dinner', 'snack'],
    5: ['breakfast', 'snack', 'lunch', 'dinner', 'snack'],
    6: ['breakfast', 'snack', 'lunch', 'snack', 'dinner', 'snack'],
  };
  return map[n];
}

function score(recipe: Recipe, prefs: PlanPrefs, byId: IngredientIndex): number {
  const { perServing } = recipeNutrition(recipe, { byId });
  const meals = slotsForMeals(prefs.mealsPerDay).length;
  let s = 0;
  if (prefs.proteinTarget) {
    const perMeal = prefs.proteinTarget / meals;
    s -= Math.abs(perServing.protein - perMeal) / Math.max(10, perMeal);
  } else if (perServing.kcal > 0) {
    s += (perServing.protein * 4) / perServing.kcal;
  }
  const cost = recipeCostTier(recipe, byId);
  if (prefs.budget === 'low') s -= (cost - 1) * 0.6;
  else if (prefs.budget === 'medium') s -= Math.max(0, cost - 2) * 0.6;
  s += likedBonus(recipe, prefs.proteinLiked, byId);
  return s;
}

/** Recipes eligible for a slot, ranked best first, plus whether the cook-time limit had to be relaxed. */
export function rankedCandidates(slot: MealSlot, prefs: PlanPrefs, ctx: PlanContext = {}): { recipes: Recipe[]; relaxedTime: boolean } {
  const recipes = ctx.recipes ?? catalog().recipes;
  const byId = ctx.byId ?? catalog().byId;
  const base = { meal: slot, tags: prefs.tags, excludeAllergens: prefs.allergens, dislikedIngredientIds: prefs.dislikedIngredientIds, excludeProteinGroups: prefs.proteinExcluded };
  let list = recipes.filter((r) => recipeMatches(r, { ...base, maxMinutes: prefs.maxCookMinutes }, byId));
  let relaxedTime = false;
  if (list.length === 0) {
    list = recipes.filter((r) => recipeMatches(r, base, byId));
    relaxedTime = list.length > 0;
  }
  const scored = list.map((r) => ({ r, s: score(r, prefs, byId) }));
  scored.sort((a, b) => b.s - a.s || recipeMinutes(a.r) - recipeMinutes(b.r) || a.r.id.localeCompare(b.r.id));
  return { recipes: scored.map((x) => x.r), relaxedTime };
}

const roundHalf = (n: number) => Math.round(n * 2) / 2;

/* --------------------------------------------------------- objective & bounds */
export const PORTION_STEP = 0.25;
/** Portions the balancer may choose. With an energy target portions also carry calories, so the range is wider. */
export function portionBounds(prefs: Pick<PlanPrefs, 'kcalTarget'>): [number, number] {
  return prefs.kcalTarget ? [0.5, 2] : [0.75, 1.5];
}
/** A day counts as on target within ± this many grams of protein (5 % of the target, at least 5 g). */
export function proteinTolerance(targetG: number): number {
  return Math.max(5, Math.round(targetG * 0.05));
}
/** Energy tolerance when (and only when) an energy target exists. */
export function energyTolerance(kcal: number): number {
  return Math.max(100, Math.round(kcal * 0.08));
}
/** At most one protein side per meal and three per day. */
const MAX_EXTRAS_PER_DAY = 3;
const MAX_BALANCE_STEPS = 12;

/* ------------------------------------------------------------ protein sides */
export interface ProteinAddOn {
  ingredientId: ID;
  /** Short description used after the amount, e.g. "roast chicken breast". */
  label: string;
  slots: MealSlot[];
  /** Grams as eaten, smallest first. */
  amounts: number[];
  /** Extra preparation time (0 = ready to eat). */
  minutes: number;
}

/** Ready-to-eat or quick protein foods from the ingredient catalogue that can be added to a planned meal. */
export const PROTEIN_ADDONS: ProteinAddOn[] = [
  { ingredientId: 'chicken-breast-cooked', label: 'roast chicken breast', slots: ['lunch', 'dinner'], amounts: [50, 75, 100, 125, 150], minutes: 0 },
  { ingredientId: 'tuna-canned', label: 'tuna in water', slots: ['lunch', 'dinner'], amounts: [60, 120], minutes: 0 },
  { ingredientId: 'shrimp-cooked', label: 'cooked prawns', slots: ['lunch', 'dinner'], amounts: [50, 75, 100, 125, 150], minutes: 0 },
  { ingredientId: 'egg', label: 'hard-boiled', slots: ['breakfast', 'lunch'], amounts: [50, 100, 150], minutes: 10 },
  { ingredientId: 'tofu-firm', label: 'firm tofu', slots: ['breakfast', 'lunch', 'dinner'], amounts: [75, 100, 150, 200], minutes: 0 },
  { ingredientId: 'tempeh', label: 'tempeh', slots: ['lunch', 'dinner'], amounts: [50, 75, 100], minutes: 5 },
  { ingredientId: 'edamame', label: 'edamame beans', slots: ['lunch', 'dinner', 'snack'], amounts: [75, 100, 150], minutes: 5 },
  { ingredientId: 'skyr-plain', label: 'plain skyr', slots: ['breakfast', 'lunch', 'snack'], amounts: [100, 150, 200, 250], minutes: 0 },
  { ingredientId: 'greek-yogurt-0', label: 'fat-free Greek yogurt', slots: ['breakfast', 'snack'], amounts: [100, 150, 200], minutes: 0 },
  { ingredientId: 'cottage-cheese', label: 'cottage cheese', slots: ['breakfast', 'lunch', 'snack'], amounts: [100, 150, 200], minutes: 0 },
  { ingredientId: 'lentils-cooked', label: 'cooked lentils', slots: ['lunch', 'dinner'], amounts: [100, 150, 200], minutes: 0 },
];
const ADDON_BY_ID = new Map(PROTEIN_ADDONS.map((a) => [a.ingredientId, a]));

function addOnAllowed(ing: Ingredient, prefs: PlanPrefs): boolean {
  if (!ingredientAllowed(ing, { tags: prefs.tags, allergens: prefs.allergens, disliked: prefs.dislikedIngredientIds })) return false;
  if (!ingredientFitsProteinPrefs(ing, prefs.proteinExcluded)) return false;
  if (prefs.budget === 'low' && ing.costTier > 2) return false;
  return true;
}

/** Protein sides allowed for a slot under the user's allergens, diet, dislikes, protein choices and budget; liked proteins first, then most protein per kcal. */
export function allowedAddOns(slot: MealSlot, prefs: PlanPrefs, ctx: PlanContext = {}): ProteinAddOn[] {
  const byId = ctx.byId ?? catalog().byId;
  return PROTEIN_ADDONS.filter((a) => {
    const ing = byId.get(a.ingredientId);
    return !!ing && a.slots.includes(slot) && addOnAllowed(ing, prefs);
  }).sort((a, b) => {
    const ia = byId.get(a.ingredientId)!;
    const ib = byId.get(b.ingredientId)!;
    const liked = (i: Ingredient) => (i.proteinGroup && prefs.proteinLiked?.includes(i.proteinGroup) ? 1 : 0);
    return liked(ib) - liked(ia) || ib.per100g.protein / ib.per100g.kcal - ia.per100g.protein / ia.per100g.kcal || a.ingredientId.localeCompare(b.ingredientId);
  });
}

/** Localized label keys for the protein sides (aiCard.side.*); the English `label` above stays the canonical text. */
const SIDE_KEYS: Record<string, string> = {
  'chicken-breast-cooked': 'chicken', 'tuna-canned': 'tuna', 'shrimp-cooked': 'shrimp', egg: 'egg', 'tofu-firm': 'tofu', tempeh: 'tempeh',
  edamame: 'edamame', 'skyr-plain': 'skyr', 'greek-yogurt-0': 'yogurt', 'cottage-cheese': 'cottageCheese', 'lentils-cooked': 'lentils',
};

/** A protein side's display label: "roast chicken breast" / "steikt kjúklingabringa"; eggs agree with `count`. */
export function sideLabel(ingredientId: ID, lang: Language = 'en', count = 1): string | null {
  const addOn = ADDON_BY_ID.get(ingredientId);
  if (!addOn) return null;
  const key = SIDE_KEYS[ingredientId];
  if (lang === 'en' || !key) return addOn.label;
  const tr = sharedT(lang);
  return tr.has(`aiCard.side.${key}`) ? tr.t(`aiCard.side.${key}` as never) : tr.tp(`aiCard.side.${key}`, count);
}

/**
 * "100 g roast chicken breast", "2 eggs (hard-boiled)", "1 can tuna in water". Icelandic puts the food first and the
 * amount after a colon, so catalogue-style labels never need inflecting: "Steikt kjúklingabringa: 100 g",
 * "Harðsoðin egg: 2 stk.", "Túnfiskur í vatni: 1 dós".
 */
export function extraText(extra: MealPlanExtra, byId: IngredientIndex = catalog().byId, lang: Language = 'en'): string {
  const ing = byId.get(extra.ingredientId);
  if (!ing) return formatGrams(extra.grams, lang);
  if (lang !== 'en') return extraTextLocalized(extra, ing, lang);
  const addOn = ADDON_BY_ID.get(extra.ingredientId);
  const counted = ing.units?.piece || ing.units?.can ? friendlyAmount(ing, extra.grams) : null;
  if (counted && addOn) return ing.units?.piece ? `${counted} (${addOn.label})` : `${counted} ${addOn.label}`;
  return `${formatGrams(extra.grams)} ${addOn?.label ?? ing.name.toLowerCase()}`;
}

function extraTextLocalized(extra: MealPlanExtra, ing: Ingredient, lang: Language): string {
  const tr = sharedT(lang);
  const cap = (x: string) => x.charAt(0).toLocaleUpperCase(localeFor(lang)) + x.slice(1);
  const addOn = ADDON_BY_ID.get(extra.ingredientId);
  // Counted like the English text: only ingredients with piece labels in the catalog (eggs).
  if (addOn && ing.units?.piece && catalog().pieceLabels[ing.id]) {
    const n = extra.grams / ing.units.piece;
    if (n >= 0.2) {
      const r = n >= 3 ? Math.round(n) : Math.round(n * 2) / 2;
      const nn = r === 0 ? 0.5 : r;
      const food = cap(sideLabel(extra.ingredientId, lang, nn) ?? addOn.label);
      return tr.tp('aiCard.side.pieces', nn, { food, amount: tr.t('aiCard.quantity.pieces', { count: formatFraction(nn) }) });
    }
  }
  const counted = addOn && ing.units?.can ? friendlyAmount(ing, extra.grams, lang) : null;
  const food = cap(addOn ? sideLabel(extra.ingredientId, lang) ?? addOn.label : ing.name.toLowerCase());
  return tr.t('aiCard.side.amount', { food, amount: counted ?? formatGrams(extra.grams, lang) });
}

/* -------------------------------------------------------------- nutrition */
function extrasMacros(extras: MealPlanExtra[] | undefined, byId: IngredientIndex): Macros {
  let m = { ...ZERO_MACROS };
  for (const e of extras ?? []) {
    const ing = byId.get(e.ingredientId);
    if (ing && e.grams > 0) m = addMacros(m, macrosForGrams(ing, e.grams));
  }
  return m;
}

/**
 * Nutrition for one planned meal (servings, ingredient swaps and protein sides applied), at stored precision
 * (the same rounding a food-log entry gets). Unknown recipes contribute only their sides.
 */
export function planItemNutrition(item: MealPlanItem, recipesById: Map<ID, Recipe>, byId: IngredientIndex = catalog().byId): Macros {
  const r = recipesById.get(item.recipeId);
  const base = r ? recipeNutrition(r, { servings: item.servings, swaps: item.swaps, byId }).total : { ...ZERO_MACROS };
  return roundMacros(addMacros(base, extrasMacros(item.extras, byId)));
}

/** Nutrition for one planned day: the sum of its meals as rounded by planItemNutrition. */
export function planDayNutrition(day: PlanDay, recipesById: Map<ID, Recipe>, byId: IngredientIndex = catalog().byId): Macros {
  return roundMacros(day.items.reduce((acc, it) => addMacros(acc, planItemNutrition(it, recipesById, byId)), { ...ZERO_MACROS }));
}

/* --------------------------------------------------------------- balancing */
interface Objective {
  protein?: number;
  tolP: number;
  kcal?: number;
  tolK: number;
}
function objectiveOf(prefs: PlanPrefs): Objective | null {
  const protein = prefs.proteinTarget && prefs.proteinTarget > 0 ? prefs.proteinTarget : undefined;
  const kcal = prefs.kcalTarget && prefs.kcalTarget > 0 ? prefs.kcalTarget : undefined;
  if (protein == null && kcal == null) return null;
  return { protein, tolP: protein ? proteinTolerance(protein) : 0, kcal, tolK: kcal ? energyTolerance(kcal) : 0 };
}
/** How far outside the tolerance band a day is (protein grams; 100 kcal outside ≈ 5 g). */
function outside(m: Macros, o: Objective): number {
  let c = 0;
  if (o.protein != null) c += Math.max(0, Math.abs(m.protein - o.protein) - o.tolP);
  if (o.kcal != null) c += 0.05 * Math.max(0, Math.abs(m.kcal - o.kcal) - o.tolK);
  return round(c, 3);
}
function centre(m: Macros, o: Objective): number {
  return (o.protein != null ? 0.02 * Math.abs(m.protein - o.protein) : 0) + (o.kcal != null ? 0.0005 * Math.abs(m.kcal - o.kcal) : 0);
}

function extraMinutes(extras: MealPlanExtra[] | undefined): number {
  return Math.max(0, ...(extras ?? []).map((e) => ADDON_BY_ID.get(e.ingredientId)?.minutes ?? 0));
}

export interface BalanceOptions extends PlanContext {
  /** Allow replacing a meal with a different recipe (used while generating; not for a plan the user has edited). */
  allowSwaps?: boolean;
  /** Day index in the week; rotates which protein side is preferred so the week isn't identical. */
  dayIndex?: number;
  /** How often each recipe is already used this week (discourages repeats when swapping). */
  weekUsage?: Map<ID, number>;
}

/**
 * Move a day's planned totals into the target band with the fewest, smallest changes. Deterministic.
 * Never adds meals, never uses anything outside the allergen/diet/dislike filters, respects cooking time.
 * Returns the day unchanged when it is already on target or nothing helps.
 */
export function balanceDay(day: PlanDay, prefs: PlanPrefs, opts: BalanceOptions = {}): PlanDay {
  const obj = objectiveOf(prefs);
  if (!obj || day.items.length === 0) return day;
  const byId = opts.byId ?? catalog().byId;
  const recipesById = new Map((opts.recipes ?? catalog().recipes).map((r) => [r.id, r]));
  const [lo, hi] = portionBounds(prefs);
  const dayIndex = opts.dayIndex ?? 0;
  const usage = opts.weekUsage ?? new Map<ID, number>();
  const pools = new Map<MealSlot, Recipe[]>();
  const poolFor = (slot: MealSlot) => {
    if (!pools.has(slot)) pools.set(slot, rankedCandidates(slot, prefs, opts).recipes);
    return pools.get(slot)!;
  };
  const sides = new Map<MealSlot, ProteinAddOn[]>();
  const sidesFor = (slot: MealSlot) => {
    if (!sides.has(slot)) sides.set(slot, allowedAddOns(slot, prefs, opts));
    return sides.get(slot)!;
  };
  const nut = (d: PlanDay) => planDayNutrition(d, recipesById, byId);
  const withItem = (d: PlanDay, idx: number, item: MealPlanItem): PlanDay => ({ ...d, items: d.items.map((x, i) => (i === idx ? item : x)) });

  let cur = day;
  let curM = nut(cur);
  let curOut = outside(curM, obj);
  for (let step = 0; step < MAX_BALANCE_STEPS && curOut > 0; step++) {
    const moves: { d: PlanDay; penalty: number }[] = [];
    const extrasInDay = cur.items.reduce((n, it) => n + (it.extras?.length ?? 0), 0);
    cur.items.forEach((it, idx) => {
      const recipe = recipesById.get(it.recipeId);
      const minutes = recipe ? recipeMinutes(recipe) : 0;
      // 1. Portions, in quarter servings, only for meals already inside the bounds (manual choices outside are kept).
      if (recipe && it.servings >= lo - 1e-9 && it.servings <= hi + 1e-9) {
        for (const dir of [1, -1]) {
          const s = round(it.servings + dir * PORTION_STEP, 2);
          if (s >= lo - 1e-9 && s <= hi + 1e-9) moves.push({ d: withItem(cur, idx, { ...it, servings: s }), penalty: 0.75 });
        }
      }
      // 2. Protein sides attached to this meal.
      const ex = it.extras ?? [];
      const first = ex[0] ? ADDON_BY_ID.get(ex[0].ingredientId) : undefined;
      if (ex.length === 0 && extrasInDay < MAX_EXTRAS_PER_DAY) {
        const list = sidesFor(it.slot).filter((a) => a.minutes === 0 || minutes + a.minutes <= prefs.maxCookMinutes);
        list.forEach((a, rank) => {
          const rot = (rank + dayIndex) % list.length;
          for (const g of a.amounts) moves.push({ d: withItem(cur, idx, { ...it, extras: [{ ingredientId: a.ingredientId, grams: g }] }), penalty: 1 + 0.15 * rot });
        });
      } else if (first) {
        // Adjust the first side one step up or down its practical amounts, or leave it out.
        const g0 = ex[0].grams;
        const rest = ex.slice(1);
        const up = first.amounts.find((g) => g > g0);
        const down = [...first.amounts].reverse().find((g) => g < g0);
        if (up != null) moves.push({ d: withItem(cur, idx, { ...it, extras: [{ ...ex[0], grams: up }, ...rest] }), penalty: 0.25 });
        if (down != null) moves.push({ d: withItem(cur, idx, { ...it, extras: [{ ...ex[0], grams: down }, ...rest] }), penalty: 0 });
        moves.push({ d: withItem(cur, idx, { ...it, extras: rest }), penalty: 0 });
      }
      // 3. A different recipe for the same meal (generation only).
      if (opts.allowSwaps) {
        const used = new Set(cur.items.map((x) => x.recipeId));
        const exMin = extraMinutes(it.extras);
        for (const r of poolFor(it.slot)) {
          if (used.has(r.id)) continue;
          if (exMin > 0 && recipeMinutes(r) + exMin > prefs.maxCookMinutes) continue;
          moves.push({ d: withItem(cur, idx, { ...it, swaps: [], ...withRecipe(r, prefs, byId) }), penalty: 2.5 + 0.75 * (usage.get(r.id) ?? 0) });
        }
      }
    });
    let best: { d: PlanDay; m: Macros; out: number; score: number } | null = null;
    for (const mv of moves) {
      const m = nut(mv.d);
      const out = outside(m, obj);
      if (out >= curOut - 1e-9) continue;
      // Without an energy target, still prefer protein-dense changes over adding lots of food.
      const kcalPenalty = obj.kcal == null ? 0.004 * Math.max(0, m.kcal - curM.kcal) : 0;
      const s = out + centre(m, obj) + mv.penalty + kcalPenalty;
      if (!best || s < best.score - 1e-9) best = { d: mv.d, m, out, score: s };
    }
    if (!best) break;
    cur = best.d;
    curM = best.m;
    curOut = best.out;
  }
  return cur;
}

/** Balance every day of a saved plan (portions and protein sides only; the user's recipe choices are kept). */
export function balancePlan<P extends PlanDraft>(plan: P, prefs: PlanPrefs, ctx: PlanContext = {}): P {
  return { ...plan, days: plan.days.map((d, i) => balanceDay(d, prefs, { ...ctx, dayIndex: i })) };
}

/* -------------------------------------------------------------- generation */
/**
 * Step 1 of generation: pick meals for each day by rotating through the best-ranked recipes per slot (and, with an
 * energy target, scale portions uniformly). The target only ranks recipes here; generateMealPlan then balances days.
 */
export function selectMeals(weekStart: ISODate, prefs: PlanPrefs, ctx: PlanContext = {}): PlanDraft {
  const byId = ctx.byId ?? catalog().byId;
  const recipesById = new Map((ctx.recipes ?? catalog().recipes).map((r) => [r.id, r]));
  const slots = slotsForMeals(prefs.mealsPerDay);
  const variant = Math.max(0, Math.floor(prefs.variant ?? 0));
  const pools = new Map<MealSlot, Recipe[]>();
  for (const slot of new Set(slots)) {
    const { recipes } = rankedCandidates(slot, prefs, ctx);
    // Keep variety but favour the best matches.
    pools.set(slot, recipes.slice(0, Math.max(3, Math.min(recipes.length, 7))));
  }
  const days: PlanDraft['days'] = [];
  for (let d = 0; d < 7; d++) {
    const date = addDays(weekStart, d);
    const used = new Set<ID>();
    const items: MealPlanItem[] = [];
    const slotSeen: Partial<Record<MealSlot, number>> = {};
    slots.forEach((slot, idx) => {
      const pool = pools.get(slot) ?? [];
      if (!pool.length) return;
      const k = slotSeen[slot] ?? 0;
      slotSeen[slot] = k + 1;
      let i = (d + variant + k * 3) % pool.length;
      for (let tries = 0; tries < pool.length && used.has(pool[i].id); tries++) i = (i + 1) % pool.length;
      const recipe = pool[i];
      used.add(recipe.id);
      items.push({ id: `${date}:${slot}:${idx}`, slot, ...withRecipe(recipe, prefs, byId), servings: 1 });
    });
    if (prefs.kcalTarget && items.length) {
      const kcal = items.reduce((s, it) => s + recipeNutrition(recipesById.get(it.recipeId)!, { servings: 1, byId }).total.kcal, 0);
      if (kcal > 0) {
        const f = Math.min(2, Math.max(0.5, prefs.kcalTarget / kcal));
        const servings = Math.max(0.5, roundHalf(f));
        items.forEach((it) => (it.servings = servings));
      }
    }
    days.push({ date, items });
  }
  return { weekStart, days, shoppingChecked: [] };
}

/** Generate a 7-day plan starting at weekStart: select meals, then reconcile every day with the objective. */
export function generateMealPlan(weekStart: ISODate, prefs: PlanPrefs, ctx: PlanContext = {}): { plan: PlanDraft; warnings: string[] } {
  const selected = selectMeals(weekStart, prefs, ctx);
  const usage = new Map<ID, number>();
  const days = selected.days.map((d, i) => {
    const day = balanceDay(d, prefs, { ...ctx, allowSwaps: true, dayIndex: i, weekUsage: usage });
    for (const it of day.items) usage.set(it.recipeId, (usage.get(it.recipeId) ?? 0) + 1);
    return day;
  });
  const plan: PlanDraft = { ...selected, days };
  return { plan, warnings: planWarnings(plan, prefs, ctx) };
}

/* ---------------------------------------------------- derived status & warnings */
const weekdayName = (date: ISODate) => formatDate(date, { weekday: 'long' });

/** Message helpers for the derived texts: language, localized names and number formatting (English output is unchanged). */
function textCtx(ctx: PlanContext) {
  const lang: Language = ctx.lang ?? 'en';
  const tr = sharedT(lang);
  const en = lang === 'en';
  return {
    lang,
    tr,
    en,
    name: (r: Recipe) => (ctx.recipeName ? ctx.recipeName(r) : r.name),
    day: (date: ISODate) => (ctx.weekdayOn ? ctx.weekdayOn(date) : `on ${weekdayName(date)}`),
    /** Lower-case meal for sentences: "breakfast" / "morgunmat" (Icelandic object form). */
    meal: (slot: MealSlot) => tr.t(`aiServer.mealSlotFor.${slot}` as SharedKey),
    /** Numbers as the English text always printed them; locale-formatted in other languages. */
    num: (n: number): string | number => (en ? String(n) : n),
    lower: (x: string) => x.toLocaleLowerCase(localeFor(lang)),
    /** Fragments joined with "and" (English kept as before: "a and b and c"). */
    and: (parts: string[]) => (en ? parts.join(' and ') : listText(parts, lang)),
    cap: (x: string) => x.charAt(0).toLocaleUpperCase(localeFor(lang)) + x.slice(1),
  };
}

/**
 * Plan-level warnings, derived from the saved plan and the current settings (so they survive a reload and
 * update when settings change): meals with no matching recipe, relaxed cooking time, and planned meals that
 * conflict with the current allergy, diet or dislike settings.
 */
export function planWarnings(plan: PlanDraft, prefs: PlanPrefs, ctx: PlanContext = {}): string[] {
  const byId = ctx.byId ?? catalog().byId;
  const recipesById = new Map((ctx.recipes ?? catalog().recipes).map((r) => [r.id, r]));
  const x = textCtx(ctx);
  const { tr } = x;
  const out: string[] = [];
  const excluded = prefs.proteinExcluded ?? [];
  const allergenList = (list: Allergen[]) => (x.en ? list.map((a) => allergenLabel(a).toLowerCase()).join(', ') : listText(list.map((a) => x.lower(allergenLabel(a, x.lang))), x.lang));
  for (const slot of new Set(slotsForMeals(prefs.mealsPerDay))) {
    const { recipes, relaxedTime } = rankedCandidates(slot, prefs, ctx);
    if (recipes.length === 0)
      out.push(tr.t(excluded.length ? 'mealPlanner.warning.noRecipesProteins' : 'mealPlanner.warning.noRecipes', { meal: x.meal(slot) }));
    else if (excluded.length && recipes.length < FEW_RECIPES)
      out.push(tr.tp('mealPlanner.warning.fewRecipes', recipes.length, { meals: tr.tp(`mealPlanner.slotCount.${slot}`, recipes.length) }));
    else if (relaxedTime) out.push(tr.t('mealPlanner.warning.timeRelaxed', { meal: x.meal(slot), minutes: x.num(prefs.maxCookMinutes) }));
  }
  for (const day of plan.days) {
    for (const it of day.items) {
      const r = recipesById.get(it.recipeId);
      if (!r) {
        out.push(tr.t('mealPlanner.warning.missingRecipe', { day: x.day(day.date) }));
        continue;
      }
      const swaps = it.swaps as Swap[] | undefined;
      const problems: string[] = [];
      const allergens = new Set<Allergen>(recipeAllergens(r, swaps, byId));
      const hit = prefs.allergens.filter((a) => allergens.has(a));
      if (hit.length) problems.push(tr.tp('mealPlanner.problem.allergens', hit.length, { allergens: allergenList(hit) }));
      for (const e of it.extras ?? []) {
        const sideHit = prefs.allergens.filter((a) => byId.get(e.ingredientId)?.allergens.includes(a));
        if (sideHit.length) problems.push(tr.tp('mealPlanner.problem.sideAllergens', sideHit.length, { side: extraText(e, byId, x.lang), allergens: allergenList(sideHit) }));
      }
      const tags = recipeDietTags(r, swaps, byId);
      const extrasOk = (t: DietTag) => (it.extras ?? []).every((e) => {
        const ing = byId.get(e.ingredientId);
        return !ing || ingredientAllowed(ing, { tags: [t] });
      });
      const notMet = prefs.tags.filter((t) => !satisfiesTag(tags, t) || !extrasOk(t));
      if (notMet.length)
        problems.push(tr.t('mealPlanner.problem.diet', {
          diets: x.en ? notMet.map((t) => dietTagLabel(t).toLowerCase()).join(' or ') : listText(notMet.map((t) => `„${dietTagLabel(t, x.lang)}“`), x.lang, 'disjunction'),
        }));
      const ids = [...resolveIngredients(r, swaps, byId).map((i) => i.ingredientId), ...(it.extras ?? []).map((e) => e.ingredientId)];
      if (prefs.dislikedIngredientIds.some((d) => ids.includes(d))) problems.push(tr.t('mealPlanner.problem.skipped'));
      if (excluded.length) {
        const groups = new Set(recipeProteinGroups(r, swaps, byId));
        for (const e of it.extras ?? []) {
          const g = byId.get(e.ingredientId)?.proteinGroup;
          if (g) groups.add(g);
        }
        const hitG = excluded.filter((g) => groups.has(g));
        if (hitG.length) problems.push(tr.t('mealPlanner.problem.proteins', { proteins: proteinListText(hitG, x.lang) }));
      }
      if (problems.length) out.push(tr.t('mealPlanner.warning.mealConflict', { recipe: x.name(r), day: x.day(day.date), problems: x.and(problems) }));
    }
  }
  if (!prefs.proteinTarget && !prefs.kcalTarget) out.push(tr.t('mealPlanner.warning.oneServing'));
  return [...new Set(out)];
}

export interface PlanDayStatus {
  date: ISODate;
  /** Planned totals at stored precision. */
  totals: Macros;
  proteinTarget?: number;
  /** ± grams that still count as on target. */
  tolerance?: number;
  /** target − planned protein in grams (positive = short), rounded with displayMacro. */
  proteinGap?: number;
  state: 'no_target' | 'on_target' | 'short' | 'over' | 'empty';
  /** Present only when the user has an energy target (full/manual). Otherwise calories are informational. */
  kcalTarget?: number;
  kcalState?: 'on_target' | 'low' | 'high';
  /** One-sentence explanation of the gap (absent when on target). */
  message?: string;
  /** Practical changes, most useful first. Never suggests relaxing allergens, diets or dislikes. */
  suggestions: string[];
  /** The day as "Balance this day" would save it (portions/sides only), when that gets closer to target. */
  balanced?: PlanDay;
}

function describeChanges(before: PlanDay, after: PlanDay, recipesById: Map<ID, Recipe>, byId: IngredientIndex, x: ReturnType<typeof textCtx>): string[] {
  const { tr } = x;
  const lines: string[] = [];
  for (const b of before.items) {
    const a = after.items.find((x) => x.id === b.id);
    if (!a || a === b) continue;
    const delta = displayMacro(planItemNutrition(a, recipesById, byId).protein - planItemNutrition(b, recipesById, byId).protein, 'protein');
    const deltaText = x.en ? `${delta}` : numberText(delta, x.lang);
    const sign = delta >= 0 ? `+${deltaText}` : deltaText;
    const rb = recipesById.get(b.recipeId);
    const ra = recipesById.get(a.recipeId);
    const meal = x.meal(a.slot);
    const parts: string[] = [];
    if (a.recipeId !== b.recipeId)
      parts.push(tr.t('mealPlanner.change.swap', { from: rb ? x.name(rb) : tr.t('mealPlanner.fallback.thisMeal'), to: ra ? x.name(ra) : tr.t('mealPlanner.fallback.anotherRecipe') }));
    if (a.servings !== b.servings)
      parts.push(tr.tp('mealPlanner.change.servings', a.servings, { count: x.num(a.servings), recipe: ra ? x.name(ra) : tr.t('mealPlanner.fallback.theMeal'), was: x.num(b.servings) }));
    const ea = JSON.stringify(a.extras ?? []);
    const eb = JSON.stringify(b.extras ?? []);
    if (ea !== eb) {
      const added = a.extras?.[0];
      const had = b.extras?.[0];
      if (added && !had) parts.push(tr.t('mealPlanner.change.addSide', { side: extraText(added, byId, x.lang), meal }));
      else if (added && had) parts.push(tr.t('mealPlanner.change.replaceSide', { side: extraText(added, byId, x.lang), meal }));
      else if (had) parts.push(tr.t('mealPlanner.change.removeSide', { side: extraText(had, byId, x.lang), meal }));
    }
    if (parts.length) lines.push(tr.t('mealPlanner.change.line', { changes: x.cap(x.and(parts)), delta: sign }));
  }
  return lines;
}

const COOK_TIME_OPTIONS = [15, 20, 30, 45, 60, 90];
/** With protein exclusions, fewer matching recipes than this for a meal means visible repeats, so the status says so. */
export const FEW_RECIPES = 5;

/** Status of one planned day against the current objective, with the gap and practical changes. Pure and deterministic. */
export function planDayStatus(day: PlanDay, prefs: PlanPrefs, ctx: PlanContext & { dayIndex?: number } = {}): PlanDayStatus {
  const byId = ctx.byId ?? catalog().byId;
  const recipesById = new Map((ctx.recipes ?? catalog().recipes).map((r) => [r.id, r]));
  const x = textCtx(ctx);
  const { tr, num } = x;
  const totals = planDayNutrition(day, recipesById, byId);
  const obj = objectiveOf(prefs);
  const status: PlanDayStatus = { date: day.date, totals, state: 'no_target', suggestions: [] };
  if (!obj) return status;
  if (obj.kcal != null) {
    status.kcalTarget = obj.kcal;
    status.kcalState = totals.kcal < obj.kcal - obj.tolK ? 'low' : totals.kcal > obj.kcal + obj.tolK ? 'high' : 'on_target';
  }
  if (obj.protein != null) {
    status.proteinTarget = obj.protein;
    status.tolerance = obj.tolP;
    status.proteinGap = displayMacro(obj.protein - totals.protein, 'protein');
  }
  if (day.items.length === 0) {
    status.state = 'empty';
    status.message = tr.t('mealPlanner.status.empty');
    return status;
  }
  const pOff = obj.protein != null && Math.abs(totals.protein - obj.protein) > obj.tolP;
  status.state = !pOff ? 'on_target' : totals.protein < obj.protein! ? 'short' : 'over';
  const kOff = status.kcalState != null && status.kcalState !== 'on_target';
  if (!pOff && !kOff) return status;

  const planned = displayMacro(totals.protein, 'protein');
  const msgs: string[] = [];
  if (status.state === 'short') msgs.push(tr.t('mealPlanner.status.short', { planned: num(planned), target: num(obj.protein!), gap: num(status.proteinGap!) }));
  else if (status.state === 'over') msgs.push(tr.t('mealPlanner.status.over', { planned: num(planned), over: num(-status.proteinGap!), target: num(obj.protein!) }));
  if (kOff) msgs.push(tr.t('mealPlanner.status.kcal', { kcal: num(displayMacro(totals.kcal, 'kcal')), target: num(obj.kcal!) }));

  const balanced = balanceDay(day, prefs, { ...ctx, dayIndex: ctx.dayIndex });
  const balancedOut = outside(planDayNutrition(balanced, recipesById, byId), obj);
  if (balanced !== day && balancedOut < outside(totals, obj) - 1e-9) {
    status.balanced = balanced;
    status.suggestions.push(...describeChanges(day, balanced, recipesById, byId, x));
  }
  if (balancedOut > 0 && status.state === 'short') {
    const after = displayMacro(planDayNutrition(balanced, recipesById, byId).protein, 'protein');
    if (status.balanced) msgs.push(tr.t('mealPlanner.status.evenWithChanges', { grams: num(after) }));
    else msgs.push(tr.t('mealPlanner.status.cannotClose'));
    msgs.push(tr.t('mealPlanner.status.neverRelaxed'));
    // Swaps to higher-protein recipes that meet the same constraints.
    const used = new Set(day.items.map((i) => i.recipeId));
    const swaps: { text: string; gain: number }[] = [];
    for (const it of day.items) {
      const cur = planItemNutrition(it, recipesById, byId).protein;
      for (const r of rankedCandidates(it.slot, prefs, ctx).recipes) {
        if (used.has(r.id)) continue;
        const gain = planItemNutrition({ ...it, swaps: [], ...withRecipe(r, prefs, byId) }, recipesById, byId).protein - cur;
        if (gain >= 3) {
          const cur = recipesById.get(it.recipeId);
          swaps.push({ text: tr.t('mealPlanner.suggestion.swap', { from: cur ? x.name(cur) : tr.t('mealPlanner.fallback.thisMeal'), to: x.name(r), grams: num(displayMacro(gain, 'protein')) }), gain });
        }
      }
    }
    swaps.sort((a, b) => b.gain - a.gain || a.text.localeCompare(b.text));
    status.suggestions.push(...swaps.slice(0, 2).map((s) => s.text));
    // Longer cooking time, if it opens higher-protein recipes.
    const nextTime = COOK_TIME_OPTIONS.find((m) => m > prefs.maxCookMinutes);
    if (nextTime) {
      const slotsInDay = [...new Set(day.items.map((i) => i.slot))];
      let bestNew: { r: Recipe; p: number } | null = null;
      for (const slot of slotsInDay) {
        const now = new Set(rankedCandidates(slot, prefs, ctx).recipes.map((r) => r.id));
        for (const r of rankedCandidates(slot, { ...prefs, maxCookMinutes: nextTime }, ctx).recipes) {
          if (now.has(r.id)) continue;
          const p = recipeNutrition(r, { servings: 1, byId }).perServing.protein;
          if (!bestNew || p > bestNew.p) bestNew = { r, p };
        }
      }
      if (bestNew && bestNew.p >= 20)
        status.suggestions.push(tr.t('mealPlanner.suggestion.longerCooking', { minutes: num(nextTime), recipe: x.name(bestNew.r), grams: num(displayMacro(bestNew.p, 'protein')) }));
    }
    // One more meal a day.
    if (prefs.mealsPerDay < 6) {
      const snackRecipe = rankedCandidates('snack', prefs, ctx).recipes
        .map((r) => ({ name: x.name(r), p: recipeNutrition(r, { servings: 1, byId }).perServing.protein }))
        .sort((a, b) => b.p - a.p)[0];
      const side = allowedAddOns('snack', prefs, ctx)[0];
      const sideP = side ? macrosForGrams(byId.get(side.ingredientId)!, side.amounts[side.amounts.length - 1]).protein : 0;
      const idea = snackRecipe && snackRecipe.p >= sideP ? tr.t('mealPlanner.suggestion.idea', { food: snackRecipe.name, grams: num(displayMacro(snackRecipe.p, 'protein')) }) : side
        ? tr.t('mealPlanner.suggestion.idea', { food: extraText({ ingredientId: side.ingredientId, grams: side.amounts[side.amounts.length - 1] }, byId, x.lang), grams: num(displayMacro(sideP, 'protein')) })
        : null;
      if (idea && Math.max(snackRecipe?.p ?? 0, sideP) >= 8)
        status.suggestions.push(tr.t('mealPlanner.suggestion.extraMeal', { meals: num(prefs.mealsPerDay + 1), idea }));
    }
    if (status.suggestions.length === 0) status.suggestions.push(tr.t('mealPlanner.suggestion.nothingElse'));
  }
  status.message = msgs.join(' ');
  return status;
}

export interface PlanStatus {
  days: PlanDayStatus[];
  /** Days that have a protein target and at least one meal. */
  withTarget: number;
  onTarget: number;
}

export function planStatus(plan: PlanDraft, prefs: PlanPrefs, ctx: PlanContext = {}): PlanStatus {
  const days = plan.days.map((d, i) => planDayStatus(d, prefs, { ...ctx, dayIndex: i }));
  const counted = days.filter((d) => d.state !== 'no_target' && d.state !== 'empty');
  return { days, withTarget: counted.length, onTarget: counted.filter((d) => d.state === 'on_target' && d.kcalState !== 'low' && d.kcalState !== 'high').length };
}

/* ------------------------------------------------------------------- edits */
/** Replace one planned meal with the next suitable recipe for that slot (portion and protein sides are kept). */
export function swapMeal<P extends PlanDraft>(plan: P, date: ISODate, itemId: ID, prefs: PlanPrefs, ctx: PlanContext = {}): P {
  return {
    ...plan,
    days: plan.days.map((day) => {
      if (day.date !== date) return day;
      const item = day.items.find((i) => i.id === itemId);
      if (!item) return day;
      const { recipes } = rankedCandidates(item.slot, prefs, ctx);
      if (!recipes.length) return day;
      const others = new Set(day.items.filter((i) => i.id !== itemId).map((i) => i.recipeId));
      const start = Math.max(-1, recipes.findIndex((r) => r.id === item.recipeId));
      let next: Recipe | undefined;
      for (let k = 1; k <= recipes.length; k++) {
        const r = recipes[(start + k) % recipes.length];
        if (r.id !== item.recipeId && !others.has(r.id)) {
          next = r;
          break;
        }
      }
      if (!next) return day;
      return { ...day, items: day.items.map((i) => (i.id === itemId ? { ...i, swaps: [], ...withRecipe(next!, prefs, ctx.byId ?? catalog().byId) } : i)) };
    }),
  };
}

export function updatePlanItem<P extends PlanDraft>(plan: P, date: ISODate, itemId: ID, patch: Partial<Omit<MealPlanItem, 'id'>>): P {
  return {
    ...plan,
    days: plan.days.map((day) => (day.date !== date ? day : { ...day, items: day.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) })),
  };
}

/** Replace one day (e.g. with the result of balanceDay). */
export function replacePlanDay<P extends PlanDraft>(plan: P, next: PlanDay): P {
  return { ...plan, days: plan.days.map((d) => (d.date === next.date ? next : d)) };
}

export function removePlanItem<P extends PlanDraft>(plan: P, date: ISODate, itemId: ID): P {
  return { ...plan, days: plan.days.map((day) => (day.date !== date ? day : { ...day, items: day.items.filter((i) => i.id !== itemId) })) };
}

export function addPlanItem<P extends PlanDraft>(plan: P, date: ISODate, slot: MealSlot, recipeId: ID, servings = 1): P {
  return {
    ...plan,
    days: plan.days.map((day) =>
      day.date !== date ? day : { ...day, items: [...day.items, { id: `${date}:${slot}:${Date.now().toString(36)}`, slot, recipeId, servings }] },
    ),
  };
}
