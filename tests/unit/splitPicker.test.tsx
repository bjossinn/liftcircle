// @vitest-environment jsdom
/**
 * Split selector in the wizard's schedule step (UI-level; no backend). Uses react-dom/client + act
 * directly (see aiUi.test.ts for why @testing-library is not used).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScheduleStep } from '@/features/onboarding/steps';
import { newDraft, type Draft } from '@/features/onboarding/draft';
import { defaultAccountState } from '@/state/defaults';
import type { OnboardingAnswers } from '@/domain/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: Draft | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
});

function Harness({ initial }: { initial: Draft }) {
  const [d, setD] = useState(initial);
  latest = d;
  const set = (patch: Partial<OnboardingAnswers>) => setD((x) => ({ ...x, a: { ...x.a, ...patch } }));
  return createElement(ScheduleStep, { d, set, setDraft: (fn: (x: Draft) => Draft) => setD(fn), errors: {}, byId: new Map() });
}

function mount(over: Partial<OnboardingAnswers> = {}) {
  const d = newDraft(defaultAccountState());
  d.a = { ...d.a, ...over };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(Harness, { initial: d })));
}

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const splitGroup = () => [...host!.querySelectorAll('[role="radiogroup"]')].find((g) => g.getAttribute('aria-labelledby') && text(document.getElementById(g.getAttribute('aria-labelledby')!)) === 'Workout split') as HTMLElement;
const splitRadios = () => [...splitGroup().querySelectorAll('[role="radio"]')] as HTMLElement[];
const checkedSplit = () => text(splitRadios().find((r) => r.getAttribute('aria-checked') === 'true') ?? null);
const radioNamed = (re: RegExp) => splitRadios().find((r) => re.test(text(r)))!;
const setLiftingDays = (n: number) => {
  const g = host!.querySelector('[aria-label="Lifting days per week"]')!;
  const b = [...g.querySelectorAll('[role="radio"]')].find((x) => text(x) === String(n)) as HTMLElement;
  act(() => b.click());
};

describe('wizard split selector', () => {
  it('shows the structures that fit, with the recommendation and tradeoffs', () => {
    mount({ experience: 'new' });
    expect(splitRadios().map((r) => text(r.querySelector('.font-medium')))).toEqual(['Full-body A/B/C Recommended', 'Upper / Lower / Full body', 'Push / Pull / Legs']);
    expect(checkedSplit()).toMatch(/^Full-body A\/B\/C/);
    expect(text(radioNamed(/^Push \/ Pull \/ Legs/))).toMatch(/once a week/);
  });

  it('stores an explicit choice and keeps the intent when the lifting-day count changes', () => {
    mount({ experience: 'returning' });
    act(() => radioNamed(/^Upper \/ Lower \/ Full body/).click());
    expect(latest!.a.splitPreference).toBe('ulf');
    expect(checkedSplit()).toMatch(/^Upper \/ Lower \/ Full body/);

    setLiftingDays(2);
    expect(splitRadios().map((r) => text(r.querySelector('.font-medium')))).toEqual(['Full-body A/B Recommended', 'Upper / Lower']);
    expect(checkedSplit()).toMatch(/^Upper \/ Lower/);
    expect(text(host!.querySelector('[role="status"]'))).toMatch(/closest structure: Upper \/ Lower/);
    expect(latest!.a.splitPreference).toBe('ulf'); // intent kept, not overwritten

    setLiftingDays(3);
    expect(checkedSplit()).toMatch(/^Upper \/ Lower \/ Full body/);
    expect(host!.querySelector('[role="status"]')).toBeNull();
  });

  it('1 lifting day: full body only; 0 days: no selector', () => {
    mount({ liftingDaysPerWeek: 1 });
    expect(splitRadios()).toHaveLength(1);
    expect(checkedSplit()).toMatch(/^Full-body session/);
    setLiftingDays(0);
    expect(splitGroup()).toBeUndefined();
  });
});
