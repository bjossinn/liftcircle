/**
 * What a user message asks for, read from its words (pure, Deno-safe, English + Icelandic):
 *  - classifyRequest: the kind of request (meal plan, program, week change, recipes, today's workout, an explanation, a
 *    question about something that already exists, …). conversation.classifyIntent and meals.asksForMealPlan both use it,
 *    so "Hvar finn ég matseðilinn minn?" or "Ekki búa til matseðil ennþá" never builds a plan anywhere;
 *  - small readers used with it: minutes / durations, Icelandic number words, decimal comma numbers ("62,5 kg"), meals
 *    per day, day counts, relative days ("á hinn morgun", "í morgun"), and a discomfort reader for pain mentions.
 *
 * These only RECOGNIZE intent. Nothing here changes data or bypasses the structured action path: a recognized "shorten"
 * still needs the fresh, shared workout snapshot and the validated action (tools.ts buildSessionAdjustment), and a
 * recognized pain report is not stored anywhere.
 *
 * Icelandic surface forms come from the approved vocabulary (isLexicon.ts); matching uses folded keys (accents dropped,
 * æ/ð/þ kept) on whole tokens — never ASCII \b, never three-letter prefixes.
 */
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { foldIs, IS_VOCAB } from './isLexicon.ts';

/* ------------------------------------------------------------------ tokens */
const L = 'a-z0-9æðþ';
/** Folded word tokens (letters/digits, apostrophes kept inside a word). */
export function tokensOf(text: string): string[] {
  return foldIs(String(text ?? '')).match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? [];
}
const toks = (phrase: string) => tokensOf(phrase);
/** Index where the phrase (token array) starts in `t`, or -1. */
function findPhrase(t: string[], p: string[], from = 0): number {
  if (!p.length) return -1;
  for (let i = from; i + p.length <= t.length; i++) if (p.every((w, k) => t[i + k] === w)) return i;
  return -1;
}
const hasPhrase = (t: string[], p: string[]) => findPhrase(t, p) >= 0;
const anyPhrase = (t: string[], ps: string[][]) => ps.some((p) => hasPhrase(t, p));
const set = (xs: readonly string[]) => new Set(xs.map(foldIs));
/** Folded text with single spaces between tokens, for small regexes with Icelandic-safe boundaries. */
const flat = (t: string[]) => ` ${t.join(' ')} `;

/* ------------------------------------------------------------------ vocabulary (folded) */
const V = IS_VOCAB;
const MEAL_PLAN_TOKENS = set(V.meal_plan.tokens);
const MEAL_PLAN_PHRASES = V.meal_plan.phrases.map(toks);
const PROGRAM_TOKENS = set(V.program.tokens);
const PROGRAM_VERBS = [...V.program.verbs, 'sett saman', 'búið til', 'gert', 'nýja', 'nýtt', 'nýju', 'nýr'].map(toks);
const PROGRAM_NEGATIVE = V.program.negativePhrases.map(toks);
const RECIPE_TOKENS = set(V.recipes.tokens);
const RECIPE_PHRASES = V.recipes.phrases.map(toks);
const SWAP_PHRASES = V.session_swap.phrases.map(toks);
const SWAP_VERBS = V.session_swap.verbs.map(toks);
const SHORTEN_PHRASES = V.session_shorten.phrases.map(toks);
const EXPLAIN_PHRASES = V.explain.phrases.map(toks);
const NUTRITION_TOKENS = set(V.nutrition_protein.tokens);
/** Food and diet words (allergen classes, foods, protein groups, ingredients, diet names): what an explanation may be about. */
const FOOD_TOKENS = (() => {
  const out = new Set<string>();
  const add = (xs: readonly string[]) => xs.forEach((x) => out.add(foldIs(x)));
  for (const g of Object.values(V.allergens_and_restriction_declarations.map)) for (const xs of Object.values(g)) add(xs as readonly string[]);
  for (const g of Object.values(V.allergens_and_restriction_declarations.ambiguous)) add((g as { forms: readonly string[] }).forms);
  for (const xs of Object.values(V.protein_groups_and_common_foods.proteinGroups)) add(xs);
  for (const g of Object.values(V.protein_groups_and_common_foods.broadGroups)) add(g.forms);
  for (const xs of Object.values(V.protein_groups_and_common_foods.ingredientTerms)) add(xs);
  for (const xs of Object.values(V.diet.map)) add(xs);
  return out;
})();
const EN_FOOD = /\b(?:protein|calories?|kcal|carbs?|carbohydrates?|fat|fibre|fiber|vegan|vegetarian|pescatarian|keto|paleo|gluten|lactose|dairy|milk|nuts?|peanuts?|eggs?|fish|shellfish|soy|sesame|mustard|celery|wheat|creatine|macros?|allerg(?:y|ies|ic)|intoleran(?:ce|t))\b/;

