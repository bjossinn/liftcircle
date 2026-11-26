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
import { ALLERGEN_LABELS, allergenLabel as localAllergenLabel, DIET_TAG_LABELS, dietTagLabel, ingredientAllowed, MEAL_LABELS, mealLabel, recipeMatches, recipeMinutes } from '../nutrition/recipes.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { ingredientFitsProteinPrefs, normalizeProteinPrefs, proteinListText } from '../nutrition/proteins.ts';
import type { ProteinGroup, ProteinPrefs } from '../nutrition/types.ts';
// @ts-ignore see above
import { listText, sharedT, type SharedKey } from '../i18n/core.ts';
// @ts-ignore see above
import { shortDate } from './humanDates.ts';
import type { Lang } from './lang.ts';
// @ts-ignore see above
import { foldIs, IS_VOCAB } from './isLexicon.ts';
// @ts-ignore see above
import { classifyRequest, dayCountIn, maxMinutesIn, mealsPerDayIn, tokensOf } from './requestSignals.ts';

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
  // A few Icelandic dish and fruit words (folded) for "pönnukökur án bláberja" (1.0.3); broader coverage is a follow-up.
  ponnukokur: ['pancake'], ponnukaka: ['pancake'], ponnukokum: ['pancake'], ponnukoku: ['pancake'],
  blaber: ['blueberr'], blaberja: ['blueberr'], blaberjum: ['blueberr'],
  hindber: ['raspberr'], hindberja: ['raspberr'], hindberjum: ['raspberr'],
  jardarber: ['strawberr'], jardarberja: ['strawberr'], jardarberjum: ['strawberr'],
  banani: ['banana'], bananar: ['banana'], bananann: ['banana'],
  // Catalogue words for the Icelandic lexicon's groups (isLexicon.ts → lexFood below).
  'red meat': ['beef', 'pork', 'lamb', 'mince', 'ham'], 'white fish': ['cod', 'haddock', 'saithe', 'pollock'],
  'oily fish': ['salmon', 'mackerel', 'sardine', 'herring', 'trout'], aubergine: ['aubergine', 'eggplant'], eggplant: ['aubergine', 'eggplant'],
  'soy drink': ['soy drink', 'soy milk'], 'soy milk': ['soy drink', 'soy milk'],
};
/** Protein groups a ruled-out word covers, so "no meat" also rules out ham and bacon (their names don't say "pork"). */
const PROTEIN_WORDS: Record<string, string[]> = {
  meat: ['chicken', 'turkey', 'beef', 'pork', 'lamb'], 'red meat': ['beef', 'pork', 'lamb'], poultry: ['chicken', 'turkey'],
  chicken: ['chicken'], turkey: ['turkey'], beef: ['beef'], pork: ['pork'], lamb: ['lamb'], mince: ['beef', 'lamb', 'turkey', 'pork'],
};
const MEAL_WORDS: Record<string, MealSlotName> = { breakfast: 'breakfast', brunch: 'breakfast', lunch: 'lunch', dinner: 'dinner', supper: 'dinner', snack: 'snack', snacks: 'snack' };
// Icelandic meal words (morgunmatur, hádegismat, kvöldmatinn, millimál, …), folded.
for (const [slot, forms] of Object.entries(IS_VOCAB.meal_slots.map)) for (const f of forms) MEAL_WORDS[foldIs(f)] = slot as MealSlotName;
// English and Icelandic (text is folded first: accents dropped, but æ, ð and þ stay).
const DIET_WORDS: [RegExp, DietTag][] = [
  [/\bvegan/, 'vegan'], [/\bvegetarian\b|\bveggie\b|\bmeatless\b|\bgrænmetis/, 'vegetarian'], [/\bpescatarian\b|\bpesketari|\bfiskæt/, 'pescatarian'],
  [/\bdairy[\s-]?free\b|\bno dairy\b|\blactose[\s-]?free\b|\bmjolkurlaus|\blaktosalaus/, 'dairy_free'],
  [/\bgluten[\s-]?free\b|\bno gluten\b|\bglutenlaus/, 'gluten_free'],
];
/** Every approved Icelandic diet phrase (isLexicon.ts diet.map: "án dýraafurða", "alfarið úr jurtaríkinu", "veganmat",
 *  "glútenlausum", …) as a folded, whole-token pattern. "án" folds to "an" (and is read as "without" by the exclusion
 *  parser), so both spellings match. "án mjólkur(vara)" / "án glútens(ins)" are consumed by the exclusion parser instead —
 *  as the milk / gluten allergen exclusions they name (the same hard filter) — so they don't add a second, diet-level
 *  constraint here. */
const IS_DIET_PHRASES: [string, DietTag][] = Object.entries(IS_VOCAB.diet.map).flatMap(([tag, forms]) =>
  (forms as readonly string[])
    .filter((f) => !((tag === 'dairy_free' || tag === 'gluten_free') && /^án\s/.test(f)))
    .map((f) => [foldIs(f).split(/\s+/).map((w) => (w === 'an' ? '(?:an|without)' : w)).join('\\s+'), tag as DietTag] as [string, DietTag]));
const DIET_BOUND_L = '(?<![a-z0-9æðþ])';
const DIET_BOUND_R = '(?![a-z0-9æðþ])';
DIET_WORDS.push(...IS_DIET_PHRASES.map(([p, tag]) => [new RegExp(`${DIET_BOUND_L}${p}${DIET_BOUND_R}`), tag] as [RegExp, DietTag]));
// A diet NAME after a negation is a statement, not a request: "I'm not vegan", "ekki vegan", "not gluten-free", "þarf ekki
// að vera vegan", "ekki lengur vegan". ("no dairy" / "no gluten" stay requests for dairy-free / gluten-free: those are
// exclusions, not diet names.)
const NEGATED_DIET = new RegExp(
  `(?<![${'a-z0-9æðþ'}])(?:not|never|no longer|isn'?t|aren'?t|am not|ekki lengur|ekki|non)[\\s-]+` +
    `(?:(?:a|an|really|strictly|fully|alveg|neitt|neinn|að|vera|lengur|endilega|to|be|need|have|necessarily)\\s+){0,3}` +
    `(?:vegan[a-zæðþ]*|vegetarian|veggie|pescatarian|græn[a-zæðþ]*|(?:dairy|lactose|gluten)[\\s-]?free|mjolkurlaus[a-zæðþ]*|glutenlaus[a-zæðþ]*|laktosalaus[a-zæðþ]*|` +
    `${IS_DIET_PHRASES.map(([p]) => p).join('|')})`,
  'g',
);
/** Folded text with negated diet names removed. */
export const stripNegatedDiets = (folded: string) => folded.replace(NEGATED_DIET, ' ');
/** Diet tags the text ASKS for (affirmed), never ones it negates. Accepts raw or folded text. */
export function dietTagsIn(text: string): DietTag[] {
  // "Segðu mér hvað vegan þýðir" / "what does vegan mean" asks ABOUT a diet: it never sets one. Judged clause by clause,
  // so a question never cancels a diet stated elsewhere ("Ég er vegan. Hvað mælirðu með?").
  const tokens = fold(markIsWords(String(text ?? ''))).match(TOKEN_RE) ?? [];
  const question = questionClauses(tokens);
  const t = stripNegatedDiets(` ${tokens.filter((_, k) => !question[k]).join(' ')} `);
  return [...new Set(DIET_WORDS.filter(([re]) => re.test(t)).map(([, tag]) => tag))];
}
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'with', 'for', 'of', 'in', 'on', 'some', 'any', 'meal', 'meals', 'recipe', 'recipes', 'idea', 'ideas', 'food', 'dish', 'something', 'me', 'my', 'easy', 'simple', 'healthy', 'good', 'tasty', 'high', 'protein', 'quick', 'fast', 'free', 'low', 'cal', 'calorie', 'kcal', 'ok', 'okay', 'fine']);

export interface QueryIntent {
  words: string[];
  meal: MealSlotName | null;
  diet: DietTag[];
  quick: boolean;
  highProtein: boolean;
  /** An explicit cooking-time cap in the request ("mest 20 mínútur", "under 20 min"), else null. */
  maxMinutes: number | null;
  /** What the request rules out ("no fish", "without nuts", "án glútens"): hard constraints, never relaxed. */
  exclude: Exclusions;
}
export function parseQuery(query: string): QueryIntent {
  const q = fold(query);
  const diet = dietTagsIn(q);
  // "Ekki fljótlegt" doesn't ask for quick recipes.
  const quick = /\b(quick|fast|speedy|under 15|15 min|no[\s-]?cook)\b|(?<![a-zæðþ])(?<!ekki )(?:fljot|snogg)/.test(q);
  // "prótein", "próteinríkur morgunmatur", "high-protein".
  const highProtein = /\bprotein|\bprotin/.test(q);
  const maxMinutes = maxMinutesIn(query);
  const exclude = parseExclusions(query);
  const negated = new Set(exclude.raw);
  let meal: MealSlotName | null = null;
  const words: string[] = [];
  const tokens = q.replace(/[^a-z0-9æðþ\s-]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (MEAL_WORDS[raw]) {
      meal ??= MEAL_WORDS[raw];
      continue;
    }
    // A ruled-out word ("no FISH") must never become a word the recipe should contain; nor may the words that only
    // shape a request ("at all", "but", "eða", "í", "because").
    if (negated.has(raw) || NEGATORS.has(raw) || QUERY_GLUE.has(raw)) continue;
    // Icelandic food words and phrases, longest first, as catalogue words: "kjúklingabaunum" → chickpea (never chicken),
    // "eggaldini" → aubergine (never egg), "sætar kartöflur" → sweet potato.
    if (STOP.has(raw) || IS_STOP.has(raw) || raw.length < 3 || DIET_WORDS.some(([re]) => re.test(raw)) || /^(vegan|vegetarian|pescatarian|dairy|gluten|lactose|no|cook|min|under)$/.test(raw)) continue;
    // "kjötlaus", "hveitilaust", "nut-free", "hnetuofnæmi": restrictions (parsed above), never foods to look for.
    if (/(?:laus|lausa|laust|lausar|lausir|lausum)$|-free$|(?:ofnæmi|oþol)$/.test(raw)) continue;
    // Two-word catalogue foods stay one search word ("soy drink" is not every soy recipe, "sweet potato" not every potato).
    const pair = `${raw} ${tokens[i + 1] ?? ''}`;
    if (EN_FOOD_PHRASES.has(pair) && !negated.has(tokens[i + 1])) {
      words.push(pair);
      i++;
      continue;
    }
    const lex = lexFoodAt(tokens, i);
    if (lex && !lex.tokens.some((w) => negated.has(w))) {
      words.push(stem(lex.english));
      i += lex.tokens.length - 1;
      continue;
    }
    words.push(stem(raw));
  }
  return { words: [...new Set(words)].slice(0, 6), meal, diet, quick, highProtein, maxMinutes, exclude };
}

/** Wanted foods a diet in the same request rules out ("Vegan matseðill með kjúklingi"): ask which to keep — never drop the
 *  diet or the food silently. Catalogue words of the conflicting wanted foods; empty when there is no conflict. */
