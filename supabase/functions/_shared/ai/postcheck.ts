/**
 * Checks on the model's final text when the reply carries an action (pure).
 * The card is the single source of truth: if the text names sessions/meals with days that disagree with the validated
 * action (e.g. "Full body on Sun" while the card skips Full body), the reply is replaced by a generated one-line
 * summary of the action. Also detects replies that write out a whole recipe (the coach should link it instead).
 */
import type { MealPlanAction, RecipeSuggestionsAction, WeekAdjustmentAction } from './types.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { humanDate, shortDate } from './humanDates.ts';
import type { Lang } from './lang.ts';
// @ts-ignore see above
import { foldIs, IS_VOCAB } from './isLexicon.ts';
// @ts-ignore see above
import { listText, sharedT } from '../i18n/core.ts';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const wdOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

export interface ProposalSummaryInput {
  name: string;
  sessionsPerWeek: number;
  target: 'apply' | 'for_coach_review';
  schedule: { weekday: number; name: string }[];
  invalid: boolean;
}

/* ------------------------------------------------------------------ one-line summaries */
// Deterministic copy in the reply language (aiServer.* in i18n/messages.*): button names match the app's labels in that
// language. Names (sessions, plans, recipes) are inserted unchanged. Validator warnings are already in the reply language.
const names = (xs: string[], lang: Lang) => (lang === 'is' ? listText(xs, 'is') : xs.join(' and '));

export function summarizeWeekPlan(a: WeekAdjustmentAction, today: string, weekStart: 0 | 1 = 1, lang: Lang = 'en'): string {
  const { t, tp } = sharedT(lang);
  const parts = a.sessions.map((s) => t(s.date === s.plannedDate ? 'aiServer.week.stays' : 'aiServer.week.moves', { name: s.name, date: humanDate(s.date, today, weekStart, lang) }));
  const skipped = a.skipped.map((s) => `**${s.name}**`);
  const body = [...parts, ...(skipped.length ? [tp('aiServer.week.skipped', skipped.length, { names: names(skipped, lang) })] : [])];
  const head = body.length ? t('aiServer.week.body', { changes: body.join(', ') }) : t('aiServer.week.allDone');
  const note = a.warnings[0] ? ` ${a.warnings[0]}` : '';
  return `${head}${note} ${t('aiServer.week.apply')}`;
}

export function summarizeMealPlan(a: MealPlanAction, today: string, weekStart: 0 | 1 = 1, lang: Lang = 'en'): string {
  const { t, tp } = sharedT(lang);
  const first = a.days[0]?.date;
  const last = a.days[a.days.length - 1]?.date;
  // A range takes display dates in Icelandic ("mán. 2. nóv. til mið. 4. nóv."; "frá á morgun" doesn't work).
  const label = (iso: string) => (lang === 'is' ? shortDate(iso, 'is') : humanDate(iso, today, weekStart));
  const span = first && last && first !== last
    ? t('aiServer.mealPlan.dateRange', { start: label(first), end: label(last) })
    : first ? humanDate(first, today, weekStart, lang) : t('aiServer.mealPlan.thisWeek');
  const adj = a.warnings[0] ? ` ${a.warnings[0]}` : '';
  return `${tp('aiServer.mealPlan.summary', a.days.length, { span })}${adj}`;
}

export function summarizeRecipes(a: RecipeSuggestionsAction, lang: Lang = 'en'): string {
  return sharedT(lang).tp('aiServer.recipes', a.recipes.length);
}

export function summarizeProposal(p: ProposalSummaryInput, lang: Lang = 'en'): string {
  const { t, tp } = sharedT(lang);
  if (p.invalid) return t('aiServer.proposal.invalid');
  const plan = tp('aiServer.proposal.schedule', p.sessionsPerWeek, { name: p.name });
  return t(p.target === 'for_coach_review' ? 'aiServer.proposal.coachReview' : 'aiServer.proposal.addReview', { plan });
}

