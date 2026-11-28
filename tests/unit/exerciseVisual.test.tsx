// @vitest-environment jsdom
/**
 * Exercise illustrations (roadmap item 13, PR 2): mapped exercises get lazy, fixed-size frames with localized alt
 * text and a licence credit; custom/unmapped exercises and failed loads show the glyph placeholder, never a broken
 * image; reduced motion shows both frames side by side with no animation control.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ExerciseIllustration, ExerciseThumb, hasIllustration, IllustrationCreditsLink } from '@/components/ExerciseVisual';
import CreditsPage from '@/features/settings/CreditsPage';
import { EXERCISE_MEDIA_MAPPING } from '@/data/exerciseMedia';
import { EXERCISES } from '@/data/exercises';
import { LanguageProvider, type Language } from '@/i18n';
import type { CustomExercise, Exercise } from '@/domain/types';

let root: Root | null = null;
let container: HTMLElement | null = null;

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: reduce && q.includes('reduce'),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

function mount(node: ReactNode, language: Language = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(LanguageProvider, { language, children: createElement(MemoryRouter, null, node) })));
  return container;
}
/** Re-render the mounted tree with a new node (same component instances where the element type matches). */
function rerender(node: ReactNode, language: Language = 'en') {
  act(() => root!.render(createElement(LanguageProvider, { language, children: createElement(MemoryRouter, null, node) })));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

const squat = EXERCISES.find((e) => e.id === 'barbell-back-squat')!;
const unmapped = EXERCISES.find((e) => e.id === 'kettlebell-swing')!;
const custom: CustomExercise = { ...squat, id: 'custom-1', name: 'My squat', custom: true } as CustomExercise;

describe('ExerciseIllustration', () => {
  it('shows lazy, fixed-size start/end frames with English alt text, a pause control and the licence credit', () => {
    setReducedMotion(false);
    const el = mount(createElement(ExerciseIllustration, { ex: squat }));
    const imgs = [...el.querySelectorAll('img')];
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('width')).toBe('480');
      expect(img.getAttribute('height')).toBe('480');
      expect(img.getAttribute('src')).toMatch(/^\/exercise-media\/v1\/ek-0122\/[01]\.webp$/);
    }
    // Only the visible frame is exposed to assistive tech.
    expect(imgs[0].getAttribute('alt')).toBe('Barbell back squat: start position');
    expect(imgs[1].getAttribute('alt')).toBe('');
    expect(el.querySelector('button[aria-label="Pause animation"]')).not.toBeNull();
    expect(el.textContent).toContain('Illustration: Everkinetic, CC BY-SA 4.0');
    expect(el.querySelector('a[href="https://creativecommons.org/licenses/by-sa/4.0/"]')?.textContent).toBe('CC BY-SA 4.0');
    // The author credit links to the in-app credits page with the full attribution.
    const credits = el.querySelector<HTMLAnchorElement>('a[href="/credits#exercise-illustrations"]');
    expect(credits?.textContent).toBe('Everkinetic');
    expect(credits?.getAttribute('aria-label')).toBe('Everkinetic: illustration credits');
  });

  it('alternates frames and stops when paused', () => {
    vi.useFakeTimers();
    setReducedMotion(false);
    const el = mount(createElement(ExerciseIllustration, { ex: squat }));
    const alts = () => [...el.querySelectorAll('img')].map((i) => i.getAttribute('alt'));
    act(() => void vi.advanceTimersByTime(1500));
    expect(alts()).toEqual(['', 'Barbell back squat: end position']);
    act(() => el.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click());
    expect(el.querySelector('button[aria-label="Play animation"]')?.getAttribute('aria-pressed')).toBe('true');
    act(() => void vi.advanceTimersByTime(5000));
    expect(alts()).toEqual(['', 'Barbell back squat: end position']);
  });

  it('with reduced motion shows both frames statically, labelled, in Icelandic', () => {
    setReducedMotion(true);
    const el = mount(createElement(ExerciseIllustration, { ex: squat }), 'is');
    expect([...el.querySelectorAll('img')].map((i) => i.getAttribute('alt'))).toEqual(['Barbell back squat: upphafsstaða', 'Barbell back squat: lokastaða']);
    expect(el.querySelector('button')).toBeNull();
    expect(el.textContent).toContain('Upphaf');
    expect(el.textContent).toContain('Teikning: Everkinetic');
    expect(el.querySelector('a[href="/credits#exercise-illustrations"]')?.getAttribute('aria-label')).toBe('Everkinetic: höfundar teikninga');
  });

  it('notes a load variant', () => {
    setReducedMotion(false);
    const el = mount(createElement(ExerciseIllustration, { ex: EXERCISES.find((e) => e.id === 'weighted-dip')! }));
    expect(el.textContent).toContain('Shown without added weight. The movement is the same.');
  });

  it('renders nothing for custom or unmapped exercises, and nothing after a load error', () => {
    setReducedMotion(false);
    expect(mount(createElement(ExerciseIllustration, { ex: unmapped })).innerHTML).toBe('');
    expect(mount(createElement(ExerciseIllustration, { ex: custom })).innerHTML).toBe('');
    const el = mount(createElement(ExerciseIllustration, { ex: squat }));
    act(() => void el.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(el.querySelector('img')).toBeNull();
  });
});