export function requestConflicts(text: string): string[] {
  const q = parseQuery(text);
  if (!q.diet.length) return [];
  const meat = ['chicken', 'turkey', 'beef', 'pork', 'lamb', 'mince', 'ham', 'bacon', 'meat', 'red meat', 'poultry'];
  const fish = ['fish', 'salmon', 'cod', 'tuna', 'haddock', 'mackerel', 'saithe', 'herring', 'prawn', 'shrimp', 'shellfish', 'white fish', 'oily fish'];
  const animal = [...meat, ...fish, 'egg', 'milk', 'cheese', 'skyr', 'yogurt', 'butter', 'whey', 'dairy'];
  const banned = new Set(q.diet.includes('vegan') ? animal : q.diet.includes('vegetarian') ? [...meat, ...fish] : q.diet.includes('pescatarian') ? meat : []);
  return q.words.filter((w) => banned.has(w) || banned.has(`${w}s`));
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
  /** A lactose restriction ("laktósalaust", "laktósaóþol"): filtered conservatively as milk, never called a milk allergy. */
  lactose?: boolean;
}
// One token-stream pass reads what a request rules out. A negation ("no", "without", "nothing", "án", "ekki", "engar", …)
// opens a LIST of items joined by "," / "or" / "and" / "og" / "eða"; each item is a short food phrase or a weekday.
//  - an item is its HEAD: the words before the first explanatory word ("nuts" in "nuts in my meals", "friday" in
//    "friday because I eat out"); a head cut short this way ends the list;
//  - fillers around an item are skipped and do NOT end the list ("without ANY nuts", "nuts AT ALL or eggs");
//  - the list also ends at punctuation, "but"/"en", a new negation, or an item that isn't a food or a day
//    ("no fish, two meals a day" → fish only);
//  - every token an item uses is CONSUMED, so it can never also count as something wanted: "no sunday roast" is a food,
//    not a Sunday, and "no fish for dinner" never searches FOR fish;
//  - CLAUSE BOUNDARIES are explicit: after a separator, a subject or affirmative word ("I", "we", "I'd", "please", "ég",
//    "við", "mér finnst", "vil", "elska", …) always starts a new clause and ends the list ("No fish, I like chicken");
//    so does "<food> is fine" / "<food> er í lagi". Extending clarifiers ("like", "such as", "including", "eins og", …)
//    inside a negation always extend it ("no nuts like peanuts", "no nuts, like peanuts") unless a subject follows
//    ("no eggs like I said"); "I like eggs" is subject-led, so it ends the list at "I".
//  - FAIL-SAFE: when it is ambiguous whether a food after a negation is wanted or ruled out, it is RULED OUT. Showing a
//    user something they're allergic to is worse than leaving out something they wanted. A food counts as wanted only
//    after an explicit boundary: a subject/affirmative word ("I like", "við viljum"), a positive "with"/"með" after a
//    separator, "<food> is fine" / "er í lagi", or the end of the list (punctuation, "but"/"en", a new clause).
//    tests/unit/aiCorrectness.test.ts enforces this: every allergen a corpus phrase mentions must be ruled out unless the
//    row explicitly declares it wanted.
const NEGATOR_WORDS = new Set(['no', 'without', 'avoid', 'not', 'never', 'nothing', 'neither', 'minus', 'except', 'excluding', 'exclude', 'skip', 'nor',
  'none', 'zero', "don't", 'don’t', 'dont', "doesn't", 'doesn’t', 'doesnt', "won't", 'won’t', 'wont', "can't", 'can’t', 'cant', 'cannot',
  'engan', 'enga', 'engar', 'engir', 'engin', 'enginn', 'engum', 'engri', 'engra', 'engrar', 'engu', 'ekkert', 'ekki', 'sleppa', 'sleppum', 'sleppi', 'nema', 'utan',
  // Icelandic negators from the approved vocabulary (isLexicon.ts negation.negators), folded.
  // ("án" and "í" are marked before folding — "án" folds to the English article "an" — and "né" joins items.)
  ...IS_VOCAB.negation.negators.filter((w) => !w.includes(' ') && w !== 'né' && w !== 'án').map(foldIs)]);
/** Declarations that open a list of things to rule out, like a negation: "ofnæmi fyrir …", "óþol fyrir …", "allergic to …". */
const DECLARATIONS: string[][] = [['ofnæmi', 'fyrir'], ['oþol', 'fyrir'], ['oþoli', 'fyrir'], ['þoli', 'illa'], ['allergic', 'to'], ['allergy', 'to'], ['intolerant', 'to'], ['intolerance', 'to']];
/** "nothing but eggs" / "ekkert nema egg": after these, "nema" means ONLY, never "without". */
const ONLY_BEFORE_NEMA = new Set(['ekkert', 'ekki', 'engin', 'enginn', 'engan', 'enga', 'engar', 'neitt', 'nothing']);
const NEGATORS = new Set([...NEGATOR_WORDS, 'free', 'laus']);
const L = 'a-z0-9æðþ';
/** Joins items in a list. */
const SEP_WORDS = new Set([',', '/', '&', 'or', 'and', 'nor', 'og', 'eða', 'eda', 'ne']);
/** Ends a list outright. */
const LIST_END = new Set(['.', ';', ':', '!', '?', '\n', '(', ')', 'but', 'then', 'instead', 'en', 'heldur', 'bara']);
/** A genuinely positive "with": at the start of a later item it begins what the user WANTS ("without nuts and WITH eggs",
 *  "án hneta, MEÐ eggjum"), so it ends the list. Right after the negation it belongs to it ("nothing WITH nuts"), and in a
 *  "nothing with X or with Y" list it stays negative. */
const POSITIVE_WITH = new Set(['with', 'plus', 'með']);
/** Negators meaning "nothing", whose "with …" alternatives stay negative: "nothing with peanuts or containing milk". */
const NOTHING_WORDS = new Set(['nothing', 'none', 'ekkert', 'neitt']);
/** Clarifiers that EXTEND a negation to more items ("no nuts, including peanuts", "án hneta, þar með talið jarðhnetur") —
 *  only when they directly follow a food (see the comment above NEGATOR_WORDS). Folded tokens; "." and "(" are tokens. */
const EXTENDERS: string[][] = [
  ['including'], ['incl', '.'], ['incl'], ['inc', '.'], ['such', 'as'], ['like'], ['especially'], ['particularly'], ['specifically'], ['even'],
  ['e', '.', 'g', '.'], ['e', '.', 'g'], ['eg'], ['þar', 'með', 'talið'], ['þ', '.', 'm', '.', 't', '.'], ['eins', 'og'], ['til', 'dæmis'], ['t', '.', 'd', '.'],
  ['serstaklega'], ['jafnvel'], ['m', '.', 'a', '.'], ['for', 'example'], ['for', 'instance'], ['say'], ['til', 'að', 'mynda'],
];
/** "Containing …" always describes what is ruled out ("nothing with peanuts or containing milk", "ekkert sem inniheldur mjólk"). */
const CONTAINERS: string[][] = [['containing'], ['contains'], ['sem', 'innihalda'], ['sem', 'inniheldur'], ['sem', 'innihelda']];
// The FULL approved Icelandic extender list (isLexicon.ts negation.extenders: every inflection — "þar á meðal", "þar með
// taldar / talin / talinn", "meðal annars", "einkum", …), as folded token phrases; "sem inniheldur/innihalda/innihelda" are
// containers. Longest first, so "incl ." wins over "incl".
for (const f of IS_VOCAB.negation.extenders) {
  const p = foldIs(f).match(/[a-z0-9æðþ'’-]+|[.,;:!?\n()/&]/g) ?? [];
  const into = p[0] === 'sem' ? CONTAINERS : EXTENDERS;
  if (p.length && !into.some((x) => x.join(' ') === p.join(' '))) into.push(p);
}
EXTENDERS.sort((a, b) => b.length - a.length);
CONTAINERS.sort((a, b) => b.length - a.length);
const CLARIFIERS = [...EXTENDERS, ...CONTAINERS];
/** A subject or affirmative word: at the start of a later item it starts a new clause and ends the list. Icelandic "í" is
 *  read as "iis" before folding, so "i" here is always the English pronoun. */
const AFFIRM_START = new Set(['i', "i'm", 'i’m', 'im', "i'd", 'i’d', "i've", 'i’ve', "i'll", 'i’ll', 'we', "we're", 'we’re', "we'd", 'we’d', "we've", 'we’ve',
  "we'll", 'we’ll', 'you', 'please', 'love', 'want', 'like', 'prefer', 'enjoy', 'would', "let's", 'let’s',
  'ég', 'eg', 'við', 'mér', 'mer', 'mig', 'okkur', 'vil', 'viljum', 'elska', 'elskum', 'langar', 'finnst', 'likar', 'myndi', 'myndum', 'borða', 'borðum', 'endilega', 'gjarnan']);
/** "<food> is fine", "<food> er í lagi": the food is the subject of an affirmative clause, not something to rule out. */
const COPULA = new Set(['is', 'are', 'was', 'were', 'seems', 'er', 'eru', 'var', 'voru']);
/** Negated copulas written as one token ("isn't okay"). */
const NEG_COPULA = new Set(["isn't", 'isn’t', 'isnt', "aren't", 'aren’t', 'arent', "wasn't", 'wasn’t', "weren't", 'weren’t']);
/** What makes "<food> is …" an approval: "is fine / ok / okay / allowed", "er í lagi" ("í" is read as "iis"). */
const OK_WORDS = new Set(['ok', 'okay', 'fine', 'allowed', 'acceptable', 'good', 'lagi', 'leyfilegt', 'leyfileg', 'leyfilegur', 'leyfilegar', 'leyft', 'velkomið', 'velkomin',
  'fin', 'fint', 'finn', 'finar', 'finir', 'gott', 'goð', 'goður', 'goðar', 'goðir']);
const COPULA_NEG = new Set(['not', 'never', 'ekki', 'aldrei', 'no']);
/** The words after the copula at k: whether they negate it and whether they approve ("is not okay": negated, approving word). */
function copulaReading(tokens: string[], k: number): { negated: boolean; ok: boolean } {
  let o = k + 1;
  let negated = NEG_COPULA.has(tokens[k]);
  while (COPULA_NEG.has(tokens[o]) || ['really', 'totally', 'alveg', 'iis', 'also', 'lika', 'still', 'enn', 'þa'].includes(tokens[o])) {
    if (COPULA_NEG.has(tokens[o])) negated = true;
    o++;
  }
  return { negated, ok: OK_WORDS.has(tokens[o]) };
}
/** "<food> is fine / er í lagi": the clause approves the food. */
const copulaAffirms = (tokens: string[], k: number) => {
  const r = copulaReading(tokens, k);
  return r.ok && !r.negated;
};
/** "<food> is not okay / er ekki í lagi / isn't allowed": the clause rules the food out. */
const copulaDenies = (tokens: string[], k: number) => {
  const r = copulaReading(tokens, k);
  return r.ok && r.negated;
};
/** Verbs between a negation and its item: "don't EAT fish", "can't HAVE gluten", "don't ADD nuts", "ekki SETJA hnetur". */
const LEAD_VERBS = new Set(['eat', 'want', 'like', 'have', 'need', 'use', 'include', 'put', 'add', 'give', 'get',
  'borða', 'borðað', 'borðar', 'vil', 'vilja', 'nota', 'setja', 'hafa', 'fa', 'gefa', 'innihalda', 'inniheldur', 'innihaldi', 'vera', 'contain', 'contains']);
/** Skipped before an item ("without ANY nuts", "nothing ON weekends", "ekki UM helgina", "nothing WITH nuts"). */
const LEAD_FILLER = new Set(['any', 'anything', 'something', 'the', 'some', 'a', 'an', 'at', 'all', 'on', 'of', 'my', 'with', 'um', 'iis', 'með',
  'neinn', 'neitt', 'neina', 'neinu', 'neinar', 'neinum', 'nokkur', 'nokkurra', 'nokkra', 'alls', 'eitthvað', 'neinu']);
/** Skipped after an item without ending the list ("nuts AT ALL or eggs", "fish PLEASE, or soy", "pork THOUGH"). */
const TRAIL_FILLER = new Set(['whatsoever', 'please', 'thanks', 'takk', 'alls', 'yfirleitt', 'heldur', 'though', 'tho', 'either', 'also', 'anyway', 'þa', 'lika', 'alveg', 'vinsamlegast']);
/** A word that means the "item" is not a food or a day. */
const NOT_AN_ITEM = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'day', 'days', 'week', 'weeks', 'today', 'tomorrow', 'time', 'minutes', 'mins', 'min', 'hour',
  'hours', 'meal', 'meals', 'snack', 'snacks', 'breakfast', 'lunch', 'dinner', 'cook', 'cooking', 'quick', 'fast', 'more', 'less', 'than', 'too', 'much', 'many', 'long', 'longer',
  'want', 'like', 'eat', 'have', 'need', 'make', 'sure', 'it', 'is', 'be', 'me', 'you', 'we', 'they', 'that', 'this', 'very', 'really', 'spicy', 'hungry', 'plan', 'out',
  'ein', 'eina', 'tvær', 'tveimur', 'þrjar', 'fjorar', 'fimm', 'sex', 'dag', 'daga', 'viku', 'vikuna', 'tima', 'timi', 'maltið', 'maltiðir', 'maltiða', 'matur', 'mat',
  'vil', 'borða', 'mikið', 'mikil', 'lengi', 'langt', 'of', 'meira', 'minna', 'fljot', 'fljotlegt', 'fljotlega', 'matarplan', 'ég', 'eg', 'það', 'þetta', 'mig', 'mer',
  'sterkt', 'sterkur', 'sterk', 'sterka', 'uti',
  // Approval words ("is not OKAY", "ekki í LAGI") are never foods.
  'ok', 'okay', 'fine', 'allowed', 'acceptable', 'lagi', 'leyfilegt', 'leyft']);
