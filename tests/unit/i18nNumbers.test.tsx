// @vitest-environment jsdom
/** Distance/speed displays and uncontrolled numeric inputs follow the language's decimal separator. */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LanguageProvider, setLanguage, type Language } from '@/i18n';
import { formatDistance, formatPace, formatSpeed, formatLength, formatCircumference } from '@/domain/units';
import { paceOrSpeed } from '@/domain/activities';
import { NumberInput } from '@/components/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => setLanguage('en'));

describe('distance and speed formatting', () => {
  it('English is unchanged', () => {
    expect(formatDistance(10250, 'km')).toBe('10.25 km');
    expect(formatSpeed(20.54, 'km')).toBe('20.5 km/h');
    expect(paceOrSpeed({ type: 'cycle', distanceM: 10250, durationSec: 1800 }, 'km')!.text).toBe('20.5 km/h');
    expect(paceOrSpeed({ type: 'run', distanceM: 10000, durationSec: 3300 }, 'km')!.text).toBe('5:30 /km');
    expect(formatLength(180.5, 'cm')).toBe('180.5 cm');
  });

  it('Icelandic uses a decimal comma; units, pace clock and values unchanged', () => {
    setLanguage('is');
    expect(formatDistance(10250, 'km')).toBe('10,25 km');
    expect(formatDistance(10250, 'km', 2, 'en')).toBe('10.25 km');
    expect(formatSpeed(20.54, 'km')).toBe('20,5 km/h');
    expect(formatSpeed(12.34, 'mi')).toBe('12,3 mph');
    const r = paceOrSpeed({ type: 'cycle', distanceM: 10250, durationSec: 1800 }, 'km')!;
    expect(r.text).toBe('20,5 km/h');
    expect(r.value).toBeCloseTo(20.5, 5);
    expect(paceOrSpeed({ type: 'run', distanceM: 10000, durationSec: 3300 }, 'km')!.text).toBe('5:30 /km');
    expect(formatPace(330, 'km')).toBe('5:30 /km');
    expect(formatLength(180.5, 'cm')).toBe('180,5 cm');
    expect(formatCircumference(80.5, 'cm')).toBe('80,5 cm');
  });
});

describe('NumberInput on language change', () => {
  let root: Root | null = null;
  let el: HTMLElement | null = null;
  let switchTo: (l: Language) => void = () => {};
  afterEach(() => {
    act(() => root?.unmount());
    el?.remove();
  });
  function Harness() {
    const [language, setLang] = useState<Language>('en');
    const [a, setA] = useState<number | null>(2.5);
    const [b, setB] = useState<number | null>(1.25);
    switchTo = setLang;
    return createElement(LanguageProvider, {
      language,
      children: [
        createElement(NumberInput, { key: 'a', ariaLabel: 'a', value: a, onChange: setA }),
        createElement(NumberInput, { key: 'b', ariaLabel: 'b', value: b, onChange: setB }),
      ],
    });
  }
  const input = (name: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;

  it('rewrites unfocused saved values and keeps an active draft', async () => {
    el = document.createElement('div');
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(createElement(Harness)));
    expect(input('a').value).toBe('2.5');

    input('b').focus();
    input('b').value = '3.75';
    await act(async () => switchTo('is'));
    expect(input('a').value).toBe('2,5');
    expect(input('b').value).toBe('3.75'); // the draft being typed is untouched

    await act(async () => input('b').blur());
    expect(input('b').value).toBe('3,75');
  });
});
