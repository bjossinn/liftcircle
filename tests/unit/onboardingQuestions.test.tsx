// @vitest-environment jsdom
/**
 * Roadmap item 6: onboarding is six quick questions (goal, experience, which days, session length, where you train,
 * anything to be careful with) before the program preview.
 * - Units come from the device locale (en-US → lb, elsewhere kg) instead of a units step; existing accounts keep theirs.
 * - Body details and nutrition are not asked; finishing setup never touches them (full existing profiles stay intact).
 * - Session length drives the generated plan (shorter sessions trimmed, longer ones get more sets, within the time).
 * - Drafts saved by the earlier 12-step wizard resume on the matching question.
 * - "Save plan, start later" / "Accept & start" and the onboarding_completed event are unchanged (onboardingStart.test.tsx
 *   covers Accept & start in depth).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { AccountState, OnboardingAnswers } from '@/domain/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown as import('@/db/db').LiftDb, tracked: [] as string[] }));
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
vi.mock('@/analytics/analytics', async (orig) => {
  const actual = (await orig()) as typeof import('@/analytics/analytics');
  return {
    ...actual,
    trackOnboardingCompleted: (_db: unknown, path: string) => {
      h.tracked.push(path);
      return Promise.resolve(true);
    },
  };
});

const { LiftDb, ACCOUNT_ROW_ID } = await import('@/db/db');
const { alive, kvGet, kvSet } = await import('@/db/repo');
const { defaultAccountState } = await import('@/state/defaults');
const { EXERCISES } = await import('@/data/exercises');
const { generateProgram } = await import('@/domain/program/generator');
const { unitsForLocale, localeRegion } = await import('@/domain/units');
const draftMod = await import('@/features/onboarding/draft');
const { DRAFT_KEY, migrateDraft, newDraft, onboardingUnits, QUESTION_STEPS, stepsFor, STEP_TITLES, trainingDaysOf, validateStep, withTrainingDays } = draftMod;
const { answersSummary } = await import('@/features/onboarding/result');
const OnboardingPage = (await import('@/features/onboarding/OnboardingPage')).default;
const { profileFrom } = await import('@/features/onboarding/OnboardingPage');
const { ToastProvider } = await import('@/components/toast');

let root: Root | null = null;
let el: HTMLDivElement | null = null;
let router: ReturnType<typeof createMemoryRouter>;
let langSpy: ReturnType<typeof vi.spyOn> | null = null;

function setLocale(tag: string) {
  langSpy?.mockRestore();
  langSpy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue([tag]);
}

beforeEach(async () => {
  h.tracked = [];
  localStorage.clear();
  setLocale('en-US');
  h.db = new LiftDb(`onboarding-q-${Math.random().toString(36).slice(2)}`);
  await h.db.open();
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  el?.remove();
  root = null;
  langSpy?.mockRestore();
  langSpy = null;
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
const button = (label: string | RegExp) => {
  const b = [...el!.querySelectorAll<HTMLButtonElement>('button')].find((x) => (typeof label === 'string' ? norm(x.textContent) === label : label.test(norm(x.textContent))));
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

async function mount() {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  router = createMemoryRouter(
    [
      { path: '/onboarding', element: createElement(OnboardingPage) },
      { path: '/train/session/:id', element: createElement('div', null, 'logger') },
      { path: '/', element: createElement('div', null, 'today') },
    ],
    { initialEntries: ['/onboarding'] },
  );
  await act(async () => root!.render(createElement(ToastProvider, null, createElement(RouterProvider, { router }))));
}

/* ----------------------------------------------------------------- pure */
describe('six questions: steps and titles', () => {
  it('plan mode is welcome → 6 questions → preview; manual mode is welcome → manual', () => {
    expect(QUESTION_STEPS).toEqual(['goal', 'experience', 'days', 'duration', 'location', 'limits']);
    expect(stepsFor({ mode: 'plan' })).toEqual(['welcome', 'goal', 'experience', 'days', 'duration', 'location', 'limits', 'result']);
    expect(stepsFor({ mode: 'manual' })).toEqual(['welcome', 'manual']);
    expect(STEP_TITLES.days).toBe('Which days can you train?');
    expect(STEP_TITLES.duration).toBe('How long is a workout?');
    expect(STEP_TITLES.location).toBe('Where do you train?');
    expect(STEP_TITLES.limits).toBe('Anything to be careful with?');
  });

  it('"Which days?" sets the whole week: picked days = training days, all lifting (max 6), spread by the generator', () => {
    const base = newDraft(defaultAccountState(), 'en-GB').a;
    expect(trainingDaysOf(base)).toEqual([1, 3, 5]);
    const a = withTrainingDays(base, [2, 4, 4, 6, 9]);
    expect(a).toMatchObject({ availableWeekdays: [2, 4, 6], totalDaysPerWeek: 3, liftingDaysPerWeek: 3, preferredLiftingWeekdays: [] });
    expect(withTrainingDays(base, [0, 1, 2, 3, 4, 5, 6])).toMatchObject({ totalDaysPerWeek: 7, liftingDaysPerWeek: 6 });
    const v = generateProgram(a, EXERCISES, { startDate: '2026-11-23' });
    expect(new Set(v.schedule.map((s) => s.weekday))).toEqual(new Set([2, 4, 6]));
  });

  it('validation: at least one day; session length within 20–180 min', () => {
    const d = newDraft(defaultAccountState(), 'en-GB');
    expect(validateStep('days', { ...d, a: withTrainingDays(d.a, []) })).toEqual({ availableWeekdays: 'Pick at least one day.' });
    expect(validateStep('days', d)).toEqual({});
    expect(validateStep('duration', { ...d, a: { ...d.a, sessionMinutes: 10 } })).toHaveProperty('sessionMinutes');
    expect(validateStep('duration', d)).toEqual({});
    expect(validateStep('limits', d)).toEqual({}); // optional
  });

  it('answersSummary restates the six answers on the preview', () => {
    const a: OnboardingAnswers = { ...withTrainingDays(newDraft(defaultAccountState(), 'en-GB').a, [1, 3, 5]), goal: 'strength', experience: 'returning', sessionMinutes: 45, location: 'minimal', limitations: ['knee', 'lower_back'] };
    expect(answersSummary(a)).toBe('Improve strength · Returning after a break · Mon, Wed and Fri · 45 min · Minimal · Careful with knees, lower back');
  });
});

