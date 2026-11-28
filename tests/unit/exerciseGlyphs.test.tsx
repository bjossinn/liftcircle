// @vitest-environment jsdom
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import {
  EXERCISE_GLYPHS,
  FALLBACK_GLYPH_KEYS,
  GLYPH_KEYS,
  MOVEMENT_GLYPH_KEYS,
  PATTERN_GLYPHS,
  exerciseGlyphKey,
  isGlyphKey,
} from '@/data/exerciseGlyphs';
import { ExerciseGlyph, GLYPHS } from '@/components/ExerciseGlyph';
import type { MovementPattern } from '@/domain/types';
import { glyphUsage, renderGlyphContactSheet } from './glyphContactSheet';

const PATTERNS: MovementPattern[] = ['squat', 'lunge', 'hinge', 'horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull', 'trunk', 'carry', 'isolation_upper', 'isolation_lower', 'conditioning', 'mobility'];

describe('exercise glyph mapping', () => {
  it('every catalog exercise has an explicit, existing glyph key', () => {
    for (const ex of EXERCISES) {
      const key = EXERCISE_GLYPHS[ex.id];
      expect(isGlyphKey(key), ex.id).toBe(true);
      expect(exerciseGlyphKey(ex), ex.id).toBe(key);
      expect(GLYPHS[key], ex.id).toBeDefined();
    }
  });

  it('the map has no ids outside the catalog', () => {
    const ids = new Set(EXERCISES.map((e) => e.id));
    expect(Object.keys(EXERCISE_GLYPHS).filter((id) => !ids.has(id))).toEqual([]);
    expect(Object.keys(EXERCISE_GLYPHS)).toHaveLength(EXERCISES.length);
  });

  it('every glyph key is drawn, and every key is used by an exercise or kept on purpose as a fallback', () => {
    expect(new Set(GLYPH_KEYS).size).toBe(GLYPH_KEYS.length);
    expect(Object.keys(GLYPHS).sort()).toEqual([...GLYPH_KEYS].sort());
    const used = new Set(Object.values(EXERCISE_GLYPHS));
    for (const key of MOVEMENT_GLYPH_KEYS) expect(used.has(key), `${key} is unused`).toBe(true);
    for (const key of FALLBACK_GLYPH_KEYS) expect(used.has(key), `${key} is a fallback, not an exercise glyph`).toBe(false);
    // Each kept fallback is reachable: a pattern fallback, or the neutral last resort.
    const patternKeys = new Set(Object.values(PATTERN_GLYPHS));
    for (const key of FALLBACK_GLYPH_KEYS) expect(patternKeys.has(key) || key === 'neutral', key).toBe(true);
  });

  it('custom and unknown exercises fall back to the pattern glyph, then the neutral mark', () => {
    for (const p of PATTERNS) {
      expect(isGlyphKey(PATTERN_GLYPHS[p]), p).toBe(true);
      expect(exerciseGlyphKey({ id: 'custom-123', pattern: p, custom: true })).toBe(PATTERN_GLYPHS[p]);
    }
    // A custom exercise never borrows a library id's glyph.
    expect(exerciseGlyphKey({ id: 'push-up', pattern: 'horizontal_push', custom: true })).toBe('bench_press');
    expect(exerciseGlyphKey({ id: 'push-up', pattern: 'horizontal_push' })).toBe('push_up');
    expect(exerciseGlyphKey({ id: 'not-in-catalog', pattern: 'vertical_pull' })).toBe('pull_up');
    expect(exerciseGlyphKey({ id: 'x', pattern: 'nonsense' as MovementPattern })).toBe('neutral');
    expect(exerciseGlyphKey({ id: 'toString', pattern: undefined as unknown as MovementPattern })).toBe('neutral');
  });

  it('fixes the worst old mismatches', () => {
    const k = (id: string) => EXERCISE_GLYPHS[id];
    expect(k('chest-supported-dumbbell-row')).toBe('chest_supported_row');
    expect(k('push-up')).toBe('push_up');
    expect(k('dumbbell-lateral-raise')).toBe('lateral_raise');
    expect(k('triceps-pushdown')).toBe('triceps_pushdown');
    expect(k('dumbbell-fly')).toBe('lying_fly');
    expect(k('lying-leg-curl')).toBe('lying_leg_curl');
    expect(k('standing-calf-raise')).toBe('standing_calf_raise');
    expect(k('leg-press')).toBe('leg_press');
  });
});

describe('exercise glyph drawings', () => {
  it('every glyph is a distinct 24×24 currentColor line drawing at stroke 1.75', () => {
    const bodies = new Map<string, string>();
    for (const key of GLYPH_KEYS) {
      const html = renderToStaticMarkup(createElement(ExerciseGlyph, { glyph: key }));
      const doc = new DOMParser().parseFromString(html, 'image/svg+xml');
      const svg = doc.documentElement;
      expect(svg.getAttribute('viewBox'), key).toBe('0 0 24 24');
      expect(svg.getAttribute('stroke'), key).toBe('currentColor');
      expect(svg.getAttribute('stroke-width'), key).toBe('1.75');
      expect(svg.getAttribute('fill'), key).toBe('none');
      expect(svg.getAttribute('data-glyph'), key).toBe(key);
      expect(html, key).not.toMatch(/#[0-9a-f]{3,6}\b/i);
      expect(svg.children.length, key).toBeGreaterThan(0);
      // Every coordinate stays inside the 24×24 box.
      for (const n of html.match(/-?\d*\.?\d+/g)!.map(Number)) expect(Math.abs(n), key).toBeLessThanOrEqual(24);
      const inner = html.replace(/<svg[^>]*>/, '');
      expect(bodies.get(inner), `${key} duplicates ${bodies.get(inner)}`).toBeUndefined();
      bodies.set(inner, key);
    }
  });
});

describe('glyph contact sheet (docs/exercise-glyphs.html)', () => {
  const file = resolve(__dirname, '../../docs/exercise-glyphs.html');
  it('lists every key with its example exercises and is up to date (npm run glyphs:sheet)', () => {
    const html = renderGlyphContactSheet();
    for (const key of GLYPH_KEYS) expect(html).toContain(`id="${key}"`);
    for (const [key, u] of glyphUsage()) for (const name of u.exercises) expect(html, key).toContain(name.replace(/&/g, '&amp;'));
    if (process.env.UPDATE_GLYPH_SHEET) writeFileSync(file, html);
    expect(readFileSync(file, 'utf8'), 'docs/exercise-glyphs.html is stale: run npm run glyphs:sheet').toBe(html);
  });
});