/** Words that start an explanatory clause after an item: the item — and the list — end there. */
const CLAUSE_BREAK = new Set(['in', 'for', 'because', 'since', 'as', 'when', 'while', 'during', 'with', 'to', 'at', 'on', 'from', 'this', 'next',
  'iis', 'a', 'fyrir', 'af', 'þvi', 'þar', 'vegna', 'með', 'um', 'þegar', 'svo', 'til', 'fra', 'eftir', 'næstu', 'þessa', 'þessari']);
/** Connectors and fillers that never name a food, so they are never search words. */
const QUERY_GLUE = new Set([...SEP_WORDS, ...LIST_END, ...LEAD_FILLER, ...TRAIL_FILLER, ...CLAUSE_BREAK, ...CLARIFIERS.flat()]);
// Weekdays match WHOLE tokens only — full English names (or plurals) and the usual abbreviations, and Icelandic day
// names with their case endings — so food words never become days ("fries", "satay", "monkfish", "sunnudagssteik").
const IS_DAY_END = '(?:ur|inn|s|sins|a|ana|ar|arnir|um|inum)?';
const WEEKDAY_TOKENS: [RegExp, string[]][] = [
  [new RegExp(`^(?:mondays?|mon|manud[ao]g${IS_DAY_END})$`), ['monday']],
  [new RegExp(`^(?:tuesdays?|tue|tues|þriðjud[ao]g${IS_DAY_END})$`), ['tuesday']],
  [new RegExp(`^(?:wednesdays?|wed|miðvikud[ao]g${IS_DAY_END})$`), ['wednesday']],
  [new RegExp(`^(?:thursdays?|thu|thur|thurs|fimmtud[ao]g${IS_DAY_END})$`), ['thursday']],
  [new RegExp(`^(?:fridays?|fri|fostud[ao]g${IS_DAY_END})$`), ['friday']],
  [new RegExp(`^(?:saturdays?|sat|laugard[ao]g${IS_DAY_END})$`), ['saturday']],
  [new RegExp(`^(?:sundays?|sun|sunnud[ao]g${IS_DAY_END})$`), ['sunday']],
  [/^(?:weekends?|helg(?:i|in|ina|inni|ar|arinnar|um)?)$/, ['saturday', 'sunday']],
  [/^weekdays?$/, ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']],
];
/** A day word with its common attachments removed: "friday's" / "friday’s", "weekend-only", "saturday-ish". Only these
 *  suffixes are dropped, and the rest must still be a WHOLE day word, so "fries", "satay" or "sunnudagssteik" stay foods.
 *  Icelandic "helgarplan…" (weekend plan) also counts as the weekend. */
const dayWord = (w: string) => w.replace(/['’]s$/, '').replace(/-(?:only|ish)$/, '').replace(/^helgarplan[a-zæðþ]*$/, 'helgar');
/** Icelandic weekday forms from the vocabulary (whole tokens; "mán." is left out: folded it is the English "man"), plus
 *  the dative "-degi" ("af miðvikudegi"). */
const IS_DAY_FORMS: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [day, forms] of Object.entries(IS_VOCAB.weekdays.map)) {
    for (const f of forms) {
      const k = foldIs(f).replace(/\.$/, '');
      if (k !== 'man') m.set(k, day);
    }
    const stem = foldIs(forms[1]).replace(/ag$/, ''); // "mánudag" → "manud"
    m.set(`${stem}egi`, day).set(`${stem}eginum`, day);
  }
  return m;
})();
const dayOf = (w: string) => {
  const d = dayWord(w);
  const is = IS_DAY_FORMS.get(d);
  return is ? [is] : WEEKDAY_TOKENS.find(([re]) => re.test(d))?.[1];
};
/** Diet names: "not vegan" is a statement about the user, never a food to rule out. */
const DIET_NAME = /^(?:vegan\w*|vegetarian|veggie|pescatarian|keto|paleo|græn\w*|non)$/;
/** Icelandic food words (folded stems) → the English words used in catalog ingredient names. Longest stems first. */
const IS_FOOD: [string, string][] = [
  ['kjuklingabaun', 'chickpea'], ['linsubaun', 'lentil'], ['svinakjot', 'pork'], ['nautakjot', 'beef'], ['lambakjot', 'lamb'], ['haframjol', 'oat'],
  ['hrisgrjon', 'rice'], ['kotasæl', 'cottage cheese'], ['hvitlauk', 'garlic'], ['kjukling', 'chicken'], ['kalkun', 'turkey'], ['beikon', 'bacon'],
  ['skink', 'ham'], ['svin', 'pork'], ['naut', 'beef'], ['hakk', 'mince'], ['kjot', 'meat'], ['svepp', 'mushroom'], ['lauk', 'onion'], ['tomat', 'tomato'],
  ['papri', 'pepper'], ['avokado', 'avocado'], ['banan', 'banana'], ['baun', 'bean'], ['hafra', 'oat'], ['ost', 'cheese'], ['lax', 'salmon'], ['þorsk', 'cod'],
  ['tunfisk', 'tuna'], ['spinat', 'spinach'], ['kokos', 'coconut'], ['mondl', 'almond'],
  // Found by the independent allergen fixture (tests/unit/aiAllergenFixture.test.ts, 1.0.3).
  ['ysa', 'haddock'], ['ysu', 'haddock'], ['makril', 'mackerel'], ['ufsa', 'saithe'], ['ufsi', 'saithe'], ['kræklin', 'mussel'], ['smokkfisk', 'squid'],
  ['smjor', 'butter'], ['mysuprot', 'whey'], ['rugbrau', 'rye bread'],
];
const isFoodEnglish = (w: string) => IS_FOOD.find(([is]) => w.startsWith(is))?.[1];

/* Icelandic food lexicon (isLexicon.ts protein_groups_and_common_foods): exact folded forms → catalogue words. Exact
 * forms beat the prefix stems above for compounds and multi-word foods ("smjörbaunir" are beans, not butter; "sætar
 * kartöflur"; "rauðs kjöts"); for single words the prefix stems keep their more specific words ("lax" → salmon). */