describe('units from the device locale', () => {
  it('en-US (and other imperial regions) → lb / ft-in / mi; everywhere else → kg / cm / km', () => {
    expect(unitsForLocale('en-US')).toEqual({ weight: 'lb', length: 'ftin', distance: 'mi' });
    expect(unitsForLocale('es-US')).toMatchObject({ weight: 'lb' });
    expect(unitsForLocale('en_US')).toMatchObject({ weight: 'lb' });
    expect(unitsForLocale('my-MM')).toMatchObject({ weight: 'lb' });
    for (const tag of ['en-GB', 'is-IS', 'de-DE', 'en-AU', 'en-CA', 'fr', 'en', '', undefined, null, 'garbage!!'])
      expect(unitsForLocale(tag as string | undefined), String(tag)).toEqual({ weight: 'kg', length: 'cm', distance: 'km' });
    expect(localeRegion('zh-Hant-TW')).toBe('TW');
  });

  it('a new account gets locale units; an onboarded account or one with units changed in Settings keeps its own', () => {
    const fresh = defaultAccountState();
    expect(newDraft(fresh, 'en-US').a.units.weight).toBe('lb');
    expect(newDraft(fresh, 'is-IS').a.units.weight).toBe('kg');
    const onboarded = { ...fresh, profile: { ...fresh.profile, onboardedAt: 1 } };
    expect(onboardingUnits(onboarded, 'en-US')).toEqual({ weight: 'kg', length: 'cm', distance: 'km' });
    const changed = { ...fresh, settings: { ...fresh.settings, units: { weight: 'kg' as const, length: 'cm' as const, distance: 'mi' as const } } };
    expect(onboardingUnits(changed, 'en-US')).toEqual({ weight: 'kg', length: 'cm', distance: 'mi' });
  });

  it('uses navigator.languages when no locale is passed', () => {
    setLocale('en-US');
    expect(newDraft(defaultAccountState()).a.units.weight).toBe('lb');
    setLocale('is-IS');
    expect(newDraft(defaultAccountState()).a.units.weight).toBe('kg');
  });
});

