/**
 * Meal helpers for the training assistant tools (pure apart from injected catalogs):
 *  - searchRecipes: tolerant find_recipes matching (case/accent-insensitive, ingredient names, tags, meal type,
 *    synonyms) with a "best fits for your targets" fallback; empty only when the user's own constraints exclude
 *    everything, and then it names the constraint(s);
 *  - buildMealPlanAction: propose_meal_plan takes INTENT only (days, meals per day, preferences) and the server builds
 *    the plan with the app's own planner (supabase/functions/_shared/nutrition/mealplan.ts — the same code the app's
 *    meal plan screen runs), from the user's targets, diet, allergens, dislikes, cook time and budget.
 */
import type { AccountStatePayload, MealPlanAction, MealSlotName, RefIngredient, RefRecipe, UserFacts } from './types.ts';
import type { NutritionStatus } from './dataStatus.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { mealPlanBlocker } from './dataStatus.ts';
// @ts-ignore see above
import { addDays, weekBounds } from './week.ts';
import type { Allergen, DietPrefs, DietTag, Ingredient, Recipe } from '../nutrition/types.ts';
// @ts-ignore see above
import { setNutritionCatalog } from '../nutrition/catalog.ts';
// @ts-ignore see above
import { generateMealPlan, planPrefsFrom, rankedCandidates, slotsForMeals, type PlanPrefs } from '../nutrition/mealplan.ts';
// @ts-ignore see above
import { ALLERGEN_LABELS, DIET_TAG_LABELS, ingredientAllowed, MEAL_LABELS, recipeMatches, recipeMinutes } from '../nutrition/recipes.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { ingredientFitsProteinPrefs, normalizeProteinPrefs, proteinListText } from '../nutrition/proteins.ts';
import type { ProteinGroup, ProteinPrefs } from '../nutrition/types.ts';

/* ------------------------------------------------------------------ text matching */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export const stemWord = (w: string) => stem(w);
const stem = (w: string) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

/** Words people use → words that appear in catalog recipe / ingredient names. */
const SYNONYMS: Record<string, string[]> = {
  fish: ['cod', 'salmon', 'tuna', 'haddock', 'trout', 'fish', 'mackerel', 'herring'],
  seafood: ['prawn', 'shrimp', 'cod', 'salmon', 'tuna', 'fish'],
  prawn: ['prawn', 'shrimp'],
  shrimp: ['shrimp', 'prawn'],
  yoghurt: ['yogurt', 'skyr'],
  yogurt: ['yogurt', 'skyr'],
  skyr: ['skyr', 'yogurt'],
  porridge: ['oat', 'porridge'],
  oatmeal: ['oat', 'porridge'],
  mince: ['mince', 'beef', 'lamb'],
  beef: ['beef', 'mince'],
  meat: ['beef', 'chicken', 'lamb', 'pork', 'turkey', 'mince'],
  poultry: ['chicken', 'turkey'],
  eggs: ['egg'],
  bean: ['bean', 'lentil', 'chickpea'],
  legume: ['bean', 'lentil', 'chickpea'],
  pulse: ['bean', 'lentil', 'chickpea'],
  noodle: ['noodle', 'pasta'],
  spaghetti: ['pasta', 'spaghetti'],
  pasta: ['pasta', 'spaghetti', 'noodle'],
  salad: ['salad'],
  soup: ['soup'],
  curry: ['curry'],
  wrap: ['wrap', 'tortilla'],
  sandwich: ['bread', 'rye', 'toast', 'sandwich'],
  toast: ['toast', 'bread', 'rye'],
  smoothie: ['smoothie', 'shake'],
  shake: ['shake', 'smoothie'],
  tofu: ['tofu', 'tempeh'],
  veggie: ['vegetable', 'veg'],
};
const MEAL_WORDS: Record<string, MealSlotName> = { breakfast: 'breakfast', brunch: 'breakfast', lunch: 'lunch', dinner: 'dinner', supper: 'dinner', snack: 'snack', snacks: 'snack' };
// English and Icelandic (text is folded first: accents dropped, but æ, ð and þ stay).
const DIET_WORDS: [RegExp, DietTag][] = [
  [/\bvegan/, 'vegan'], [/\bvegetarian\b|\bveggie\b|\bmeatless\b|\bgrænmetis/, 'vegetarian'], [/\bpescatarian\b/, 'pescatarian'],
  [/\bdairy[\s-]?free\b|\bno dairy\b|\blactose[\s-]?free\b|\bmjolkurlaus|\blaktosalaus/, 'dairy_free'],
  [/\bgluten[\s-]?free\b|\bno gluten\b|\bglutenlaus/, 'gluten_free'],
];
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'with', 'for', 'of', 'in', 'on', 'some', 'any', 'meal', 'meals', 'recipe', 'recipes', 'idea', 'ideas', 'food', 'dish', 'something', 'me', 'my', 'easy', 'simple', 'healthy', 'good', 'tasty', 'high', 'protein', 'quick', 'fast', 'free', 'low', 'cal', 'calorie', 'kcal']);