const LEX = IS_VOCAB.protein_groups_and_common_foods;
const ALX = IS_VOCAB.allergens_and_restriction_declarations;
const GROUP_EN: Record<string, string | null> = {
  chicken: 'chicken', turkey: 'turkey', beef: 'beef', pork: 'pork', lamb: 'lamb', white_fish: null, oily_fish: null, tuna: 'tuna', prawns: 'prawn', shellfish: null,
  eggs: 'egg', dairy: null, tofu_tempeh: 'tofu', beans_lentils: 'bean', chickpeas: 'chickpea', whey: 'whey', plant_protein: 'plant protein',
  meat: 'meat', red_meat: 'red meat', poultry: 'poultry',
  pancake: 'pancake', blueberry: 'blueberr', raspberry: 'raspberr', strawberry: 'strawberr', banana: 'banana', oats: 'oat', rice: 'rice', mushroom: 'mushroom',
  onion: 'onion', garlic: 'garlic', tomato: 'tomato', pepper: 'pepper', avocado: 'avocado', spinach: 'spinach', potato: 'potato', sweet_potato: 'sweet potato',
  broccoli: 'broccoli', bread: 'bread', pasta: 'pasta', peanut_butter: 'peanut butter', butter: 'butter', coconut: 'coconut', eggplant: 'aubergine',
  // No catalogue word: the Icelandic name itself is matched (and is never a weekday).
  sunday_roast: null, saturday_candy: null,
};
const GROUP_FALLBACK: Record<string, string> = { white_fish: 'white fish', oily_fish: 'oily fish', shellfish: 'shellfish', dairy: 'dairy' };
const NOT_FOOD_MATCH = new Set(ALX.notFoodMatches.map(foldIs));
/** Folded form (words joined by one space) → catalogue word, and whether it beats the prefix stems. */
const LEX_FOOD: Map<string, { english: string; exact: boolean }> = (() => {
  const m = new Map<string, { english: string; exact: boolean }>();
  const add = (group: string, forms: readonly string[]) => {
    for (const f of forms) {
      const k = foldIs(f);
      const prefix = isFoodEnglish(k);
      // Groups without one catalogue word (white fish, dairy, …): a single word the stems don't know is left to the
      // allergen tables below ("síld" → herring/fish, "mjólk" → milk).
      if (GROUP_EN[group] == null && prefix == null && !k.includes(' ')) continue;
      let english = GROUP_EN[group] ?? prefix ?? GROUP_FALLBACK[group] ?? k;
      if (group === 'beans_lentils' && k.startsWith('linsubaun')) english = 'lentil';
      // Exact when it is several words, a known compound trap, or the stems don't know it.
      const exact = k.includes(' ') || NOT_FOOD_MATCH.has(k) || prefix == null || GROUP_EN[group] != null && group in LEX.ingredientTerms;
      if (!m.has(k)) m.set(k, { english: exact || GROUP_EN[group] == null ? english : prefix ?? english, exact });
    }
  };
  for (const [g, forms] of Object.entries(LEX.ingredientTerms)) add(g, forms);
  for (const [g, forms] of Object.entries(LEX.proteinGroups)) add(g, forms);
  for (const [g, b] of Object.entries(LEX.broadGroups)) add(g, b.forms);
  return m;
})();
/** Allergen class words, compound declarations and the ambiguous classes (bare "hnetur" → both nut classes). */
const LEX_ALLERGEN_CLASS: Map<string, Allergen[]> = new Map();
/** Specific foods that carry an allergen ("síld", "rjóma", "tahini"): used when the prefix stems don't know them. */
const LEX_ALLERGEN_FOOD: Map<string, Allergen[]> = new Map();
const addTo = (m: Map<string, Allergen[]>, forms: readonly string[], a: Allergen[]) => {
  for (const f of forms) m.set(foldIs(f), [...new Set([...(m.get(foldIs(f)) ?? []), ...a])]);
};
for (const [a, g] of Object.entries(ALX.map) as [Allergen, { forms: readonly string[]; foods?: readonly string[]; compoundDeclarations?: readonly string[] }][]) {
  addTo(LEX_ALLERGEN_CLASS, [...g.forms, ...(g.compoundDeclarations ?? [])], [a]);
  addTo(LEX_ALLERGEN_FOOD, g.foods ?? [], [a]);
}
addTo(LEX_ALLERGEN_CLASS, ALX.ambiguous.nuts.forms, ['tree_nuts', 'peanuts']);
addTo(LEX_ALLERGEN_CLASS, ALX.ambiguous.seafood.forms, ['fish', 'shellfish']);
addTo(LEX_ALLERGEN_CLASS, ALX.ambiguous.lactose.forms, ['milk']);
/** Bare "nuts" / "hnetur": peanuts are ruled out too, unless the same message clearly wants peanuts (see parseExclusions). */
const BARE_NUT = new Set(ALX.ambiguous.nuts.forms.map(foldIs));
const isBareNut = (w: string, prev?: string) => BARE_NUT.has(w) || (/^nuts?$/.test(w) && prev !== 'tree') || /^nut-free$/.test(w);
const LACTOSE = new Set(ALX.ambiguous.lactose.forms.map(foldIs));
/** Peanut words, for "…but I love peanut butter" / "…ég vil hnetusmjör" (the bare-nut ambiguity is then resolved). */
const PEANUT_WORD = (w: string) => /^peanuts?$/.test(w) || (LEX_ALLERGEN_CLASS.get(w)?.includes('peanuts') && !BARE_NUT.has(w));
/** Catalogue words for allergen classes and allergen foods, for what the user WANTS ("með fiski" → fish). */
const CLASS_EN: Partial<Record<Allergen, string>> = { fish: 'fish', shellfish: 'shellfish', egg: 'egg', milk: 'milk', peanuts: 'peanut', soy: 'soy', sesame: 'sesame', mustard: 'mustard', celery: 'celery', wheat: 'wheat' };
const ALLERGEN_FOOD_EN: [string, string][] = [
  ['skyr', 'skyr'], ['jogurt', 'yogurt'], ['rjom', 'cream'], ['mysuprot', 'whey'], ['mys', 'whey'], ['eggjahvit', 'egg white'], ['eggjarauð', 'egg'], ['luð', 'halibut'],
  ['sild', 'herring'], ['krabb', 'crab'], ['hum', 'lobster'], ['rug', 'rye'], ['bygg', 'barley'], ['tofu', 'tofu'], ['tempeh', 'tempeh'], ['sojasos', 'soy sauce'],
  ['sojamjolk', 'soy drink'], ['tahini', 'tahini'], ['spelt', 'spelt'],
];
/** Dish names with no catalogue word ("sunnudagssteik", "laugardagsnammi"): any inflection ("sunnudagssteikar") is
 *  matched by its base form, so a catalogue item of that name is still ruled out. Long compounds only. */
const NAMED_DISHES = [...LEX.ingredientTerms.sunday_roast, ...LEX.ingredientTerms.saturday_candy].map(foldIs).filter((f) => !/(?:ina|ið)$/.test(f));
/** One folded word as a catalogue word (lexicon, then the prefix stems), or undefined. */
function wordEnglish(w: string): string | undefined {
  const dish = NAMED_DISHES.find((d) => w.startsWith(d));
  if (dish) return dish;
  const lex = LEX_FOOD.get(w);
  if (lex?.exact) return lex.english;
  if (LEX_ALLERGEN_FOOD.has(w) || w === 'sojamjolk') {
    const hit = ALLERGEN_FOOD_EN.find(([p]) => w.startsWith(p));
    if (hit) return hit[1];
  }
  const prefix = isFoodEnglish(w);
  if (prefix) return prefix;
  if (lex) return lex.english;
  const cls = LEX_ALLERGEN_CLASS.get(w);
  if (cls?.length === 1 && CLASS_EN[cls[0]]) return CLASS_EN[cls[0]];
  return undefined;
}
/** The longest lexicon food phrase starting at token i (1–3 words), as a catalogue word. */
function lexFoodAt(tokens: string[], i: number): { english: string; tokens: string[] } | null {
  for (let n = Math.min(3, tokens.length - i); n >= 2; n--) {
    const k = tokens.slice(i, i + n).join(' ');
    const hit = LEX_FOOD.get(k);
    if (hit) return { english: hit.english, tokens: tokens.slice(i, i + n) };
  }
  const english = wordEnglish(tokens[i]);
  return english ? { english, tokens: [tokens[i]] } : null;
}
/** Two-word catalogue foods (as catalog ingredient names spell them), kept together as one search word. */
const EN_FOOD_PHRASES = new Set(['peanut butter', 'sweet potato', 'soy sauce', 'soy drink', 'soy milk', 'soy yogurt', 'egg white', 'red meat', 'white fish', 'oily fish',
  'rye bread', 'cottage cheese', 'greek yogurt', 'coconut milk', 'black beans', 'kidney beans', 'white beans', 'green beans', 'spring onion', 'smoked salmon',
  'rice noodles', 'egg noodles', 'oat drink', 'pea protein', 'whey protein', 'chia seeds', 'pumpkin seeds', 'sunflower seeds', 'sesame oil', 'sunday roast']);