describe('ExerciseThumb', () => {
  it('shows a decorative thumbnail for mapped exercises and the glyph placeholder otherwise', () => {
    const el = mount(createElement(ExerciseThumb, { ex: squat }));
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/exercise-media/v1/ek-0122/thumb.webp');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('loading')).toBe('lazy');
    act(() => void img.dispatchEvent(new Event('error')));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('svg')).not.toBeNull();

    for (const ex of [unmapped, custom] as Exercise[]) {
      const p = mount(createElement(ExerciseThumb, { ex }));
      expect(p.querySelector('img')).toBeNull();
      expect(p.querySelector('svg')).not.toBeNull();
      expect(hasIllustration(ex)).toBe(false);
    }
    expect(hasIllustration(squat)).toBe(true);
  });
});

describe('load failure is per image, not per row (logger swap)', () => {
  const bench = EXERCISES.find((e) => e.id === 'barbell-bench-press')!;

  it('an illustration that failed (e.g. offline) does not block the next exercise swapped into the same row', () => {
    setReducedMotion(false);
    const el = mount(createElement(ExerciseIllustration, { ex: squat }));
    act(() => void el.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(el.querySelector('img')).toBeNull();
    // Same component instance, new exercise (what ExerciseBlock does on swap).
    rerender(createElement(ExerciseIllustration, { ex: bench }));
    expect([...el.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['/exercise-media/v1/ek-0042/0.webp', '/exercise-media/v1/ek-0042/1.webp']);
    // Swapping back to the failed exercise keeps showing nothing rather than a broken image again.
    rerender(createElement(ExerciseIllustration, { ex: squat }));
    expect(el.querySelector('img')).toBeNull();
  });

  it('a thumbnail that failed does not block the next exercise swapped into the same row', () => {
    const el = mount(createElement(ExerciseThumb, { ex: squat }));
    act(() => void el.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(el.querySelector('img')).toBeNull();
    rerender(createElement(ExerciseThumb, { ex: bench }));
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/exercise-media/v1/ek-0042/thumb.webp');
  });
});

describe('credits', () => {
  it('thumbnail-only surfaces get a shared credit line linking to the credits page', () => {
    const el = mount(createElement(IllustrationCreditsLink));
    expect(el.textContent).toBe('Exercise drawings: Everkinetic, CC BY-SA 4.0. Credits & licences');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/credits#exercise-illustrations');
    const is = mount(createElement(IllustrationCreditsLink), 'is');
    expect(is.textContent).toBe('Æfingateikningar: Everkinetic, CC BY-SA 4.0. Höfundar og leyfi');
  });

  it('the credits page carries the complete attribution: source, creator, licence and the changes notice', () => {
    const el = mount(createElement(CreditsPage));
    const section = el.querySelector('#exercise-illustrations')!.closest('section')!;
    const text = section.textContent!;
    expect(text).toContain('Drawings by Everkinetic (everkinetic.com), created by Greg Priday');
    expect(text).toContain(`Used for ${Object.keys(EXERCISE_MEDIA_MAPPING).length} exercises in the library.`);
    expect(text).toContain('converted them to WebP with a transparent background');
    expect(text).toContain('The adapted drawings are shared under the same licence.');
    expect(section.querySelector('a[href="https://github.com/everkinetic/data"]')).not.toBeNull();
    expect(section.querySelector('a[href="https://creativecommons.org/licenses/by-sa/4.0/"]')?.textContent).toContain('CC BY-SA 4.0');
    const is = mount(createElement(CreditsPage), 'is');
    expect(is.textContent).toContain('Höfundar og leyfi');
    expect(is.textContent).toContain('gerðar af Greg Priday');
    expect(is.textContent).toContain('Aðlöguðu teikningarnar eru birtar með sama leyfi.');
  });
});