export interface QueryIntent {
  words: string[];
  meal: MealSlotName | null;
  diet: DietTag[];
  quick: boolean;
  highProtein: boolean;
  /** What the request rules out ("no fish", "without nuts", "án glútens"): hard constraints, never relaxed. */
  exclude: Exclusions;
}
export function parseQuery(query: string): QueryIntent {
  const q = fold(query);
  const diet = DIET_WORDS.filter(([re]) => re.test(q)).map(([, t]) => t);
  const quick = /\b(quick|fast|speedy|under 15|15 min|no[\s-]?cook)\b|\bfljot|\bsnogg/.test(q);
  const highProtein = /\bprotein\b|\bprotin/.test(q);
  const exclude = parseExclusions(query);
  const negated = new Set(exclude.raw);
  let meal: MealSlotName | null = null;
  const words: string[] = [];
  for (const raw of q.replace(/[^a-z0-9æðþ\s-]/g, ' ').split(/\s+/).filter(Boolean)) {
    if (MEAL_WORDS[raw]) {
      meal ??= MEAL_WORDS[raw];
      continue;
    }
    // A ruled-out word ("no FISH") must never become a word the recipe should contain.
    if (negated.has(raw) || NEGATORS.has(raw)) continue;
    if (STOP.has(raw) || raw.length < 3 || DIET_WORDS.some(([re]) => re.test(raw)) || /^(vegan|vegetarian|pescatarian|dairy|gluten|lactose|no|cook|min|under)$/.test(raw)) continue;
    words.push(stem(raw));
  }
  return { words: [...new Set(words)].slice(0, 6), meal, diet, quick, highProtein, exclude };
}

/* ------------------------------------------------------------------ exclusions ("no fish", "án hneta") */
export interface Exclusions {
  /** Allergen groups ruled out (fish, tree_nuts, …). */
  allergens: Allergen[];
  /** Other ruled-out foods, to match against ingredient names ("pork", "red onion"). Folded, English where known. */
  words: string[];
  /** Every ruled-out token (folded), so callers can drop it from search words. */
  raw: string[];
  /** Weekdays ruled out ("not Friday", "ekki um helgina"), as English names (monday … sunday). */
  days: string[];
}
// A negation opens a list ("without gluten, soy or nuts", "no fish, no nuts", "án fisks, án hneta"); each item is a
// short food phrase or a weekday. The list ends at the next negation, at sentence punctuation or "but", or at the first
// item that isn't a food/day phrase ("no fish, two meals a day" → fish only).
const NEGATOR_WORDS = ['no', 'without', 'avoid', 'not', 'never', 'minus', 'except', 'excluding', 'exclude', 'skip', 'nor', 'none', 'zero',
  'engan', 'enga', 'engin', 'enginn', 'ekkert', 'ekki', 'sleppa', 'sleppum', 'sleppi', 'nema', 'utan'];
const NEGATORS = new Set([...NEGATOR_WORDS, 'free', 'laus']);
const L = 'a-z0-9æðþ';
const NEG_START = new RegExp(`(?<![${L}])(?:${NEGATOR_WORDS.join('|')})(?![${L}])`, 'g');
const ITEM_SEP = new RegExp(`\\s*(?:,|/|&|(?<![${L}])(?:or|and|nor|og|eða|eda|ne)(?![${L}]))\\s*`);
const SEGMENT_END = new RegExp(`[.;:!?\\n()]|(?<![${L}])(?:but|then|instead|en|heldur|bara)(?![${L}])`);
/** Words around an item that carry no meaning ("without ANY nuts", "nuts AT ALL", "ekki UM helgina"). */
const FILLER = new Set(['any', 'the', 'some', 'a', 'an', 'at', 'all', 'on', 'of', 'my', 'whatsoever', 'please', 'um', 'i', 'neinn', 'neitt', 'neina', 'neinu', 'neinar', 'neinum', 'takk']);
/** A word that means the "item" is not a food or a day: the list has ended. */
const NOT_AN_ITEM = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'day', 'days', 'week', 'weeks', 'today', 'tomorrow', 'time', 'minutes', 'mins', 'min', 'hour',
  'hours', 'meal', 'meals', 'snack', 'snacks', 'breakfast', 'lunch', 'dinner', 'cook', 'cooking', 'quick', 'fast', 'more', 'less', 'than', 'too', 'much', 'many', 'long', 'longer',
  'want', 'like', 'eat', 'have', 'need', 'make', 'sure', 'it', 'is', 'be', 'me', 'you', 'we', 'they', 'that', 'this', 'very', 'really', 'spicy', 'hungry', 'plan',
  'ein', 'eina', 'tvær', 'tveimur', 'þrjar', 'fjorar', 'fimm', 'sex', 'dag', 'daga', 'viku', 'vikuna', 'tima', 'timi', 'maltið', 'maltiðir', 'maltiða', 'matur', 'mat',
  'vil', 'borða', 'mikið', 'mikil', 'lengi', 'langt', 'of', 'meira', 'minna', 'fljot', 'fljotlegt', 'fljotlega', 'matarplan', 'ég', 'eg', 'það', 'þetta', 'mig', 'mer']);
