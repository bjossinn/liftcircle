// @vitest-environment jsdom
/**
 * Roadmap item 7, UI (MOCKED aiApi; real Dexie via fake-indexeddb; real SessionPage, SummaryPage and AiChatPage):
 *  - the workout logger's "Ask coach" entry points (Short on time / Equipment busy / Explain this) and the summary's
 *    "Explain" open the Coach with the request stored for it; guests get none;
 *  - the Coach sends a contextual request once, with the live workout attached, AFTER the sync barrier ran; when it
 *    can't send yet the text goes into the composer with the workout attached;
 *  - the "Apply to today's workout" card changes only the live session (the plan is untouched) and Undo restores it,
 *    also from the logger's banner;
 *  - the Coach tab's first open is the single-step consent (Supportive by default), and a waiting request is sent
 *    as soon as it's turned on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  db: null as unknown,
  account: null as unknown,
  auth: 'signed_in' as 'signed_in' | 'guest',
  online: true,
  order: [] as string[],
}));
vi.mock('@/state/app', () => ({
  useApp: () => ({
    db: h.db,
    account: h.account,
    accountReady: true,
    auth: h.auth === 'signed_in' ? { status: 'signed_in', userId: 'user-1' } : { status: 'guest' },
    online: h.online,
    backendConfigured: true,
    updateAccount: async (fn: (a: unknown) => unknown) => {
      h.account = fn(h.account);
    },
  }),
  useDb: () => h.db,
  useSettings: () => (h.account as { settings: unknown }).settings,
}));
vi.mock('@/backend/ai', () => ({
  aiApi: { status: vi.fn(), getSettings: vi.fn(), saveSettings: vi.fn(), history: vi.fn(), send: vi.fn(), clearHistory: vi.fn(), listProposals: vi.fn(), respondProposal: vi.fn() },
}));
vi.mock('@/backend/coaching', () => ({ coachingApi: { myRelationships: vi.fn(async () => []), sendMessage: vi.fn() } }));
// The sync barrier's push: recorded so the test can check it ran BEFORE the message was sent.
vi.mock('@/sync/engine', () => ({
  syncNow: vi.fn(async () => {
    h.order.push('sync');
  }),
}));
vi.mock('@/social/autoShare', () => ({ maybeAutoShare: async () => false }));
vi.mock('@/features/social/SharePreview', () => ({ SharePreview: () => null }));
vi.mock('@/components/celebrate', () => ({ celebrateOnce: () => undefined, celebrate: () => undefined }));

import { aiApi } from '@/backend/ai';
import type { AiSettings } from '@/backend/coachingContract';
import { LiftDb } from '@/db/db';
import { kvGet, kvSet, saveRecord } from '@/db/repo';
import { ToastProvider } from '@/components/toast';
import { defaultAccountState } from '@/state/defaults';
import { EXERCISES } from '@/data/exercises';
import { createProgram } from '@/domain/program/program';
import type { Exercise, LoggedSet, Program, ProgramVersion, WorkoutSession } from '@/domain/types';
import AiChatPage from '@/features/coaching/AiChatPage';
import SessionPage from '@/features/train/SessionPage';
import SummaryPage from '@/features/train/SummaryPage';
import { AI_DRAFT_KEY, AI_PENDING_KEY } from '@/features/coaching/ai/model';
import { AI_ATTACHED_REQUEST_KEY, AI_COACH_REQUEST_KEY, openCoachWith, type CoachRequest } from '@/features/coaching/ai/workoutContext';
import { applyAdjustment } from '@/features/coaching/ai/sessionAdjustStore';
import type { SessionAdjustmentAction, WorkoutContext } from '../../supabase/functions/_shared/ai/workout';

/* ---------------------------------------------------------------- harness */
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
let root: Root | null = null;
let el: HTMLDivElement | null = null;
const tick = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function waitFor<T>(fn: () => T | Promise<T>, timeout = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() - start > timeout) throw e;
      await tick(15);
    }
  }
}
function Where() {
  return createElement('output', { 'data-testid': 'where' }, useLocation().pathname);
}
function render(path: string, routes: [string, ReactElement][]) {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  act(() =>
    root!.render(
      createElement(ToastProvider, null,
        createElement(MemoryRouter, { initialEntries: [path] },
          createElement(Where),
          createElement(Routes, null, ...routes.map(([p, e]) => createElement(Route, { key: p, path: p, element: e })), createElement(Route, { key: '*', path: '*', element: createElement('p', null, 'elsewhere') })))),
    ),
  );
}
const where = () => el!.querySelector('[data-testid="where"]')?.textContent;
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];
const button = (name: string | RegExp) => {
  const b = buttons().find((x) => {
    const n = norm(x.getAttribute('aria-label') || x.textContent);
    return typeof name === 'string' ? n === name : name.test(n);
  });
  if (!b) throw new Error(`no button ${name}\n${norm(document.body.textContent).slice(0, 500)}`);
  return b;
};
const click = (b: Element) => act(() => void b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const text = () => norm(document.body.textContent);
function fireInput(el: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/* ---------------------------------------------------------------- fixtures */
const api = aiApi as unknown as Record<keyof typeof aiApi, ReturnType<typeof vi.fn>>;
const db = () => h.db as LiftDb;
const SETTINGS_ON: AiSettings = { enabled: true, paused: false, consentAt: '2026-11-01T10:00:00Z', scopes: { profile: true, training: true, measurements: false, nutrition: false }, profileNotes: '', coachStyle: 'supportive' };
const byName = (re: RegExp) => EXERCISES.find((e) => re.test(e.name)) as Exercise;
const BENCH = EXERCISES.find((e) => e.id === 'barbell-bench-press')!;
const DB_BENCH = EXERCISES.find((e) => e.id === 'dumbbell-bench-press')!;
const RAISE = byName(/lateral raise/i);
let n = 0;
const st = (completed: boolean, type: LoggedSet['type'] = 'normal'): LoggedSet => ({ id: `set-${++n}`, type, weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: completed ? 10 : 8, completed });

function plan(): Program {
  const v: ProgramVersion = {
    version: 1, createdAt: 0, reason: 'test', weeks: 8, reviewWeek: 8, rationale: [], warnings: [], schedule: [{ weekday: 6, templateId: 'tA' }],
    templates: [{
      id: 'tA', name: 'Push A', focus: 'Push', kind: 'lifting', estimatedMinutes: 60,
      exercises: [
        { id: 'slot-bench', exerciseId: BENCH.id, sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 120, warmup: '', priority: 1, alternatives: [] },
        { id: 'slot-raise', exerciseId: RAISE.id, sets: 3, repMin: 12, repMax: 15, targetRir: 1, restSec: 60, warmup: '', priority: 3, alternatives: [] },
      ],
    }],
  };
  return createProgram(null, v, '2026-11-01', 'Push Pull', 'generated');
}
function live(p: Program, over: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    id: 'sess-live', createdAt: 1, updatedAt: 1, name: 'Push A', status: 'active', programId: p.id, programVersion: 1, templateId: 'tA', date: '2026-11-28', timeZone: 'UTC',
    startedAt: Date.now() - 20 * 60_000, pausedTotalMs: 0,
    exercises: [
      { id: 'se-bench', exerciseId: BENCH.id, order: 0, prescription: { sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 120, slotId: 'slot-bench' }, sets: [st(true), st(true), st(false)] },
      { id: 'se-raise', exerciseId: RAISE.id, order: 1, prescription: { sets: 3, repMin: 12, repMax: 15, targetRir: 1, restSec: 60, slotId: 'slot-raise' }, sets: [st(false), st(false), st(false)] },
    ],
    ...over,
  };
}
const shortenAction = (id: string): SessionAdjustmentAction => ({
  kind: 'session_adjustment', id, sessionId: 'sess-live', change: 'shorten', minutes: 10, estimatedMinutes: 6, removeSets: [], dropExercises: [{ sessionExerciseId: 'se-raise', name: RAISE.name }], summary: '', warnings: [],
});
const swapAction = (id: string): SessionAdjustmentAction => ({
  kind: 'session_adjustment', id, sessionId: 'sess-live', change: 'swap', removeSets: [], dropExercises: [],
  swap: { sessionExerciseId: 'se-bench', fromExerciseId: BENCH.id, fromName: BENCH.name, toExerciseId: DB_BENCH.id, toName: DB_BENCH.name }, summary: '', warnings: [],
});
async function seed() {
  const p = await saveRecord('programs', plan(), db());
  const s = await saveRecord('sessions', live(p), db());
  return { p, s };
}
const sendArg = (i = 0) => api.send.mock.calls[i][0] as { id: string; text: string; mode: string; unsynced?: number; workout?: WorkoutContext };

beforeEach(() => {
  h.db = new LiftDb(`ai-context-ui-${++n}`);
  h.account = defaultAccountState();
  h.auth = 'signed_in';
  h.online = true;
  h.order = [];
  for (const fn of Object.values(api)) fn.mockReset();
  api.status.mockResolvedValue({ available: true, provider: 'openai', providerName: 'OpenAI', consentCurrent: true, usage: { day: '2026-11-28', requests: 1, inputTokens: 0, outputTokens: 0, limitRequests: 40 } });
  api.getSettings.mockResolvedValue(SETTINGS_ON);
  api.history.mockResolvedValue([]);
  api.send.mockImplementation(async () => {
    h.order.push('send');
    return { reply: { id: `r-${++n}`, role: 'assistant', content: 'Here you go.', createdAt: new Date().toISOString(), status: 'sent' }, proposal: null };
  });
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(async () => {
  if (root) act(() => root!.unmount());
  el?.remove();
  root = null;
  await db().delete();
});

/* ================================================================== logger entry points */
describe('workout logger: Ask coach entry points', () => {
  const logger = () => render('/train/session/sess-live', [['/train/session/:id', createElement(SessionPage)], ['/coach', createElement('p', null, 'COACH')]]);

  it('Short on time → minutes → opens the Coach with the request stored for this workout', async () => {
    await seed();
    logger();
    const group = await waitFor(() => {
      const g = el!.querySelector('[role="group"][aria-label="Ask your coach"]');
      if (!g) throw new Error('no group');
      return g;
    });
    expect([...group.querySelectorAll('button')].map((b) => norm(b.textContent))).toEqual(['Short on time', 'Equipment busy', 'Explain this']);
    click(button('Short on time'));
    expect(await waitFor(() => button('20 min'))).toBeTruthy();
    expect(text()).toContain('You’ll see the changes before anything is applied, and your plan stays the same.');
    click(button('20 min'));
    await waitFor(() => expect(where()).toBe('/coach'));
    expect(await kvGet<CoachRequest>(AI_COACH_REQUEST_KEY, db())).toMatchObject({ intent: 'shorten', minutes: 20, sessionId: 'sess-live', userId: 'user-1' });
  });

  it('Equipment busy lists only exercises with sets left; picking one asks for a swap of that exercise', async () => {
    const { p } = await seed();
    await saveRecord('sessions', live(p, { exercises: live(p).exercises.map((e) => (e.id === 'se-bench' ? { ...e, sets: e.sets.map((x) => ({ ...x, completed: true })) } : e)) }), db());
    logger();
    click(await waitFor(() => button('Equipment busy')));
    const sheet = await waitFor(() => {
      const d = [...document.querySelectorAll('dialog[open]')].find((x) => norm(x.textContent).includes('Which equipment is busy?'));
      if (!d) throw new Error('no sheet');
      return d;
    });
    const names = [...sheet.querySelectorAll('button')].filter((b) => !b.getAttribute('aria-label')).map((b) => norm(b.textContent)); // minus the sheet's Close
    expect(names).toEqual([RAISE.name]);
    click([...sheet.querySelectorAll('button')].find((b) => norm(b.textContent) === RAISE.name)!);
    await waitFor(() => expect(where()).toBe('/coach'));
    expect(await kvGet<CoachRequest>(AI_COACH_REQUEST_KEY, db())).toMatchObject({ intent: 'swap', focusId: 'se-raise', sessionId: 'sess-live' });
  });

  it('the exercise menu has "Explain this" and "Equipment busy? Ask coach"', async () => {
    await seed();
    logger();
    click(await waitFor(() => button(`Options for ${BENCH.name}`)));
    const menu = await waitFor(() => {
      const d = [...document.querySelectorAll('dialog[open]')].find((x) => norm(x.textContent).includes('Swap exercise'));
      if (!d) throw new Error('no menu');
      return d;
    });
    const item = (label: string) => [...menu.querySelectorAll('button')].find((b) => norm(b.textContent) === label);
    expect(item('Equipment busy? Ask coach')).toBeTruthy();
    click(item('Explain this')!);
    await waitFor(() => expect(where()).toBe('/coach'));
    expect(await kvGet<CoachRequest>(AI_COACH_REQUEST_KEY, db())).toMatchObject({ intent: 'explain', focusId: 'se-bench' });
  });

  it('guests get no Ask coach entry points (the assistant needs an account)', async () => {
    h.auth = 'guest';
    await seed();
    logger();
    await waitFor(() => button(`Options for ${BENCH.name}`));
    expect(el!.querySelector('[aria-label="Ask your coach"]')).toBeNull();
    click(button(`Options for ${BENCH.name}`));
    expect(buttons().some((b) => norm(b.textContent) === 'Explain this')).toBe(false);
  });

  it('after Apply, the logger says what the coach changed for today, and Undo restores it', async () => {
    const { s } = await seed();
    expect(await applyAdjustment(db(), shortenAction('msg-a'), new Map(EXERCISES.map((e) => [e.id, e])), [`Skip ${RAISE.name}`])).toEqual({ ok: true });
    logger();
    await waitFor(() => expect(text()).toContain(`Changed for today by your training assistant: Skip ${RAISE.name}. Your plan stays the same.`));
    expect(el!.querySelector(`[aria-labelledby="ex-se-raise"]`)).toBeNull();
    click(button('Undo'));
    await waitFor(() => expect((async () => (await db().sessions.get(s.id))!.exercises.map((e) => e.id))()).resolves.toEqual(['se-bench', 'se-raise']));
    await waitFor(() => expect(text()).not.toContain('Changed for today by your training assistant'));
  });
});

/* ================================================================== summary entry point */
describe('workout summary: Explain next to a next target', () => {
  it('opens the Coach with the shown target attached (signed in only)', async () => {
    const done: WorkoutSession = {
      id: 'w1', createdAt: 1, updatedAt: 1, name: 'Push A', status: 'completed', date: '2026-11-27', timeZone: 'UTC',
      startedAt: Date.parse('2026-11-27T17:00:00Z'), endedAt: Date.parse('2026-11-27T18:00:00Z'), pausedTotalMs: 0,
      exercises: [{ id: 'w1-e', exerciseId: BENCH.id, order: 0, prescription: { sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 120 }, sets: [0, 1, 2].map(() => ({ ...st(true), reps: 12, rir: 2 })) }],
    };
    await db().sessions.put(done);
    render('/train/summary/w1', [['/train/summary/:id', createElement(SummaryPage)], ['/coach', createElement('p', null, 'COACH')]]);
    const explain = await waitFor(() => button(`Explain the next target for ${BENCH.name}`));
    const target = norm(el!.querySelector('[data-testid="next-target"] .tabular')?.textContent);
    expect(target).toMatch(/kg/);
    click(explain);
    await waitFor(() => expect(where()).toBe('/coach'));
    const req = await kvGet<CoachRequest>(AI_COACH_REQUEST_KEY, db());
    expect(req).toMatchObject({ intent: 'explain', sessionId: 'w1', focusId: 'w1-e' });
    expect(req!.shownTarget).toContain(target);
  });

  it('guests see the next target without an Explain button', async () => {
    h.auth = 'guest';
    await db().sessions.put({
      id: 'w2', createdAt: 1, updatedAt: 1, name: 'Push A', status: 'completed', date: '2026-11-27', timeZone: 'UTC', startedAt: 1, endedAt: 3_600_001, pausedTotalMs: 0,
      exercises: [{ id: 'w2-e', exerciseId: BENCH.id, order: 0, prescription: { sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 120 }, sets: [st(true), st(true), st(true)] }],
    });
    render('/train/summary/w2', [['/train/summary/:id', createElement(SummaryPage)]]);
    await waitFor(() => expect(el!.querySelector('[data-testid="next-target"]')).not.toBeNull());
    expect(buttons().some((b) => /Explain/.test(b.getAttribute('aria-label') ?? ''))).toBe(false);
  });
});

/* ================================================================== the Coach */
describe('Coach: contextual requests, the workout card and first-use consent', () => {
  const coach = () => render('/coach', [['/coach', createElement(AiChatPage)], ['/train/session/:id', createElement('p', null, 'LOGGER')]]);

  it('sends the request once, with the live workout attached, after the sync barrier pushed this device’s changes', async () => {
    await seed(); // saving queues the workout in the outbox: the barrier must push it first
    expect(await db().outbox.count()).toBeGreaterThan(0);
    await openCoachWith(db(), (() => undefined) as never, { intent: 'shorten', sessionId: 'sess-live', minutes: 15, userId: 'user-1' });
    coach();
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    const a = sendArg();
    expect(a.text).toBe('Short on time: I have about 15 minutes left. Please shorten the rest of today’s workout (Push A).');
    expect(a.mode).toBe('chat');
    expect(a.workout).toMatchObject({ sessionId: 'sess-live', status: 'active', intent: 'shorten', minutesLeft: 15, name: 'Push A' });
    expect(a.workout!.exercises.map((e) => [e.id, e.priority, e.sets.filter((x) => x.done).length])).toEqual([['se-bench', 1, 2], ['se-raise', 3, 0]]);
    expect(h.order).toEqual(['sync', 'send']); // sync barrier before the coach reads the workout
    await waitFor(() => expect(text()).toContain('Short on time: I have about 15 minutes left.'));
    expect(await kvGet(AI_COACH_REQUEST_KEY, db())).toBeNull();
    // Taken once: a remount doesn't send it again.
    act(() => root!.unmount());
    el!.remove();
    coach();
    await tick(100);
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it('a summary "Explain" request carries the finished workout and the shown target', async () => {
    const { p } = await seed();
    await saveRecord('sessions', live(p, { id: 'w-done', status: 'completed', endedAt: Date.now() }), db());
    await openCoachWith(db(), (() => undefined) as never, { intent: 'explain', sessionId: 'w-done', focusId: 'se-bench', shownTarget: '62.5 kg × 8 reps (Add weight)', userId: 'user-1' });
    coach();
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(sendArg().text).toBe(`Explain this: why is my next target for ${BENCH.name} “62.5 kg × 8 reps (Add weight)”?`);
    expect(sendArg().workout).toMatchObject({ sessionId: 'w-done', status: 'completed', intent: 'explain', focusId: 'se-bench', shownTarget: '62.5 kg × 8 reps (Add weight)' });
  });

  it('when it can’t send yet, the request waits in the composer with the workout attached and is sent with it', async () => {
    await seed();
    // An earlier message that wasn't confirmed blocks new sends until it's retried or edited.
    await kvSet(AI_PENDING_KEY, { id: '00000000-0000-4000-8000-000000000999', text: 'earlier', mode: 'chat', status: 'failed', createdAt: new Date().toISOString(), userId: 'user-1' }, db());
    await openCoachWith(db(), (() => undefined) as never, { intent: 'swap', sessionId: 'sess-live', focusId: 'se-bench', userId: 'user-1' });
    coach();
    const composer = await waitFor(() => {
      const t = el!.querySelector<HTMLTextAreaElement>('#ai-composer');
      if (!t?.value) throw new Error('no draft yet');
      return t;
    });
    expect(composer.value).toBe(`Equipment busy: the equipment for ${BENCH.name} is taken. What can I do instead, just for today?`);
    expect(norm(el!.querySelector('[data-testid="ai-attached-workout"]')?.textContent)).toBe('Today’s workout attached: Push A');
    expect(api.send).not.toHaveBeenCalled();
    click(button('Edit')); // the earlier message goes back into the composer, so sending is possible again
    click(await waitFor(() => button('Send')));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(sendArg().workout).toMatchObject({ sessionId: 'sess-live', intent: 'swap', focusId: 'se-bench' });
    expect(el!.querySelector('[data-testid="ai-attached-workout"]')).toBeNull();
  });

  const failedPending = () =>
    kvSet(AI_PENDING_KEY, { id: '00000000-0000-4000-8000-000000000999', text: 'earlier', mode: 'chat', status: 'failed', createdAt: new Date().toISOString(), userId: 'user-1' }, db());
  const chip = () => el!.querySelector('[data-testid="ai-attached-workout"]');
  const composer = () => el!.querySelector<HTMLTextAreaElement>('#ai-composer')!;

  it('the attached workout can be removed before sending (and stays removed after a reload)', async () => {
    await seed();
    await failedPending();
    await openCoachWith(db(), (() => undefined) as never, { intent: 'shorten', sessionId: 'sess-live', minutes: 10, userId: 'user-1' });
    coach();
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(composer().value).toMatch(/^Short on time: I have about 10 minutes left/);
    click(button('Remove attached workout'));
    expect(chip()).toBeNull();
    await waitFor(async () => expect(await kvGet(AI_ATTACHED_REQUEST_KEY, db())).toBeNull());
    act(() => root!.unmount());
    el!.remove();
    coach();
    await waitFor(() => expect(composer().value).toMatch(/^Short on time/)); // the draft text itself is kept
    await tick(60);
    expect(chip()).toBeNull();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('offline (sharing can’t be checked): nothing is written or sent; the request waits for the next online open', async () => {
    h.online = false;
    await seed();
    await openCoachWith(db(), (() => undefined) as never, { intent: 'shorten', sessionId: 'sess-live', minutes: 10, userId: 'user-1' });
    coach();
    await waitFor(() => expect(el!.querySelector('#ai-composer')).not.toBeNull());
    await tick(80);
    expect(composer().value).toBe('');
    expect(chip()).toBeNull();
    expect(await kvGet(AI_COACH_REQUEST_KEY, db())).toMatchObject({ intent: 'shorten' });
    // Back online: it's sent then.
    act(() => root!.unmount());
    el!.remove();
    h.online = true;
    coach();
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(sendArg().workout).toMatchObject({ intent: 'shorten', minutesLeft: 10 });
  });

  /* ---------------------------------------------------- PR #23 review: P1 Training sharing, P2 deferred attachments */
  it('Summary “Explain” → first-use consent with Training switched off: no generated message, no attachment, nothing sent', async () => {
    await db().sessions.put({ ...live(plan()), id: 'w-done', status: 'completed', endedAt: Date.now() });
    api.getSettings.mockResolvedValue(null);
    api.saveSettings.mockImplementation(async (patch: Partial<AiSettings>) => ({ ...SETTINGS_ON, ...patch, consentAt: '2026-11-28T10:00:00Z' }));
    await openCoachWith(db(), (() => undefined) as never, { intent: 'explain', sessionId: 'w-done', focusId: 'se-bench', shownTarget: '62.5 kg × 8 (Add weight)', userId: 'user-1' });
    coach();
    const training = await waitFor(() => {
      const t = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((x) => norm(document.querySelector(`label[for="${CSS.escape(x.id)}"]`)?.textContent) === 'Training');
      if (!t) throw new Error('no Training switch');
      return t;
    });
    click(training); // switch Training sharing off
    click(button('Turn on training assistant'));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ scopes: expect.objectContaining({ training: false }) })));
    await waitFor(() => expect(text()).toContain('Training sharing is off, so your question about that workout wasn’t sent.'));
    await tick(80);
    expect(api.send).not.toHaveBeenCalled();
    expect(composer().value).toBe('');
    expect(chip()).toBeNull();
    expect(text()).not.toContain('62.5 kg × 8');
    expect(text()).not.toContain('Explain this:');
    expect(await kvGet(AI_COACH_REQUEST_KEY, db())).toBeNull(); // dropped, not kept for later
    expect(await kvGet(AI_ATTACHED_REQUEST_KEY, db())).toBeFalsy();
    // Whatever the user sends next carries no workout.
    fireInput(composer(), 'hello');
    click(button('Send'));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(sendArg().text).toBe('hello');
    expect(sendArg().workout).toBeUndefined();
    expect(JSON.stringify(api.send.mock.calls)).not.toMatch(new RegExp(BENCH.name));
  });

  it('Training sharing turned off after a workout was attached: the attachment is dropped and never sent', async () => {
    await seed();
    await kvSet(AI_ATTACHED_REQUEST_KEY, { intent: 'shorten', sessionId: 'sess-live', minutes: 10, createdAt: Date.now(), userId: 'user-1' }, db());
    api.getSettings.mockResolvedValue({ ...SETTINGS_ON, scopes: { ...SETTINGS_ON.scopes, training: false } });
    coach();
    await waitFor(() => expect(el!.querySelector('#ai-composer')).not.toBeNull());
    await waitFor(async () => expect(await kvGet(AI_ATTACHED_REQUEST_KEY, db())).toBeNull());
    expect(chip()).toBeNull();
    fireInput(composer(), 'quick question');
    click(button('Send'));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(sendArg().workout).toBeUndefined();
  });

  /* ---------------------------------------------------- PR #23 second review: generated text after Training turns off */
  const TRAINING_OFF = { ...SETTINGS_ON, scopes: { ...SETTINGS_ON.scopes, training: false } };
  const GENERATED = `Explain this: why does the app suggest “Add weight → 62.5 kg × 8” for ${BENCH.name} today?`;
  const explainReq = (over: Partial<CoachRequest> = {}): CoachRequest =>
    ({ intent: 'explain', sessionId: 'sess-live', focusId: 'se-bench', shownTarget: 'Add weight → 62.5 kg × 8', createdAt: Date.now(), userId: 'user-1', ...over });

  it('(a) Training turned off with a waiting workout question: its generated text and attachment are both removed; nothing workout-related is sent', async () => {
    await seed();
    // State left by a deferred Explain while Training was on: the generated text in the composer, the attachment kept.
    await kvSet(AI_DRAFT_KEY, GENERATED, db());
    await kvSet(AI_ATTACHED_REQUEST_KEY, explainReq({ text: GENERATED }), db());
    api.getSettings.mockResolvedValue(TRAINING_OFF);
    coach();
    await waitFor(() => expect(text()).toContain('Training sharing is off, so your question about that workout wasn’t sent.'));
    await waitFor(() => expect(composer().value).toBe(''));
    expect(chip()).toBeNull();
    expect(await kvGet(AI_ATTACHED_REQUEST_KEY, db())).toBeNull();
    expect(await kvGet(AI_DRAFT_KEY, db())).toBe('');
    // A reload doesn't bring any of it back.
    act(() => root!.unmount());
    el!.remove();
    coach();
    await waitFor(() => expect(el!.querySelector('#ai-composer')).not.toBeNull());
    await tick(60);
    expect(composer().value).toBe('');
    expect(text()).not.toContain('62.5 kg × 8');
    fireInput(composer(), 'unrelated question');
    click(button('Send'));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(sendArg()).toMatchObject({ text: 'unrelated question' });
    expect(sendArg().workout).toBeUndefined();
    expect(JSON.stringify(api.send.mock.calls)).not.toMatch(/62\.5|bench press/i);
  });

  it('(a) only the generated text goes: what the user wrote around it stays; an edited version of it goes too', async () => {
    await seed();
    await kvSet(AI_DRAFT_KEY, `Also my knees feel fine.\n${GENERATED}`, db());
    await kvSet(AI_ATTACHED_REQUEST_KEY, explainReq({ text: GENERATED }), db());
    api.getSettings.mockResolvedValue(TRAINING_OFF);
    coach();
    await waitFor(() => expect(composer().value).toBe('Also my knees feel fine.'));
    expect(chip()).toBeNull();
    act(() => root!.unmount());
    el!.remove();
    await kvSet(AI_DRAFT_KEY, `${GENERATED.replace('Explain this:', 'Quick one:')}`, db()); // edited from the generated text
    await kvSet(AI_ATTACHED_REQUEST_KEY, explainReq({ text: GENERATED }), db());
    coach();
    await waitFor(() => expect(text()).toContain('Training sharing is off'));
    await waitFor(() => expect(composer().value).toBe(''));
    expect(api.send).not.toHaveBeenCalled();
  });

  it('(b) a failed workout question can’t be retried after Training is turned off: shown as not sendable, Remove only, nothing sent', async () => {
    await seed();
    await kvSet(AI_PENDING_KEY, {
      id: '00000000-0000-4000-8000-000000000777', text: GENERATED, mode: 'chat', status: 'failed', error: 'You appear to be offline.',
      createdAt: new Date().toISOString(), userId: 'user-1', request: explainReq(),
    }, db());
    api.getSettings.mockResolvedValue(TRAINING_OFF);
    coach();
    await waitFor(() => expect(text()).toContain('Not sent: Training sharing is off, so this workout question can’t be sent.'));
    expect(buttons().some((b) => norm(b.textContent) === 'Retry')).toBe(false);
    expect(buttons().some((b) => norm(b.textContent) === 'Edit')).toBe(false);
    await tick(80);
    expect(api.send).not.toHaveBeenCalled();
    click(button('Remove'));
    await waitFor(async () => expect(await kvGet(AI_PENDING_KEY, db())).toBeNull());
    expect(text()).not.toContain('62.5 kg × 8');
    expect(composer().value).toBe(''); // never put back in the composer either
    expect(api.send).not.toHaveBeenCalled();
  });

  it('(b) a workout question left "sending" by a closed tab isn’t re-sent after Training is turned off', async () => {
    await seed();
    await kvSet(AI_PENDING_KEY, { id: '00000000-0000-4000-8000-000000000778', text: GENERATED, mode: 'chat', status: 'sending', createdAt: new Date().toISOString(), userId: 'user-1', request: explainReq() }, db());
    api.getSettings.mockResolvedValue(TRAINING_OFF);
    coach();
    await waitFor(() => expect(text()).toContain('Training sharing is off, so this workout question can’t be sent.'));
    expect(buttons().some((b) => norm(b.textContent) === 'Retry')).toBe(false);
    await tick(80);
    expect(api.send).not.toHaveBeenCalled();
  });

  it('with Training on, the same failed workout question still retries normally (with a fresh snapshot)', async () => {
    await seed();
    await kvSet(AI_PENDING_KEY, { id: '00000000-0000-4000-8000-000000000779', text: GENERATED, mode: 'chat', status: 'failed', createdAt: new Date().toISOString(), userId: 'user-1', request: explainReq() }, db());
    coach();
    click(await waitFor(() => button('Retry')));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(sendArg()).toMatchObject({ id: '00000000-0000-4000-8000-000000000779', text: GENERATED });
    expect(sendArg().workout).toMatchObject({ intent: 'explain', focusId: 'se-bench' });
  });

  it('a deferred attachment survives a reload, comes back with Edit after a failed send, and is rebuilt fresh when sent', async () => {
    await seed();
    await failedPending();
    await openCoachWith(db(), (() => undefined) as never, { intent: 'shorten', sessionId: 'sess-live', minutes: 15, userId: 'user-1' });
    coach();
    await waitFor(() => expect(chip()).not.toBeNull());
    // Reload: draft and attachment are both still there.
    act(() => root!.unmount());
    el!.remove();
    coach();
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(composer().value).toMatch(/^Short on time/);
    // Clear the earlier failed message, then send: it fails.
    click(button('Edit'));
    fireInput(composer(), 'Short on time, keep it brief');
    api.send.mockRejectedValueOnce(Object.assign(new Error('Failed to fetch'), { code: 'network' }));
    click(await waitFor(() => button('Send')));
    await waitFor(() => expect(text()).toContain('Not sent'));
    expect(chip()).toBeNull(); // it travels with the pending message now
    expect(sendArg().workout).toMatchObject({ intent: 'shorten' });
    // Edit the failed send: the attachment comes back with the text.
    click(button('Edit'));
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(await kvGet(AI_ATTACHED_REQUEST_KEY, db())).toMatchObject({ intent: 'shorten', sessionId: 'sess-live' });
    // Log another set meanwhile: the snapshot sent is rebuilt from the device right before sending.
    const sess = (await db().sessions.get('sess-live'))!;
    await saveRecord('sessions', { ...sess, exercises: sess.exercises.map((e) => (e.id === 'se-bench' ? { ...e, sets: e.sets.map((x) => ({ ...x, completed: true })) } : e)) }, db());
    click(await waitFor(() => button('Send')));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(sendArg(1).workout!.exercises.find((e) => e.id === 'se-bench')!.sets.every((x) => x.done)).toBe(true);
    await waitFor(() => expect(chip()).toBeNull());
    expect(await kvGet(AI_ATTACHED_REQUEST_KEY, db())).toBeNull();
  });

  it('"Apply to today’s workout" changes only the live session (plan untouched); Undo restores it', async () => {
    const { p, s } = await seed();
    const planBefore = structuredClone(await db().programs.get(p.id));
    api.history.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'Equipment busy', createdAt: '2026-11-28T10:00:00Z', status: 'sent' },
      { id: 'r1', role: 'assistant', content: 'Use dumbbells today.', createdAt: '2026-11-28T10:00:01Z', status: 'sent', sessionAdjustment: swapAction('u1') },
    ]);
    coach();
    const card = await waitFor(() => {
      const c = el!.querySelector('section[aria-label="Change to today’s workout"]');
      if (!c) throw new Error('no card');
      return c;
    });
    expect(norm(card.textContent)).toContain(`${BENCH.name} → ${DB_BENCH.name}`);
    expect(norm(card.textContent)).toContain('Only today’s workout changes. Your plan and future sessions stay the same.');
    click(await waitFor(() => button('Apply to today’s workout')));
    // Two bench sets were already done: they stay; the last set moves to dumbbell bench, right after it.
    await waitFor(async () => expect((await db().sessions.get(s.id))!.exercises.map((e) => e.exerciseId)).toEqual([BENCH.id, DB_BENCH.id, RAISE.id]));
    expect((await db().sessions.get(s.id))!.exercises[0].sets.every((x) => x.completed)).toBe(true);
    expect(await db().programs.get(p.id)).toEqual(planBefore);
    await waitFor(() => expect(norm(card.textContent)).toContain('Applied'));
    click(button('Back to workout'));
    await waitFor(() => expect(where()).toBe('/train/session/sess-live'));
    act(() => root!.unmount());
    el!.remove();
    coach();
    click(await waitFor(() => button('Undo')));
    await waitFor(async () => expect((await db().sessions.get(s.id))!.exercises).toEqual(s.exercises));
    expect(await db().programs.get(p.id)).toEqual(planBefore);
    await waitFor(() => button('Apply to today’s workout')); // can be applied again
  });

  it('a card for a finished workout explains why it can’t be applied', async () => {
    const { p } = await seed();
    await saveRecord('sessions', live(p, { status: 'completed', endedAt: Date.now() }), db());
    api.history.mockResolvedValue([{ id: 'r1', role: 'assistant', content: 'Shorter.', createdAt: '2026-11-28T10:00:01Z', status: 'sent', sessionAdjustment: shortenAction('u1') }]);
    coach();
    await waitFor(() => expect(text()).toContain('This workout is already finished, so there’s nothing to change.'));
    expect(buttons().some((b) => norm(b.textContent) === 'Apply to today’s workout')).toBe(false);
  });

  it('first open of the Coach: single-step consent, Supportive by default; one tap turns it on and a waiting workout question is sent', async () => {
    await seed();
    api.getSettings.mockResolvedValue(null);
    api.saveSettings.mockImplementation(async (patch: Partial<AiSettings>) => ({ ...SETTINGS_ON, ...patch, consentAt: '2026-11-28T10:00:00Z' }));
    await openCoachWith(db(), (() => undefined) as never, { intent: 'shorten', sessionId: 'sess-live', minutes: 20, userId: 'user-1' });
    coach();
    const turnOn = await waitFor(() => button('Turn on training assistant'));
    expect(text()).toContain('Tone: Supportive (default)');
    expect(text()).toContain('You can switch to Balanced or Strict any time in training assistant settings.');
    expect(text()).toContain('Feeling tired is always a good reason to go lighter or rest.');
    expect(el!.querySelector('input[type="checkbox"]')).toBeNull();
    expect(api.send).not.toHaveBeenCalled();
    click(turnOn);
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, acceptConsent: true, coachStyle: 'supportive', provider: 'openai' })));
    await waitFor(() => expect(el!.querySelector('#ai-composer')).not.toBeNull());
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(sendArg().workout).toMatchObject({ intent: 'shorten', minutesLeft: 20 });
  });
});