/* ------------------------------------------------------------------ number words */
const NUMBER_WORDS: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (const [n, forms] of Object.entries(V.numbers_duration.numbers)) for (const f of forms) if (!f.includes(' ')) m.set(foldIs(f), Number(n));
  const en: [string, number][] = [['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
    ['fifteen', 15], ['twenty', 20], ['thirty', 30], ['forty', 40], ['sixty', 60]];
  for (const [w, n] of en) m.set(w, n);
  return m;
})();
/** "fjörutíu og fimm" style multi-word numbers from the vocabulary. */
const NUMBER_PHRASES: [string[], number][] = Object.entries(V.numbers_duration.numbers)
  .flatMap(([n, forms]) => forms.filter((f) => f.includes(' ')).map((f) => [toks(f), Number(n)] as [string[], number]));

/**
 * A number typed in chat: "62,5" and "62.5" → 62.5; "1,25" → 1.25 (never 125); an unambiguous grouped "1.250,5" → 1250.5.
 * Mixed or ambiguous separators ("1,250.5", "1.2.3") → null rather than guessing.
 */
export function parseChatNumber(raw: string): number | null {
  const s = String(raw ?? '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d+[.,]\d+$/.test(s)) return Number(s.replace(',', '.'));
  if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  return null;
}
const NUM_RE = /\d{1,3}(?:\.\d{3})+,\d+|\d+(?:[.,]\d+)?/g;
/** Every number in the text, decimal comma aware ("Næst er 62,5 kg" → [62.5]). */
export function numbersIn(text: string): number[] {
  return (String(text ?? '').match(NUM_RE) ?? []).map(parseChatNumber).filter((n): n is number => n != null);
}
/** Value of token i as a number (digits, decimal comma, or a number word), with how many tokens it used. */
function numberAt(t: string[], i: number, raw?: string[]): { value: number; len: number } | null {
  for (const [p, n] of NUMBER_PHRASES) if (p.every((w, k) => t[i + k] === w)) return { value: n, len: p.length };
  const w = t[i];
  if (w == null) return null;
  if (/^\d+$/.test(w)) {
    // "1,5" is tokenized as "1" "5": rejoin from the raw text when it was a decimal.
    if (raw && raw[i] != null && /^\d+[.,]\d+$/.test(raw[i])) return { value: parseChatNumber(raw[i])!, len: 1 };
    return { value: Number(w), len: 1 };
  }
  const n = NUMBER_WORDS.get(w);
  return n != null ? { value: n, len: 1 } : null;
}
/** Tokens that keep "1,5" / "62.5" together (for numbers next to units). */
function numericTokens(text: string): string[] {
  return foldIs(String(text ?? '')).match(/\d{1,3}(?:\.\d{3})+,\d+|\d+(?:[.,]\d+)?|[\p{L}]+(?:['’][\p{L}]+)*/gu) ?? [];
}

/* ------------------------------------------------------------------ durations */
const MINUTE_UNITS = new Set([...V.numbers_duration.units.minutes.map((x) => foldIs(x).replace(/\.$/, '')), 'min', 'mins', 'minute', 'minutes', 'minutna']);
const HOUR_UNITS = new Set([...V.numbers_duration.units.hours.map((x) => foldIs(x).replace(/\.$/, '')), 'klukkutima', 'klukkutimi', 'klukkutimar', 'h', 'hr', 'hrs', 'hour', 'hours']);
const DURATION_PHRASES: [string[], number][] = Object.entries(V.numbers_duration.duration)
  .flatMap(([n, forms]) => forms.map((f) => [toks(f), Number(n)] as [string[], number]))
  .sort((a, b) => b[0].length - a[0].length);
const DURATION_EN: [string[], number][] = [[['half', 'an', 'hour'], 30], [['an', 'hour'], 60], [['quarter', 'of', 'an', 'hour'], 15]];

/** Minutes the text states ("korter" 15, "hálftíma" 30, "þrjú korter" 45, "tuttugu mínútur" 20, "1,5 klst." 90), else null. */
export function minutesIn(text: string): number | null {
  const t = numericTokens(text);
  for (let i = 0; i < t.length; i++) {
    for (const [p, n] of [...DURATION_PHRASES, ...DURATION_EN]) if (p.every((w, k) => t[i + k] === w)) return n;
    const num = numberAt(t.map((w) => (/^\d/.test(w) ? w.replace(/[.,].*$/, '') : w)), i, t);
    if (!num) continue;
    const unit = t[i + num.len];
    if (unit && MINUTE_UNITS.has(unit)) return num.value;
    if (unit && HOUR_UNITS.has(unit)) return Math.round(num.value * 60);
  }
  return null;
}

/** An explicit cooking-time cap ("mest 20 mínútur", "hámark tuttugu mínútur", "undir fimmtán mínútum", "under 20 min"). */
export function maxMinutesIn(text: string): number | null {
  const t = tokensOf(text);
  const f = flat(t);
  const cap = /(?: mest | hamark | i mesta lagi | ekki lengur en | ekki meira en | undir | max | at most | under | no more than | up to | tilbuið a )/;
  const m = cap.exec(f);
  if (!m) return null;
  return minutesIn(f.slice(m.index));
}

/** "150 g af próteini", "150 g protein" → 150. */
export function proteinGramsIn(text: string): number | null {
  const m = foldIs(String(text ?? '')).match(/(\d+(?:[.,]\d+)?)\s*(?:g|gr|gramm|gromm|grams?)\s+(?:af\s+|of\s+)?prot[a-z]*/);
  return m ? parseChatNumber(m[1]) : null;
}

/** A load step in kg ("1,25 kg skref", "2.5 kg increments") → 1.25. */
export function incrementKgIn(text: string): number | null {
  const m = foldIs(String(text ?? '')).match(/(\d+(?:[.,]\d+)?)\s*kg\s+(?:skref|hækkun|þrep|steps?|increments?|jumps?)/);
  return m ? parseChatNumber(m[1]) : null;
}

/** "fyrir fjóra daga", "for 4 days" → 4. Not "á dag" (per day). */
export function dayCountIn(text: string): number | null {
  const t = tokensOf(text);
  for (let i = 0; i < t.length; i++) {
    if (!['fyrir', 'for', 'i', 'next'].includes(t[i])) continue;
    const num = numberAt(t, i + 1);
    if (num && /^(?:daga|dag|dogum|days?)$/.test(t[i + 1 + num.len] ?? '')) return num.value;
  }
  return null;
}

/**
 * Meals per day the text asks for: an integer 1–6 ("þrjár máltíðir á dag", "2 meals a day"), `{ invalid }` for a fraction
 * ("2,5 máltíðir") so the coach asks instead of rounding, or null when not stated.
 */
export function mealsPerDayIn(text: string): { value: number } | { invalid: string } | null {
  const f = foldIs(String(text ?? ''));
  const frac = f.match(new RegExp(`(?<![${L}.,])(\\d+[.,]\\d+)\\s+(?:maltið[${L}]*|meals?)(?![${L}])`));
  if (frac) return { invalid: frac[1] };
  // A count in a question ("Why does my meal plan have three meals? Reduce it to two meals a day.") describes what is
  // there, not what is asked for: a count stated outside a question wins.
  const found: { value: number; asked: boolean }[] = [];
  for (const sentence of String(text ?? '').match(/[^.!?\n]+[.!?\n]*/g) ?? []) {
    const t = tokensOf(sentence);
    const asked = /\?/.test(sentence) && CLAUSE_QUESTION.test(t[0] ?? '');
    for (let i = 0; i < t.length; i++) {
      const num = numberAt(t, i);
      if (!num) continue;
      const unit = t[i + num.len] ?? '';
      if (/^(?:maltið(?:ir|um|a|in)?|meals?)$/.test(unit)) found.push({ value: num.value, asked });
    }
  }
  const pick = found.find((x) => !x.asked) ?? found[0];
  if (!pick) return null;
  return pick.value >= 1 && pick.value <= 6 && Number.isInteger(pick.value) ? { value: pick.value } : { invalid: String(pick.value) };
}

/* ------------------------------------------------------------------ relative days */
/**
 * Days from today a relative day word means: "í dag" 0, "í morgun" 0 (earlier today), "á morgun" 1, "á hinn morgun" 2,
 * "í gær" -1 (English today / tomorrow / day after tomorrow / yesterday). "morgunmatur" is breakfast, never a day.
 * Pass the raw text: "á" and "í" are told apart before folding.
 */
export function relativeDayOffset(text: string): number | null {
  const marked = String(text ?? '').replace(/(^|[^\p{L}])á(?=\s)/giu, '$1qqa ').replace(/(^|[^\p{L}])í(?=\s)/giu, '$1qqi ');
  const t = tokensOf(marked);
  const f = flat(t);
  if (/ qqa hinn morgun | eftir tvo daga | day after tomorrow | in two days /.test(f)) return 2;
  if (/ qqa morgun | tomorrow /.test(f)) return 1;
  if (/ qqi gær | yesterday /.test(f)) return -1;
  if (/ qqi morgun | qqi dag | dagurinn qqi dag | today | this morning /.test(f)) return 0;
  return null;
}

/* ------------------------------------------------------------------ request kinds */
export type RequestKind =
  | 'meal_plan' | 'week_adjustment' | 'program' | 'recipes'
  | 'session_shorten' | 'session_swap' | 'explain' | 'program_change' | 'recipe_substitution'
  | 'explain_existing_program' | 'explain_existing_meal_plan' | 'app_navigation' | 'nutrition_explanation' | 'declined';

const EN_MEAL_PLAN = /\bmeal[\s-]?plan|\bplan (my|the|our)?\s*(meals|food|eating)|\bplan meals\b|\bmeals for (the|this|next) week\b/;
const EN_WEEK = /\b(only|just) (train|lift|go|make it)\b.*\b(this week|once|twice|\d+ times?)|\bthis week\b.*\b(only|just|can'?t|cannot|miss|skip|move)\b|\b(move|swap|reschedule)\b.*\b(session|workout|day)\b/;
const EN_PROGRAM = /\b(new|build|make|create|write|design|give me)\b.*\b(program|programme|routine|split|training plan|workout plan)\b|\b(program|programme|routine)\b.*\b(for me|please)\b/;
const EN_RECIPES = /\brecipes?\b|\bmeal ideas?\b|\bwhat (should|can) i (eat|cook|make)\b|\b(breakfast|lunch|dinner|snack) ideas?\b/;
const EN_PROGRAM_NOUN = /\b(program|programme|routine|training plan|workout plan)\b/;

const isMealPlanToken = (w: string) =>
  MEAL_PLAN_TOKENS.has(w) || /^(?:vikumatseð|matseðil|matseðl|matarplan|mataraætlun)/.test(w);
const isProgramToken = (w: string) => PROGRAM_TOKENS.has(w) || /^(?:æfingaaætlun|æfingaplan|æfingaprogramm|programm)/.test(w);
const mealPlanNoun = (t: string[], f: string) => t.some(isMealPlanToken) || anyPhrase(t, MEAL_PLAN_PHRASES) || EN_MEAL_PLAN.test(f);
const programNoun = (t: string[], f: string) => t.some(isProgramToken) || EN_PROGRAM_NOUN.test(f);
const CREATE_VERBS = [...PROGRAM_VERBS, ...['gerðu', 'útbúðu', 'búðu til', 'settu saman', 'skipuleggðu', 'make', 'create', 'build', 'give me', 'write', 'design'].map(toks)];
const hasCreateVerb = (t: string[]) => anyPhrase(t, CREATE_VERBS);
const NEGATORS = new Set(['ekki', 'aldrei', 'not', "don't", 'don’t', 'dont', 'never', "won't", 'won’t', 'no', 'engan', 'enga', 'engin', 'ekkert', 'neinn']);
/**
 * Words of the creation PREDICATE that governs the plan noun: subjects, want/need/make verbs, articles, "new", "me". A
 * negation counts against the request only inside this predicate ("Ekki búa til matseðil", "Ég vil ekki nýja
 * æfingaáætlun", "I don't want a meal plan"); a negation of something else in the sentence ("Ég borða EKKI fisk og vil
 * matseðil", "I don't eat fish and want a meal plan") is a food restriction, not a refusal of the plan.
 */
const PREDICATE_WORDS = new Set([
  ...CREATE_VERBS.flat(),
  ...['ég', 'eg', 'við', 'þu', 'mer', 'mig', 'okkur', 'vil', 'viljum', 'vilja', 'langar', 'þarf', 'þurfum', 'vantar', 'að', 'fa', 'nyjan', 'nyja', 'nytt', 'nyjum', 'nyr',
    'annan', 'aðra', 'neinn', 'neina', 'nein', 'ennþa', 'strax', 'nuna', 'buir', 'gerir', 'gera', 'bua', 'til', 'setja', 'saman',
    'i', "i'd", 'id', 'we', 'you', 'please', 'want', 'need', 'like', 'would', 'to', 'do', 'does', 'a', 'an', 'the', 'my', 'me', 'us', 'new', 'another', 'any', 'yet', 'now',
    'get', 'make', 'create', 'build', 'give', 'write', 'design'].map(foldIs),
]);
/** The plan noun at `at` is negated by its own predicate: walk back over predicate words only. */
function predicateNegated(c: string[], at: number): boolean {
  for (let k = at - 1; k >= 0 && at - k <= 7; k--) {
    if (NEGATORS.has(c[k])) return true;
    if (!PREDICATE_WORDS.has(c[k])) return false;
  }
  return false;
}

/** Clauses of the folded text (split at punctuation and "but"/"en"). */
function clauses(text: string): string[][] {
  return foldIs(String(text ?? ''))
    .split(/[.,;:!?\n]+|(?<![\p{L}])(?:but|en)(?![\p{L}])/u)
    .map((c) => c.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? [])
    .filter((c) => c.length);
}
/** A creation request that is negated in its own predicate: "Ekki búa til matseðil ennþá", "Ég vil ekki nýja æfingaáætlun". */
function negatedCreate(text: string, noun: (w: string) => boolean, enNoun: RegExp): boolean {
  let negated = false;
  for (const c of clauses(text)) {
    const at = c.findIndex((w, i) => noun(w) || enNoun.test(c.slice(i, i + 3).join(' ')));
    if (at < 0) continue;
    if (predicateNegated(c, at)) negated = true;
    else return false; // a positive clause asks for it after all
  }
  return negated;
}

const SWAP_FOOD = (t: string[]) => t.some((w) => FOOD_TOKENS.has(w) || /^(?:kjukling|tofu|lax|fisk|nautakjot|svinakjot|kjot|ost|hrisgrjon|pasta)/.test(w));
const EQUIPMENT = /^(?:bekk|tæki|stong|stang|rekk|handloð|loð|buna|velin$|kapal|allt$)/;
const BUSY = /^(?:upptekin|upptekinn|upptekið|uppteknir|upptekna|upptekn|laus|laust|lausir|lausar|bilað|biluð|bilaður)$/;
const PERMANENT = [['i', 'aætluninni'], ['framvegis'], ['alltaf'], ['i', 'programminu'], ['permanently'], ['from', 'now', 'on'], ['in', 'my', 'program']];
/** Equipment-busy phrases from the vocabulary ("tækið er upptekið", "ég hef ekki þetta tæki"); "aðeins í dag" is scope, not a swap. */
const EQUIPMENT_PHRASES = SWAP_PHRASES.filter((p) => p.some((w) => /upptek|tæki|laus|bilað|handloð/.test(w)));
/** Shorten phrases; "bara þessa æfingu" / "ekki breyta áætluninni" only scope a change. */
const SHORTEN_ONLY = SHORTEN_PHRASES.filter((p) => !hasPhrase(p, ['bara', 'þessa', 'æfingu']) && !hasPhrase(p, ['ekki', 'breyta']));

/** Today's-workout requests (Icelandic, plus the common English phrasings). Null when it isn't one. */
function sessionKind(t: string[], f: string): RequestKind | null {
  const swapVerb = anyPhrase(t, SWAP_VERBS) || /(?: skipt[a-z]* (?:ut|um) )/.test(f);
  const exerciseObj = t.some((w) => /^æfing/.test(w) || /pressu$|pressa$|lyftu$/.test(w));
  if (swapVerb && exerciseObj && PERMANENT.some((p) => hasPhrase(t, p))) return 'program_change';
  if (swapVerb && !exerciseObj && SWAP_FOOD(t)) return 'recipe_substitution';
  // "Bekkurinn er upptekinn", "engin laus lóð": the EQUIPMENT is busy. A busy person ("ég er upptekinn") is not.
  const equipmentBusy = t.some((w, i) => BUSY.test(w) && t.slice(Math.max(0, i - 3), i + 3).some((x) => EQUIPMENT.test(x)));
  const instead = hasPhrase(t, ['i', 'staðinn']) && (exerciseObj || t.some((w) => /^(?:gera|geri|gert|nota|handloð)$/.test(w)));
  const alternative = t.some((w) => /^valkost/.test(w)) && !SWAP_FOOD(t);
  if (equipmentBusy || (swapVerb && exerciseObj) || instead || alternative || anyPhrase(t, EQUIPMENT_PHRASES) ||
    /\b(?:equipment|bench|rack|machine|station) (?:is )?(?:taken|busy|occupied)\b/.test(f)) return 'session_swap';
  const notShorten = hasPhrase(t, ['ekki', 'stytta']) || /\bdon'?t shorten\b/.test(f);
  if (!notShorten) {
    if (t.some((w) => /^stytt/.test(w)) || /\bshorten\b|\bshort on time\b|\bin a hurry\b/.test(f)) return 'session_shorten';
    if (anyPhrase(t, SHORTEN_ONLY)) return 'session_shorten';
    const hasTime = t.some((w) => w === 'hef' || w === 'have' || w === 'got');
    if (hasTime && (t.includes('eftir') || t.includes('left')) && minutesIn(f) != null) return 'session_shorten';
    if (hasTime && /(?: litinn | stuttan | nauman | knappan )tima /.test(f)) return 'session_shorten';
  }
  return null;
}

const QUESTION_START = /^ (?:hvað|hvar|hvernig|hvenær|af hverju|hvers vegna|getur|geturðu|what|where|why|how|when|can|could|is|are|does|do) /;
/** A question that READS something (not a polite request like "Could you do my meal plan?" / "Geturðu …?"): it opens with
 *  a question word or an inverted copula/auxiliary. Icelandic "er/eru" only with the "?": "Er með hnetuofnæmi" is a
 *  declaration with the subject dropped ("Er matseðillinn minn vegan? Ekki breyta matseðlinum." is a question). */
const asksQuestion = (text: string, f: string) =>
  /^ (?:hvað|hvaða|hvar|hvernig|hvenær|af hverju|hvers vegna|inniheldur|what|what's|whats|which|where|why|how|when|is|are|does|did|has) /.test(f) ||
  (/^ (?:er|eru) /.test(f) && /\?/.test(String(text ?? '')));
/** Interrogative words anywhere in the message ("Segðu mér HVERSU mikið prótein er í matseðlinum mínum", "how many
 *  calories are in my meal plan"). */
const QUESTION_WORDS = new Set(['hvað', 'hvaða', 'hvar', 'hvernig', 'hvenær', 'hversu', 'hve', 'hver', 'hverjir', 'hverjar', 'hvert', 'hverju', 'hverja', 'hvers',
  'hvort', 'hvor', 'what', "what's", 'whats', 'which', 'where', "where's", 'why', 'how', 'when', 'who', 'whether'].map(foldIs));
/** Polite request openers: "Could you do my meal plan?" / "Geturðu …?" asks for something, it isn't a question about it. */
const POLITE_OPENER = /^ (?:can|could|would|will|geturðu|getur|gætirðu|gætir|viltu|vilt|mættirðu|please|vinsamlegast) /;
/** A question about something: a question word anywhere, an inverted copula/auxiliary at the start, or a "?" (in any
 *  sentence) in a message that does not open as a polite request. */
const isQuestion = (text: string, t: string[], f: string) =>
  asksQuestion(text, f) || t.some((w) => QUESTION_WORDS.has(w)) || (/\?/.test(String(text ?? '')) && !POLITE_OPENER.test(f));
/** The user's own, existing plan: a possessive ("minn", "my") or the definite noun ("matseðillinn", "æfingaáætlunina"). */
const OWN = new Set(['minn', 'min', 'mitt', 'minum', 'minni', 'mina', 'minnar', 'mins', 'okkar', 'nuverandi', 'my', 'our', 'current']);
const DEFINITE_PLAN = /^(?:vikumatseð|matseð|matarplan|mataraætlun|æfingaaætlun|æfingaplan|æfingaprogramm|programm)[a-zæðþ]*(?:inn|inum|ins|sins|ið|inu|ina|inni|innar)$/;
const PLAN_WORD_EN = /^(?:plan|meal|meals|program|programme|routine|split)$/;
const planWord = (w: string) => isMealPlanToken(w) || isProgramToken(w) || PLAN_WORD_EN.test(w);
/** A possessive counts only next to a plan word ("my meal plan", "matseðlinum mínum", "my current plan"): "Meal plan for
 *  next week. What do you recommend for MY peanut allergy?" is about the allergy, not about an existing plan. */
const ownPlan = (t: string[]) => t.some((w, i) => DEFINITE_PLAN.test(w) || (OWN.has(w) && t.slice(Math.max(0, i - 3), i + 4).some(planWord)));
/**
 * An AFFIRMATIVE request to edit (create, change, reduce, …) something, in at least one clause: an imperative ("Reduce it to
 * two meals a day", "Breyttu matseðlinum mínum", "Change it to …"), a polite request ("Can you change my meal plan?",
 * "Geturðu breytt …?") or a stated wish ("I want to swap …", "Ég vil breyta …"). Not one: a question about a change ("Why did
 * you change my meal plan?", "Af hverju …?"), a past-tense mention ("You changed it", "ég breytti …"), a noun ("no
 * changes", "breytingar"), or a negated verb ("Do not change anything", "Don't change it", "Ekki breyta áætluninni").
 */
const EDIT_EN = new Set(['change', 'update', 'replace', 'redo', 'regenerate', 'swap', 'switch', 'fix', 'adjust', 'tweak', 'edit', 'make', 'create', 'build', 'rebuild',
  'reduce', 'increase', 'decrease', 'lower', 'raise', 'add', 'remove', 'drop', 'cut', 'limit', 'shorten', 'redesign', 'rework', 'modify', 'revise']);
/** Icelandic change verbs (stems); "breytti" (past, "ég breytti stillingunum") and the noun "breyting…" are no request. */
const EDIT_IS = /^(?:breyt|uppfær|endurgerð|endurger|lagaðu$|laga$|skiptu$|skipta$)/;
const isEditVerb = (w: string) => EDIT_EN.has(w) || (EDIT_IS.test(w) && !/^breyting/.test(w) && w !== 'breytti' && !/^breytt(?:ir|irðu|ist|ust)$/.test(w));
const CLAUSE_QUESTION = /^(?:why|what|whats|what's|how|when|where|which|who|did|didn't|do|does|is|are|was|were|has|have|had|hvað|hvaða|hvar|hvernig|hvenær|hversu|hvers|af|er|eru|var|voru)$/;
/** Words that may stand before an edit verb in a request: subjects, polite openers, want/need verbs, "please", fillers. */
const REQUEST_LEAD = new Set([...PREDICATE_WORDS, ...['can', 'could', 'will', 'just', 'also', 'then', 'and', 'so', 'now', 'kindly', 'maybe', 'instead', "let's", 'let’s', 'lets',
  'geturðu', 'getur', 'gætirðu', 'gætir', 'viltu', 'vilt', 'vinsamlegast', 'bara', 'og', 'þa', 'lika', 'please'].map(foldIs)]);
export function editRequested(text: string): boolean {
  for (const raw of clauses(text)) {
    let c = raw;
    while (c.length && /^(?:and|so|then|also|og|þa|ok|okay)$/.test(c[0])) c = c.slice(1);
    if (!c.length) continue;
    // "Why did you change …?", "Hvað …?", "Af hverju …?": a question about it, not a request.
    if (CLAUSE_QUESTION.test(c[0]) && !(c[0] === 'af' && c[1] !== 'hverju') && !(c[0] === 'hvers' && c[1] !== 'vegna')) continue;
    for (let v = 0; v < c.length; v++) {
      if (!isEditVerb(c[v])) continue;
      // Only request words (and no negation) may stand before the verb: "Do NOT change", "Ekki breyta", "please reduce".
      let ok = true;
      for (let k = v - 1; k >= 0; k--) {
        if (NEGATORS.has(c[k]) || /^(?:never|nothing|don't|don’t|dont|doesn't|doesn’t|aldrei)$/.test(c[k])) { ok = false; break; }
        if (!REQUEST_LEAD.has(c[k])) { ok = false; break; }
      }
      if (ok) return true;
    }
  }
  return false;
}
const EXPLAIN = (t: string[], f: string) =>
  anyPhrase(t, EXPLAIN_PHRASES) || / (?:af hverju|hvers vegna|utskyrðu|utskyra|hvað þyðir) /.test(f) || /\b(?:why|explain)\b/.test(f);

/**
 * The kind of request a message makes (null: none of these). Meal plans first (a meal-plan request that also mentions
 * recipes is a meal plan); then today's workout, this week's schedule, a new program and recipes; then explanations.
 * Questions about something that already exists ("Hvar finn ég matseðilinn minn?", "Af hverju er æfingaáætlunin mín
 * svona?") and negated requests ("Ekki búa til matseðil ennþá") are never requests to create or replace it.
 */
export function classifyRequest(text: string): RequestKind | null {
  const t = tokensOf(text);
  if (!t.length) return null;
  const f = flat(t);
  const create = hasCreateVerb(t);
  const mealNoun = mealPlanNoun(t, f);
  const progNoun = programNoun(t, f);

  // Questions about what already exists.
  if ((mealNoun || progNoun) && !create) {
    if (/^ (?:hvar|where) /.test(f) || / (?:hvar finn|hvernig finn|how do i find|where do i find|where is|where's) /.test(f)) return 'app_navigation';
    // "Why does my meal plan have three meals? Reduce it to two meals a day.": a question AND an affirmative edit request
    // in another clause — a request for the (changed) meal plan, not only a question about it.
    const editMeal = mealNoun && !progNoun && editRequested(text);
    if (!editMeal && (EXPLAIN(t, f) || anyPhrase(t, PROGRAM_NEGATIVE.filter((p) => !p.includes('ekki'))))) return mealNoun && !progNoun ? 'explain_existing_meal_plan' : 'explain_existing_program';
    // "Er matseðillinn minn vegan?", "Is my meal plan vegan?", "Hversu mikið prótein er í matseðlinum mínum?", "How many
    // calories are in my meal plan?": a question about the user's OWN plan (possessive or definite form, any case) reads
    // it; it never creates or replaces one. Only an explicit create/change verb does ("Geturðu breytt matseðlinum mínum?").
    if (isQuestion(text, t, f) && ownPlan(t) && !editRequested(text)) return mealNoun && !progNoun ? 'explain_existing_meal_plan' : 'explain_existing_program';
  }
  // Negated creation.
  if (mealNoun && negatedCreate(text, isMealPlanToken, EN_MEAL_PLAN)) return 'declined';
  if (progNoun && (negatedCreate(text, isProgramToken, EN_PROGRAM_NOUN) || anyPhrase(t, PROGRAM_NEGATIVE.filter((p) => p.includes('ekki'))))) return 'declined';

  if (mealNoun) return 'meal_plan';

  const session = sessionKind(t, f);
  if (session === 'program_change' || session === 'recipe_substitution' || session === 'session_swap') return session;

  // This week's schedule (before a program: "breyta æfingadögunum í vikunni" is this week, not a new plan).
  const weekIs =
    / (?:get|getum|næ|kemst) (?:bara|aðeins|ekki) /.test(f) && t.some((w) => /^(?:æft|æfa|æfingu|æfingar|æfingum|æfinguna)$/.test(w)) ||
    t.some((w) => /^(?:færðu|færa|færum|flyttu|flytja)$/.test(w)) && t.some((w) => /^æfing/.test(w)) ||
    t.some((w) => /^(?:breyta|breytt|breyttu|breytum)$/.test(w)) && t.some((w) => /^(?:æfingadag|æfingadog|vikun|vikuna)/.test(w)) ||
    / (?:skiptu|skipta|skiptum) um æfingadag/.test(f) ||
    t.some((w) => /^(?:sleppum|sleppa|slepptu)$/.test(w)) && t.some((w) => /^æfing/.test(w)) ||
    / breyttu vikunni /.test(f);
  if (EN_WEEK.test(f) || weekIs) return 'week_adjustment';
  if (session === 'session_shorten') return session;

  if (EN_PROGRAM.test(f) || (progNoun && create)) return 'program';

  const recipes =
    t.some((w) => RECIPE_TOKENS.has(w) || /^uppskrift/.test(w)) || anyPhrase(t, RECIPE_PHRASES) ||
    / hvað (?:get|a|ætti|aetti) eg (?:að )?(?:borða|borðað|elda|eldað|buið til|bua til) / .test(f) ||
    / hugmynd(?:ir)? að / .test(f) || / eitthvað i (?:kvoldmat|hadegismat|morgunmat) /.test(f) || EN_RECIPES.test(f);
  if (recipes) return 'recipes';

  // Questions about food, diets or nutrients: explanations, never preference changes or searches.
  const aboutFood = t.some((w) => FOOD_TOKENS.has(w) || NUTRITION_TOKENS.has(w)) || EN_FOOD.test(f);
  const question = QUESTION_START.test(f) || / (?:hvað (?:er|eru|þyðir)|þyðir|segðu mer|hversu mikið|what (?:is|are|does)|what's|how much|mean) /.test(f) || /\?\s*$/.test(String(text));
  if (aboutFood && question && !create) return 'nutrition_explanation';

  if (EXPLAIN(t, f)) return 'explain';
  return null;
}

/**
 * The message only ASKS about the user's existing meal plan or program ("Hversu mikið prótein er í matseðlinum mínum?",
 * "How much protein is in my meal plan?", "Af hverju er æfingaáætlunin mín svona?") and asks for no change to it: a tool
 * proposal (propose_meal_plan / propose_program_change) must not create or replace one then. An affirmative edit request
 * in any clause ("… Reduce it to two meals a day.", "Breyttu matseðlinum mínum") makes it a request again (null); a
 * question about a change ("Why did you change my meal plan?") or a negated one ("Do not change anything") does not.
 */
export function asksAboutExistingPlan(text: string): 'meal_plan' | 'program' | null {
  const kind = classifyRequest(text);
  if (kind !== 'explain_existing_meal_plan' && kind !== 'explain_existing_program') return null;
  // Only an AFFIRMATIVE edit request lifts the guard: "Why did you change my meal plan?" and "… Do not change anything."
  // stay questions.
  if (editRequested(text)) return null;
  return kind === 'explain_existing_meal_plan' ? 'meal_plan' : 'program';
}

/** The minutes a today's-workout request states (null: not stated — ask, never invent). */
export function sessionMinutes(text: string): number | null {
  return minutesIn(text);
}

/* ------------------------------------------------------------------ discomfort */
export type BodyArea = 'knee' | 'shoulder' | 'lower_back' | 'back' | 'hip' | 'groin' | 'wrist' | 'elbow' | 'ankle' | 'neck' | 'chest';
const AREA: [RegExp, BodyArea][] = [
  [/^(?:mjobak|lower)/, 'lower_back'], [/^(?:oxl|axl|shoulder)/, 'shoulder'], [/^(?:hne|knee)/, 'knee'], [/^(?:bak|back)/, 'back'], [/^(?:mjoðm|hip)/, 'hip'],
  [/^(?:nar|groin)/, 'groin'], [/^(?:ulnlið|wrist)/, 'wrist'], [/^(?:olnbog|elbow)/, 'elbow'], [/^(?:okkl|ankle)/, 'ankle'], [/^(?:hals|neck)/, 'neck'],
  [/^(?:brjost|chest)/, 'chest'],
];
const PAIN_TOKENS = set([...V.pain_discomfort.tokens, 'aum', 'aumur', 'aumt', 'auma', 'aumir', 'pain', 'painful', 'hurts', 'hurt', 'sore', 'injured', 'injury', 'ache', 'aches', 'aching']);
const PAIN_PHRASES = V.pain_discomfort.phrases.map(toks);
const PAIN_NEGATIVE = V.pain_discomfort.negativePhrases.map(toks);
const BODY = set(V.pain_discomfort.bodyParts);
const areaOf = (w: string): BodyArea | null => (BODY.has(w) || /^(?:mjobak|oxl|axl|hne|bak|mjoðm|nar|ulnlið|olnbog|okkl|hals|brjost)/.test(w) || /^(?:knee|shoulder|back|hip|wrist|elbow|ankle|neck|chest|groin)s?$/.test(w)
  ? AREA.find(([re]) => re.test(w))?.[1] ?? null
  : null);
const isPain = (w: string) => PAIN_TOKENS.has(w) || /(?:verk|verkur|verki|verkir|verkjum)$/.test(w) && w.length > 5;

export interface DiscomfortReading {
  mentioned: boolean;
  /** The area with current discomfort (a negated area is never reported). */
  area: BodyArea | null;
  /** Chest pain/pressure, dizziness, feeling unwell with pain: stop and get help, no workout. */
  safetyEscalation: boolean;
}

/** Current pain or discomfort the message reports, clause by clause ("Engir verkir í hnénu, en öxlin er aum" → shoulder). */
export function discomfortIn(text: string): DiscomfortReading {
  let area: BodyArea | null = null;
  let mentioned = false;
  let escalate = false;
  for (const c of clauses(text)) {
    if (anyPhrase(c, PAIN_NEGATIVE)) continue;
    const at = c.findIndex((w) => isPain(w));
    const phrase = anyPhrase(c, PAIN_PHRASES);
    if (at < 0 && !phrase) continue;
    // "ekki með verki", "no pain": negated in its own clause.
    if (at >= 0 && c.slice(Math.max(0, at - 3), at).some((w) => /^(?:ekki|engin|enginn|engir|ekkert|no|not|without|zero)$/.test(w))) continue;
    mentioned = true;
    const fromCompound = at >= 0 ? areaOf(c[at].replace(/(?:verkur|verkir|verkjum|verki|verk)$/, '')) : null;
    const a = fromCompound ?? c.map(areaOf).find((x): x is BodyArea => !!x) ?? null;
    area ??= a;
    if (a === 'chest' || c.some((w) => /^(?:svim|ogleð|dizzy|faint)/.test(w)) || hasPhrase(c, ['þrystingur', 'i', 'brjosti'])) escalate = true;
  }
  if (mentioned && / liður illa | feel unwell | feel sick /.test(flat(tokensOf(text))) && area === 'chest') escalate = true;
  return { mentioned, area, safetyEscalation: escalate };
}
