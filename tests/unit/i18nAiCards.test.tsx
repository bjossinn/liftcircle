// @vitest-environment jsdom
/**
 * Icelandic AI action cards (roadmap item 8, spec §5): Session / Week / Meal plan / Recipe cards, the proposal detail
 * and the proposals list render the approved copy in pending / applied / undo states; describeChanges, validation,
 * applyProposal / applyWeekPlan texts follow the language; persisted version reasons stay English and are localized
 * at render. Real Dexie (fake-indexeddb), mocked app state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  db: null as unknown,
  account: null as unknown,
  updateAccount: (async () => undefined) as (fn: unknown) => Promise<void>,
}));

vi.mock('@/state/app', () => ({
  useApp: () => ({
    db: h.db,
    auth: { status: 'signed_in', userId: 'user-1' },
    account: h.account,
    accountReady: true,
    online: true,
    backendConfigured: true,
    updateAccount: h.updateAccount,
  }),
  useDb: () => h.db,
  useSettings: () => (h.account as { settings: unknown }).settings,
}));
vi.mock('@/backend/ai', () => ({
  aiApi: { listProposals: vi.fn(async () => []), respondProposal: vi.fn(async () => undefined) },
}));
vi.mock('@/backend/coaching', () => ({ coachingApi: { myRelationships: vi.fn(async () => []), sendMessage: vi.fn() } }));

import { setLanguage, t, tp } from '@/i18n';
import { LiftDb } from '@/db/db';
import { kvSet, saveRecord } from '@/db/repo';
import { ToastProvider } from '@/components/toast';
import { defaultAccountState } from '@/state/defaults';
import { EXERCISES } from '@/data/exercises';
import { exerciseDisplayName, ingredientDisplayName, recipeDisplayName } from '@/data/catalogText';
import { RECIPES } from '@/data/recipes';
import { createProgram, withNewVersion } from '@/domain/program/program';
import {
  applyProposal, describeChanges, rationaleLineText, takeOverPlan, validateProposedProgram, versionReasonText,
} from '@/domain/program/proposals';
import { applyWeekPlan, type WeekPlan } from '@/domain/program/schedule';
import { toMealPlanSuggestion, toRecipeSuggestions } from '@/domain/nutrition/aiActions';
import { addDays, formatDate, startOfWeek, todayISO, weekdayShort } from '@/lib/dates';
import type { AccountState, Program, ProgramVersion, WorkoutSession } from '@/domain/types';
import type { ProgramProposal } from '@/backend/coachingContract';
import type { SessionAdjustmentAction } from '../../supabase/functions/_shared/ai/workout';
import { SessionAdjustmentCard } from '@/features/coaching/ai/SessionAdjustmentCard';
import { WeekPlanCard } from '@/features/coaching/ai/WeekPlanCard';
import { MealPlanCard } from '@/features/coaching/ai/MealPlanCard';
import { changesText, RecipeCards } from '@/features/coaching/ai/RecipeCards';
import { ProposalDetail } from '@/features/coaching/ai/ProposalDetail';
import { applyAiProposal } from '@/features/coaching/ai/apply';
import { AI_SESSION_ADJUST_KEY } from '@/features/coaching/ai/sessionAdjustStore';

/* ---------------------------------------------------------------- harness */
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const mounted: { root: Root; container: HTMLElement }[] = [];
function render(el: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(ToastProvider, null, createElement(MemoryRouter, null, el))));
  mounted.push({ root, container });
  return container;
}
async function waitFor<T>(fn: () => T | Promise<T>, timeout = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fn();
      await act(async () => {
        await new Promise((res) => setTimeout(res, 0));
      });
      return r;
    } catch (e) {
      if (Date.now() - start > timeout) throw e;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15));
      });
    }
  }
}
const buttons = (scope: ParentNode = document.body) => [...scope.querySelectorAll('button')].map((b) => norm(b.textContent));
function button(name: string, scope: ParentNode = document.body): HTMLButtonElement {
  const b = [...scope.querySelectorAll('button')].find((x) => norm(x.textContent) === name);
  if (!b) throw new Error(`No button "${name}" in: ${buttons(scope).join(' | ')}`);
  return b as HTMLButtonElement;
}
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
const bodyText = () => norm(document.body.textContent);