const WEEKDAY_STEMS: [RegExp, string[]][] = [
  [/^(mon|manudag)/, ['monday']], [/^(tue|þriðjudag)/, ['tuesday']], [/^(wed|miðvikudag)/, ['wednesday']], [/^(thu|fimmtudag)/, ['thursday']],
  [/^(fri|fostudag)/, ['friday']], [/^(sat|laugardag)/, ['saturday']], [/^(sun|sunnudag)/, ['sunday']], [/^(weekend|helgi)/, ['saturday', 'sunday']],
];
/** Icelandic food words (folded stems) → the English words used in catalog ingredient names. Longest stems first. */
const IS_FOOD: [string, string][] = [
  ['kjuklingabaun', 'chickpea'], ['linsubaun', 'lentil'], ['svinakjot', 'pork'], ['nautakjot', 'beef'], ['lambakjot', 'lamb'], ['haframjol', 'oat'],
  ['hrisgrjon', 'rice'], ['kotasæl', 'cottage cheese'], ['hvitlauk', 'garlic'], ['kjukling', 'chicken'], ['kalkun', 'turkey'], ['beikon', 'bacon'],
  ['skink', 'ham'], ['svin', 'pork'], ['naut', 'beef'], ['hakk', 'mince'], ['kjot', 'meat'], ['svepp', 'mushroom'], ['lauk', 'onion'], ['tomat', 'tomato'],
  ['papri', 'pepper'], ['avokado', 'avocado'], ['banan', 'banana'], ['baun', 'bean'], ['hafra', 'oat'], ['ost', 'cheese'], ['lax', 'salmon'], ['þorsk', 'cod'],
  ['tunfisk', 'tuna'], ['spinat', 'spinach'], ['kokos', 'coconut'],
];
const FREE_RE = new RegExp(`(?<![${L}])([a-zæðþ]+)[\\s-]free(?![${L}])|(?<![${L}])([a-zæðþ]{3,}?)laus(?:ir|ar|an|um|ri|a|t)?(?![${L}])`, 'g');

type Item = { kind: 'allergens'; allergens: Allergen[]; tokens: string[] } | { kind: 'food'; phrase: string; tokens: string[] } | { kind: 'days'; days: string[]; tokens: string[] };

/** One list item → what it rules out, or null when it isn't a food or day phrase (the list ends there). */
function classifyItem(rawItem: string): Item | null {
  const tokens = rawItem.split(/\s+/).filter(Boolean);
  while (tokens.length && FILLER.has(tokens[0])) tokens.shift();
  while (tokens.length && FILLER.has(tokens[tokens.length - 1])) tokens.pop();
  if (!tokens.length || tokens.length > 3 || tokens.some((w) => /\d/.test(w) || NOT_AN_ITEM.has(w))) return null;
  const days = tokens.map((w) => WEEKDAY_STEMS.find(([re]) => re.test(w))?.[1]);
  if (days.every(Boolean)) return { kind: 'days', days: [...new Set(days.flat() as string[])], tokens };
  const english = tokens.map((w) => IS_FOOD.find(([is]) => w.startsWith(is))?.[1] ?? w).join(' ');
  const hits = ALLERGEN_WORDS.filter(([re]) => re.test(english) || re.test(tokens.join(' '))).flatMap(([, a]) => a);
  if (hits.length) return { kind: 'allergens', allergens: [...new Set(hits)], tokens };
  if (english.replace(/\s/g, '').length < 3) return null;
  return { kind: 'food', phrase: english, tokens };
}