/* ------------------------------------------------------------------ conflict detection */
interface DayToken { at: number; weekdays: number[] }

// Icelandic weekday names as WHOLE tokens (every case form in the approved vocabulary, plus the dative "-degi"), so
// "sunnudagssteik" or "laugardagsnammi" is never a day; and "í dag" / "á morgun" / "á hinn morgun" (folded).
const IS_DAY_RE = (() => {
  const forms: [string, number][] = [];
  Object.values(IS_VOCAB.weekdays.map).forEach((list, k) => {
    const wd = (k + 1) % 7; // monday … sunday → 1 … 0
    for (const f of list) if (!f.endsWith('.')) forms.push([foldIs(f), wd]);
    const stem = foldIs(list[1]).replace(/ag$/, '');
    forms.push([`${stem}egi`, wd], [`${stem}eginum`, wd]);
  });
  forms.sort((a, b) => b[0].length - a[0].length);
  return { re: new RegExp(`(?<![a-zæðþ])(${forms.map(([f]) => f).join('|')}|a hinn morgun|a morgun|i dag)(?![a-zæðþ])`, 'g'), day: new Map(forms) };
})();
/** English day words, whole tokens only: "fries", "satay", "monkfish", "sundae" and "thus" are not days. */
const EN_DAY_RE = /\b(today|tomorrow|mon(?:days?)?|tue(?:s|sdays?)?|wed(?:nesdays?)?|thu(?:rs?|rsdays?)?|fri(?:days?)?|sat(?:urdays?)?|sun(?:days?)?)\.?(?![a-z])|\b(\d{4}-\d{2}-\d{2})\b/g;

function dayTokens(seg: string, today: string): DayToken[] {
  const out: DayToken[] = [];
  let m: RegExpExecArray | null;
  EN_DAY_RE.lastIndex = 0;
  while ((m = EN_DAY_RE.exec(seg))) {
    let wd: number | null = null;
    if (m[1] === 'today') wd = wdOf(today);
    else if (m[1] === 'tomorrow') wd = (wdOf(today) + 1) % 7;
    else if (m[1]) wd = WEEKDAYS.indexOf(m[1].slice(0, 3));
    else if (m[2]) wd = wdOf(m[2]);
    if (wd != null && wd >= 0) out.push({ at: m.index, weekdays: [wd] });
  }
  IS_DAY_RE.re.lastIndex = 0;
  while ((m = IS_DAY_RE.re.exec(seg))) {
    const w = m[1];
    const wd = w === 'i dag' ? wdOf(today) : w === 'a morgun' ? (wdOf(today) + 1) % 7 : w === 'a hinn morgun' ? (wdOf(today) + 2) % 7 : IS_DAY_RE.day.get(w)!;
    out.push({ at: m.index, weekdays: [wd] });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Pairs each mentioned name with the first day after it (before the next name), else the nearest day before it. */
function namedDays(seg: string, names: string[], today: string): { name: string; weekday: number | null; text: string }[] {
  const f = fold(seg);
  const hits: { name: string; at: number }[] = [];
  for (const n of names) {
    const fn = fold(n);
    if (fn.length < 3) continue;
    let i = f.indexOf(fn);
    while (i >= 0) {
      hits.push({ name: n, at: i });
      i = f.indexOf(fn, i + fn.length);
    }
  }
  // longer names win when one contains another ("Full body B" vs "Full body")
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.name.length > h.name.length && o.at <= h.at && o.at + o.name.length >= h.at + h.name.length));
  kept.sort((a, b) => a.at - b.at);
  const days = dayTokens(f, today);
  return kept.map((h, k) => {
    const nextAt = kept[k + 1]?.at ?? Infinity;
    const after = days.find((d) => d.at > h.at && d.at < nextAt);
    const before = [...days].reverse().find((d) => d.at < h.at && (k === 0 || d.at > kept[k - 1].at));
    return { name: h.name, weekday: (after ?? before)?.weekdays[0] ?? null, text: f.slice(h.at, Math.min(nextAt, f.length)) };
  });
}