let dbCount = 0;
beforeEach(() => {
  setLanguage('is');
  h.db = new LiftDb(`i18n-ai-cards-${++dbCount}`);
  const acc = defaultAccountState();
  acc.settings.timeZone = 'UTC';
  acc.settings.language = 'is';
  h.account = acc;
  h.updateAccount = vi.fn(async () => undefined);
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.container.remove();
  }
  await (h.db as LiftDb).delete();
  setLanguage('en');
});

/* --------------------------------------------------------------- fixtures */
const EX = EXERCISES.slice(0, 2);
function version(sets = 3, weeks = 8): ProgramVersion {
  return {
    version: 1,
    createdAt: Date.now(),
    reason: 'test',
    templates: [
      {
        id: 'tA', name: 'Full body A', focus: 'Full body', kind: 'lifting', estimatedMinutes: 45,
        exercises: EX.map((e, i) => ({ id: `s${i}`, exerciseId: e.id, sets, repMin: 8, repMax: 12, targetRir: 2, restSec: 90, warmup: '', priority: 1, alternatives: [] })),
      },
    ],
    schedule: [{ weekday: 1, templateId: 'tA' }],
    weeks,
    reviewWeek: weeks,
    rationale: [],
    warnings: [],
  };
}
function basePlan(): Program {
  return { ...createProgram(null, version(), '2026-10-01', 'My plan', 'manual'), active: true };
}
function proposalFor(base: Program, over: Partial<ProgramProposal> = {}): ProgramProposal {
  const { version: _v, createdAt: _c, ...content } = version(4);
  void _v;
  void _c;
  return {
    id: 'prop-1', authorKind: 'ai', clientId: 'user-1', status: 'draft', baseProgramId: base.id, baseVersion: base.currentVersion, revision: 1,
    program: { ...content, name: 'Two-day plan' }, changeSummary: ['Adds a set to each exercise'], message: 'You said you can train less.',
    target: 'apply', createdAt: '2026-10-27T10:00:00Z', ...over,
  };
}

/* ------------------------------------------------------------------ tests */
describe('Icelandic AI cards: counts and numbers', () => {
  it('plural forms follow Icelandic rules for 0/1/2/11/21 and decimals use a comma', () => {
    const days = [0, 1, 2, 11, 21].map((n) => tp('aiCard.mealPlan.addedDays', n));
    expect(days).toEqual([
      'Bætt við matseðilinn þinn (0 dagar)',
      'Bætt við matseðilinn þinn (1 dagur)',
      'Bætt við matseðilinn þinn (2 dagar)',
      'Bætt við matseðilinn þinn (11 dagar)',
      'Bætt við matseðilinn þinn (21 dagur)',
    ]);
    const plan = (n: number) => ({ ...version(), name: 'P', templates: Array.from({ length: n }, (_, i) => ({ ...version().templates[0], id: `t${i}` })) });
    expect([0, 1, 2, 11, 21].map((n) => describeChanges(null, plan(n), (id) => id)[0])).toEqual([
      'Ný æfingaáætlun: 0 æfingar á viku. Fjöldi vikna: 8.',
      'Ný æfingaáætlun: 1 æfing á viku. Fjöldi vikna: 8.',
      'Ný æfingaáætlun: 2 æfingar á viku. Fjöldi vikna: 8.',
      'Ný æfingaáætlun: 11 æfingar á viku. Fjöldi vikna: 8.',
      'Ný æfingaáætlun: 21 æfing á viku. Fjöldi vikna: 8.',
    ]);
    expect(t('aiCard.mealPlan.proteinTarget', { protein: 61.25, target: 140 })).toBe('61,25 g prótein / 140 g');
  });
});

