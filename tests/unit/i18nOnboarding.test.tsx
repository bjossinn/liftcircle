// @vitest-environment jsdom
/**
 * Onboarding in Icelandic (roadmap item 8): the six questions, their options, validation and the plan preview use the
 * approved copy, and switching language mid-setup only changes display text (draft answers and units are untouched).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { AccountState } from '@/domain/types';
import type { Language } from '@/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown as import('@/db/db').LiftDb }));
vi.mock('@/state/app', async () => {
  const { useLiveQuery } = await import('dexie-react-hooks');
  const { defaultAccountState } = await import('@/state/defaults');
  const { saveRecord } = await import('@/db/repo');
  const { ACCOUNT_ROW_ID: ROW } = await import('@/db/db');
  const useApp = () => {
    const row = useLiveQuery(async () => (await h.db.account.get(ROW)) ?? null, [h.db]);
    const account = row ?? defaultAccountState();
    return {
      db: h.db,
      auth: { status: 'guest' as const },
      account,
      accountReady: row !== undefined,
      online: true,
      backendConfigured: false,
      updateAccount: async (fn: (a: AccountState) => AccountState) => {
        const cur = (await h.db.account.get(ROW)) ?? defaultAccountState();
        await saveRecord('account_state', fn(cur), h.db);
      },
    };
  };
  return { useApp, useDb: () => h.db, useSettings: () => useApp().account.settings, isDemoMode: () => false, DEMO_KEY: 'lc-demo' };
});
vi.mock('@/analytics/analytics', async (orig) => ({ ...((await orig()) as object), trackOnboardingCompleted: () => Promise.resolve(true) }));

const { LiftDb } = await import('@/db/db');
const { kvGet } = await import('@/db/repo');
const { defaultAccountState } = await import('@/state/defaults');
const { LanguageProvider, setLanguage, t } = await import('@/i18n');
const { DRAFT_KEY, newDraft, STEP_TITLES, stepTitle, validateStep, withTrainingDays, ALLERGEN_LABELS } = await import('@/features/onboarding/draft');
const { GOAL_OPTIONS, EXPERIENCE_OPTIONS, DURATION_OPTIONS } = await import('@/features/onboarding/steps');
const { answersSummary } = await import('@/features/onboarding/result');
const { rxSummary } = await import('@/features/program/parts');
const OnboardingPage = (await import('@/features/onboarding/OnboardingPage')).default;
const { ToastProvider } = await import('@/components/toast');

let root: Root | null = null;
let el: HTMLDivElement | null = null;
let switchLanguage: (l: Language) => void = () => undefined;

beforeEach(async () => {
  localStorage.clear();
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['is-IS']);
  h.db = new LiftDb(`onboarding-is-${Math.random().toString(36).slice(2)}`);
  await h.db.open();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  el?.remove();
  root = null;
  vi.restoreAllMocks();
  setLanguage('en');
  h.db.close();
  await h.db.delete();
});

const tick = (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function waitFor<T>(fn: () => T | Promise<T>, tries = 200): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await tick();
    }
  }
}
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const button = (label: string) => {
  const b = [...el!.querySelectorAll<HTMLButtonElement>('button')].find((x) => norm(x.textContent) === label);
  if (!b) throw new Error(`no button ${label}`);
  return b;
};
const option = (title: string) => {
  const b = [...el!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((x) => x.querySelector('.font-medium')?.textContent === title);
  if (!b) throw new Error(`no option ${title}`);
  return b;
};
const chip = (group: string, label: string) => {
  const g = el!.querySelector(`[role="group"][aria-label="${group}"]`);
  const b = [...(g?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((x) => norm(x.textContent) === label);
  if (!b) throw new Error(`no chip ${label} in ${group}`);
  return b;
};
const heading = () => norm(el!.querySelector('h1')?.textContent);
const counter = () => norm(el!.querySelector('header [aria-live]')?.textContent);
const click = (b: HTMLElement) => act(async () => b.click());

function Harness({ initial }: { initial: Language }) {
  const [language, setLang] = useState<Language>(initial);
  switchLanguage = (l) => setLang(l);
  const router = useState(() =>
    createMemoryRouter(
      [
        { path: '/onboarding', element: createElement(OnboardingPage) },
        { path: '/', element: createElement('div', null, 'today') },
      ],
      { initialEntries: ['/onboarding'] },
    ),
  )[0];
  return createElement(LanguageProvider, { language, children: createElement(ToastProvider, null, createElement(RouterProvider, { router })) });
}
async function mount(language: Language) {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(Harness, { initial: language })));
}

describe('onboarding copy in Icelandic', () => {
  it('question titles, options and validation use the approved Icelandic copy', () => {
    setLanguage('is');
    expect(STEP_TITLES.goal).toBe('Hvert er helsta markmiðið þitt?');
    expect(stepTitle('days')).toBe('Hvaða daga geturðu æft?');
    expect(GOAL_OPTIONS.map((g) => g.title)).toEqual(['Byggja upp vöðva', 'Auka styrk', 'Minnka fitu', 'Bæta almennt form', 'Auka úthald']);
    expect(EXPERIENCE_OPTIONS.find((o) => o.value === 'intermediate')?.title).toBe('Nokkur reynsla');
    expect(DURATION_OPTIONS[0].title).toBe('30 mínútur');
    expect(ALLERGEN_LABELS.peanuts).toBe(t('onboarding.allergen.peanuts'));

    const d = newDraft(defaultAccountState(), 'is-IS');
    expect(validateStep('days', { ...d, a: withTrainingDays(d.a, []) })).toEqual({ availableWeekdays: 'Veldu að minnsta kosti einn dag.' });
    expect(validateStep('duration', { ...d, a: { ...d.a, sessionMinutes: 10 } })).toEqual({ sessionMinutes: t('onboarding.validation.minMinutes') });
    expect(validateStep('duration', { ...d, a: { ...d.a, sessionMinutes: 999 } })).toEqual({ sessionMinutes: t('onboarding.validation.maxMinutes') });
    // No raw Zod text: unknown enum / number problems get the authored fallbacks.
    expect(validateStep('goal', { ...d, a: { ...d.a, goal: 'bogus' as never } })).toEqual({ goal: t('onboarding.validation.invalidOption') });
    expect(validateStep('duration', { ...d, a: { ...d.a, sessionMinutes: 45.5 } })).toEqual({ sessionMinutes: t('onboarding.validation.invalidNumber') });
    expect(validateStep('manual', { ...d, manual: { sessions: 9, days: [] } })).toEqual({ sessions: t('onboarding.validation.manualCount') });

    // English stays as it was.
    setLanguage('en');
    expect(validateStep('days', { ...d, a: withTrainingDays(d.a, []) })).toEqual({ availableWeekdays: 'Pick at least one day.' });
    expect(validateStep('goal', { ...d, a: { ...d.a, goal: 'bogus' as never } })).toEqual({ goal: 'Choose a valid option.' });
  });

  it('the plan summary and prescriptions format for Icelandic (decimal comma, translated fragments)', () => {
    setLanguage('is');
    const d = newDraft(defaultAccountState(), 'is-IS');
    const a = { ...withTrainingDays(d.a, [1, 3, 5]), goal: 'strength' as const, experience: 'returning' as const, sessionMinutes: 45, location: 'minimal' as const, limitations: ['knee' as const] };
    const s = answersSummary(a);
    expect(s.startsWith('Auka styrk · Aftur af stað eftir hlé · ')).toBe(true);
    expect(s).toContain(t('onboarding.result.minutes', { minutes: 45 }));
    expect(s).toContain(t('onboarding.result.carefulWith', { areas: 'hné' }));
    expect(s).not.toMatch(/ and |Careful with/);
    const rx = { id: 'x', exerciseId: 'bench', sets: 3, repMin: 6, repMax: 8, targetRir: 2, restSec: 120, priority: 1, alternatives: [], startLoadKg: 62.5 } as never;
    expect(rxSummary(rx, undefined, 'kg')).toContain('byrja með 62,5 kg');
    expect(rxSummary({ ...(rx as object), startLoadKg: undefined, calibrate: true } as never, { unilateral: true } as never, 'kg')).toMatch(/finna byrjunarþyngd · á hvora hlið$/);
  });
});

describe('OnboardingPage in Icelandic', () => {
  it('renders the questions in Icelandic, shows Icelandic validation, and a language switch keeps the draft and units', async () => {
    await mount('en');
    await waitFor(() => expect(heading()).toBe('Welcome to Hard Earned'));
    await click(button('Get started'));
    await click(option('Improve strength'));
    await click(button('Continue'));
    await click(button('Continue'));
    expect(heading()).toBe('Which days can you train?');
    await click(chip('Training days', 'Tue'));
    await tick(400); // debounced draft save
    const before = await kvGet<{ a: { units: unknown; availableWeekdays: number[]; goal: string } }>(DRAFT_KEY, h.db);
    expect(before?.a.goal).toBe('strength');
    expect(before?.a.units).toEqual({ weight: 'kg', length: 'cm', distance: 'km' });

    await act(async () => switchLanguage('is'));
    expect(heading()).toBe('Hvaða daga geturðu æft?');
    expect(counter()).toBe('Spurning 3 af 6');
    expect(chip('Æfingadagar', 'mán.').getAttribute('aria-checked')).toBe('true');
    expect(chip('Æfingadagar', 'þri.').getAttribute('aria-checked')).toBe('true');
    expect(norm(el!.textContent)).toContain('4 dagar í viku.');
    await tick(400);
    expect(await kvGet(DRAFT_KEY, h.db)).toEqual(before);

    // Clear the days → Icelandic validation.
    for (const day of ['mán.', 'þri.', 'mið.', 'fös.']) await click(chip('Æfingadagar', day));
    await click(button('Áfram'));
    expect(norm(el!.textContent)).toContain('Veldu að minnsta kosti einn dag.');
    expect(norm(el!.textContent)).toContain(t('onboarding.fixField.one', undefined, 'is'));
    expect(heading()).toBe('Hvaða daga geturðu æft?');

    // Back on the goal question in Icelandic, the earlier answer is still selected.
    await click(el!.querySelector<HTMLButtonElement>(`button[aria-label="${t('onboarding.back', undefined, 'is')}"]`)!);
    await click(el!.querySelector<HTMLButtonElement>(`button[aria-label="${t('onboarding.back', undefined, 'is')}"]`)!);
    expect(heading()).toBe('Hvert er helsta markmiðið þitt?');
    expect(el!.querySelectorAll('[role="radiogroup"][aria-label="Aðalmarkmið"] [role="radio"]')).toHaveLength(5);
    expect(option('Auka styrk').getAttribute('aria-checked')).toBe('true');
  });
});
