// @vitest-environment jsdom
/**
 * Direction B session marks + localized wizard session names on the screens that show program sessions:
 *  - SessionCard (onboarding result / program editor): Upper A and Upper B render different marks and letter badges.
 *  - Today and Train: generated session names render in the display language (stored data stays English) and every
 *    program session row on Train has its own mark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { OnboardingAnswers, SessionTemplate } from '@/domain/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown, account: null as unknown }));
vi.mock('@/state/app', () => ({
  useApp: () => ({
    db: h.db,
    account: h.account,
    accountReady: true,
    auth: { status: 'guest' },
    online: true,
    backendConfigured: false,
    updateAccount: async () => undefined,
  }),
  useDb: () => h.db,
  useSettings: () => (h.account as { settings: unknown }).settings,
}));

const { LiftDb } = await import('@/db/db');
const { defaultAccountState } = await import('@/state/defaults');
const { EXERCISES } = await import('@/data/exercises');
const { generateProgram } = await import('@/domain/program/generator');
const { createProgram, currentVersion } = await import('@/domain/program/program');
const { setLanguage, t } = await import('@/i18n');
const { SessionCard } = await import('@/features/program/parts');
const { sessionDisplayName } = await import('@/domain/program/localize');
const TodayPage = (await import('@/features/today/TodayPage')).default;
const TrainPage = (await import('@/features/train/TrainPage')).default;
const { ToastProvider } = await import('@/components/toast');

let root: Root | null = null;
let el: HTMLDivElement | null = null;
let dbCount = 0;
const tick = (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function waitFor<T>(fn: () => T, tries = 150): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries) throw e;
      await tick();
    }
  }
}
async function render(node: ReactElement) {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, null, node))));
}

function answers(over: Partial<OnboardingAnswers> = {}): OnboardingAnswers {
  return {
    displayName: 'Test', units: { weight: 'kg', length: 'cm', distance: 'km' }, goal: 'build_muscle', experience: 'intermediate',
    totalDaysPerWeek: 7, liftingDaysPerWeek: 3, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], preferredLiftingWeekdays: [], sessionMinutes: 60,
    location: 'full_gym', equipment: [], preferredActivities: [], enjoyedExerciseIds: [], excludedExerciseIds: [], limitations: [],
    activityLevel: 'moderate', wantsNutrition: false,
    diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 },
    ...over,
  };
}
const todayIso = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  h.db = new LiftDb(`marks-${++dbCount}`);
  h.account = defaultAccountState();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  el?.remove();
  setLanguage('en');
});

describe('SessionCard marks', () => {
  it('Upper A and Upper B do not render the same mark or letter badge', async () => {
    const v = generateProgram(answers({ splitPreference: 'ul4', liftingDaysPerWeek: 4, totalDaysPerWeek: 4, experience: 'advanced' }), EXERCISES, { startDate: '2026-11-02' });
    const byId = new Map(EXERCISES.map((e) => [e.id, e]));
    const upperA = v.templates.find((x) => x.name === 'Upper A') as SessionTemplate;
    const upperB = v.templates.find((x) => x.name === 'Upper B') as SessionTemplate;
    await render(
      createElement('div', null, ...[upperA, upperB].map((template) => createElement(SessionCard, { key: template.id, template, byId, catalog: EXERCISES, unit: 'kg', defaultOpen: false }))),
    );
    const cards = [...el!.querySelectorAll('article')];
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Upper A', 'Upper B']);
    const marks = cards.map((c) => c.querySelector('[data-testid="session-mark"]')!.getAttribute('data-session-mark'));
    expect(marks).toEqual(['upper:A', 'upper:B']);
    const letters = cards.map((c) => c.querySelector('[data-testid="session-mark-letter"]')!.textContent);
    expect(letters).toEqual(['A', 'B']);
    // Direction B tile: duotone well, theme tokens only.
    const tile = cards[0].querySelector('[data-testid="session-mark"]')!.parentElement!;
    expect(tile.className).toContain('bg-surface-2');
    expect(tile.className).toContain('text-accent');
  });
});

describe('Today and Train show localized wizard session names', () => {
  async function seed() {
    const v = generateProgram(answers(), EXERCISES, { startDate: todayIso() });
    const program = createProgram(answers(), v, todayIso(), 'Full-body A/B/C', 'generated');
    await (h.db as InstanceType<typeof LiftDb>).programs.put(program);
    return currentVersion(program);
  }

  it('Train: Icelandic names on the start button and every program row, each row with its own mark', async () => {
    const v = await seed();
    setLanguage('is');
    await render(createElement(TrainPage));
    const fbA = t('program.template.fullBodyA', undefined, 'is');
    await waitFor(() => expect(el!.textContent).toContain(fbA));
    expect(fbA).not.toBe('Full body A');
    expect(el!.textContent).not.toContain('Full body A');
    expect(el!.textContent).toContain(t('program.template.fullBodyB', undefined, 'is'));
    expect(el!.querySelector(`[aria-label="${t('train.startNamed', { name: fbA }, 'is')}"]`)).not.toBeNull();
    const marks = [...el!.querySelectorAll('[data-testid="session-mark"]')].map((m) => m.getAttribute('data-session-mark'));
    expect(marks.length).toBe(v.templates.length);
    expect(new Set(marks).size).toBe(marks.length);
  });

  it('Today: the next session tile shows the Icelandic name and its session mark', async () => {
    const v = await seed();
    setLanguage('is');
    await render(createElement(TodayPage));
    await waitFor(() => expect(el!.querySelector('[data-testid="session-mark"]')).not.toBeNull());
    const shown = el!.textContent ?? '';
    const localized = v.templates.map((x) => sessionDisplayName(x, 'is'));
    expect(localized.some((name) => shown.includes(name))).toBe(true);
    expect(shown).not.toMatch(/Full body [ABC]|Easy walk|Mobility/);
  });
});
