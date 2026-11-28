import { afterEach, describe, expect, it } from 'vitest';
import { EN, IS, setLanguage } from '@/i18n';
import { EXERCISES } from '@/data/exercises';
import { RECIPES } from '@/data/recipes';
import { INGREDIENTS, PIECE_LABELS, INGREDIENT_CATEGORY_LABELS } from '@/data/ingredients';
import {
  exerciseAliases, exerciseDisplayName, exerciseExecution, exerciseMistakes, exerciseSetup, foodDisplayText, foodPrepText,
  ingredientCategoryLabel, ingredientDisplayName, pieceLabel, proteinExampleText, recipeDisplayName, recipeNotes, recipeSteps,
} from '@/data/catalogText';
import { searchExercises } from '@/data/exerciseMeta';
import { PROTEIN_GROUPS } from '@/domain/nutrition/recipes';
import type { CustomExercise } from '@/domain/types';

const dict = (k: string) => [(EN as Record<string, string>)[k], (IS as Record<string, string>)[k]] as const;

afterEach(() => setLanguage('en'));

describe('catalog translations', () => {
  it('every bundled exercise has an Icelandic name, setup, execution, aliases and mistakes', () => {
    for (const ex of EXERCISES) {
      const [en, is] = dict(`exercise.name.${ex.id}`);
      expect(en, ex.id).toBe(ex.name);
      expect(is?.trim(), ex.id).toBeTruthy();
      expect(dict(`exercise.setup.${ex.id}`)[1]?.trim(), ex.id).toBeTruthy();
      expect(dict(`exercise.execution.${ex.id}`)[1]?.trim(), ex.id).toBeTruthy();
      ex.aliases.forEach((_, i) => expect(dict(`exercise.alias.${ex.id}.${i + 1}`)[1]?.trim(), `${ex.id} alias ${i + 1}`).toBeTruthy());
      ex.mistakes.forEach((_, i) => expect(dict(`exercise.mistake.${ex.id}.${i + 1}`)[1]?.trim(), `${ex.id} mistake ${i + 1}`).toBeTruthy());
    }
  });

  it('every recipe has an Icelandic name, every step and its notes', () => {
    for (const r of RECIPES) {
      const [en, is] = dict(`recipe.name.${r.id}`);
      expect(en, r.id).toBe(r.name);
      expect(is?.trim(), r.id).toBeTruthy();
      r.steps.forEach((s, i) => {
        expect(dict(`recipe.step.${r.id}.${i + 1}`)[0], `${r.id} step ${i + 1}`).toBe(s);
        expect(dict(`recipe.step.${r.id}.${i + 1}`)[1]?.trim(), `${r.id} step ${i + 1}`).toBeTruthy();
      });
      if (r.notes) expect(dict(`recipe.notes.${r.id}`)[1]?.trim(), `${r.id} notes`).toBeTruthy();
    }
  });

  it('every ingredient, amount, prep, piece label, category and protein example has Icelandic', () => {
    for (const ing of INGREDIENTS) {
      expect(dict(`food.ingredient.${ing.id}`)[0], ing.id).toBe(ing.name);
      expect(dict(`food.ingredient.${ing.id}`)[1]?.trim(), ing.id).toBeTruthy();
      expect(ingredientDisplayName(ing, 'is'), ing.id).toBe(IS[`food.ingredient.${ing.id}` as keyof typeof IS]);
    }
    const entries: [string, string][] = Object.entries(EN);
    const displays = new Set(entries.filter(([k]) => k.startsWith('food.display.')).map(([, v]) => v));
    const preps = new Set(entries.filter(([k]) => k.startsWith('food.prep.')).map(([, v]) => v));
    for (const r of RECIPES) {
      for (const ri of r.ingredients) {
        if (ri.display) expect(displays.has(ri.display), `${r.id} display "${ri.display}"`).toBe(true);
        if (ri.prep) expect(preps.has(ri.prep), `${r.id} prep "${ri.prep}"`).toBe(true);
      }
    }
    for (const [id, [one, other]] of Object.entries(PIECE_LABELS) as [string, [string, string]][]) {
      expect(pieceLabel(id, 1, 'en')).toBe(one);
      expect(pieceLabel(id, 2, 'en')).toBe(other);
      expect(pieceLabel(id, 2, 'is')?.trim(), id).toBeTruthy();
    }
    for (const c of Object.keys(INGREDIENT_CATEGORY_LABELS) as (keyof typeof INGREDIENT_CATEGORY_LABELS)[]) {
      expect(ingredientCategoryLabel(c, 'en')).toBe(INGREDIENT_CATEGORY_LABELS[c]);
      expect(ingredientCategoryLabel(c, 'is')).not.toBe(INGREDIENT_CATEGORY_LABELS[c]);
    }
    for (const g of PROTEIN_GROUPS) expect(proteinExampleText(g, 'is')?.trim(), g).toBeTruthy();
  });
});