/** Parse what a request rules out: allergen groups, other foods and weekdays. Pass the user's text as written. */
export function parseExclusions(text: string): Exclusions {
  // Icelandic "án" (without) folds to "an", which is also an English article, so it is read before folding.
  const t = fold(text.replace(/(^|[^\p{L}])án(?=\s)/giu, '$1without '));
  const items: Item[] = [];
  const starts = [...t.matchAll(NEG_START)];
  starts.forEach((m, k) => {
    let seg = t.slice(m.index! + m[0].length, k + 1 < starts.length ? starts[k + 1].index : t.length);
    const cut = seg.search(SEGMENT_END);
    if (cut >= 0) seg = seg.slice(0, cut);
    for (const part of seg.split(ITEM_SEP)) {
      if (!part.trim()) continue;
      const item = classifyItem(part.trim());
      if (!item) break;
      items.push(item);
    }
  });
  for (const m of t.matchAll(FREE_RE)) {
    const item = classifyItem((m[1] ?? m[2] ?? '').trim());
    if (item && item.kind !== 'days') items.push(item);
  }
  const allergens = new Set<Allergen>();
  const words = new Set<string>();
  const days = new Set<string>();
  const raw = new Set<string>();
  for (const it of items) {
    it.tokens.forEach((w) => raw.add(w));
    if (it.kind === 'allergens') it.allergens.forEach((a) => allergens.add(a));
    else if (it.kind === 'food') words.add(it.phrase);
    else it.days.forEach((d) => days.add(d));
  }
  return { allergens: [...allergens], words: [...words], raw: [...raw], days: [...days] };
}

/** Ingredient ids whose name matches a ruled-out word (or its synonyms: "meat" → beef, chicken, …). */
export function excludedIngredientIds(words: string[], ingredients: Iterable<RefIngredient>): string[] {
  const keys = words.flatMap((w) => [w, ...(SYNONYMS[w] ?? SYNONYMS[stem(w)] ?? [])]).map(stem).filter((k) => k.length >= 3);
  if (!keys.length) return [];
  const out: string[] = [];
  for (const i of ingredients) {
    const n = fold(i.name);
    if (keys.some((k) => n.includes(k))) out.push(i.id);
  }
  return out;
}

const DIET_FLAG: Record<string, keyof NonNullable<RefIngredient['diet']>> = { vegetarian: 'vegetarian', vegan: 'vegan', pescatarian: 'pescatarian', dairy_free: 'dairyFree', gluten_free: 'glutenFree' };

function haystack(r: RefRecipe, ing: Map<string, RefIngredient>): string {
  return fold([r.name, ...(r.ingredients ?? []).map((x) => ing.get(x.ingredientId)?.name ?? x.ingredientId)].join(' '));
}
export function wordsMatch(r: RefRecipe, words: string[], ing: Map<string, RefIngredient>): boolean {
  if (!words.length) return true;
  const hay = haystack(r, ing);
  return words.some((w) => [w, ...(SYNONYMS[w] ?? SYNONYMS[`${w}s`] ?? [])].some((s) => hay.includes(stem(s))));
}
export function dietOk(r: RefRecipe, tags: DietTag[], ing: Map<string, RefIngredient>): boolean {
  const flags = tags.map((t) => DIET_FLAG[t]).filter(Boolean);
  return flags.every((f) => (r.ingredients ?? []).every((x) => x.optional || ing.get(x.ingredientId)?.diet?.[f as keyof NonNullable<RefIngredient['diet']>] === true));
}
export const totalMinutes = (r: RefRecipe) => (r.prepMinutes ?? 0) + (r.cookMinutes ?? 0);

/* ------------------------------------------------------------------ constraint explanations */
export interface ConstraintSet {
  allergens: string[];
  dietTags: string[];
  disliked: string[];
  maxMinutes: number | null;
  meal: string | null;
  /** Protein groups marked "not for me". */
  proteinExcluded?: string[];
}
const allergenLabel = (a: string) => (ALLERGEN_LABELS as Record<string, string>)[a]?.toLowerCase() ?? a;
const dietLabel = (t: string) => (DIET_TAG_LABELS as Record<string, string>)[t] ?? t;

/** "vegan + no soy + ≤ 15 min" — the user's active constraints, in words. */
export function describeConstraints(c: ConstraintSet): string {
  const parts = [
    ...c.dietTags.map(dietLabel),
    ...c.allergens.map((a) => `no ${allergenLabel(a)}`),
    ...(c.disliked.length ? [`${c.disliked.length} skipped ingredient${c.disliked.length === 1 ? '' : 's'}`] : []),
    ...(c.proteinExcluded?.length ? [`no ${proteinListText(c.proteinExcluded as ProteinGroup[])}`] : []),
    ...(c.maxMinutes != null ? [`≤ ${c.maxMinutes} min`] : []),
    ...(c.meal ? [(MEAL_LABELS as Record<string, string>)[c.meal]?.toLowerCase() ?? c.meal] : []),
  ];
  return parts.join(' + ') || 'no constraints';
}