describe('session length drives the plan', () => {
  const plan = (sessionMinutes: number, experience: OnboardingAnswers['experience'] = 'intermediate') => {
    const a = { ...newDraft(defaultAccountState(), 'en-GB').a, sessionMinutes, experience };
    return generateProgram(a, EXERCISES, { startDate: '2026-11-23' }).templates.filter((t) => t.kind === 'lifting');
  };
  const sets = (ts: ReturnType<typeof plan>) => ts.reduce((n, t) => n + t.exercises.reduce((m, e) => m + e.sets, 0), 0);
  const count = (ts: ReturnType<typeof plan>) => ts.reduce((n, t) => n + t.exercises.length, 0);

  it('every workout fits the chosen time', () => {
    for (const m of [30, 45, 60, 75, 90]) for (const t of plan(m)) expect(t.estimatedMinutes, `${m} min`).toBeLessThanOrEqual(m);
  });

  it('shorter sessions have fewer exercises; longer sessions have more sets (never more than 5 per exercise)', () => {
    expect(count(plan(30))).toBeLessThan(count(plan(60)));
    expect(sets(plan(30))).toBeLessThan(sets(plan(45)));
    expect(sets(plan(45))).toBeLessThan(sets(plan(60)));
    expect(sets(plan(60))).toBeLessThan(sets(plan(75)));
    expect(sets(plan(75))).toBeLessThanOrEqual(sets(plan(90)));
    for (const t of plan(90)) for (const e of t.exercises) expect(e.sets).toBeLessThanOrEqual(5);
  });

  it('newer lifters get at most one extra set per exercise from a longer session', () => {
    const base = plan(60, 'new');
    const long = plan(90, 'new');
    expect(sets(long)).toBeGreaterThan(sets(base));
    for (const t of long) {
      const b = base.find((x) => x.id === t.id)!;
      for (const e of t.exercises) expect(e.sets - (b.exercises.find((x) => x.exerciseId === e.exerciseId)?.sets ?? e.sets)).toBeLessThanOrEqual(1);
    }
  });
});

describe('drafts from the earlier 12-step wizard', () => {
  const legacy = (step: string, over: Partial<OnboardingAnswers> = {}) => {
    const d = newDraft(defaultAccountState(), 'en-GB');
    return { ...d, step: step as never, a: { ...d.a, availableWeekdays: [1, 2, 3, 4, 5, 6, 0], totalDaysPerWeek: 4, liftingDaysPerWeek: 3, preferredLiftingWeekdays: [2], ...over } };
  };

  it('resume on the matching question', () => {
    expect(migrateDraft(legacy('about')).step).toBe('goal');
    expect(migrateDraft(legacy('body')).step).toBe('goal');
    expect(migrateDraft(legacy('schedule')).step).toBe('days');
    expect(migrateDraft(legacy('equipment')).step).toBe('location');
    expect(migrateDraft(legacy('nutrition')).step).toBe('limits');
    expect(migrateDraft(legacy('review')).step).toBe('result');
    expect(migrateDraft(legacy('limits')).step).toBe('limits');
    expect(migrateDraft(legacy('bogus')).step).toBe('welcome');
  });

  it('"available any day" becomes the picked training days for the old day count', () => {
    const d = migrateDraft(legacy('schedule'));
    expect(d.a).toMatchObject({ availableWeekdays: [1, 2, 4, 5], totalDaysPerWeek: 4, liftingDaysPerWeek: 4, preferredLiftingWeekdays: [] });
    const exact = migrateDraft(legacy('schedule', { availableWeekdays: [1, 3, 6], totalDaysPerWeek: 3, preferredLiftingWeekdays: [] }));
    expect(exact.a.availableWeekdays).toEqual([1, 3, 6]);
  });
});