describe('Icelandic AI cards: SessionAdjustmentCard', () => {
  const action: SessionAdjustmentAction = {
    kind: 'session_adjustment', id: 'u-adj', sessionId: 'w1', change: 'shorten', minutes: 30, estimatedMinutes: 25,
    removeSets: [], dropExercises: [{ sessionExerciseId: 'x1', name: 'Bench press' }], summary: 'Server summary', warnings: ['Server warning as sent'],
  };
  async function putSession() {
    const db = h.db as LiftDb;
    await db.sessions.put({ id: 'w1', name: 'Push A', status: 'active', date: '2026-10-28', exercises: [], createdAt: 1, updatedAt: 1 } as unknown as WorkoutSession);
  }

  it('pending: Icelandic title, explanation and the context-specific Apply label; server warnings shown as sent', async () => {
    await putSession();
    const c = render(createElement(SessionAdjustmentCard, { action, db: h.db as LiftDb }));
    await waitFor(() => button('Nota í æfingu dagsins', c));
    const section = c.querySelector('section')!;
    expect(section.getAttribute('aria-label')).toBe('Breyting á æfingu dagsins');
    expect(norm(section.querySelector('h3')!.textContent)).toBe('Styttri æfing: um 30 mín.');
    expect(section.querySelector('ul')!.getAttribute('aria-label')).toBe('Hvað breytist í dag');
    expect(norm(section.textContent)).toContain('Eftir breytinguna eru um 25 mín. eftir af æfingunni. Sett sem þú hefur lokið haldast óbreytt.');
    expect(norm(section.textContent)).toContain('Aðeins æfing dagsins breytist. Æfingaáætlunin og næstu æfingar haldast óbreyttar.');
    expect(norm(section.textContent)).toContain('Server warning as sent');
  });

  it('swap without minutes and applied state: badge, Back to workout and Undo', async () => {
    await putSession();
    await kvSet(AI_SESSION_ADJUST_KEY, { 'u-adj': { actionId: 'u-adj', sessionId: 'w1', change: 'swap', appliedAt: Date.now() } }, h.db as LiftDb);
    const c = render(createElement(SessionAdjustmentCard, { action: { ...action, change: 'swap', minutes: undefined }, db: h.db as LiftDb }));
    await waitFor(() => button('Afturkalla', c));
    expect(norm(c.querySelector('h3')!.textContent)).toBe('Önnur æfing í dag');
    expect(button('Til baka í æfingu', c)).toBeTruthy();
    expect(norm(c.textContent)).toContain('Breyting gerð');
  });
});