/** Icelandic words that only shape a request; never search words. */
const IS_STOP = new Set([
  ...IS_VOCAB.recipes.tokens, ...IS_VOCAB.meal_plan.tokens,
  'ég', 'mig', 'mér', 'vil', 'vantar', 'langar', 'finndu', 'sýndu', 'geturðu', 'getur', 'hvað', 'get', 'er', 'eru', 'það', 'þetta', 'fyrir', 'og', 'eða', 'takk',
  'hugmynd', 'hugmyndir', 'hugmyndum', 'eitthvað', 'góður', 'góð', 'gott', 'góða', 'mjög', 'líka', 'bara', 'kvöld', 'dag', 'dagsins', 'viku', 'vikuna', 'næstu',
  'finnst', 'elska', 'borða', 'elda', 'eldað', 'búa', 'til', 'búðu', 'gerðu', 'settu', 'saman', 'rétti', 'rétt', 'réttir', 'réttum', 'máltíð', 'máltíðir', 'máltíðum',
  'lagi', 'allt', 'fer', 'hinn', 'morgun', 'borðaði', 'þoli', 'þolir', 'ofnæmi', 'óþol', 'matinn', 'matnum', 'mat', 'matur', 'svo', 'helst', 'gjarnan',
].map(foldIs));
const FREE_RE = new RegExp(`(?<![${L}])([a-zæðþ]+)[\\s-]free(?![${L}])|(?<![${L}])([a-zæðþ]{3,}?)laus(?:ir|ar|an|um|ri|a|t)?(?![${L}])`, 'g');
const TOKEN_RE = /[a-z0-9æðþ'’-]+|[.,;:!?\n()/&]/g;
/** Icelandic "án" (without) folds to "an", an English article, and "í" (in) folds to "i", the English pronoun: both are
 *  marked before folding. */
const markIsWords = (text: string) => text.replace(/(^|[^\p{L}])án(?=\s)/giu, '$1without ').replace(/(^|[^\p{L}])í(?=\s)/giu, '$1iis ');

/* Question vs declaration, CLAUSE BY CLAUSE. A question about a food ("Hvað eru jarðhnetur?", "What is a nut allergy?")
 * declares nothing — but only within its own clause: a question elsewhere in the message ("Ég er með ofnæmi fyrir mjólk.
 * Hvað mælirðu með í morgunmat?", "What should I eat? I'm allergic to milk.") never cancels an allergy or diet stated in
 * another clause, in either order. A first-person statement ("ég er með …", "I'm allergic …", "ef ég er með …") is a
 * declaration even inside a question; only the inverted form ("Er ég með ofnæmi …?", "Am I allergic …?") asks. */
const CLAUSE_END = new Set(['.', '?', '!', ';', ':', '\n', ',', 'but', 'en']);
/** Abbreviations whose dot is not the end of a sentence ("t.d.", "incl.", "e.g."). */
const ABBREV = new Set(['incl', 'inc', 'etc', 'eg', 'ca', 'ath']);
const isClauseEnd = (tokens: string[], k: number) =>
  CLAUSE_END.has(tokens[k]) && !(tokens[k] === '.' && (/^[a-zæðþ]$/.test(tokens[k - 1] ?? '') || ABBREV.has(tokens[k - 1] ?? '')));
/** Clause kinds that only ask: about a food or diet, or about the user's existing plan ("Is my meal plan vegan?"). */
const ASKS_ONLY = new Set(['nutrition_explanation', 'explain_existing_meal_plan', 'explain_existing_program']);
const FIRST_PERSON = new Set(['ég', 'eg', 'við', 'i', 'we']);
const FIRST_PERSON_VERB = new Set(['er', 'erum', 'hef', 'hofum', 'þoli', 'þolum', 'ma', 'megum', 'borða', 'borðum', 'am', 'have', 'are', 'react', 'get', "can't", 'can’t', 'cannot', 'must', 'avoid']);
const FIRST_PERSON_TOKEN = new Set(["i'm", 'i’m', 'im', "i've", 'i’ve', "we're", 'we’re', "we've", 'we’ve']);
/** A subject-first first-person statement in the clause ("ég er …", "ef ég er …", "I'm …", "I have …"). */
const firstPersonStatement = (w: string[]) =>
  w.some((x, k) => FIRST_PERSON_TOKEN.has(x) || (FIRST_PERSON.has(x) && FIRST_PERSON_VERB.has(w[k + 1] ?? '')));
/** True for every token inside a clause that only ASKS about a food, diet or nutrient. */
function questionClauses(tokens: string[]): boolean[] {
  const mask: boolean[] = tokens.map(() => false);
  let start = 0;
  const close = (end: number) => {
    const words = tokens.slice(start, end).filter((w) => /^[a-z0-9æðþ'’-]+$/.test(w));
    const asText = `${words.map((w) => (w === 'iis' ? 'i' : w)).join(' ')}${tokens[end] === '?' ? '?' : ''}`;
    if (words.length && !firstPersonStatement(words) && ASKS_ONLY.has(classifyRequest(asText) ?? ''))
      for (let k = start; k < end; k++) mask[k] = true;
    start = end + 1;
  };
  tokens.forEach((_, k) => {
    if (isClauseEnd(tokens, k)) close(k);
  });
  close(tokens.length);
  return mask;
}

type Item =
  | { kind: 'allergens'; allergens: Allergen[]; tokens: string[]; implied?: Allergen[]; lactose?: boolean }
  | { kind: 'food'; phrase: string; tokens: string[] }
  | { kind: 'days'; days: string[]; tokens: string[] };

/** A head (1–3 words) → what it rules out, or null when it isn't a food or a day. */
function classifyHead(head: string[]): Item | null {
  if (!head.length || head.some((w) => DIET_NAME.test(w))) return null;
  const days = head.map(dayOf);
  if (days.every(Boolean)) return { kind: 'days', days: [...new Set(days.flat() as string[])], tokens: head };
  // A multi-word lexicon food ("sætar kartöflur", "rauðs kjöts") is read as one; otherwise word by word, exact lexicon
  // forms first (compound traps: "eggaldin", "kjúklingabaunir", "smjörbaunir"), then the prefix stems.
  const whole = head.length > 1 ? LEX_FOOD.get(head.join(' ')) : undefined;
  const english = whole ? whole.english : head.map((w) => wordEnglish(w) ?? w).join(' ');
  const hits = whole || head.some((w) => LEX_FOOD.get(w)?.exact && NOT_FOOD_MATCH.has(w))
    ? ALLERGEN_WORDS.filter(([re]) => re.test(english)).flatMap(([, a]) => a)
    : ALLERGEN_WORDS.filter(([re]) => re.test(english) || re.test(head.join(' '))).flatMap(([, a]) => a);
  // Allergen class words and declarations from the lexicon ("mjólkurprótein", "hnetuofnæmi", "sjávarfang"), and
  // allergen foods the stems don't know ("síld", "rjóma", "tahini").
  for (const w of head) {
    hits.push(...(LEX_ALLERGEN_CLASS.get(w) ?? []));
    if (!isFoodEnglish(w)) hits.push(...(LEX_ALLERGEN_FOOD.get(w) ?? []));
  }
  if (hits.length) {
    const implied: Allergen[] = head.some((w, k) => isBareNut(w, head[k - 1])) && !head.some(PEANUT_WORD) ? ['peanuts'] : [];
    const lactose = head.some((w) => LACTOSE.has(w) || /^lactose/.test(w)) || undefined;
    return { kind: 'allergens', allergens: [...new Set([...hits, ...implied])], tokens: head, ...(implied.length ? { implied } : {}), ...(lactose ? { lactose } : {}) };
  }
  if (english.replace(/\s/g, '').length < 3) return null;
  return { kind: 'food', phrase: english, tokens: head };
}

/** A single word or short phrase given as a thing to avoid (no negation needed): "tree nuts", "svínakjöt". */
function classifyItem(text: string): Item | null {
  const words = fold(text).match(TOKEN_RE)?.filter((w) => !LEAD_FILLER.has(w) && !TRAIL_FILLER.has(w)) ?? [];
  return words.length && words.length <= 3 ? classifyHead(words) : null;
}

interface ExclusionParse {
  items: Item[];
  tokens: string[];
  /** Token indices used by a negation or one of its items. */
  consumed: Set<number>;
}

/** The token-stream pass (see the comment above NEGATOR_WORDS). */
function parseExclusionTokens(text: string): ExclusionParse {
  // Icelandic "án" (without) folds to "an", an English article, and "í" (in) folds to "i", the English pronoun: both are
  // read before folding. Negated diet names ("I'm not vegan", "not gluten-free") are statements about the user, not
  // exclusions: removed first.
  const t = stripNegatedDiets(fold(markIsWords(text)));
  const tokens = t.match(TOKEN_RE) ?? [];
  const consumed = new Set<number>();
  const items: Item[] = [];
  const isWord = (w: string | undefined) => !!w && /^[a-z0-9æðþ'’-]+$/.test(w);
  // A question about a food ("Hvað eru jarðhnetur?", "Hvað er hnetuofnæmi?") declares nothing — in its own clause only
  // (see questionClauses): "Ég er með ofnæmi fyrir mjólk. Hvað mælirðu með?" still declares the milk allergy.
  const question = questionClauses(tokens);
  // Negative declarations are not exclusions: "Ég er ekki með hnetuofnæmi", "ekki með ofnæmi fyrir …", "I'm not allergic
  // to …" — the negation and the declaration are both skipped (a later real exclusion in the message still counts).
  const suppressed = new Set<number>();
  tokens.forEach((w, k) => {
    const decl = (x: string | undefined) => !!x && (/(?:ofnæmi|oþol|oþoli)$/.test(x) || x === 'allergic' || x === 'allergy' || x === 'intolerant');
    const at = (w === 'ekki' || w === 'not') ? (decl(tokens[k + 1]) ? k + 1 : tokens[k + 1] === 'með' && decl(tokens[k + 2]) ? k + 2 : -1) : -1;
    if (at < 0) return;
    for (let n = k; n <= at; n++) suppressed.add(n);
    if (tokens[at + 1] === 'fyrir' || tokens[at + 1] === 'to') {
      suppressed.add(at + 1);
      // …and the foods it names, up to the end of the clause.
      for (let n = at + 2; n < tokens.length && !LIST_END.has(tokens[n]) && !NEGATOR_WORDS.has(tokens[n]); n++) suppressed.add(n);
    }
  });
  const declarationAt = (k: number) => DECLARATIONS.find((d) => d.every((w, n) => tokens[k + n] === w));
  /** The clarifier phrase starting at k (an opening "(" may precede it): its length and kind, or null. */
  const clarifierAt = (k: number): { len: number; extender: boolean } | null => {
    const open = tokens[k] === '(' ? 1 : 0;
    const hit = CLARIFIERS.find((c) => c.every((w, n) => tokens[k + open + n] === w));
    return hit ? { len: hit.length + open, extender: EXTENDERS.includes(hit) } : null;
  };
  for (let i = 0; i < tokens.length; i++) {
    if (suppressed.has(i)) continue;
    const decl = question[i] ? undefined : declarationAt(i);
    if (!decl && !NEGATOR_WORDS.has(tokens[i])) continue;
    // "ekkert nema egg" / "nothing but eggs": ONLY eggs — wanted, never ruled out ("allt nema fisk" still rules fish out).
    if (tokens[i] === 'nema' && ONLY_BEFORE_NEMA.has(tokens[i - 1])) continue;
    consumed.add(i);
    let j = i + 1;
    if (decl) {
      for (let n = 1; n < decl.length; n++) consumed.add(i + n);
      j = i + decl.length;
    }
    // "nothing WITH x …": later "with"/"containing" alternatives stay negative.
    const withScope = NOTHING_WORDS.has(tokens[i]) && (POSITIVE_WITH.has(tokens[j]) || !!clarifierAt(j));
    list: for (let first = true; ; first = false) {
      // Clause boundaries at the start of a later item: "…, I like chicken", "…, please …", "…, ég vil egg", "and with eggs".
      if (!first) {
        // An extender inside the list keeps it going, even "like" ("no nuts, like peanuts"): fail-safe. Only a subject
        // or another affirmative word ends it ("No fish, I like chicken").
        const c0 = clarifierAt(j);
        if (!c0?.extender && AFFIRM_START.has(tokens[j])) break;
        if (!withScope && !c0 && POSITIVE_WITH.has(tokens[j])) break;
      }
      // Leading fillers, clarifiers and (right after the negation) verbs: "without ANY nuts", "nothing WITH nuts",
      // ", INCLUDING peanuts", "or CONTAINING milk", "don't EAT fish".
      for (;;) {
        const c = clarifierAt(j);
        if (c) {
          // Fail-safe: an extender anywhere in the list extends it ("no nuts and like peanuts" rules peanuts out too);
          // "like I said" stops right below, at the subject.
          j += c.len;
          if (AFFIRM_START.has(tokens[j])) break list; // "no eggs like I said"
        } else if (first && LEAD_VERBS.has(tokens[j])) j++;
        else if (j < tokens.length && LEAD_FILLER.has(tokens[j]) && !(tokens[j] === 'at' && tokens[j + 1] !== 'all')) j++;
        else break;
      }
      const start = j;
      const head: string[] = [];
      let cut = false;
      let copula = false;
      let copulaOk = false;
      while (j < tokens.length && isWord(tokens[j]) && !SEP_WORDS.has(tokens[j]) && !LIST_END.has(tokens[j]) && !NEGATOR_WORDS.has(tokens[j]) && !clarifierAt(j)) {
        const w = tokens[j];
        if (w === 'at' && tokens[j + 1] === 'all') break; // "nuts at all" — a filler, handled below
        if (TRAIL_FILLER.has(w)) break;
        if (COPULA.has(w) || NEG_COPULA.has(w)) {
          copula = true;
          copulaOk = copulaAffirms(tokens, j);
          break;
        }
        if (/\d/.test(w) || NOT_AN_ITEM.has(w) || CLAUSE_BREAK.has(w) || AFFIRM_START.has(w) || head.length === 3) {
          cut = true;
          break;
        }
        head.push(w);
        j++;
      }
      // "no tuna, salmon IS fine" / "…, lax er í lagi": a later item that the clause explicitly AFFIRMS is what the user
      // wants — not ruled out. Anything else after "is/er" ("peanut butter is NOT okay", "hnetusmjör er ekki í lagi",
      // "peanuts are dangerous") keeps the item ruled out: a mere mention never relaxes a restriction.
      if (copula && copulaOk && !first) break;
      const item = classifyHead(head);
      if (!item) break;
      items.push(item);
      for (let k = start; k < start + head.length; k++) consumed.add(k);
      if (cut || copula) break;
      // Fillers after the item don't end the list: "no nuts at all, eggs or soy", "(incl. peanuts)".
      for (;;) {
        if (tokens[j] === 'at' && tokens[j + 1] === 'all') j += 2;
        else if (TRAIL_FILLER.has(tokens[j]) || tokens[j] === ')') j++;
        else break;
      }
      if (clarifierAt(j)) continue; // "no nuts including peanuts": the clarifier is handled at the top of the loop
      if (!SEP_WORDS.has(tokens[j])) break;
      while (SEP_WORDS.has(tokens[j])) j++;
      if (NEGATOR_WORDS.has(tokens[j])) break; // "no fish, no nuts": the outer loop starts the next list
    }
  }
  for (const m of t.matchAll(FREE_RE)) {
    const item = classifyHead([(m[1] ?? m[2] ?? '').trim()].filter(Boolean));
    if (item && item.kind !== 'days') items.push(item);
  }
  // "<food> is not okay" / "<food> er ekki í lagi" / "<food> isn't allowed" on its own: a restriction too.
  tokens.forEach((w, k) => {
    if (question[k] || !(COPULA.has(w) || NEG_COPULA.has(w)) || !copulaDenies(tokens, k)) return;
    const head: number[] = [];
    for (let h = k - 1; h >= 0 && head.length < 3; h--) {
      const x = tokens[h];
      if (!isWord(x) || SEP_WORDS.has(x) || LIST_END.has(x) || NEGATOR_WORDS.has(x) || LEAD_FILLER.has(x) || AFFIRM_START.has(x) || CLAUSE_BREAK.has(x) || NOT_AN_ITEM.has(x) || clarifierAt(h)) break;
      head.unshift(h);
    }
    if (!head.length || head.some((h) => consumed.has(h))) return;
    const item = classifyHead(head.map((h) => tokens[h]));
    if (item && item.kind !== 'days') {
      items.push(item);
      head.forEach((h) => consumed.add(h));
    }
  });
  // Allergy and intolerance declared in one word ("hnetuofnæmi", "mjólkurofnæmi", "laktósaóþol", "glútenóþol", "selíak")
  // or as "<food> allergy": a hard exclusion wherever it stands — unless negated or only asked about (in its own clause).
  {
    tokens.forEach((w, k) => {
      if (suppressed.has(k) || question[k]) return;
      const compound = LEX_ALLERGEN_CLASS.has(w) && (/(?:ofnæmi|oþol)$/.test(w) || /^seliak/.test(w));
      const head = compound ? [w] : /^(?:allergy|allergies|intolerance)$/.test(w) && isWord(tokens[k - 1]) && !suppressed.has(k - 1) ? [tokens[k - 1]] : null;
      const item = head && classifyHead(head);
      if (item && item.kind === 'allergens') {
        items.push(item);
        consumed.add(k);
      }
    });
  }
  return { items, tokens, consumed };
}

/** Verbs of wanting / liking that make a clause an explicit request FOR a food ("I love …", "ég vil …", "við elskum …"). */
const WANT_VERBS = new Set(['love', 'loves', 'want', 'wants', 'enjoy', 'prefer', 'adore', 'crave', 'vil', 'viljum', 'vilja', 'elska', 'elskum', 'langar', 'likar', 'endilega', 'gjarnan']);
const LIKE_SUBJECT = new Set(['i', 'we', "i'd", 'i’d', "we'd", 'we’d', 'would', 'really', 'also', 'do', 'still']);
/** "mér finnst … gott": liking in Icelandic needs the approving adjective. */
const GOOD_WORDS = new Set(['gott', 'goð', 'goður', 'goðar', 'goðir', 'frabært', 'frabær', 'æði', 'best']);
/**
 * Token k (a food) sits in an explicitly AFFIRMATIVE wanted-food clause: the clause has a wanting/liking verb before it
 * ("but I love peanut butter", "en ég vil hnetusmjör", "mér finnst hnetusmjör gott") or approves it ("peanut butter is
 * fine", "hnetusmjör er í lagi"), contains no negation, and is not a question. Anything less — a question, a negated
 * statement ("is not okay", "ekki í lagi"), a bare mention — is not permission to relax a restriction.
 */
function affirmedWanted(tokens: string[], k: number, question: boolean[]): boolean {
  if (question[k]) return false;
  let s = k;
  while (s > 0 && !isClauseEnd(tokens, s - 1)) s--;
  let e = k;
  while (e < tokens.length && !isClauseEnd(tokens, e)) e++;
  // "?" ending the clause: asked, not stated.
  if (tokens[e] === '?') return false;
  const clause = tokens.slice(s, e);
  if (clause.some((w) => NEGATOR_WORDS.has(w) || NEG_COPULA.has(w) || w === 'without')) return false;
  const before = tokens.slice(s, k);
  if (before.some((w, n) => WANT_VERBS.has(w) || (w === 'like' && LIKE_SUBJECT.has(before[n - 1] ?? '')) || (w === 'finnst' && tokens.slice(k, e).some((x) => GOOD_WORDS.has(x))))) return true;
  for (let c = k + 1; c < e; c++) if (COPULA.has(tokens[c])) return copulaAffirms(tokens, c);
  return false;
}

/** Parse what a request rules out: allergen groups, other foods and weekdays. Pass the user's text as written. */
export function parseExclusions(text: string): Exclusions {
  const { items, tokens, consumed } = parseExclusionTokens(text);
  const allergens = new Set<Allergen>();
  const words = new Set<string>();
  const days = new Set<string>();
  const raw = new Set<string>();
  let lactose = false;
  // Bare "nuts" / "hnetur" rules peanuts out too (safety), unless the message itself EXPLICITLY wants peanuts in an
  // affirmative clause ("no nuts like almonds, but I love peanut butter", "engar hnetur eins og möndlur, ég vil
  // hnetusmjör") and nothing rules them out. A mere mention never relaxes it: not a question ("Hvað með hnetusmjör?"), not
  // a negated statement ("peanut butter is not okay", "hnetusmjör er ekki í lagi"), not an unconsumed list remnant.
  const question = questionClauses(tokens);
  const peanutsWanted = tokens.some((w, k) => !consumed.has(k) && PEANUT_WORD(w) && affirmedWanted(tokens, k, question));
  const explicitPeanuts = items.some((it) => it.kind === 'allergens' && it.allergens.includes('peanuts') && !it.implied?.includes('peanuts'));
  for (const it of items) {
    it.tokens.forEach((w) => raw.add(w));
    if (it.kind === 'allergens') {
      it.allergens.filter((a) => !(peanutsWanted && !explicitPeanuts && it.implied?.includes(a))).forEach((a) => allergens.add(a));
      if (it.lactose) lactose = true;
    } else if (it.kind === 'food') words.add(it.phrase);
    else it.days.forEach((d) => days.add(d));
  }
  return { allergens: [...allergens], words: [...words], raw: [...raw], days: [...days], ...(lactose ? { lactose } : {}) };
}

/** Every allergen group the text MENTIONS anywhere (wanted or not) — used by the tests to enforce the fail-safe rule. */
export function allergenMentions(text: string): Allergen[] {
  const tokens = fold(text).match(TOKEN_RE) ?? [];
  const english = tokens.map((w) => wordEnglish(w) ?? w).join(' ');
  const raw = tokens.filter((w) => !NOT_FOOD_MATCH.has(w)).join(' ');
  const lex = tokens.flatMap((w) => [...(LEX_ALLERGEN_CLASS.get(w) ?? []), ...(isFoodEnglish(w) ? [] : LEX_ALLERGEN_FOOD.get(w) ?? [])]);
  return [...new Set([...ALLERGEN_WORDS.filter(([re]) => re.test(english) || re.test(raw)).flatMap(([, a]) => a), ...lex])];
}

/** Weekdays the text asks FOR: whole day words that no negation used ("Monday and Friday" yes; "no sunday roast",
 *  "not Friday", "sunnudagssteik" no). English names in week order. */
export function wantedDays(text: string): string[] {
  const { tokens, consumed } = parseExclusionTokens(text);
  const out = new Set<string>();
  tokens.forEach((w, i) => {
    if (consumed.has(i)) return;
    dayOf(w)?.forEach((d) => out.add(d));
    // Icelandic "virka daga" / "virkum dögum" / "virkir dagar" (weekdays).
    if (/^virk(?:a|um|ir)$/.test(w) && /^d[ao]g(?:a|um|ar)$/.test(tokens[i + 1] ?? '')) ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].forEach((d) => out.add(d));
  });
  return WEEKDAYS_EN.filter((d) => out.has(d));
}

/** Ingredient ids whose name matches a ruled-out word (or its synonyms: "meat" → beef, chicken, …). */
export function excludedIngredientIds(words: string[], ingredients: Iterable<RefIngredient>): string[] {
  const keys = words.flatMap((w) => [w, ...(SYNONYMS[w] ?? SYNONYMS[stem(w)] ?? [])]).map(stem).filter((k) => k.length >= 3);
  if (!keys.length) return [];
  // Protein groups the words cover ("meat" → every meat group, so ham and bacon too, whose names don't say "pork").
  const groups = new Set(words.flatMap((w) => PROTEIN_WORDS[w] ?? PROTEIN_WORDS[stem(w)] ?? []));
  const out: string[] = [];
  for (const i of ingredients) {
    const n = fold(i.name);
    if (keys.some((k) => n.includes(k)) || (i.proteinGroup && groups.has(i.proteinGroup))) out.push(i.id);
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
const allergenLabel = (a: string, lang: Lang = 'en') =>
  (lang === 'en' ? (ALLERGEN_LABELS as Record<string, string>)[a]?.toLowerCase() : localAllergenLabel(a as Allergen, lang).toLocaleLowerCase('is-IS')) ?? a;
const dietLabel = (t: string, lang: Lang = 'en') => (lang === 'en' ? (DIET_TAG_LABELS as Record<string, string>)[t] ?? t : dietTagLabel(t as DietTag, lang));

/** "no soy" / "án soja": a complete phrase per allergen (never "án" + a nominative label); unknown ones use the fallback. */
function noAllergen(a: string, lang: Lang): string {
  const tr = sharedT(lang);
  const key = `aiServer.constraints.exclude.${a}`;
  if (lang === 'en' || !tr.has(key)) return lang === 'en' ? `no ${allergenLabel(a)}` : tr.t('aiServer.constraints.noAllergen', { allergen: allergenLabel(a, lang) });
  return tr.t(key as SharedKey);
}

/** "vegan + no soy + ≤ 15 min" — the user's active constraints, in words (in the reply language). */
export function describeConstraints(c: ConstraintSet, lang: Lang = 'en'): string {
  const { t, tp } = sharedT(lang);
  const meal = (m: string) => (lang === 'en' ? (MEAL_LABELS as Record<string, string>)[m]?.toLowerCase() ?? m : mealLabel(m as MealSlotName, lang).toLocaleLowerCase('is-IS'));
  const parts = [
    ...c.dietTags.map((d) => dietLabel(d, lang)),
    ...c.allergens.map((a) => noAllergen(a, lang)),
    ...(c.disliked.length ? [tp('aiServer.constraints.skipped', c.disliked.length)] : []),
    ...(c.proteinExcluded?.length ? [t('aiServer.constraints.noProtein', { proteins: proteinListText(c.proteinExcluded as ProteinGroup[], lang) })] : []),
    ...(c.maxMinutes != null ? [t('aiServer.constraints.maxTime', { minutes: c.maxMinutes })] : []),
    ...(c.meal ? [meal(c.meal)] : []),
  ];
  return parts.join(' + ') || t('aiServer.constraints.none');
}

/**
 * Which of the user's constraints empty the catalog: tries dropping each one; names the ones whose removal brings
 * recipes back, otherwise the whole combination.
 */
export function explainNoRecipes(c: ConstraintSet, recipes: RefRecipe[], ing: Map<string, RefIngredient>, facts: UserFacts, lang: Lang = 'en'): string {
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
        return !bad; // optional ones too: find_recipes rejects a recipe that would need one left out (1.0.3)
      });
    });
  void facts;
  const tr = sharedT(lang);
  const culprits: string[] = [];
  if (c.maxMinutes != null && fits({ ...c, maxMinutes: null })) culprits.push(tr.t('aiServer.constraints.causeTime', { minutes: c.maxMinutes }));
  for (const d of c.dietTags) if (fits({ ...c, dietTags: c.dietTags.filter((x) => x !== d) })) culprits.push(tr.t('aiServer.constraints.causeDiet', { diet: lang === 'en' ? dietLabel(d).toLowerCase() : dietLabel(d, lang) }));
  for (const a of c.allergens) if (fits({ ...c, allergens: c.allergens.filter((x) => x !== a) })) culprits.push(tr.t('aiServer.constraints.causeAllergen', { allergen: allergenLabel(a, lang) }));
  if (c.disliked.length && fits({ ...c, disliked: [] })) culprits.push(tr.t('aiServer.constraints.causeSkipped'));
  if (c.proteinExcluded?.length && fits({ ...c, proteinExcluded: [] })) culprits.push(tr.t('aiServer.constraints.causeProtein'));
  const constraints = describeConstraints(c, lang);
  const causes = lang === 'en' ? culprits.slice(0, 3).join(' or ') : listText(culprits.slice(0, 3), lang, 'disjunction');
  return culprits.length ? tr.t('aiServer.recipes.noMatchCauses', { constraints, causes }) : tr.t('aiServer.recipes.noMatch', { constraints });
}

/* ------------------------------------------------------------------ meal plans from intent */
// English and Icelandic stems (folded text: "fiskur", "hnetum", "glútens", "rækjur", "jarðhnetur", "mjólk").
const ALLERGEN_WORDS: [RegExp, Allergen[]][] = [
  [/\bfish\b|\bseafood\b|\bfisk|\bsjavarfang/, ['fish', 'shellfish']], [/\bshellfish\b|\bprawns?\b|\bshrimps?\b|\bcrustaceans?\b|\bmollus[ck]s?\b|\brækj|\bskelfisk|\bkrabbadyr|\blindyr/, ['shellfish']],
  [/\bdairy\b|\bmilk\b|\blactose\b|\bcheese\b|\bmjolk|\blaktos/, ['milk']],
  [/\beggs?\b|\beggj/, ['egg']], [/\bpeanuts?\b|\bjarðhnet|\bhnetusmjor/, ['peanuts']], [/\bnuts?\b|\btree nuts?\b|(?<![a-zæðþ])hnet(?!usmjor)|\btrjahnet|\balmonds?\b|\bcashews?\b|\bwalnuts?\b|\bhazelnuts?\b|\bpecans?\b|\bpistachios?\b|\bmacadamias?\b|\bmondl|\bvalhnet|\bheslihnet|\bkasju/, ['tree_nuts']], [/\bgluten/, ['gluten']], [/\bwheat\b|\bhveiti/, ['wheat']],
  [/\bsoy\b|\bsoya\b|\btofu\b|\bsoja/, ['soy']], [/\bsesame\b|\bsesam/, ['sesame']], [/\bmustard\b|\bsinnep/, ['mustard']], [/\bcelery\b|\bsellerí|\bselleri/, ['celery']],
];

export interface MealPlanIntent {
  week?: unknown;
  days?: unknown;
  meals_per_day?: unknown;
  /** How many days to plan ("for four days", "fjóra daga"): the first N plan days of the week, 1–7. */
  day_count?: unknown;
  /** A single day relative to today ("tomorrow" 1, "á hinn morgun" 2); used when no days are named. */
  relative_day?: unknown;
  /** An explicit cooking-time cap ("hámark 20 mínútur"): a hard limit, never relaxed. */
  max_minutes?: unknown;
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
  /** Reply language for the errors and warnings (they reach the user as written); English by default. */
  lang?: Lang;
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
export function buildMealPlanAction(
  input: MealPlanIntent,
  ctx: MealPlanBuildContext,
): { action: MealPlanAction | null; errors: string[]; adjusted: string[]; clarify?: PlanClarification } {
  const lang: Lang = ctx.lang ?? 'en';
  const tr = sharedT(lang);
  const blocker = mealPlanBlocker(ctx.nutrition, lang);
  if (blocker) return { action: null, errors: [blocker], adjusted: [] };
  const userText = (ctx.requestText ?? '').slice(0, 1200);
  // What the user's own words pin down (week, days, a day count or relative day, meals per day, a cooking-time cap) fills
  // in whatever the model's intent left out. Something that can't be planned without guessing — a diet that rules out a
  // food they asked for, "2,5 máltíðir", "ten days" — is a question for the user, never a plan.
  const said: MealPlanIntent = userText ? mealPlanIntentFromText(userText) : {};
  const mpdIn = input.meals_per_day ?? said.meals_per_day;
  const mpd = mpdIn == null ? NaN : Number(mpdIn);
  const dayCountIn_ = input.day_count ?? said.day_count;
  const dayCount = dayCountIn_ == null ? null : Number(dayCountIn_);
  const clarify: PlanClarification | null =
    requestClarification(userText) ??
    (mpdIn != null && !(Number.isInteger(mpd) && mpd >= 1 && mpd <= 6) ? { kind: 'meals_per_day', value: String(mpdIn).slice(0, 20) } : null) ??
    (dayCount != null && !(Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 7) ? { kind: 'day_count', value: dayCount } : null);
  if (clarify) return { action: null, errors: [clarificationNote(clarify)], adjusted: [], clarify };
  const capIn = [input.max_minutes, said.max_minutes, maxMinutesIn(strs(input.preferences).join(' '))]
    .map((v) => (v == null ? NaN : Number(v)))
    .filter((v) => Number.isFinite(v) && v > 0);
  const cap = capIn.length ? Math.min(...capIn) : null;

  const allRecipes = ctx.recipes as unknown as Recipe[];
  const byId = new Map((ctx.ingredients as unknown as Ingredient[]).map((i) => [i.id, i]));
  setNutritionCatalog({ byId, recipes: allRecipes });

  // Preferences: the user's saved settings, tightened by what they asked for in this message (never relaxed).
  const prefs: PlanPrefs = { ...prefsFromAccountPayload(ctx.account) };
  const adjusted: string[] = [];
  if (Number.isInteger(mpd)) prefs.mealsPerDay = mpd;
  // An explicit cap ("hámark 10 mínútur") is hard: only recipes within it are planned (never "some take longer").
  if (cap != null) prefs.maxCookMinutes = Math.min(prefs.maxCookMinutes, cap);
  const recipes = cap != null ? allRecipes.filter((r) => recipeMinutes(r) <= prefs.maxCookMinutes) : allRecipes;
  const planCtx = { recipes, byId };
  const prefText = fold([...strs(input.preferences), ...strs(input.avoid), userText].join(' '));
  if (input.quick === true || /\b(quick|fast|no[\s-]?cook)\b/.test(prefText)) prefs.maxCookMinutes = Math.min(prefs.maxCookMinutes, 15);
  const extraTags = [...strs(input.diet), ...dietTagsIn(prefText)].filter((t): t is DietTag => t in DIET_TAG_LABELS && t !== 'high_protein');
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
  const modelDays = strs(input.days);
  const asked = modelDays.length ? modelDays : strs(said.days);
  let week = input.week === 'this' || input.week === 'next' ? input.week : said.week === 'this' || said.week === 'next' ? said.week : undefined;
  // One relative day ("á hinn morgun", "the day after tomorrow") with no days named: exactly that day, in its week.
  const relIn = Number(input.relative_day ?? said.relative_day);
  const relDate = !asked.length && Number.isInteger(relIn) && relIn >= 1 && relIn <= 13 ? addDays(ctx.today, relIn) : null;
  const relWeek = relDate ? (relDate <= thisEnd ? 'this' : relDate <= addDays(thisEnd, 7) ? 'next' : null) : null;
  const useRel = relDate != null && relWeek != null && (week == null || week === relWeek);
  if (useRel) week = relWeek!;
  // "Four days" with no week named: this week when that many days are left, else next week.
  if (week == null && !useRel && !asked.length && dayCount != null && dayCount > left) week = 'next';
  const next = week === 'next' || (week !== 'this' && left < 3 && !asked.length && !useRel);
  const weekStart = next ? addDays(thisStart, 7) : thisStart;
  const weekEnd = addDays(weekStart, 6);
  const allDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).filter((d) => next || d >= ctx.today);
  let dates = useRel ? allDates.filter((d) => d === relDate) : allDates;
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
    if (!dates.length) {
      // English keeps its original wording (ISO dates); Icelandic shows display dates.
      const range = lang === 'en' ? { start: allDates[0] ?? weekStart, end: weekEnd } : { start: shortDate(allDates[0] ?? weekStart, lang), end: shortDate(weekEnd, lang) };
      return { action: null, errors: [tr.t(next ? 'aiServer.mealPlan.daysUnavailableNext' : 'aiServer.mealPlan.daysUnavailableThis', range)], adjusted };
    }
  }
  if (!dates.length) return { action: null, errors: [tr.t('aiServer.mealPlan.noDays')], adjusted };
  // Days the user ruled out ("not Friday") are never planned, whatever days the model picked.
  if (fromUser.days.length) {
    dates = dates.filter((d) => !fromUser.days.includes(DAY_NAMES[new Date(`${d}T00:00:00Z`).getUTCDay()]));
    if (!dates.length) return { action: null, errors: [tr.t(next ? 'aiServer.mealPlan.allExcludedNext' : 'aiServer.mealPlan.allExcludedThis')], adjusted };
  }
  // A day count takes the first N plan days; fewer left than asked for is a question, never a shorter or longer plan.
  if (dayCount != null && !useRel) {
    if (dates.length < dayCount) {
      const c: PlanClarification = { kind: 'day_count', value: dayCount };
      return { action: null, errors: [clarificationNote(c)], adjusted, clarify: c };
    }
    dates = dates.slice(0, dayCount);
  }

  // Every slot needs at least one recipe under the constraints; otherwise say which constraint is the blocker.
  const constraints: ConstraintSet = {
    allergens: prefs.allergens, dietTags: prefs.tags, disliked: prefs.dislikedIngredientIds, maxMinutes: prefs.maxCookMinutes, meal: null, proteinExcluded: prefs.proteinExcluded,
  };
  for (const slot of new Set(slotsForMeals(prefs.mealsPerDay))) {
    const { recipes: pool, relaxedTime } = rankedCandidates(slot, prefs, planCtx);
    if (!pool.length) {
      return { action: null, errors: [explainNoRecipes({ ...constraints, maxMinutes: cap != null ? prefs.maxCookMinutes : null, meal: slot }, ctx.recipes, new Map(ctx.ingredients.map((i) => [i.id, i])), ctx.facts, lang)], adjusted };
    }
    if (relaxedTime) adjusted.push(tr.t('aiServer.mealPlan.timeRelaxed', { slot: tr.t(`aiServer.mealSlotFor.${slot}` as SharedKey), minutes: prefs.maxCookMinutes }));
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
      return { action: null, errors: [tr.t('aiServer.mealPlan.conflictingMeal')], adjusted };
    for (const e of it.extras ?? []) {
      const i = byId.get(e.ingredientId);
      if (!i || !ingredientAllowed(i, { tags: prefs.tags, allergens: prefs.allergens, disliked: prefs.dislikedIngredientIds }) || !ingredientFitsProteinPrefs(i, prefs.proteinExcluded))
        return { action: null, errors: [tr.t('aiServer.mealPlan.conflictingSide')], adjusted };
    }
  }
  const slow = days.flatMap((d) => d.items).filter((it) => recipeMinutes(recipes.find((r) => r.id === it.recipeId)!) > prefs.maxCookMinutes);
  if (slow.length && !adjusted.length) adjusted.push(tr.tp('aiServer.mealPlan.slow', slow.length, { minutes: prefs.maxCookMinutes }));
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
  // The same classifier as conversation.classifyIntent: "Hvar finn ég matseðilinn minn?" and "Ekki búa til matseðil
  // ennþá" never build a plan.
  return classifyRequest(text) === 'meal_plan';
}