describe('finishing setup keeps existing data', () => {
  it('only goal, experience and areas to be careful with change on the profile', () => {
    const prev = {
      ...defaultAccountState().profile,
      displayName: 'Björn', age: 41, heightCm: 182, sexParam: 'male' as const, targetWeightKg: 85, activityLevel: 'moderate' as const,
      diet: { ...defaultAccountState().profile.diet, tags: ['high_protein' as const] }, injuryNotes: 'old knee', individualizedNutrition: false,
    };
    const a = { ...newDraft(defaultAccountState(), 'en-GB').a, goal: 'strength' as const, experience: 'advanced' as const, limitations: ['shoulder' as const] };
    const next = profileFrom(a, prev);
    expect(next).toMatchObject({ displayName: 'Björn', age: 41, heightCm: 182, sexParam: 'male', targetWeightKg: 85, activityLevel: 'moderate', injuryNotes: 'old knee', goal: 'strength', experience: 'advanced', limitations: ['shoulder'] });
    expect(next.diet.tags).toEqual(['high_protein']);
    expect(next.onboardedAt).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ UI */
describe('OnboardingPage: six questions → preview', () => {
  it('walks the six questions in about a minute and saves a plan that matches the answers (en-US → lb)', async () => {
    await mount();
    await waitFor(() => expect(heading()).toBe('Welcome to Hard Earned'));
    expect(counter()).toBe('About a minute');
    expect(norm(el!.textContent)).toContain('Six quick questions');
    await click(button('Get started'));

    expect(counter()).toBe('Question 1 of 6');
    expect(heading()).toBe('What’s your main goal?');
    expect(el!.querySelectorAll('[role="radiogroup"][aria-label="Main goal"] [role="radio"]')).toHaveLength(5);
    await click(option('Improve strength'));
    await click(button('Continue'));

    expect(counter()).toBe('Question 2 of 6');
    expect(el!.querySelectorAll('[role="radiogroup"][aria-label="Experience"] [role="radio"]')).toHaveLength(4);
    await click(option('Intermediate'));
    await click(button('Continue'));

    expect(counter()).toBe('Question 3 of 6');
    expect(heading()).toBe('Which days can you train?');
    expect(chip('Training days', 'Mon').getAttribute('aria-checked')).toBe('true');
    expect(chip('Training days', 'Tue').getAttribute('aria-checked')).toBe('false');
    await click(chip('Training days', 'Tue'));
    expect(norm(el!.textContent)).toContain('4 days a week.');
    await click(button('Continue'));

    expect(counter()).toBe('Question 4 of 6');
    await click(option('45 minutes'));
    await click(button('Continue'));

    expect(counter()).toBe('Question 5 of 6');
    expect(heading()).toBe('Where do you train?');
    await click(option('Home gym'));
    await click(button('Continue'));

    expect(counter()).toBe('Question 6 of 6');
    await click(chip('Limitation areas', 'Knees'));
    await click(button('Build my plan'));

    await waitFor(() => expect(heading()).toBe('Your plan'));
    expect(norm(el!.querySelector('[data-testid="answers-summary"]')?.textContent)).toBe('Improve strength · Intermediate · Mon, Tue, Wed and Fri · 45 min · Home gym · Careful with knees');
    // No body-detail or nutrition questions anywhere on the way.
    expect(norm(el!.textContent)).not.toMatch(/Nutrition targets|Current weight|What should we call you/);

    await click(button('Save plan, start later'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const [p] = alive(await h.db.programs.toArray());
    const v = p.versions[p.versions.length - 1];
    expect(new Set(v.schedule.map((s) => s.weekday))).toEqual(new Set([1, 2, 3, 5]));
    for (const t of v.templates.filter((x) => x.kind === 'lifting')) expect(t.estimatedMinutes).toBeLessThanOrEqual(45);
    expect(p.inputs).toMatchObject({ goal: 'strength', experience: 'intermediate', sessionMinutes: 45, location: 'home_gym', limitations: ['knee'] });
    const acc = (await h.db.account.get(ACCOUNT_ROW_ID))!;
    expect(acc.settings.units).toEqual({ weight: 'lb', length: 'ftin', distance: 'mi' });
    expect(acc.profile).toMatchObject({ goal: 'strength', experience: 'intermediate', limitations: ['knee'] });
    expect(acc.profile.onboardedAt).toBeGreaterThan(0);
    expect(acc.settings.nutritionEnabled).toBe(false); // nutrition is set up later, not here
    expect(h.tracked).toEqual(['suggested']);
    expect(await h.db.measurements.count()).toBe(0);
  });

  it('elsewhere (is-IS) the plan is saved in kg', async () => {
    setLocale('is-IS');
    await mount();
    await waitFor(() => button('Get started'));
    await click(button('Get started'));
    for (let i = 0; i < 5; i++) await click(button('Continue'));
    await click(button('Build my plan'));
    await waitFor(() => button('Save plan, start later'));
    await click(button('Save plan, start later'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect((await h.db.account.get(ACCOUNT_ROW_ID))!.settings.units.weight).toBe('kg');
  });

  it('“Which days?” with no day picked shows an error and stays on the question', async () => {
    await mount();
    await waitFor(() => button('Get started'));
    await click(button('Get started'));
    await click(button('Continue'));
    await click(button('Continue'));
    for (const d of ['Mon', 'Wed', 'Fri']) await click(chip('Training days', d));
    await click(button('Continue'));
    expect(counter()).toBe('Question 3 of 6');
    expect(norm(el!.textContent)).toContain('Pick at least one day.');
  });

  it('an existing account with a full profile, nutrition targets and kg keeps all of it after redoing setup', async () => {
    const base = defaultAccountState();
    const full: AccountState = {
      ...base,
      settings: { ...base.settings, units: { weight: 'kg', length: 'cm', distance: 'km' }, nutritionEnabled: true },
      profile: { ...base.profile, displayName: 'Björn', age: 41, heightCm: 182, sexParam: 'male', onboardedAt: 1_700_000_000_000, goal: 'build_muscle', experience: 'returning', diet: { ...base.profile.diet, tags: ['high_protein'] } },
      nutrition: { ...base.nutrition, mode: 'full', proteinG: 160, calories: 2600, updatedAt: 1 },
    };
    await h.db.account.put({ ...full, id: ACCOUNT_ROW_ID } as AccountState & { id: string });
    const d = newDraft(full);
    d.step = 'result';
    await kvSet(DRAFT_KEY, d, h.db);
    await mount();
    await waitFor(() => button('Accept & start'));
    await click(button('Accept & start'));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/train\/session\//));
    const acc = (await h.db.account.get(ACCOUNT_ROW_ID))!;
    expect(acc.settings.units).toEqual({ weight: 'kg', length: 'cm', distance: 'km' }); // en-US locale doesn't override
    expect(acc.settings.nutritionEnabled).toBe(true);
    expect(acc.nutrition).toMatchObject({ mode: 'full', proteinG: 160, calories: 2600 });
    expect(acc.profile).toMatchObject({ displayName: 'Björn', age: 41, heightCm: 182, sexParam: 'male', diet: { tags: ['high_protein'] } });
    expect(h.tracked).toEqual(['suggested']);
    expect(await kvGet(DRAFT_KEY, h.db)).toBeUndefined();
  });

  it('a draft saved mid-way through the old wizard resumes on the matching question', async () => {
    const d = newDraft(defaultAccountState());
    await kvSet(DRAFT_KEY, { ...d, step: 'equipment' }, h.db);
    await mount();
    await waitFor(() => expect(counter()).toBe('Question 5 of 6'));
    expect(heading()).toBe('Where do you train?');
  });

  it('manual mode creates an empty program without any questions', async () => {
    await mount();
    await waitFor(() => button('Get started'));
    await click(button(/^I already have a program/));
    await click(button('Get started'));
    expect(heading()).toBe('Your own program');
    await click(button('Create my program'));
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/onboarding'));
    expect(alive(await h.db.programs.toArray())).toHaveLength(1);
    expect(h.tracked).toEqual(['manual']);
  });
});