describe('catalog display helpers', () => {
  const squat = EXERCISES.find((e) => e.id === 'barbell-back-squat')!;
  const custom: CustomExercise = { ...squat, id: 'custom-1', name: 'My squat', aliases: ['ms'], setup: 'mine', execution: 'mine', mistakes: ['x'], custom: true } as CustomExercise;

  it('shows Icelandic catalog text in Icelandic and the catalog English in English', () => {
    expect(exerciseDisplayName(squat, undefined, 'en')).toBe(squat.name);
    setLanguage('is');
    expect(exerciseDisplayName(squat)).toBe(IS['exercise.name.barbell-back-squat']);
    expect(exerciseDisplayName('barbell-back-squat')).toBe(IS['exercise.name.barbell-back-squat']);
    expect(exerciseSetup(squat)).toBe(IS['exercise.setup.barbell-back-squat']);
    expect(exerciseExecution(squat)).toBe(IS['exercise.execution.barbell-back-squat']);
    expect(exerciseAliases(squat)[0]).toBe(IS['exercise.alias.barbell-back-squat.1']);
    expect(exerciseMistakes(squat)[0]).toBe(IS['exercise.mistake.barbell-back-squat.1']);
    expect(exerciseDisplayName('no-such-exercise')).toBe(IS['workout.unknownExercise']);
    const r = RECIPES[0];
    expect(recipeDisplayName(r)).toBe(IS[`recipe.name.${r.id}` as keyof typeof IS]);
    expect(recipeSteps(r)[0]).toBe(IS[`recipe.step.${r.id}.1` as keyof typeof IS]);
    expect(recipeDisplayName({ id: 'user-recipe', name: 'Grandma soup' })).toBe('Grandma soup');
    const withNotes = RECIPES.find((x) => x.notes)!;
    expect(recipeNotes(withNotes)).toBe(IS[`recipe.notes.${withNotes.id}` as keyof typeof IS]);
    expect(foodDisplayText('½ cup')).toBe(IS['food.display.1_2_cup']);
    expect(foodPrepText('diced')).toBe(IS['food.prep.diced']);
    expect(foodDisplayText('a user typed amount')).toBe('a user typed amount');
  });

  it('never translates custom exercises', () => {
    setLanguage('is');
    expect(exerciseDisplayName(custom)).toBe('My squat');
    expect(exerciseAliases(custom)).toEqual(['ms']);
    expect(exerciseSetup(custom)).toBe('mine');
    expect(exerciseMistakes(custom)).toEqual(['x']);
  });

  it('search finds catalog exercises by Icelandic and English names in either language', () => {
    const isName = IS['exercise.name.barbell-back-squat'];
    for (const lang of ['en', 'is'] as const) {
      setLanguage(lang);
      expect(searchExercises(EXERCISES, isName)[0]?.id, lang).toBe('barbell-back-squat');
      expect(searchExercises(EXERCISES, 'back squat').map((e) => e.id), lang).toContain('barbell-back-squat');
    }
    const isAlias = IS['exercise.alias.barbell-back-squat.1'];
    expect(searchExercises(EXERCISES, isAlias).map((e) => e.id)).toContain('barbell-back-squat');
  });
});
