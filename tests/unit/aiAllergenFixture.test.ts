/**
 * Independently specified allergen fixture (PR 1b, ChatGPT P3). The safety net in aiCorrectness.test.ts checks every
 * corpus row against allergenMentions(), which shares its word list with the parser, so a word missing from that list
 * was invisible to both. These tables are written from the allergen definitions and the ingredient catalog, NOT from
 * the parser's dictionaries:
 *  A. words that name an allergen class (EN + IS) → allergenMentions() must report that allergen;
 *  B. specific foods (EN + IS) → "no X" must rule out the catalog ingredients listed by hand (by id), whether the parser
 *     treats X as its allergen class or as a food word.
 */
import { describe, expect, it } from 'vitest';
import { allergenMentions, excludedIngredientIds, parseQuery } from '../../supabase/functions/_shared/ai/meals';
import { INGREDIENTS } from '@/data/ingredients';
import type { Allergen } from '@/domain/types';
import type { RefIngredient } from '../../supabase/functions/_shared/ai/types';

const CLASS_WORDS: [string, Allergen][] = [
  ['fish', 'fish'], ['seafood', 'fish'], ['seafood', 'shellfish'], ['shellfish', 'shellfish'], ['crustaceans', 'shellfish'], ['molluscs', 'shellfish'],
  ['dairy', 'milk'], ['milk', 'milk'], ['lactose', 'milk'], ['eggs', 'egg'], ['egg', 'egg'], ['peanuts', 'peanuts'], ['peanut', 'peanuts'],
  ['tree nuts', 'tree_nuts'], ['nuts', 'tree_nuts'], ['gluten', 'gluten'], ['wheat', 'wheat'], ['soy', 'soy'], ['soya', 'soy'],
  ['sesame', 'sesame'], ['sesame seeds', 'sesame'], ['mustard', 'mustard'], ['celery', 'celery'],
  // Icelandic
  ['fisk', 'fish'], ['fiski', 'fish'], ['sjávarfang', 'fish'], ['skelfisk', 'shellfish'], ['mjólk', 'milk'], ['mjólkurvörur', 'milk'], ['laktósa', 'milk'],
  ['egg', 'egg'], ['eggjum', 'egg'], ['jarðhnetur', 'peanuts'], ['hnetur', 'tree_nuts'], ['trjáhnetur', 'tree_nuts'], ['glúten', 'gluten'],
  ['hveiti', 'wheat'], ['soja', 'soy'], ['sesam', 'sesame'], ['sinnep', 'mustard'], ['sellerí', 'celery'],
];

const FOODS: [string, string[]][] = [
  ['salmon', ['salmon-raw', 'smoked-salmon']], ['lax', ['salmon-raw', 'smoked-salmon']],
  ['cod', ['cod-raw']], ['þorsk', ['cod-raw']], ['tuna', ['tuna-canned']], ['túnfisk', ['tuna-canned']],
  ['haddock', ['haddock-raw']], ['ýsu', ['haddock-raw']], ['mackerel', ['mackerel-canned']], ['makríl', ['mackerel-canned']],
  ['sardines', ['sardines-canned']], ['pollock', ['saithe-raw']], ['ufsa', ['saithe-raw']],
  ['prawns', ['shrimp-cooked']], ['shrimp', ['shrimp-cooked']], ['rækjur', ['shrimp-cooked']],
  ['mussels', ['mussels-cooked']], ['krækling', ['mussels-cooked']], ['squid', ['squid-raw']], ['smokkfisk', ['squid-raw']],
  ['cheese', ['gouda', 'feta', 'cottage-cheese', 'mozzarella-light', 'parmesan']], ['ost', ['gouda', 'feta', 'cottage-cheese', 'mozzarella-light', 'parmesan']],
  ['butter', ['butter']], ['smjör', ['butter']], ['yogurt', ['greek-yogurt-0']], ['skyr', ['skyr-plain']], ['ricotta', ['ricotta']],
  ['whey', ['whey-protein']], ['mysuprótein', ['whey-protein']],
  ['almonds', ['almonds']], ['möndlur', ['almonds']], ['walnuts', ['walnuts']], ['valhnetur', ['walnuts']], ['cashews', ['cashews']], ['kasjúhnetur', ['cashews']],
  ['peanut butter', ['peanut-butter']], ['hnetusmjör', ['peanut-butter']],
  ['tofu', ['tofu-firm']], ['tempeh', ['tempeh']], ['edamame', ['edamame']], ['soy sauce', ['soy-sauce']], ['sojasósu', ['soy-sauce']],
  ['tahini', ['tahini']], ['hummus', ['hummus']],
  ['egg whites', ['egg-white']], ['eggjahvítur', ['egg-white']],
  ['pasta', ['pasta-dry', 'pasta-cooked']], ['couscous', ['couscous-dry']], ['bulgur', ['bulgur-dry']], ['rye bread', ['rye-bread']], ['rúgbrauð', ['rye-bread']],
  ['oats', ['oats-dry']], ['hafra', ['oats-dry']],
];

const ING = INGREDIENTS as unknown as RefIngredient[];
/** Catalog ingredient ids that "phrase" rules out, the way find_recipes applies it (allergen classes + named foods). */
function ruledOut(phrase: string): Set<string> {
  const q = parseQuery(phrase);
  const byWord = new Set(excludedIngredientIds(q.exclude.words, ING));
  return new Set(ING.filter((i) => byWord.has(i.id) || (i.allergens ?? []).some((a) => q.exclude.allergens.includes(a as never))).map((i) => i.id));
}

describe('independent allergen fixture', () => {
  it('the hand-listed ingredient ids exist in the catalog', () => {
    for (const [, ids] of FOODS) for (const id of ids) expect(ING.some((i) => i.id === id), id).toBe(true);
  });

  it.each(CLASS_WORDS)('allergenMentions("%s") reports %s', (word, allergen) => {
    expect(allergenMentions(word)).toContain(allergen);
    expect(allergenMentions(`no ${word} please`)).toContain(allergen);
  });

  it.each(CLASS_WORDS)('"no %s" rules out every %s ingredient', (word, allergen) => {
    const out = ruledOut(/[áéíóúýöæðþ]/i.test(word) || ['fisk', 'fiski', 'egg', 'eggjum', 'hveiti', 'soja', 'sesam', 'sinnep', 'hnetur'].includes(word) ? `uppskriftir án ${word}` : `recipes with no ${word}`);
    const missing = ING.filter((i) => (i.allergens ?? []).includes(allergen as never) && !out.has(i.id)).map((i) => i.id);
    expect(missing).toEqual([]);
  });

  it.each(FOODS)('"no %s" rules out %j', (word, ids) => {
    const icelandic = /[áéíóúýöæðþ]/i.test(word) || ['lax', 'ost', 'ufsa', 'hafra'].includes(word);
    const out = ruledOut(icelandic ? `uppskriftir án ${word}` : `recipes with no ${word}`);
    expect(ids.filter((id) => !out.has(id))).toEqual([]);
  });
});
