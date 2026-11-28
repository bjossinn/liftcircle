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
import { EXERCISES } from '@/data/exercises';
import { EN, LanguageProvider, type Language } from '@/i18n';
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
    expect(el.querySelector('img')?.getAttribute('alt')).toBe('Barbell back squat – upphafs- og lokastaða');
    expect(el.textContent).toContain('Lykilatriði');
    expect(cueTexts(el)).toHaveLength(4);
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
  it('shows a decorative thumbnail for library exercises and the glyph placeholder otherwise', () => {
    const el = mount(createElement(ExerciseThumb, { ex: squat }));
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/exercise-media/v2/barbell-back-squat/thumb.webp');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('width')).toBe('256');
    act(() => void img.dispatchEvent(new Event('error')));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('svg')).not.toBeNull();

    const p = mount(createElement(ExerciseThumb, { ex: custom as Exercise }));
    expect(p.querySelector('img')).toBeNull();
    expect(p.querySelector('svg')).not.toBeNull();
    expect(hasIllustration(custom)).toBe(false);
    expect(hasIllustration(squat)).toBe(true);
    expect(hasIllustration(undefined)).toBe(false);
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

  it('a thumbnail that failed does not block the next exercise swapped into the same row', () => {
    const el = mount(createElement(ExerciseThumb, { ex: squat }));
    act(() => void el.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(el.querySelector('img')).toBeNull();
    rerender(createElement(ExerciseThumb, { ex: bench }));
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/exercise-media/v2/barbell-bench-press/thumb.webp');
  });
});