/** An English word ALLERGEN_WORDS maps back to the same allergen (for MealPlanIntent.avoid). */
const ALLERGEN_AVOID_WORD: Partial<Record<Allergen, string>> = {
  fish: 'fish', shellfish: 'shellfish', milk: 'milk', egg: 'egg', peanuts: 'peanuts', tree_nuts: 'tree nuts', gluten: 'gluten', wheat: 'wheat', soy: 'soy',
  sesame: 'sesame', mustard: 'mustard', celery: 'celery',
};
const WEEKDAYS_EN = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
// Meal counts ("two meals", "þrjár máltíðir", every inflected Icelandic number word): requestSignals.mealsPerDayIn.

/**
 * The meal-plan intent stated in a user's own words (used when the model didn't call propose_meal_plan, so the
 * server-built plan still honours "no fish, two meals a day, next week"). Never invents constraints: anything it
 * can't read is simply not set, and the user's saved settings still apply in buildMealPlanAction.
 */
export function mealPlanIntentFromText(text: string): MealPlanIntent {
  const t = fold(text);
  const intent: MealPlanIntent = { preferences: [text.slice(0, 300)] };
  // Meals per day: a whole number 1–6 only — "2,5 máltíðir" is left unset (the coach asks), never rounded.
  const mpd = mealsPerDayIn(text);
  if (mpd && 'value' in mpd) intent.meals_per_day = mpd.value;
  // Days to plan: a count ("fyrir fjóra daga", "four days next week") or one relative day that is the plan's own target
  // ("matseðill fyrir á hinn morgun", "meal plan for tomorrow"); "í dag" / "í morgun" (this morning) never narrow the plan,
  // nor does a day in another clause ("I shop tomorrow").
  const count = planDayCountIn(text);
  if (count != null && Number.isInteger(count) && count >= 1 && count <= 7) intent.day_count = count;
  const rel = planRelativeDay(text);
  if (rel != null && rel >= 1) intent.relative_day = rel;
  const cap = maxMinutesIn(text);
  if (cap != null && cap > 0) intent.max_minutes = cap;
  if (/\bnext week\b|(?<![a-zæðþ])næstu viku(?:nni)?(?![a-zæðþ])|(?<![a-zæðþ])næsta viku(?![a-zæðþ])/.test(t)) intent.week = 'next';
  else if (/\bthis week\b|(?<![a-zæðþ])þessa(ri)? viku\b/.test(t)) intent.week = 'this';
  const ex = parseExclusions(text);
  // Days asked for (whole day words no negation used), minus days ruled out ("not Friday", "ekki um helgina"); with only
  // exclusions, every other day of that week.
  const positive = wantedDays(text).filter((d) => !ex.days.includes(d));
  if (positive.length) intent.days = positive;
  else if (ex.days.length) intent.days = WEEKDAYS_EN.filter((d) => !ex.days.includes(d));
  if (/\b(quick|fast|no[\s-]?cook)\b|(?<![a-zæðþ])(?<!ekki )(?:fljot|snogg)/.test(t)) intent.quick = true;
  const diet = dietTagsIn(t);
  if (diet.length) intent.diet = diet;
  // Foods and allergens ruled out, as phrases ("tree nuts", "red onion") — buildMealPlanAction maps them again.
  const avoid = [...ex.allergens.map((a) => ALLERGEN_AVOID_WORD[a] ?? a.replace(/_/g, ' ')), ...ex.words];
  if (avoid.length) intent.avoid = [...new Set(avoid)];
  return intent;
}

