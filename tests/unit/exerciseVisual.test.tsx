// @vitest-environment jsdom
/**
 * Exercise illustrations (roadmap item 13, PR 2): every library exercise shows one lazy, fixed-size two-panel image
 * (start and end position) with localized alt text and its technique cues underneath; custom exercises and failed loads
 * show the glyph placeholder or just the cues, never a broken image; a failure doesn't stick to a logger row on swap.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ExerciseIllustration, ExerciseThumb, hasIllustration } from '@/components/ExerciseVisual';
import { ExerciseGlyph } from '@/components/ExerciseGlyph';
import { PATTERN_GLYPHS } from '@/data/exerciseGlyphs';
import { EXERCISES } from '@/data/exercises';
import { EN, IS, LanguageProvider, type Language } from '@/i18n';
import type { CustomExercise, Exercise } from '@/domain/types';

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(node: ReactNode, language: Language = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(LanguageProvider, { language, children: node })));
  return container;
}
/** Re-render the mounted tree with a new node (same component instance: what a logger row does on swap). */
function rerender(node: ReactNode, language: Language = 'en') {
  act(() => root!.render(createElement(LanguageProvider, { language, children: node })));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const squat = EXERCISES.find((e) => e.id === 'barbell-back-squat')!;
const bench = EXERCISES.find((e) => e.id === 'barbell-bench-press')!;
const custom: CustomExercise = { ...squat, id: 'custom-1', name: 'My squat', custom: true } as CustomExercise;
const cueTexts = (el: HTMLElement) => [...el.querySelectorAll('[data-testid="exercise-cues"] li')].map((li) => li.textContent);

describe('ExerciseIllustration', () => {
  it('shows one lazy, fixed-size image with English alt text and the cues underneath', () => {
    const el = mount(createElement(ExerciseIllustration, { ex: squat }));
    const imgs = [...el.querySelectorAll('img')];
    expect(imgs).toHaveLength(1);
    const [img] = imgs;
    expect(img.getAttribute('src')).toBe('/exercise-media/v2/barbell-back-squat/full.webp');
    expect(img.getAttribute('alt')).toBe('Barbell back squat – start and end position');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('width')).toBe('800');
    expect(img.getAttribute('height')).toBe('800');
    expect(el.querySelector('button')).toBeNull(); // no frame toggle: the image shows both positions
    expect(el.textContent).toContain('Key points');
    expect(cueTexts(el)).toEqual([
      `1${EN['exercise.cues.barbell-back-squat.1']}`,
      `2${EN['exercise.cues.barbell-back-squat.2']}`,
      `3${EN['exercise.cues.barbell-back-squat.3']}`,
      `4${EN['exercise.cues.barbell-back-squat.4']}`,
    ]);
    expect(el.querySelector('a')).toBeNull(); // no attribution needed for our own illustrations
  });

  it('uses the Icelandic alt text and heading', () => {
    const el = mount(createElement(ExerciseIllustration, { ex: squat }), 'is');
    expect(el.querySelector('img')?.getAttribute('alt')).toBe('Hnébeygja með stöng á baki – upphafs- og lokastaða');
    expect(el.textContent).toContain('Lykilatriði');
    expect(cueTexts(el)).toEqual([1, 2, 3, 4].map((n) => `${n}${IS[`exercise.cues.barbell-back-squat.${n}` as keyof typeof IS]}`));
    expect(cueTexts(el)[1]).toBe('2Spenntu kviðinn fyrir hverja endurtekningu');
  });

  it('renders nothing for custom exercises; after a load error the image goes and the cues stay', () => {
    expect(mount(createElement(ExerciseIllustration, { ex: custom })).innerHTML).toBe('');
    const el = mount(createElement(ExerciseIllustration, { ex: squat }));
    act(() => void el.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(el.querySelector('img')).toBeNull();
    expect(cueTexts(el)).toHaveLength(4);
  });

  it('every library exercise renders an image and 3–4 cues', () => {
    for (const ex of EXERCISES) {
      const el = mount(createElement(ExerciseIllustration, { ex }));
      expect(el.querySelector('img')?.getAttribute('src'), ex.id).toBe(`/exercise-media/v2/${ex.id}/full.webp`);
      expect(cueTexts(el).length, ex.id).toBeGreaterThanOrEqual(3);
      act(() => root?.unmount());
      container?.remove();
    }
    root = null;
    container = null;
  });
});

describe('ExerciseThumb', () => {
  it('always shows the Direction B movement-pattern tile (no thumb.webp in lists, the picker or compact logger rows)', () => {
    const el = mount(createElement(ExerciseThumb, { ex: squat }));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[src*="thumb.webp"]')).toBeNull();
    const tile = el.querySelector('[data-testid="exercise-glyph-tile"]')!;
    expect(tile).not.toBeNull();
    expect(tile.className).toContain('bg-surface-2');
    expect(tile.className).toContain('text-accent');
    expect(tile.className).toContain('size-11');
    const svg = tile.querySelector('svg')!;
    expect(svg.getAttribute('data-pattern')).toBe('squat');
    expect(svg.getAttribute('data-glyph')).toBe('barbell_squat');
    expect(svg.getAttribute('stroke-width')).toBe('1.75');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');

    rerender(createElement(ExerciseThumb, { ex: bench }));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('svg')?.getAttribute('data-pattern')).toBe('horizontal_push');
    expect(el.querySelector('svg')?.getAttribute('data-glyph')).toBe('bench_press');

    const p = mount(createElement(ExerciseThumb, { ex: custom as Exercise }));
    expect(p.querySelector('img')).toBeNull();
    expect(p.querySelector('svg')).not.toBeNull();
    // Custom exercises use their movement-pattern glyph.
    expect(p.querySelector('svg')?.getAttribute('data-glyph')).toBe(PATTERN_GLYPHS[(custom as Exercise).pattern]);
    expect(hasIllustration(custom)).toBe(false);
    expect(hasIllustration(squat)).toBe(true);
    expect(hasIllustration(undefined)).toBe(false);
  });
});