/**
 * Which of the user's constraints empty the catalog: tries dropping each one; names the ones whose removal brings
 * recipes back, otherwise the whole combination.
 */
export function explainNoRecipes(c: ConstraintSet, recipes: RefRecipe[], ing: Map<string, RefIngredient>, facts: UserFacts): string {
  const fits = (k: ConstraintSet) =>
    recipes.some((r) => {
      if (k.meal && r.meal !== k.meal) return false;
      if (k.maxMinutes != null && totalMinutes(r) > k.maxMinutes) return false;
      return (r.ingredients ?? []).every((x) => {
        const i = ing.get(x.ingredientId);
        if (!i) return false;
        if (!x.optional && i.proteinGroup && k.proteinExcluded?.includes(i.proteinGroup)) return false;
        const bad = (i.allergens ?? []).some((a) => k.allergens.includes(a)) || k.disliked.includes(i.id) ||
          k.dietTags.some((t) => DIET_FLAG[t] && i.diet?.[DIET_FLAG[t] as keyof NonNullable<RefIngredient['diet']>] !== true);
        return !bad || x.optional;
      });
    });
  void facts;
  const culprits: string[] = [];
  if (c.maxMinutes != null && fits({ ...c, maxMinutes: null })) culprits.push(`the ${c.maxMinutes}-minute cooking limit`);
  for (const t of c.dietTags) if (fits({ ...c, dietTags: c.dietTags.filter((x) => x !== t) })) culprits.push(`the ${dietLabel(t).toLowerCase()} setting`);
  for (const a of c.allergens) if (fits({ ...c, allergens: c.allergens.filter((x) => x !== a) })) culprits.push(`avoiding ${allergenLabel(a)}`);
  if (c.disliked.length && fits({ ...c, disliked: [] })) culprits.push('the skipped ingredients');
  if (c.proteinExcluded?.length && fits({ ...c, proteinExcluded: [] })) culprits.push('the proteins marked "not for me"');
  const combo = describeConstraints(c);
  return culprits.length
    ? `Nothing in the catalog fits ${combo}. It's ${culprits.slice(0, 3).join(' or ')} that rules everything out.`
    : `Nothing in the catalog fits ${combo}.`;
}

/* ------------------------------------------------------------------ meal plans from intent */
// English and Icelandic stems (folded text: "fiskur", "hnetum", "glútens", "rækjur", "jarðhnetur", "mjólk").
const ALLERGEN_WORDS: [RegExp, Allergen[]][] = [
  [/\bfish\b|\bseafood\b|\bfisk|\bsjavarfang/, ['fish', 'shellfish']], [/\bshellfish\b|\bprawns?\b|\bshrimps?\b|\brækj|\bskelfisk/, ['shellfish']],
  [/\bdairy\b|\bmilk\b|\blactose\b|\bcheese\b|\bmjolk|\blaktos/, ['milk']],
  [/\beggs?\b|\beggj/, ['egg']], [/\bpeanuts?\b|\bjarðhnet/, ['peanuts']], [/\bnuts?\b|\btree nuts?\b|\bhnet/, ['tree_nuts']], [/\bgluten/, ['gluten']], [/\bwheat\b|\bhveiti/, ['wheat']],
  [/\bsoy\b|\bsoya\b|\btofu\b|\bsoja/, ['soy']], [/\bsesame\b|\bsesam/, ['sesame']], [/\bmustard\b|\bsinnep/, ['mustard']], [/\bcelery\b|\bsellerí|\bselleri/, ['celery']],
];

export interface MealPlanIntent {
  week?: unknown;
  days?: unknown;
  meals_per_day?: unknown;
  quick?: unknown;
  diet?: unknown;
  avoid?: unknown;
  preferences?: unknown;
  summary?: unknown;
}

export interface MealPlanBuildContext {
  facts: UserFacts;
  account: AccountStatePayload | null;
  today: string;
  nutrition: NutritionStatus;
  messageId: string;
  recipes: RefRecipe[];
  ingredients: RefIngredient[];
  /**
   * The user's own words for this request (the message, plus the original request for a follow-up). Restrictions in it —
   * diet words, quick, "no fish", "not Friday" — are applied even when the model's intent left them out.
   */
  requestText?: string;
}

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 60)) : typeof v === 'string' ? [v.slice(0, 300)] : []);

