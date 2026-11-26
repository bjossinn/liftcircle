// @vitest-environment jsdom
/**
 * Onboarding "Accept & start" starts the new plan's first workout and opens the logger (roadmap item 3).
 * - firstWorkoutToStart / startFirstWorkout: which planned session is started, and the edge cases (a workout already
 *   in progress, a plan with no lifting workout).
 * - OnboardingPage on the result step (real Dexie via fake-indexeddb, mocked app context): Accept & start lands in
 *   /train/session/:id; a double tap saves one plan and one session; an active workout is never replaced; "Save plan,
 *   start later" saves the plan and goes to Today without starting anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { AccountState, ProgramVersion, SessionTemplate, WorkoutSession } from '@/domain/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown as import('@/db/db').LiftDb, failStart: false }));
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

// failStart: the workout can't be started after the plan was saved (e.g. storage error on that write).
vi.mock('@/features/train/start', async (orig) => {
  const actual = (await orig()) as typeof import('@/features/train/start');
  return {
    ...actual,
    tryStartFromTemplate: (...args: Parameters<typeof actual.tryStartFromTemplate>) =>
      h.failStart ? Promise.reject(new Error('The device storage is full')) : actual.tryStartFromTemplate(...args),
  };
});

const { LiftDb } = await import('@/db/db');
const { alive, kvSet } = await import('@/db/repo');
const { createProgram } = await import('@/domain/program/program');
const { EXERCISES } = await import('@/data/exercises');
const { todayISO, addDays, weekday } = await import('@/lib/dates');
const { defaultAccountState } = await import('@/state/defaults');
const { DRAFT_KEY, newDraft } = await import('@/features/onboarding/draft');
const { firstWorkoutToStart, startFirstWorkout } = await import('@/features/onboarding/firstWorkout');
const OnboardingPage = (await import('@/features/onboarding/OnboardingPage')).default;
const { ToastProvider } = await import('@/components/toast');

const settings = defaultAccountState().settings;
const today = todayISO(settings.timeZone);

const lifting = (id: string): SessionTemplate => ({
  id,
  name: `Lift ${id}`,
  focus: 'Full body',
  kind: 'lifting',
  estimatedMinutes: 45,
  exercises: [{ id: `${id}-1`, exerciseId: 'barbell-bench-press', sets: 3, repMin: 8, repMax: 10, targetRir: 2, restSec: 90, warmup: '', priority: 1, alternatives: [] }],
});
const run: SessionTemplate = { id: 'run', name: 'Easy run', focus: 'Easy run', kind: 'cardio', estimatedMinutes: 30, exercises: [], cardio: { activity: 'run', minutes: 30, intensity: 'easy', notes: '' } };

function programWith(templates: SessionTemplate[], schedule: { weekday: number; templateId: string }[]) {
  const v: ProgramVersion = { version: 1, createdAt: 1, reason: 'test', templates, schedule, weeks: 8, reviewWeek: 8, rationale: [], warnings: [] };
  return createProgram(null, v, today, 'Test plan', 'manual');
}

beforeEach(async () => {
  h.failStart = false;
  localStorage.clear();
  h.db = new LiftDb(`onboarding-start-${Math.random().toString(36).slice(2)}`);
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
  h.db.close();
  await h.db.delete();
});

describe('firstWorkoutToStart', () => {
  it('starts today’s lifting session when there is one', () => {
    const p = programWith([lifting('a'), lifting('b')], [{ weekday: weekday(today), templateId: 'b' }, { weekday: weekday(addDays(today, 2)), templateId: 'a' }]);
    const first = firstWorkoutToStart(p, today, []);
    expect(first?.template.id).toBe('b');
    expect(first?.date).toBe(today);
  });

  it('skips activities (cardio today) and takes the next lifting session, even if it isn’t today', () => {
    const p = programWith([lifting('a'), run], [{ weekday: weekday(today), templateId: 'run' }, { weekday: weekday(addDays(today, 1)), templateId: 'a' }]);
    const first = firstWorkoutToStart(p, today, []);
    expect(first?.template.id).toBe('a');
    expect(first?.date).toBe(addDays(today, 1));
  });

  it('returns null for a plan with no workout days or only activities', () => {
    expect(firstWorkoutToStart(programWith([lifting('a')], []), today, [])).toBeNull();
    expect(firstWorkoutToStart(programWith([run], [{ weekday: weekday(today), templateId: 'run' }]), today, [])).toBeNull();
    const empty = { ...lifting('e'), exercises: [] };
    expect(firstWorkoutToStart(programWith([empty], [{ weekday: weekday(today), templateId: 'e' }]), today, [])).toBeNull();
  });
});

describe('startFirstWorkout', () => {
  const ctx = () => ({ db: h.db, settings, catalog: EXERCISES });

  it('creates an active session linked to the plan and its planned date', async () => {
    const p = programWith([lifting('a')], [{ weekday: weekday(today), templateId: 'a' }]);
    const r = await startFirstWorkout(p, today, ctx());
    expect(r.kind).toBe('started');
    const s = r.kind === 'started' ? r.session : null;
    expect(s).toMatchObject({ status: 'active', programId: p.id, programVersion: 1, plannedDate: today, templateId: 'a', name: 'Lift a' });
    expect(s!.exercises[0].sets.filter((x) => x.type !== 'warmup')).toHaveLength(3); // plus generated warm-ups
  });

  it('never starts a second workout while one is in progress', async () => {
    const existing: WorkoutSession = { id: 'live', createdAt: 1, updatedAt: 1, name: 'Already going', status: 'active', date: today, timeZone: 'UTC', startedAt: Date.now(), pausedTotalMs: 0, exercises: [] };
    await h.db.sessions.put(existing);
    const p = programWith([lifting('a')], [{ weekday: weekday(today), templateId: 'a' }]);
    const r = await startFirstWorkout(p, today, ctx());
    expect(r).toMatchObject({ kind: 'already_active', session: { id: 'live' } });
    expect(await h.db.sessions.count()).toBe(1);
  });

  it('concurrent starts (two tabs / two taps) create exactly one active session', async () => {
    const p = programWith([lifting('a')], [{ weekday: weekday(today), templateId: 'a' }]);
    const results = await Promise.all([startFirstWorkout(p, today, ctx()), startFirstWorkout(p, today, ctx()), startFirstWorkout(p, today, ctx())]);
    const active = (await h.db.sessions.toArray()).filter((s) => s.status === 'active');
    expect(active).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'started')).toHaveLength(1);
    for (const r of results) expect(r.kind === 'none' ? null : r.session.id).toBe(active[0].id);
  });

  it('the shared starters are atomic too: concurrent template / empty / repeat starts leave one active session', async () => {
    const { startFromTemplate, startEmpty, repeatSession } = await import('@/features/train/start');
    const past: WorkoutSession = { id: 'old', createdAt: 1, updatedAt: 1, name: 'Old', status: 'completed', date: '2026-01-01', timeZone: 'UTC', startedAt: 1, pausedTotalMs: 0, exercises: [] };
    const out = await Promise.all([startFromTemplate(lifting('a'), ctx()), startEmpty(ctx()), repeatSession(past, ctx()), startEmpty(ctx())]);
    const active = (await h.db.sessions.toArray()).filter((s) => s.status === 'active');
    expect(active).toHaveLength(1);
    expect(new Set(out.map((s) => s.id))).toEqual(new Set([active[0].id]));
    expect((await h.db.outbox.toArray()).filter((o) => o.entity === 'sessions')).toHaveLength(1);
  });

  it('starts nothing for a plan without a lifting workout', async () => {
    const r = await startFirstWorkout(programWith([run], [{ weekday: weekday(today), templateId: 'run' }]), today, ctx());
    expect(r.kind).toBe('none');
    expect(await h.db.sessions.count()).toBe(0);
  });
});

/* ------------------------------------------------------------------ OnboardingPage */
let root: Root | null = null;
let el: HTMLDivElement | null = null;
let router: ReturnType<typeof createMemoryRouter>;
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
const button = (label: string) => {
  const b = [...el!.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button ${label}`);
  return b;
};

async function mountAtResult() {
  const d = newDraft(defaultAccountState());
  d.step = 'result';
  d.a = { ...d.a, displayName: 'Tester' };
  await kvSet(DRAFT_KEY, d, h.db);
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
  await waitFor(() => button('Accept & start'));
}
const programs = async () => alive(await h.db.programs.toArray());
const sessions = async () => alive(await h.db.sessions.toArray());

describe('OnboardingPage: Accept & start', () => {
  it('saves the plan, starts its first workout and opens the logger', async () => {
    await mountAtResult();
    await act(async () => button('Accept & start').click());
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/train\/session\//));
    const [p] = await programs();
    const [s] = await sessions();
    expect(p.active).toBe(true);
    expect(s.status).toBe('active');
    expect(s.programId).toBe(p.id);
    expect(router.state.location.pathname).toBe(`/train/session/${s.id}`);
    expect(s.exercises.length).toBeGreaterThan(0);
    expect(await h.db.kv.get(DRAFT_KEY)).toBeUndefined();
  });

  it('a double tap saves one plan and starts one workout', async () => {
    await mountAtResult();
    const b = button('Accept & start');
    await act(async () => {
      b.click();
      b.click();
    });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/train\/session\//));
    await tick(100);
    expect(await programs()).toHaveLength(1);
    expect(await sessions()).toHaveLength(1);
  });

  it('with a workout already in progress, saves the plan and goes to Today without replacing it', async () => {
    await h.db.sessions.put({ id: 'live', createdAt: 1, updatedAt: 1, name: 'Already going', status: 'active', date: today, timeZone: 'UTC', startedAt: Date.now(), pausedTotalMs: 0, exercises: [] });
    await mountAtResult();
    await act(async () => button('Accept & start').click());
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await programs()).toHaveLength(1);
    expect((await sessions()).map((s) => s.id)).toEqual(['live']);
    expect(el!.textContent).toContain('already have a workout in progress');
  });

  it('if the plan saves but the workout can’t start, it goes to Today with an error and the plan is saved once', async () => {
    h.failStart = true;
    await mountAtResult();
    await act(async () => button('Accept & start').click());
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await programs()).toHaveLength(1);
    expect(await sessions()).toHaveLength(0);
    expect(el!.textContent).toContain('Plan saved, but the workout couldn’t start');
    expect(await h.db.kv.get(DRAFT_KEY)).toBeUndefined();
  });

  it('“Save plan, start later” saves the plan and goes to Today without starting a workout', async () => {
    await mountAtResult();
    await act(async () => button('Save plan, start later').click());
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await programs()).toHaveLength(1);
    expect(await sessions()).toHaveLength(0);
  });
});