describe('ExerciseThumb glyph choice', () => {
  it('library exercises use their own glyph key; a custom copy falls back to the pattern glyph', () => {
    const pushUp = EXERCISES.find((e) => e.id === 'push-up')!;
    const lateral = EXERCISES.find((e) => e.id === 'dumbbell-lateral-raise')!;
    const el = mount(createElement(ExerciseThumb, { ex: pushUp }));
    expect(el.querySelector('svg')?.getAttribute('data-glyph')).toBe('push_up');
    rerender(createElement(ExerciseThumb, { ex: lateral }));
    expect(el.querySelector('svg')?.getAttribute('data-glyph')).toBe('lateral_raise');
    rerender(createElement(ExerciseThumb, { ex: { ...pushUp, id: 'custom-2', custom: true } as CustomExercise }));
    expect(el.querySelector('svg')?.getAttribute('data-glyph')).toBe('bench_press');
  });
});

describe('ExerciseGlyph (Direction B)', () => {
  it('draws 13 distinct 24×24 pattern fallback marks with stroke 1.75 and currentColor', () => {
    const patterns = ['squat', 'lunge', 'hinge', 'horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull', 'trunk', 'carry', 'isolation_upper', 'isolation_lower', 'conditioning', 'mobility'] as const;
    const bodies = new Set<string>();
    for (const pattern of patterns) {
      const el = mount(createElement(ExerciseGlyph, { pattern }));
      const svg = el.querySelector('svg')!;
      expect(svg.getAttribute('viewBox'), pattern).toBe('0 0 24 24');
      expect(svg.getAttribute('stroke'), pattern).toBe('currentColor');
      expect(svg.getAttribute('stroke-width'), pattern).toBe('1.75');
      expect(svg.getAttribute('fill'), pattern).toBe('none');
      expect(svg.innerHTML).not.toMatch(/#[0-9a-f]{3,6}/i);
      bodies.add(svg.innerHTML);
      act(() => root?.unmount());
      container?.remove();
    }
    root = null;
    container = null;
    expect(bodies.size).toBe(patterns.length);
  });
});

describe('load failure is per image, not per row (logger swap)', () => {
  it('an image that failed (e.g. offline) does not block the next exercise swapped into the same row', () => {
    const el = mount(createElement(ExerciseIllustration, { ex: squat }));
    act(() => void el.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(el.querySelector('img')).toBeNull();
    rerender(createElement(ExerciseIllustration, { ex: bench }));
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/exercise-media/v2/barbell-bench-press/full.webp');
    expect(cueTexts(el)[0]).toBe(`1${EN['exercise.cues.barbell-bench-press.1']}`);
    // Swapping back to the failed exercise doesn't retry a broken image.
    rerender(createElement(ExerciseIllustration, { ex: squat }));
    expect(el.querySelector('img')).toBeNull();
  });
});