describe('Icelandic AI cards: WeekPlanCard', () => {
  const today = '2026-10-28';
  function weekPlan(p: Program, over: Partial<WeekPlan> = {}): WeekPlan {
    return {
      kind: 'week_adjustment', id: 'wp-1', baseProgramId: p.id, baseVersion: p.currentVersion, managedBy: 'self', weekStart: '2026-10-26', weekEnd: '2026-11-01',
      targetSessions: 2, completed: [{ date: '2026-10-26', name: 'Full body A' }],
      sessions: [{ templateId: 'tA', name: 'Full body B', date: '2026-10-29', plannedDate: '2026-10-28' }],
      skipped: [{ templateId: 'tC', name: 'Full body C', plannedDate: '2026-10-30' }], adjustments: [], warnings: [], summary: '', ...over,
    };
  }
  const props = (p: Program, plan: WeekPlan) => ({ plan, program: p, sessions: [] as WorkoutSession[], today, weekStart: 1 as const, db: h.db as LiftDb });

  it('available: heading, done/skipped lines, scope note and "Nota fyrir þessa viku"', () => {
    const p = basePlan();
    const c = render(createElement(WeekPlanCard, props(p, weekPlan(p))));
    const section = c.querySelector('section')!;
    expect(section.getAttribute('aria-label')).toBe('Áætlun vikunnar');
    expect(norm(section.querySelector('h3')!.textContent)).toBe('Aðeins þessa viku');
    const d = formatDate('2026-10-26', { weekday: 'short', day: 'numeric', month: 'short' });
    expect(norm(section.textContent)).toContain(`Lokið: Full body A (${d})`);
    expect(norm(section.textContent)).toContain('Sleppt í þessari viku: Full body C');
    expect(norm(section.textContent)).toContain('Æfingaáætlunin sjálf breytist ekki. Venjulegir æfingadagar taka aftur við í næstu viku.');
    expect(button('Nota fyrir þessa viku', c)).toBeTruthy();
  });

  it('coach-managed note, applied (badge + Undo), stale and expired states', () => {
    const p = { ...basePlan(), managedBy: { kind: 'coach' as const } };
    let c = render(createElement(WeekPlanCard, props(p, weekPlan(p, { sessions: [] }))));
    expect(norm(c.textContent)).toContain('Engar fleiri æfingar í þessari viku.');
    expect(norm(c.textContent)).toContain('næstu viku. Aðeins dagarnir breytast. Æfingarnar frá þjálfaranum haldast óbreyttar.');

    const applied = { ...p, overrides: [{ date: '2026-10-30', templateId: 'tA', status: 'skipped' as const, weekPlanId: 'wp-1' }] };
    c = render(createElement(WeekPlanCard, props(applied, weekPlan(applied))));
    expect(button('Afturkalla', c)).toBeTruthy();
    expect(norm(c.textContent)).toContain('Breyting gerð');

    const stale = basePlan();
    c = render(createElement(WeekPlanCard, props(stale, weekPlan(stale, { baseVersion: 99 }))));
    expect(norm(c.textContent)).toContain('Æfingaáætlunin breyttist eftir að tillagan var gerð, svo hún var ekki notuð. Spurðu æfingaaðstoðina aftur.');

    c = render(createElement(WeekPlanCard, { ...props(stale, weekPlan(stale)), today: '2026-11-05' }));
    expect(norm(c.textContent)).toContain('Þessi tillaga var fyrir aðra viku.');
  });

  it('applyWeekPlan result text is Icelandic (and already-applied)', () => {
    const p = basePlan();
    const plan = weekPlan(p, { completed: [], skipped: [], targetSessions: 1, sessions: [{ templateId: 'tA', name: 'Full body A', date: '2026-10-29', plannedDate: '2026-11-02' }] });
    const r = applyWeekPlan(p, { ...plan, sessions: [] }, today, [], 1);
    expect(r.ok && r.message).toBe('Engar fleiri æfingar í þessari viku. Venjuleg dagskrá tekur aftur við í næstu viku.');
    const applied = { ...p, overrides: [{ date: '2026-10-30', templateId: 'tA', status: 'skipped' as const, weekPlanId: 'wp-1' }] };
    expect(applyWeekPlan(applied, plan, today, [], 1).message).toBe('Breytingin hefur þegar verið gerð fyrir þessa viku.');
    expect(applyWeekPlan(p, { ...plan, baseVersion: 42 }, today, [], 1).message).toBe(t('aiCard.week.stale'));
  });
});