const segments = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
// English, and the Icelandic skip words of the approved vocabulary ("sleppa", "fellur niður", "hvíldardagur", "í staðinn"), folded.
const SKIP_WORDS = new RegExp(
  `\\b(skip|skipped|skipping|drop|dropped|miss|missed|instead|rest|off|not)\\b|(?<![a-zæðþ])(?:${IS_VOCAB.postprocessing.skipWords.map(foldIs).sort((a, b) => b.length - a.length).join('|')})(?![a-zæðþ])`,
);

/** Reason the reply contradicts the week plan, or null. */
export function weekPlanConflict(reply: string, a: WeekAdjustmentAction, today: string): string | null {
  const names = [...new Set([...a.sessions.map((s) => s.name), ...a.skipped.map((s) => s.name)])];
  for (const seg of segments(reply)) {
    for (const h of namedDays(seg, names, today)) {
      if (h.weekday == null) continue;
      const planned = a.sessions.filter((s) => s.name === h.name).map((s) => wdOf(s.date));
      const skipped = a.skipped.some((s) => s.name === h.name);
      if (planned.length && !planned.includes(h.weekday) && !SKIP_WORDS.test(h.text)) return `${h.name} is on another day in the plan`;
      if (!planned.length && skipped && !SKIP_WORDS.test(h.text)) return `${h.name} is skipped in the plan`;
    }
  }
  return null;
}

/** Reason the reply contradicts (or restates) the meal plan, or null. */
export function mealPlanConflict(reply: string, a: MealPlanAction, catalogNames: string[]): string | null {
  const inPlan = new Set(a.days.flatMap((d) => d.items.map((i) => fold(i.name))));
  const f = fold(reply);
  const other = catalogNames.find((n) => n.length > 5 && !inPlan.has(fold(n)) && f.includes(fold(n)));
  if (other) return `mentions ${other}, which isn't in the plan`;
  const listLines = reply.split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length;
  if (listLines >= 3) return 'restates the plan as a list';
  return null;
}

/** Reason the reply contradicts the proposed program's weekly schedule, or null. */
export function proposalConflict(reply: string, p: ProposalSummaryInput, today: string): string | null {
  const names = [...new Set(p.schedule.map((s) => s.name))];
  for (const seg of segments(reply)) {
    for (const h of namedDays(seg, names, today)) {
      if (h.weekday == null) continue;
      const days = p.schedule.filter((s) => s.name === h.name).map((s) => s.weekday);
      if (days.length && !days.includes(h.weekday)) return `${h.name} is on another day in the proposal`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ full recipes in chat */
// English units, and the Icelandic ones of the approved vocabulary ("2 dl", "1 tsk.", "3 geirar", "2 sneiðar").
const QTY = new RegExp(
  `(?<![\\p{L}\\p{N}])\\d+(?:[.,]\\d+)?\\s*(?:tbsp|tsp|cups?|oz|tablespoons?|teaspoons?|cloves?|slices?|${[...IS_VOCAB.postprocessing.quantityUnits].sort((a, b) => b.length - a.length).map((u) => u.replace('.', '\\.')).join('|')})(?![\\p{L}])`,
  'iu',
);
const RECIPE_HEADING = new RegExp(`^\\s*(?:#+\\s*)?\\**\\s*(ingredients|method|instructions|directions|steps|${IS_VOCAB.postprocessing.recipeHeadings.join('|')})\\s*\\**:?\\s*\\**\\s*$`, 'iu');
/** True when the text writes out a recipe (ingredient list with quantities, or an Ingredients/Method section). */
export function looksLikeFullRecipe(text: string): boolean {
  const lines = String(text ?? '').split('\n');
  const heading = lines.some((l) => RECIPE_HEADING.test(l));
  const qtyLines = lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l) && QTY.test(l)).length;
  return heading || qtyLines >= 3;
}