/** "fyrir fjóra daga", "for 4 days", "four days next week" → 4 ("eftir tvo daga" / "in two days" is a relative day). */
export function planDayCountIn(text: string): number | null {
  const direct = dayCountIn(text);
  if (direct != null) return direct;
  const t = tokensOf(text);
  for (let i = 0; i < t.length; i++) {
    if (['eftir', 'in', 'a', 'per', 'every'].includes(t[i - 1] ?? '')) continue;
    const n = dayCountIn(`for ${t.slice(i, i + 4).join(' ')}`);
    if (n != null) return n;
  }
  return null;
}

/** Something in the request the planner can't follow without guessing: ask the user, never build a plan or show recipes. */
export type PlanClarification =
  | { kind: 'diet_conflict'; diet: DietTag[]; foods: string[] }
  | { kind: 'meals_per_day'; value: string }
  | { kind: 'day_count'; value: number };

/** What the user's own words leave for them to decide (a diet that rules out a food they asked for, "2,5 máltíðir", "ten days"). */
export function requestClarification(text: string): PlanClarification | null {
  if (!text) return null;
  const foods = requestConflicts(text);
  if (foods.length) return { kind: 'diet_conflict', diet: dietTagsIn(text), foods };
  const mpd = mealsPerDayIn(text);
  if (mpd && 'invalid' in mpd) return { kind: 'meals_per_day', value: mpd.invalid };
  const n = planDayCountIn(text);
  if (n != null && (!Number.isInteger(n) || n < 1 || n > 7)) return { kind: 'day_count', value: n };
  return null;
}