/** The planner preferences for this user (same derivation as the app's prefsFromAccount). */
export function prefsFromAccountPayload(account: AccountStatePayload | null): PlanPrefs {
  const d = account?.profile?.diet ?? {};
  const diet: DietPrefs = {
    tags: (d.tags ?? []) as DietTag[],
    allergens: (d.allergens ?? []) as Allergen[],
    dislikedIngredientIds: d.dislikedIngredientIds ?? [],
    maxCookMinutes: typeof d.maxCookMinutes === 'number' ? d.maxCookMinutes : 30,
    budget: (d as { budget?: DietPrefs['budget'] }).budget ?? 'any',
    mealsPerDay: typeof d.mealsPerDay === 'number' ? d.mealsPerDay : 3,
    ...((d as { proteinPrefs?: unknown }).proteinPrefs ? { proteinPrefs: normalizeProteinPrefs((d as { proteinPrefs?: Partial<ProteinPrefs> }).proteinPrefs) } : {}),
  };
  const n = account?.nutrition;
  const mode = n?.mode === 'protein_only' || n?.mode === 'full' || n?.mode === 'manual' ? n.mode : 'none';
  return planPrefsFrom(diet, { mode, proteinG: n?.proteinG, calories: n?.calories }, account?.settings?.nutritionEnabled !== false);
}

/**
 * propose_meal_plan: build the plan on the server from intent. Default days: the rest of this week, or next week
 * when fewer than 3 days are left. Returns the action, or errors that say exactly what blocked it.
 */