describe('Icelandic AI cards: MealPlanCard', () => {
  async function setup(proteinG: number) {
    const acc = h.account as AccountState;
    acc.settings.nutritionEnabled = true;
    acc.nutrition = { ...acc.nutrition, mode: 'protein_only', proteinG };
    const today = todayISO(acc.settings.timeZone);
    const ws = startOfWeek(today, acc.settings.weekStart);
    const lunch = RECIPES.find((r) => r.meal === 'lunch')!;
    const plan = toMealPlanSuggestion({
      kind: 'meal_plan', id: 'u-mp', weekStart: ws, weekEnd: addDays(ws, 6), targets: { proteinG, kcal: null }, summary: 'Server summary as sent', warnings: ['Server warning as sent'],
      days: [{ date: today, items: [{ slot: 'lunch', recipeId: lunch.id, name: lunch.name, servings: 1, extras: [{ ingredientId: 'chicken-breast-cooked', grams: 100 }] }] }],
    })!;
    return { plan, ws, lunch };
  }

  it('pending → Add (toast, badge, Open/Undo) → Undo; labels and 61,25 g target in Icelandic', async () => {
    const { plan, ws, lunch } = await setup(61.25);
    const c = render(createElement(MealPlanCard, { plan }));
    await waitFor(() => expect(button('Bæta við matseðilinn minn', c).disabled).toBe(false));
    expect(button('Bæta við og breyta', c)).toBeTruthy();
    expect(bodyText()).not.toContain('Customize');
    const section = c.querySelector('section')!;
    expect(section.getAttribute('aria-label')).toBe('Tillaga að matseðli');
    const d = (x: string) => formatDate(x, { weekday: 'short', day: 'numeric', month: 'short' });
    expect(norm(section.querySelector('h3')!.textContent)).toBe(`Matseðill · ${d(ws)} – ${d(addDays(ws, 6))}`);
    expect(section.querySelector('ul')!.getAttribute('aria-label')).toBe('Dagar');
    const totals = norm(section.querySelector('[data-testid="ai-mealplan-totals"]')!.textContent);
    expect(totals).toMatch(/^\d+ g prótein \/ 61,25 g · \d+ kcal/);
    // Balancing may scale servings (decimal comma) and the side; the side reads "{{food}}: {{amount}}".
    const esc = recipeDisplayName(lunch.id, 'is').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(norm(section.textContent)).toMatch(new RegExp(`Hádegismatur: ${esc}( ×\\d+(,\\d+)?)? \\+ Steikt kjúklingabringa: \\d+ g`));
    expect(norm(section.textContent)).toContain('Server summary as sent');
    expect(norm(section.textContent)).toContain('Server warning as sent');

    click(button('Bæta við matseðilinn minn', c));
    await waitFor(() => button('Afturkalla', c));
    expect(bodyText()).toContain('Bætt við matseðilinn þinn (1 dagur)');
    expect(button('Opna matseðil', c)).toBeTruthy();
    expect(norm(c.textContent)).toContain('Bætt við');

    click(button('Afturkalla', c));
    await waitFor(() => button('Bæta við matseðilinn minn', c));
    expect(bodyText()).toContain('Matseðillinn er aftur eins og áður.');
  });

  it('no target and nutrition off notices', async () => {
    const { plan } = await setup(140);
    const acc = h.account as AccountState;
    acc.nutrition = { ...acc.nutrition, proteinG: null as unknown as number };
    acc.settings.nutritionEnabled = false;
    const c = render(createElement(MealPlanCard, { plan }));
    await waitFor(() => button('Bæta við matseðilinn minn', c));
    expect(norm(c.textContent)).toContain('Slökkt er á næringareiginleikum í Stillingum.');
  });
});

describe('Icelandic AI cards: RecipeCards', () => {
  it('card labels, omission/swap frames, Save, and the Add to plan sheet', async () => {
    const r = RECIPES.find((x) => x.id === 'skyr-oat-pancakes')!;
    const s = toRecipeSuggestions({
      kind: 'recipe_suggestions', id: 'u-r',
      recipes: [{ id: r.id, totalMinutes: 15, perServing: { kcal: 500, protein_g: 40, carbs_g: 50, fat_g: 12 }, omit: ['blueberries'], swaps: [{ from: 'skyr-plain', to: 'cottage-cheese' }] }],
    })!;
    const c = render(createElement(RecipeCards, { suggestions: s }));
    expect(c.querySelector('section')!.getAttribute('aria-label')).toBe('Tillögur að uppskriftum');
    const card = c.querySelector('[data-testid="ai-recipe-card"]')!;
    expect(norm(card.textContent)).toContain(`${t(`aiCard.meal.${r.meal}`)} · 15 mín.`);
    expect(norm(card.textContent)).toContain('40 g prótein í skammti');
    // Ingredient names are catalog display text in the app language.
    const ing = (id: string) => ingredientDisplayName(id, 'is').replace(/\s*\(.*\)\s*$/, '');
    expect(norm(card.querySelector('[data-testid="ai-recipe-changes"]')!.textContent)).toBe(
      t('aiCard.recipe.omitted', { ingredients: ing('blueberries').toLocaleLowerCase('is') }) + ' · ' + t('aiCard.recipe.swap', { to: ing('cottage-cheese'), from: ing('skyr-plain').toLocaleLowerCase('is') }),
    );
    expect(norm(card.querySelector('a')!.textContent)).toBe('Opna');
    expect(button('Vista', c)).toBeTruthy();

    click(button('Bæta við matseðil…', c));
    await waitFor(() => button('Bæta við matseðil'));
    expect(bodyText()).toContain(`Bæta við matseðil: ${recipeDisplayName(r, 'is')}`);
    expect(bodyText()).toContain('Dagur');
    expect(document.body.querySelector('[aria-label="Máltíð"]')).toBeTruthy();
    expect(bodyText()).toContain('Í dag');
    await waitFor(() => expect(button('Bæta við matseðil').disabled).toBe(false));
    click(button('Bæta við matseðil'));
    await waitFor(() => expect(bodyText()).toContain(`Bætt við matseðil: ${recipeDisplayName(r, 'is')} · `));
    expect(button('Afturkalla')).toBeTruthy();
  });

  it('English frames are unchanged', () => {
    setLanguage('en');
    expect(changesText({ omit: ['blueberries'], swaps: [{ from: 'skyr-plain', to: 'cottage-cheese' }] })).toBe('Without blueberries · Cottage cheese, low-fat instead of skyr, plain');
  });
});