/** The question for the MODEL to put to the user, in the reply language (English diagnostics; no approved fixed copy). */
export function clarificationNote(c: PlanClarification): string {
  if (c.kind === 'diet_conflict')
    return `The request asks for ${c.diet.join(' + ')} AND for ${c.foods.join(', ')}, which that diet rules out. Nothing was built. Ask the user which to keep (the diet, or the ${c.foods.join(', ')}); never drop either one silently.`;
  if (c.kind === 'meals_per_day')
    return `The request asks for ${c.value} meals a day, which isn't a whole number from 1 to 6. Nothing was built. Ask the user how many meals a day (a whole number 1–6) they want; never round it.`;
  return `The request asks for ${c.value} days; a meal plan covers 1–7 days of one week. Nothing was built. Ask the user which days (or how many, 1–7) they want.`;
}

/* Relative days a plan can be FOR: the approved vocabulary (weekdays.relative: "á morgun", "á hinn morgun", "eftir tvo
 * daga") only, plus English. "á" is marked before folding ("í morgun" is this morning). */
const REL_PLAN_DAYS: [string[], number][] = ([
  ...IS_VOCAB.weekdays.relative.dayAfterTomorrow.map((p) => [relTokens(p), 2] as [string[], number]),
  ...IS_VOCAB.weekdays.relative.tomorrow.map((p) => [relTokens(p), 1] as [string[], number]),
  [['the', 'day', 'after', 'tomorrow'], 2], [['day', 'after', 'tomorrow'], 2],
  [['in', 'two', 'days'], 2], [['tomorrow'], 1],
] as [string[], number][]).sort((a, b) => b[0].length - a[0].length);
function relTokens(text: string): string[] {
  return tokensOf(String(text ?? '').replace(/(^|[^\p{L}])á(?=\s)/giu, '$1qqa ').replace(/(^|[^\p{L}])í(?=\s)/giu, '$1qqi ')).map((w) => w.replace(/['’]s$/, ''));
}
const PLAN_WORDS = new Set([...IS_VOCAB.meal_plan.tokens.map(foldIs), 'plan', 'plans', 'menu', 'menus', 'meals', 'mealplan']);
/** Words that start another clause: a relative day after them is not the plan's target ("…, because I shop tomorrow"). */
const CLAUSE_WORDS = new Set(['and', 'but', 'because', 'since', 'as', 'when', 'while', 'so', 'og', 'en', 'því', 'þvi', 'þegar', 'svo', 'af', 'vegna']);
const ONLY_DAY_FILLER = new Set(['for', 'fyrir', 'just', 'only', 'bara', 'please', 'takk']);

/**
 * Days from today a relative day means when it is the plan's own time target in the same clause: right after "for" /
 * "fyrir", next to the plan word ("tomorrow's meal plan", "matseðill á morgun"), or a line that is just the day ("Á morgun.").
 * A day in another clause ("Meal plan, I shop tomorrow", "Ég fer í búð á morgun, gerðu matseðil") is null.
 */
export function planRelativeDay(text: string): number | null {
  for (const line of String(text ?? '').split('\n')) {
    const lineTokens = relTokens(line);
    for (const part of line.split(/[,.;:!?()]+/)) {
      const t = relTokens(part);
      // Split the clause again at clause words.
      const clauses: string[][] = [[]];
      for (const w of t) {
        if (CLAUSE_WORDS.has(w)) clauses.push([]);
        else clauses[clauses.length - 1].push(w);
      }
      for (const c of clauses) {
        for (let i = 0; i < c.length; i++) {
          const hit = REL_PLAN_DAYS.find(([p]) => p.every((w, k) => c[i + k] === w));
          if (!hit) continue;
          const [p, n] = hit;
          const end = i + p.length;
          const hasPlan = c.some((w) => PLAN_WORDS.has(w));
          const afterFor = ['for', 'fyrir'].includes(c[i - 1] ?? '') || (c[i - 1] === 'the' && c[i - 2] === 'for');
          const nextToPlan = PLAN_WORDS.has(c[i - 1] ?? '') || PLAN_WORDS.has(c[end] ?? '') || (c[end] === 'meal' && PLAN_WORDS.has(c[end + 1] ?? ''));
          const alone = lineTokens.length > 0 && lineTokens.every((w) => ONLY_DAY_FILLER.has(w) || p.includes(w));
          if ((hasPlan && (afterFor || nextToPlan)) || alone) return n;
          i = end - 1;
        }
      }
    }
  }
  return null;
}