export function buildMealPlanAction(input: MealPlanIntent, ctx: MealPlanBuildContext): { action: MealPlanAction | null; errors: string[]; adjusted: string[] } {
  const blocker = mealPlanBlocker(ctx.nutrition);
  if (blocker) return { action: null, errors: [blocker], adjusted: [] };
  const recipes = ctx.recipes as unknown as Recipe[];
  const byId = new Map((ctx.ingredients as unknown as Ingredient[]).map((i) => [i.id, i]));
  setNutritionCatalog({ byId, recipes });
  const planCtx = { recipes, byId };

  // Preferences: the user's saved settings, tightened by what they asked for in this message (never relaxed).
  const prefs: PlanPrefs = { ...prefsFromAccountPayload(ctx.account) };
  const adjusted: string[] = [];
  const mpd = Number(input.meals_per_day);
  if (Number.isFinite(mpd) && mpd >= 1 && mpd <= 6) prefs.mealsPerDay = Math.round(mpd);
  const userText = (ctx.requestText ?? '').slice(0, 1200);
  const prefText = fold([...strs(input.preferences), ...strs(input.avoid), userText].join(' '));
  if (input.quick === true || /\b(quick|fast|no[\s-]?cook)\b/.test(prefText)) prefs.maxCookMinutes = Math.min(prefs.maxCookMinutes, 15);
  const extraTags = [...strs(input.diet), ...DIET_WORDS.filter(([re]) => re.test(prefText)).map(([, t]) => t)].filter((t): t is DietTag => t in DIET_TAG_LABELS && t !== 'high_protein');
  prefs.tags = [...new Set([...prefs.tags, ...extraTags])];
  for (const w of strs(input.avoid).map(fold)) {
    const item = classifyItem(w);
    if (item?.kind === 'allergens') prefs.allergens = [...new Set([...prefs.allergens, ...item.allergens])];
    else if (item?.kind !== 'days') {
      const phrase = item?.kind === 'food' ? item.phrase : w;
      prefs.dislikedIngredientIds = [...new Set([...prefs.dislikedIngredientIds, ...excludedIngredientIds([phrase], byId.values())])];
    }
  }
  // "no fish", "without nuts", "án glútens" in the request text: allergens and named ingredients are ruled out too.
  const ex = parseExclusions([...strs(input.preferences), ...strs(input.avoid)].join(' '));
  const fromUser = parseExclusions(userText);
  ex.allergens.push(...fromUser.allergens);
  ex.words.push(...fromUser.words);
  prefs.allergens = [...new Set([...prefs.allergens, ...ex.allergens])] as Allergen[];
  prefs.dislikedIngredientIds = [...new Set([...prefs.dislikedIngredientIds, ...excludedIngredientIds(ex.words, byId.values())])];

  // Days.
  const { start: thisStart, end: thisEnd } = weekBounds(ctx.today, ctx.facts.weekStart);
  const left = Math.round((Date.parse(`${thisEnd}T00:00:00Z`) - Date.parse(`${ctx.today}T00:00:00Z`)) / 86_400_000) + 1;
  const next = input.week === 'next' || (input.week !== 'this' && left < 3 && !Array.isArray(input.days));
  const weekStart = next ? addDays(thisStart, 7) : thisStart;
  const weekEnd = addDays(weekStart, 6);
  const allDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).filter((d) => next || d >= ctx.today);
  let dates = allDates;
  const asked = strs(input.days);
  if (asked.length) {
    const picked = new Set<string>();
    for (const a of asked) {
      const f = fold(a);
      if (isDate(a)) picked.add(a);
      else {
        const wd = DAY_NAMES.findIndex((n) => n.startsWith(f.slice(0, 3)));
        const d = allDates.find((x) => new Date(`${x}T00:00:00Z`).getUTCDay() === wd);
        if (d) picked.add(d);
      }
    }
    dates = allDates.filter((d) => picked.has(d));
    if (!dates.length) return { action: null, errors: [`None of those days are left in ${next ? 'next' : 'this'} week (${allDates[0] ?? weekStart} to ${weekEnd}).`], adjusted };
  }
  if (!dates.length) return { action: null, errors: ['No days are left this week; ask for next week instead.'], adjusted };
  // Days the user ruled out ("not Friday") are never planned, whatever days the model picked.
  if (fromUser.days.length) {
    dates = dates.filter((d) => !fromUser.days.includes(DAY_NAMES[new Date(`${d}T00:00:00Z`).getUTCDay()]));
    if (!dates.length) return { action: null, errors: [`Every day left in ${next ? 'next' : 'this'} week is one you asked to leave out.`], adjusted };
  }

  // Every slot needs at least one recipe under the constraints; otherwise say which constraint is the blocker.
  const constraints: ConstraintSet = {
    allergens: prefs.allergens, dietTags: prefs.tags, disliked: prefs.dislikedIngredientIds, maxMinutes: prefs.maxCookMinutes, meal: null, proteinExcluded: prefs.proteinExcluded,
  };
  for (const slot of new Set(slotsForMeals(prefs.mealsPerDay))) {
    const { recipes: pool, relaxedTime } = rankedCandidates(slot, prefs, planCtx);
    if (!pool.length) {
      return { action: null, errors: [explainNoRecipes({ ...constraints, maxMinutes: null, meal: slot }, ctx.recipes, new Map(ctx.ingredients.map((i) => [i.id, i])), ctx.facts)], adjusted };
    }
    if (relaxedTime) adjusted.push(`No ${slot} recipe fits ${prefs.maxCookMinutes} minutes, so some take longer.`);
  }

  const { plan } = generateMealPlan(weekStart, prefs, planCtx);
  const recipeName = new Map(recipes.map((r) => [r.id, r.name]));
  const days: MealPlanAction['days'] = plan.days
    .filter((d) => dates.includes(d.date))
    .map((d) => ({
      date: d.date,
      items: d.items.map((it) => ({
        slot: it.slot,
        recipeId: it.recipeId,
        name: recipeName.get(it.recipeId) ?? it.recipeId,
        servings: it.servings,
        ...(it.swaps?.length ? { swaps: it.swaps.map((s) => ({ from: s.from, to: s.to })) } : {}),
        ...(it.extras?.length ? { extras: it.extras.map((e) => ({ ingredientId: e.ingredientId, grams: e.grams })) } : {}),
      })),
    }));
  // Belt and braces: everything in the plan must pass the user's filters (the planner never relaxes them).
  for (const d of days) for (const it of d.items) {
    const r = recipes.find((x) => x.id === it.recipeId);
    if (!r || !recipeMatches(r, { excludeAllergens: prefs.allergens, tags: prefs.tags, dislikedIngredientIds: prefs.dislikedIngredientIds, excludeProteinGroups: prefs.proteinExcluded }, byId))
      return { action: null, errors: ['The planner produced a meal that conflicts with the user\'s settings; nothing was offered.'], adjusted };
    for (const e of it.extras ?? []) {
      const i = byId.get(e.ingredientId);
      if (!i || !ingredientAllowed(i, { tags: prefs.tags, allergens: prefs.allergens, disliked: prefs.dislikedIngredientIds }) || !ingredientFitsProteinPrefs(i, prefs.proteinExcluded))
        return { action: null, errors: ['The planner produced a side that conflicts with the user\'s settings; nothing was offered.'], adjusted };
    }
  }
  const slow = days.flatMap((d) => d.items).filter((it) => recipeMinutes(recipes.find((r) => r.id === it.recipeId)!) > prefs.maxCookMinutes);
  if (slow.length && !adjusted.length) adjusted.push(`${slow.length} meal${slow.length === 1 ? '' : 's'} take longer than ${prefs.maxCookMinutes} minutes.`);
  return {
    action: {
      kind: 'meal_plan',
      id: ctx.messageId,
      weekStart,
      weekEnd,
      days,
      targets: { proteinG: ctx.nutrition.proteinG!, kcal: ctx.nutrition.kcal },
      summary: typeof input.summary === 'string' ? input.summary.trim().slice(0, 300) : '',
      warnings: adjusted.slice(0, 4),
    },
    errors: [],
    adjusted,
  };
}