describe('Icelandic AI cards: ProposalDetail', () => {
  const coach = null;
  it('pending revision: Icelandic header, describeChanges, Apply confirmation', async () => {
    const base = basePlan();
    const p = proposalFor(base);
    const c = render(createElement(ProposalDetail, { proposal: p, programs: [base], coach, onChanged: () => undefined }));
    await waitFor(() => button('Nota tillögu', c));
    const text = norm(c.textContent);
    expect(text).toContain('Tillaga gervigreindar');
    expect(text).toContain(t('ai.proposal.status.pending'));
    expect(text).toContain(`Tillaga frá 27. okt. 2026 · uppfærir „My plan“ (útgáfu 1)`);
    expect(text).toContain('Af hverju leggur gervigreindin þetta til?');
    expect(text).toContain('Breytingar frá útgáfu 1');
    expect(text).toContain(`Full body A: ${exerciseDisplayName(EX[0])} 3×8–12 → 4×8–12.`);
    expect(text).toContain('Samantekt gervigreindarinnar');
    expect(button('Hafna', c)).toBeTruthy();
    click(button('Nota tillögu', c));
    await waitFor(() => expect(bodyText()).toContain('Nota þessa tillögu gervigreindar?'));
    expect(bodyText()).toContain('Þetta vistar nýja útgáfu af „My plan“ (útgáfu 2) og virkjar hana sem æfingaáætlunina þína.');
    expect(button('Nota breytingar')).toBeTruthy();
  });

  it('applied, declined and coach-managed states', async () => {
    const base = basePlan();
    let c = render(createElement(ProposalDetail, {
      proposal: proposalFor(base, { status: 'accepted', appliedProgramId: base.id, appliedVersion: 2, respondedAt: '2026-10-28T12:00:00Z' }),
      programs: [base], coach, onChanged: () => undefined,
    }));
    await waitFor(() => expect(norm(c.textContent)).toContain('Breyting gerð 28. okt. 2026 og vistuð sem útgáfa 2.'));
    expect(button('Skoða æfingaáætlun', c)).toBeTruthy();

    c = render(createElement(ProposalDetail, { proposal: proposalFor(base, { status: 'declined' }), programs: [base], coach, onChanged: () => undefined }));
    await waitFor(() => expect(norm(c.textContent)).toContain('Þú hafnaðir þessari tillögu. Æfingaáætlunin breyttist ekki.'));

    const managed = { ...basePlan(), managedBy: { kind: 'coach' as const } };
    c = render(createElement(ProposalDetail, { proposal: proposalFor(managed), programs: [managed], coach, onChanged: () => undefined }));
    await waitFor(() => button('Taka við umsjón áætlunar', c));
    expect(norm(c.textContent)).toContain(t('aiCard.proposal.coachManagedBodyGeneric'));
    expect(norm(c.textContent)).toContain('Opnaðu skilaboðin til þjálfarans til að ræða tillöguna.');
    click(button('Taka við umsjón áætlunar', c));
    await waitFor(() => expect(bodyText()).toContain('Taka við umsjón æfingaáætlunarinnar?'));
    expect(bodyText()).toContain(t('aiCard.proposal.coachPlanStopsGeneric'));
    expect(button('Taka við umsjón og nota tillögu')).toBeTruthy();
  });
});

