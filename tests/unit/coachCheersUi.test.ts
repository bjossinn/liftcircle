// @vitest-environment jsdom
/**
 * Coach cheers in the real workout logger (SessionPage + ToastProvider, real Dexie via fake-indexeddb, mocked app
 * context): a popup on ✓, none on undo, the rest-over popup naming the right next set (driven by the stored
 * deadline, shown once), the popup never taking focus, and the toggle switching everything off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown, account: null as unknown, updates: [] as unknown[] }));

vi.mock('@/state/app', () => ({
  useApp: () => ({
    db: h.db,
    account: h.account,
    auth: { status: 'guest' },
    updateAccount: async (fn: (a: unknown) => unknown) => {
      h.account = fn(h.account);
      h.updates.push(h.account);
    },
  }),
  useDb: () => h.db,
}));
vi.mock('@/social/autoShare', () => ({ maybeAutoShare: async () => false }));

import { LiftDb } from '@/db/db';
import { defaultAccountState } from '@/state/defaults';
import { ToastProvider } from '@/components/toast';
import SessionPage from '@/features/train/SessionPage';
import { CHEER_LINES } from '@/domain/coachCheers';
import type { AccountState, WorkoutSession } from '@/domain/types';

let dbCount = 0;
let root: Root | null = null;
let container: HTMLElement | null = null;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        ToastProvider,
        null,
        createElement(MemoryRouter, { initialEntries: ['/train/session/s1'] }, createElement(Routes, null, createElement(Route, { path: '/train/session/:id', element: createElement(SessionPage) }))),
      ),
    );
  });
}
function unmount() {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
}
const tick = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function waitFor<T>(fn: () => T | Promise<T>, timeout = 3000): Promise<T> {
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
const button = (label: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
  if (!el) throw new Error(`no button ${label}`);
  return el;
};
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const popups = () => [...document.querySelectorAll<HTMLElement>('[data-coach-cheer]')];
const popupText = () => popups().map((p) => p.textContent?.replace(/^Coach: /, '').replace(/Undo$/, '').trim());
const db = () => h.db as LiftDb;
const account = () => h.account as AccountState;

function seed(over: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    id: 's1', createdAt: 1, updatedAt: 1, name: 'Upper A', status: 'active', date: '2026-10-30', timeZone: 'UTC', startedAt: Date.now() - 60_000, pausedTotalMs: 0,
    exercises: [
      {
        id: 'e1', exerciseId: 'barbell-bench-press', order: 0, prescription: { sets: 3, repMin: 8, repMax: 10, targetRir: 2, restSec: 90 },
        sets: [
          { id: 'w', type: 'warmup', weightKg: 20, entered: { value: 20, unit: 'kg' }, reps: 10, completed: false },
          { id: 'a', type: 'normal', weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: 8, completed: false },
          { id: 'b', type: 'normal', weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: 8, completed: false },
          { id: 'c', type: 'normal', weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: 8, completed: false },
        ],
      },
    ],
    ...over,
  };
}

async function start(session = seed(), tweak?: (a: AccountState) => void) {
  h.account = defaultAccountState();
  account().settings.rest.autoStart = false; // keep the ✓ tests free of rest popups unless a test wants one
  tweak?.(account());
  await db().sessions.put(session);
  mount();
  await waitFor(() => button('Mark set W done'));
}

beforeEach(() => {
  h.db = new LiftDb(`cheers-ui-${++dbCount}`);
  h.updates = [];
  localStorage.clear();
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => unmount());

describe('coach cheers in the logger', () => {
  it('tapping ✓ shows one coach popup (avatar + one line, polite, Undo kept) that never takes focus', async () => {
    await start();
    const before = document.activeElement;
    click(button('Mark set 1 done'));
    await waitFor(() => expect(popups()).toHaveLength(1));
    const [line] = popupText();
    expect(CHEER_LINES.general.balanced).toContain(line);
    expect(popups()[0].closest('[aria-live="polite"]')).toBeTruthy();
    expect(popups()[0].getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(before);
    expect(document.body.textContent).not.toContain('Set logged'); // the cheer replaces the plain toast
    // A second ✓ replaces the popup (one at a time) with a different line.
    click(button('Mark set 2 done'));
    await waitFor(() => expect(popupText()[0]).not.toBe(line));
    expect(popups()).toHaveLength(1);
    // Tap to dismiss.
    click(popups()[0]);
    expect(popups()).toHaveLength(0);
  });

  it('follows the coach style mirrored in the app settings (Strict)', async () => {
    await start(seed(), (a) => (a.settings.coachStyle = 'strict'));
    click(button('Mark set 1 done'));
    await waitFor(() => expect(popups()).toHaveLength(1));
    expect(CHEER_LINES.general.strict).toContain(popupText()[0]);
  });

  it('undo is quiet: the popup’s Undo and un-ticking a done set show no new popup', async () => {
    await start();
    click(button('Mark set 1 done'));
    await waitFor(() => expect(popups()).toHaveLength(1));
    click([...popups()[0].querySelectorAll('button')].find((b) => b.textContent === 'Undo')!);
    await waitFor(async () => expect((await db().sessions.get('s1'))!.exercises[0].sets[1].completed).toBe(false));
    await tick(60);
    expect(popups()).toHaveLength(0);
    click(button('Mark set 1 done'));
    await waitFor(() => expect(popups()).toHaveLength(1));
    click(popups()[0]);
    click(button('Set 1 done. Tap to undo'));
    await waitFor(async () => expect((await db().sessions.get('s1'))!.exercises[0].sets[1].completed).toBe(false));
    await tick(60);
    expect(popups()).toHaveLength(0);
  });

  it('warm-up sets get no coach popup', async () => {
    await start();
    click(button('Mark set W done'));
    await waitFor(() => expect(document.body.textContent).toContain('Set logged'));
    expect(popups()).toHaveLength(0);
  });

  it('when the rest timer ends, a popup names the next set — once, even after a reload', async () => {
    const s = seed({ rest: { endsAt: Date.now() + 120, durationMs: 90_000, forExerciseId: 'e1' } });
    s.exercises[0].sets[1].completed = true;
    s.exercises[0].sets[2] = { ...s.exercises[0].sets[2], weightKg: 62.5, entered: { value: 62.5, unit: 'kg' } };
    await start(s);
    expect(popups()).toHaveLength(0);
    await waitFor(() => expect(popupText()[0]).toMatch(/^Rest’s up, Barbell bench press set 2: 62\.5 kg × 8\. /));
    expect(CHEER_LINES.rest_over.balanced.map((t) => t.replace('{set}', 'Barbell bench press set 2: 62.5 kg × 8'))).toContain(popupText()[0]);
    click(popups()[0]);
    unmount();
    mount();
    await waitFor(() => button('Mark set W done'));
    await tick(150);
    expect(popups()).toHaveLength(0);
  });

  it('a deadline that passed while the app was in the background is announced once on return', async () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const s = seed({ rest: { endsAt: Date.now() + 50, durationMs: 90_000, forExerciseId: 'e1' } });
    s.exercises[0].sets[1].completed = true;
    await start(s);
    await tick(150);
    expect(popups()).toHaveLength(0);
    vis.mockReturnValue('visible');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(popupText()[0]).toMatch(/^Rest’s up, Barbell bench press set 2: 60 kg × 8\./));
    click(popups()[0]);
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await tick(30);
    expect(popups()).toHaveLength(0);
    vis.mockRestore();
  });

  it('toggle off means silence: no ✓ popup and no rest popup (plain "Set logged" stays)', async () => {
    const s = seed({ rest: { endsAt: Date.now() + 60, durationMs: 90_000, forExerciseId: 'e1' } });
    await start(s, (a) => (a.settings.workout.coachCheers = false));
    await tick(150);
    expect(popups()).toHaveLength(0);
    click(button('Mark set 1 done'));
    await waitFor(() => expect(document.body.textContent).toContain('Set logged'));
    expect(popups()).toHaveLength(0);
  });

  it('the logger menu has a quick on/off that writes Settings.workout.coachCheers', async () => {
    await start();
    click(button('Workout options'));
    const toggle = await waitFor(() => {
      const label = [...document.querySelectorAll('label')].find((l) => l.textContent === 'Coach cheers during workouts');
      const el = label ? document.getElementById(label.htmlFor) : null;
      if (!el) throw new Error('no toggle');
      return el;
    });
    click(toggle);
    await waitFor(() => expect(account().settings.workout.coachCheers).toBe(false));
  });
});