/** True when the request is "make/add a meal plan" (or a short follow-up to one). */
export function asksForMealPlan(text: string): boolean {
  const t = fold(text);
  return /\bmeal[\s-]?plan|\bplan (my|the|our)?\s*(meals|food|eating)|\bplan meals\b|\bmeals for (the|this|next) week\b|\bmatarplan|\bmatseðil|\bmatseðl/.test(t);
}

/** An English word ALLERGEN_WORDS maps back to the same allergen (for MealPlanIntent.avoid). */
const ALLERGEN_AVOID_WORD: Partial<Record<Allergen, string>> = {
  fish: 'fish', shellfish: 'shellfish', milk: 'milk', egg: 'egg', peanuts: 'peanuts', tree_nuts: 'tree nuts', gluten: 'gluten', wheat: 'wheat', soy: 'soy',
  sesame: 'sesame', mustard: 'mustard', celery: 'celery',
};
const WEEKDAYS_EN = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKDAYS_IS = ['manudag', 'þriðjudag', 'miðvikudag', 'fimmtudag', 'fostudag', 'laugardag', 'sunnudag'];
const COUNT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ein: 1, eina: 1, einni: 1, tvær: 2, tveimur: 2, þrjar: 3, þremur: 3, fjorar: 4, fjorum: 4, fimm: 5, sex: 6,
};

/**
 * The meal-plan intent stated in a user's own words (used when the model didn't call propose_meal_plan, so the
 * server-built plan still honours "no fish, two meals a day, next week"). Never invents constraints: anything it
 * can't read is simply not set, and the user's saved settings still apply in buildMealPlanAction.
 */
export function mealPlanIntentFromText(text: string): MealPlanIntent {
  const t = fold(text);
  const intent: MealPlanIntent = { preferences: [text.slice(0, 300)] };
  const m = t.match(/(?<![a-z0-9æðþ])(\d|one|two|three|four|five|six|ein|eina|einni|tvær|tveimur|þrjar|þremur|fjorar|fjorum|fimm|sex)\s+(?:meals?\b|maltið)/);
  if (m) intent.meals_per_day = /^\d$/.test(m[1]) ? Number(m[1]) : COUNT_WORDS[m[1]];
  if (/\bnext week\b|\bnæstu viku\b|\bnæsta viku\b/.test(t)) intent.week = 'next';
  else if (/\bthis week\b|(?<![a-zæðþ])þessa(ri)? viku\b/.test(t)) intent.week = 'this';
  const ex = parseExclusions(text);
  // Days named outside a negation; "not Friday" / "except the weekend" / "ekki á föstudag" rule days OUT (all other days
  // of that week, or the named ones minus the excluded).
  const mentioned: string[] = [];
  WEEKDAYS_EN.forEach((d, i) => {
    if (new RegExp(`(?<![a-zæðþ])(?:${d}|${WEEKDAYS_IS[i]})`).test(t)) mentioned.push(d);
  });
  if (/\bweekend\b|\bhelgin/.test(t)) mentioned.push('saturday', 'sunday');
  const positive = [...new Set(mentioned)].filter((d) => !ex.days.includes(d));
  if (positive.length) intent.days = positive;
  else if (ex.days.length) intent.days = WEEKDAYS_EN.filter((d) => !ex.days.includes(d));
  if (/\b(quick|fast|no[\s-]?cook)\b|\bfljot|\bsnogg/.test(t)) intent.quick = true;
  const diet = DIET_WORDS.filter(([re]) => re.test(t)).map(([, tag]) => tag);
  if (diet.length) intent.diet = diet;
  // Foods and allergens ruled out, as phrases ("tree nuts", "red onion") — buildMealPlanAction maps them again.
  const avoid = [...ex.allergens.map((a) => ALLERGEN_AVOID_WORD[a] ?? a.replace(/_/g, ' ')), ...ex.words];
  if (avoid.length) intent.avoid = [...new Set(avoid)];
  return intent;
}