describe('Icelandic AI cards: domain texts', () => {
  it('validation, applyProposal refusals and the non-AI guard are Icelandic', async () => {
    const bad = { ...version(), name: '', weeks: 60, templates: [{ ...version().templates[0], exercises: [{ ...version().templates[0].exercises[0], exerciseId: 'nope', sets: 11 }] }] };
    const errs = validateProposedProgram(bad, new Set(EX.map((e) => e.id)));
    expect(errs).toContain('Æfingaáætlunin þarf heiti.');
    expect(errs).toContain('Óþekkt æfing „nope“ í „Full body A“.');
    expect(errs).toContain('Fjöldi setta verður að vera 1–10 (nope).');
    expect(errs).toContain('Æfingatímabilið verður að vera 1–52 vikur.');

    const base = basePlan();
    const ids = new Set(EXERCISES.map((e) => e.id));
    expect(applyProposal(proposalFor(base, { target: 'for_coach_review' }), [base], { today: '2026-10-28', catalog: ids }))
      .toMatchObject({ ok: false, message: 'Þessi tillaga er til umræðu við þjálfarann þinn. Ekki er hægt að nota hana sem æfingaáætlun.' });
    expect(applyProposal(proposalFor(base, { baseVersion: 7 }), [base], { today: '2026-10-28', catalog: ids }))
      .toMatchObject({ ok: false, reason: 'stale', message: 'Æfingaáætlunin breyttist eftir að uppfærslan var gerð. Biddu um uppfærða útgáfu.' });
    const res = await applyAiProposal({
      proposal: proposalFor(base, { authorKind: 'coach' }), programs: [base], db: h.db as LiftDb, today: '2026-10-28', catalog: new Map(EXERCISES.map((e) => [e.id, e])),
      respond: async () => undefined,
    });
    expect(res).toMatchObject({ ok: false, message: 'Þetta er ekki tillaga frá gervigreind.' });
  });

  it('describeChanges schedule uses localized weekdays', () => {
    const base = version();
    const next = { ...version(), name: 'P', schedule: [{ weekday: 3, templateId: 'tA' }] };
    expect(describeChanges(base, next, (id) => id)).toEqual([`Æfingadagskrá: ${weekdayShort(1)} Full body A → ${weekdayShort(3)} Full body A.`]);
    expect(weekdayShort(1)).toBe('mán.');
  });

  it('persisted version reasons stay English; they are localized at render by exact match', async () => {
    const base = await saveRecord('programs', basePlan(), h.db as LiftDb);
    const r = applyProposal(proposalFor(base, { program: { ...proposalFor(base).program, progressionNotes: 'Add 2.5 kg' } }), [base], { today: '2026-10-28', catalog: new Set(EXERCISES.map((e) => e.id)) });
    if (!r.ok) throw new Error(r.message);
    const v = r.program.versions.at(-1)!;
    expect(v.reason).toBe('AI-suggested update: Adds a set to each exercise');
    expect(v.rationale.at(-1)).toBe('Progression: Add 2.5 kg');
    expect(versionReasonText(v.reason)).toBe('Uppfærsla að tillögu gervigreindar: Adds a set to each exercise');
    expect(rationaleLineText(v.rationale.at(-1)!)).toBe('Framvinda: Add 2.5 kg');
    const taken = takeOverPlan(withNewVersion(base, version()));
    expect(taken.versions.at(-1)!.reason).toBe('Switched to a self-managed plan');
    expect(versionReasonText('Switched to a self-managed plan')).toBe('Umsjón æfingaáætlunar færð til þín');
    expect(versionReasonText('Coach update')).toBe('Uppfærsla frá þjálfara');
    expect(versionReasonText('Something the user wrote')).toBe('Something the user wrote');
    expect(versionReasonText('Coach updates')).toBe('Coach updates');
    setLanguage('en');
    expect(versionReasonText(v.reason)).toBe(v.reason);
    expect(rationaleLineText('Progression: Add 2.5 kg')).toBe('Progression: Add 2.5 kg');
  });
});
