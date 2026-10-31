/**
 * Data checks for the bundled recipe and ingredient catalogues and their backend copies
 * (supabase/seed.sql and the reference-data migrations). Macros are never typed: everything below is computed
 * from ingredient data with the app's own nutrition functions.
 */
import { describe, expect, it } from 'vitest';
import { RECIPES, RECIPES_BY_ID } from '@/data/recipes';
import { INGREDIENTS, INGREDIENTS_BY_ID } from '@/data/ingredients';
import { isSimpleRecipe, recipeAllergens, recipeDietTags, recipeNutrition, satisfiesTag } from '@/domain/nutrition/recipes';
import type { DietTag, Recipe } from '@/domain/types';
import SEED_SQL from '../../supabase/seed.sql?raw';

const MIGRATIONS = import.meta.glob<string>('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true });

/** The recipe pack added in Nov 2026 starts at this recipe (the first 24 are the original starters). */
const FIRST_NEW = RECIPES.findIndex((r) => r.id === 'skyr-oat-pancakes');
const NEW_RECIPES = RECIPES.slice(FIRST_NEW, 84);

const proteinPerServing = (r: Recipe) => recipeNutrition(r).perServing.protein;
/** Meals ≥ 30 g protein per serving, snacks ≥ 15 g. */
const isHighProtein = (r: Recipe) => proteinPerServing(r) >= (r.meal === 'snack' ? 15 : 30);
const has = (r: Recipe, t: DietTag) => satisfiesTag(recipeDietTags(r), t);

describe('recipe catalogue', () => {
  it('has the original 24 recipes plus the 60 of pack 2 first (pack 3 follows; see recipeCatalog.test.ts)', () => {
    expect(FIRST_NEW).toBe(24);
    expect(RECIPES.length).toBeGreaterThan(84);
    expect(NEW_RECIPES).toHaveLength(60);
  });

  it('ids are unique kebab-case, for recipes and ingredients', () => {
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    expect(new Set(INGREDIENTS.map((i) => i.id)).size).toBe(INGREDIENTS.length);
    for (const r of RECIPES) expect(r.id, r.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const i of INGREDIENTS) expect(i.id, i.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('every recipe line uses a known ingredient with a plausible amount', () => {
    for (const r of RECIPES) {
      expect(r.servings, r.id).toBeGreaterThan(0);
      expect(r.prepMinutes, r.id).toBeGreaterThanOrEqual(0);
      expect(r.cookMinutes, r.id).toBeGreaterThanOrEqual(0);
      expect(new Set(r.ingredients.map((i) => i.ingredientId)).size, `${r.id} repeats an ingredient`).toBe(r.ingredients.length);
      for (const ri of r.ingredients) {
        expect(INGREDIENTS_BY_ID.has(ri.ingredientId), `${r.id}: ${ri.ingredientId}`).toBe(true);
        expect(ri.grams, `${r.id}: ${ri.ingredientId}`).toBeGreaterThanOrEqual(1);
        expect(ri.grams, `${r.id}: ${ri.ingredientId}`).toBeLessThanOrEqual(1500);
        expect(ri.grams / r.servings, `${r.id}: ${ri.ingredientId} per serving`).toBeLessThanOrEqual(750);
      }
      for (const s of r.substitutions) {
        expect(r.ingredients.some((i) => i.ingredientId === s.ingredientId), `${r.id} sub ${s.ingredientId}`).toBe(true);
        expect(s.alternatives.length).toBeGreaterThan(0);
        for (const a of s.alternatives) expect(INGREDIENTS_BY_ID.has(a), `${r.id} alt ${a}`).toBe(true);
      }
      expect(recipeNutrition(r).missingIds, r.id).toEqual([]);
    }
  });

  it('steps are present and non-empty', () => {
    for (const r of RECIPES) {
      expect(r.steps.length, r.id).toBeGreaterThan(0);
      for (const s of r.steps) expect(s.trim().length, r.id).toBeGreaterThan(5);
      expect(r.name.trim().length).toBeGreaterThan(3);
    }
  });

  it('every new recipe is simple: ≤ 20 min hands-on, ≤ 8 non-optional ingredients, ≤ 6 steps', () => {
    for (const r of NEW_RECIPES) {
      expect(isSimpleRecipe(r), r.id).toBe(true);
      expect(r.steps.length, r.id).toBeGreaterThanOrEqual(2);
    }
    // The rule itself.
    const base = RECIPES_BY_ID.get('skyr-oat-pancakes')!;
    expect(isSimpleRecipe({ ...base, prepMinutes: 21 })).toBe(false);
    expect(isSimpleRecipe({ ...base, steps: Array.from({ length: 7 }, (_, i) => `Step number ${i}`) })).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({ ingredientId: INGREDIENTS[i].id, grams: 10 }));
    expect(isSimpleRecipe({ ...base, ingredients: nine })).toBe(false);
    expect(isSimpleRecipe({ ...base, ingredients: [...nine.slice(0, 8), { ...nine[8], optional: true }] })).toBe(true);
  });

  it('new recipes meet the meal and diet distribution targets', () => {
    const meals = { breakfast: 0, lunch: 0, dinner: 0, snack: 0 };
    for (const r of NEW_RECIPES) meals[r.meal]++;
    expect(meals).toEqual({ breakfast: 15, lunch: 15, dinner: 20, snack: 10 });
    const count = (f: (r: Recipe) => boolean) => NEW_RECIPES.filter(f).length;
    expect(count(isHighProtein)).toBeGreaterThanOrEqual(25);
    expect(count((r) => has(r, 'vegetarian'))).toBeGreaterThanOrEqual(12);
    expect(count((r) => has(r, 'vegan'))).toBeGreaterThanOrEqual(8);
    expect(count((r) => has(r, 'dairy_free'))).toBeGreaterThanOrEqual(10);
    expect(count((r) => has(r, 'gluten_free'))).toBeGreaterThanOrEqual(10);
    expect(count((r) => r.cookMinutes === 0)).toBeGreaterThanOrEqual(15); // no-cook options
    expect(count((r) => r.servings === 4)).toBeGreaterThanOrEqual(4); // batch recipes
  });

  it('high-protein recipes are high protein by the app\'s own nutrition maths', () => {
    expect(proteinPerServing(RECIPES_BY_ID.get('tuna-white-bean-salad')!)).toBeGreaterThanOrEqual(30);
    expect(proteinPerServing(RECIPES_BY_ID.get('chilli-lime-edamame')!)).toBeGreaterThanOrEqual(15);
    expect(proteinPerServing(RECIPES_BY_ID.get('nut-seed-trail-mix')!)).toBeLessThan(15);
  });
});

describe('allergens and diet tags derive from ingredients', () => {
  const r = (id: string) => RECIPES_BY_ID.get(id)!;

  it('a recipe with skyr is neither dairy-free nor vegan, and lists milk', () => {
    const skyr = r('skyr-oat-pancakes');
    const tags = recipeDietTags(skyr);
    expect(tags).not.toContain('dairy_free');
    expect(tags).not.toContain('vegan');
    expect(tags).toContain('vegetarian');
    expect(recipeAllergens(skyr)).toEqual(expect.arrayContaining(['milk', 'egg', 'gluten']));
  });

  it('a cod recipe is pescatarian, not vegetarian', () => {
    const cod = r('cod-white-bean-tomato');
    const tags = recipeDietTags(cod);
    expect(tags).toContain('pescatarian');
    expect(tags).not.toContain('vegetarian');
    expect(tags).toEqual(expect.arrayContaining(['dairy_free', 'gluten_free']));
    expect(recipeAllergens(cod)).toEqual(['fish']);
  });

  it('meat recipes are neither vegetarian nor pescatarian', () => {
    for (const id of ['lamb-cabbage-skillet', 'turkey-bolognese-batch', 'pork-noodle-stir-fry']) {
      const tags = recipeDietTags(r(id));
      expect(tags, id).not.toContain('vegetarian');
      expect(tags, id).not.toContain('pescatarian');
    }
  });

  it('vegan recipes really are plant-only, and soy sauce or wheat removes gluten-free', () => {
    const dal = recipeDietTags(r('red-lentil-dal-batch'));
    expect(dal).toEqual(expect.arrayContaining(['vegan', 'vegetarian', 'dairy_free', 'gluten_free']));
    expect(recipeAllergens(r('red-lentil-dal-batch'))).toEqual(['celery']); // stock
    const tempeh = recipeDietTags(r('tempeh-broccoli-rice'));
    expect(tempeh).toContain('vegan');
    expect(tempeh).not.toContain('gluten_free');
    expect(recipeAllergens(r('tempeh-broccoli-rice'))).toEqual(expect.arrayContaining(['soy', 'wheat', 'gluten', 'sesame']));
  });

  it('honey keeps a recipe vegetarian but not vegan; tree nuts and shellfish are flagged', () => {
    const tags = recipeDietTags(r('greek-yogurt-walnut-honey'));
    expect(tags).toContain('vegetarian');
    expect(tags).not.toContain('vegan');
    expect(recipeAllergens(r('nut-seed-trail-mix'))).toEqual(['tree_nuts']);
    expect(recipeAllergens(r('prawn-tacos-cabbage'))).toEqual(expect.arrayContaining(['shellfish', 'milk']));
  });

  it('a swap changes the derived tags (skyr → soy yogurt makes the fajitas dairy-free)', () => {
    const fajitas = r('chicken-fajitas-skyr');
    expect(recipeDietTags(fajitas)).not.toContain('dairy_free');
    expect(recipeDietTags(fajitas, [{ from: 'skyr-plain', to: 'soy-yogurt' }])).toContain('dairy_free');
  });
});

/* ------------------------------------------------------------ SQL parity */
type SqlRows = Map<string, unknown>;

/** Rows of `insert into public.<table> … values (…), …;` blocks: id → parsed `data` jsonb. Later blocks win. */
function parseRefRows(sql: string, table: string, into: SqlRows = new Map()): SqlRows {
  const text = sql.replace(/\r\n/g, '\n');
  const header = new RegExp(`^insert into public\\.${table} \\([^)]*\\) values$`, 'gm');
  let m: RegExpExecArray | null;
  while ((m = header.exec(text))) {
    const rest = text.slice(m.index + m[0].length + 1);
    for (const line of rest.split('\n')) {
      if (!line.startsWith('  (')) break;
      const id = /^ {2}\('((?:[^']|'')*)'/.exec(line)?.[1];
      const data = /'((?:[^']|'')*)'::jsonb\),?$/.exec(line)?.[1];
      if (!id || data == null) throw new Error(`unparseable ${table} row: ${line.slice(0, 80)}`);
      into.set(id.replace(/''/g, "'"), JSON.parse(data.replace(/''/g, "'")));
    }
  }
  return into;
}
/** Ids in `delete from public.<table> where id not in (…);`, or null when there is none. */
function pruneList(sql: string, table: string): string[] | null {
  const m = new RegExp(`delete from public\\.${table} where id not in \\(([^;]*)\\);`).exec(sql);
  return m ? [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")) : null;
}
/** The TS objects as they serialise into the jsonb column (undefined fields dropped). */
const asJson = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('backend reference data matches src/data', () => {
  const seed = SEED_SQL;
  const migPaths = Object.keys(MIGRATIONS).sort();
  const migFiles = migPaths.map((p) => p.split('/').pop()!);
  const migSql = migPaths.map((p) => MIGRATIONS[p]);

  for (const [table, list] of [
    ['ref_ingredients', INGREDIENTS],
    ['ref_recipes', RECIPES],
  ] as const) {
    const expected = new Map<string, unknown>(list.map((x) => [x.id, asJson(x)]));

    it(`seed.sql has exactly the bundled ${table} rows, with matching data, and prunes the rest`, () => {
      const rows = parseRefRows(seed, table);
      expect([...rows.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [id, data] of rows) expect(data, id).toEqual(expected.get(id));
      expect(pruneList(seed, table)?.sort()).toEqual([...expected.keys()].sort());
    });

    it(`the migrations together upsert every bundled ${table} row (and nothing else), never deleting`, () => {
      const rows: SqlRows = new Map();
      for (const sql of migSql) parseRefRows(sql, table, rows);
      expect([...rows.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [id, data] of rows) expect(data, id).toEqual(expected.get(id));
      for (const sql of migSql) expect(pruneList(sql, table)).toBeNull();
    });
  }

  it('the recipe pack 3 migration (protein groups, ~190 new recipes) is additive and upserts every bundled row', () => {
    const f = '20261104000001_recipe_pack_3.sql';
    expect(migFiles).toContain(f);
    const sql = migSql[migFiles.indexOf(f)];
    expect(sql).not.toMatch(/^s*(delete|drop|truncate|alter)/im);
    expect(sql.match(/^on conflict \(id\) do update set /gm)).toHaveLength(2);
    expect(parseRefRows(sql, 'ref_recipes').size).toBe(RECIPES.length);
    expect(parseRefRows(sql, 'ref_ingredients').size).toBe(INGREDIENTS.length);
    expect((parseRefRows(sql, 'ref_ingredients').get('shrimp-cooked') as { proteinGroup?: string }).proteinGroup).toBe('prawns');
  });

  it('the recipe-pack migration is additive and upserts', () => {
    const f = '20261103000001_more_recipes.sql';
    expect(migFiles).toContain(f);
    const sql = migSql[migFiles.indexOf(f)];
    expect(sql).not.toMatch(/^\s*(delete|drop|truncate|alter)\b/im);
    expect(sql).not.toMatch(/^\s*(begin|commit);/im); // each migration already runs in its own transaction
    expect(sql.match(/^on conflict \(id\) do update set /gm)).toHaveLength(2);
    for (const r of NEW_RECIPES) expect(sql).toContain(`('${r.id.replace(/'/g, "''")}', `);
  });
});
