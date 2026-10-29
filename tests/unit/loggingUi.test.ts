// @vitest-environment jsdom
/**
 * Workout logger input persistence & completion validation, rendered with the real SessionPage,
 * real Dexie (fake-indexeddb) and a mocked app context. "Reload" = unmount + remount and re-read from Dexie.
 * (@testing-library/dom isn't installed, so this uses react-dom/client + act like the other UI tests.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown, account: null as unknown, failSave: false }));

vi.mock('@/state/app', () => ({
  useApp: () => ({ db: h.db, account: h.account, auth: { status: 'guest' }, updateAccount: async () => undefined }),
  useDb: () => h.db,
}));
vi.mock('@/social/autoShare', () => ({ maybeAutoShare: async () => false }));
vi.mock('@/db/repo', async (orig) => {
  const actual = (await orig()) as typeof import('@/db/repo');
  return {
    ...actual,
    saveRecord: (...args: Parameters<typeof actual.saveRecord>) => (h.failSave ? Promise.reject(new Error('The device storage is full')) : actual.saveRecord(...args)),
  };
});

import { LiftDb } from '@/db/db';
import { defaultAccountState } from '@/state/defaults';
import { ToastProvider } from '@/components/toast';
import SessionPage from '@/features/train/SessionPage';
import { draftKey } from '@/features/train/setDraft';
import type { WorkoutSession } from '@/domain/types';

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
        createElement(MemoryRouter, { initialEntries: ['/train/session/s1'] }, createElement(Routes, null, createElement(Route, { path: '/train/session/:id', element: createElement(SessionPage) }), createElement(Route, { path: '*', element: createElement('div', null, 'elsewhere') }))),
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
const input = (label: string) => {
  const el = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!el) throw new Error(`no input ${label}`);
  return el;
};
const button = (label: string | RegExp) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => (typeof label === 'string' ? b.getAttribute('aria-label') === label || b.textContent?.trim() === label : label.test(b.getAttribute('aria-label') ?? b.textContent ?? '')));
  if (!el) throw new Error(`no button ${label}`);
  return el;
};
function type(el: HTMLInputElement, value: string) {
  act(() => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}
const db = () => h.db as LiftDb;
const set = async (i: number) => (await db().sessions.get('s1'))!.exercises[0].sets[i];

function seed(): WorkoutSession {
  return {
    id: 's1', createdAt: 1, updatedAt: 1, name: 'Push', status: 'active', date: '2026-10-28', timeZone: 'UTC', startedAt: Date.now() - 60_000, pausedTotalMs: 0,
    exercises: [
      {
        id: 'e1', exerciseId: 'barbell-bench-press', order: 0, prescription: { sets: 2, repMin: 8, repMax: 10, targetRir: 2, restSec: 90 },
        sets: [
          { id: 'a', type: 'normal', weightKg: 20, entered: { value: 20, unit: 'kg' }, reps: 8, completed: false },
          { id: 'b', type: 'normal', weightKg: null, reps: null, completed: false },
        ],
      },
      {
        id: 'e2', exerciseId: 'plank', order: 1, prescription: { sets: 1, repMin: 1, repMax: 1, targetRir: 2, restSec: 60, durationSec: 30 },
        sets: [{ id: 'p', type: 'timed', weightKg: null, reps: null, durationSec: null, completed: false }],
      },
    ],
  };
}

beforeEach(async () => {
  h.failSave = false;
  h.db = new LiftDb(`logging-ui-${++dbCount}`);
  h.account = defaultAccountState();
  localStorage.clear();
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  await db().sessions.put(seed());
  mount();
  await waitFor(() => input('Set 1 load in kg'));
});
afterEach(() => {
  unmount();
});

describe('logger input persistence', () => {
  it('reproduced defect fixed: save 20 kg, type 25 kg leaving the field focused → after the debounce a reload shows 25 kg', async () => {
    const el = input('Set 1 load in kg');
    expect(el.value).toBe('20');
    type(el, '25');
    expect(document.activeElement).toBe(el);
    await waitFor(async () => expect((await set(0)).weightKg).toBe(25));
    expect(document.activeElement).toBe(input('Set 1 load in kg')); // same element: not remounted, still focused
    expect((await set(0)).entered).toEqual({ value: 25, unit: 'kg' });
    unmount(); // "reload"
    mount();
    await waitFor(() => expect(input('Set 1 load in kg').value).toBe('25'));
  });

  it('typing keeps the draft text while focused (decimal comma, no cursor-clobbering) and saves 22.5', async () => {
    const el = input('Set 1 load in kg');
    type(el, '22,');
    await tick(500);
    expect(el.value).toBe('22,'); // not rewritten to "22" while typing
    type(el, '22,5');
    await waitFor(async () => expect((await set(0)).weightKg).toBe(22.5));
    expect(el.value).toBe('22,5');
    act(() => el.blur());
    await tick();
    expect(input('Set 1 load in kg').value).toBe('22.5');
  });

  it('physical load is preserved across unit changes: focusing/blurring a kg value shown in lb rewrites nothing', async () => {
    unmount();
    (h.account as { settings: { units: { weight: string } } }).settings.units.weight = 'lb';
    mount();
    const el = await waitFor(() => input('Set 1 load in lb'));
    expect(el.value).toBe('44.1'); // 20 kg
    act(() => el.focus());
    act(() => el.blur());
    await tick(500);
    expect(await set(0)).toMatchObject({ weightKg: 20, entered: { value: 20, unit: 'kg' } });
    type(el, '45');
    await waitFor(async () => expect((await set(0)).entered).toEqual({ value: 45, unit: 'lb' }));
    expect((await set(0)).weightKg).toBeCloseTo(20.4116, 3);
  });

  it('navigating away before the debounce flushes the typed value', async () => {
    type(input('Set 1 reps'), '9');
    unmount(); // route change unmounts the logger
    await waitFor(async () => expect((await set(0)).reps).toBe(9));
  });

  it('pagehide and visibility=hidden flush pending values immediately', async () => {
    type(input('Set 1 reps'), '7');
    act(() => void window.dispatchEvent(new Event('pagehide')));
    await waitFor(async () => expect((await set(0)).reps).toBe(7), 300); // well before the 400 ms debounce
    type(input('Set T1 duration in seconds'), '45');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await waitFor(async () => expect((await db().sessions.get('s1'))!.exercises[1].sets[0].durationSec).toBe(45), 300);
  });

  it('a local draft left by a killed tab is restored and saved on reopen', async () => {
    unmount();
    localStorage.setItem('lc.setdraft:' + draftKey('s1', 'a', 'weight'), JSON.stringify({ text: '27,5', t: Date.now() }));
    mount();
    await waitFor(() => expect(input('Set 1 load in kg').value).toBe('27,5'));
    await waitFor(async () => expect((await set(0)).weightKg).toBe(27.5));
    await waitFor(() => expect(localStorage.getItem('lc.setdraft:' + draftKey('s1', 'a', 'weight'))).toBeNull());
  });

  it('completing a set before the debounced write uses the typed value', async () => {
    type(input('Set 1 reps'), '10');
    click(button('Mark set 1 done'));
    await waitFor(async () => {
      const s = await set(0);
      expect(s.completed).toBe(true);
      expect(s.reps).toBe(10);
    });
    expect((await set(1)).reps).toBe(10); // carried forward from the typed value
  });

  it('an empty draft clears the value (null, not 0)', async () => {
    type(input('Set 1 reps'), '');
    await waitFor(async () => expect((await set(0)).reps).toBeNull());
  });

  it('storage errors are visible, keep the session and the typed value, and Retry saves it', async () => {
    h.failSave = true;
    type(input('Set 1 load in kg'), '40');
    await waitFor(() => expect(document.body.textContent).toContain('Couldn’t save your last change on this device'));
    expect(input('Set 1 load in kg').value).toBe('40');
    expect(localStorage.getItem('lc.setdraft:' + draftKey('s1', 'a', 'weight'))).toContain('40');
    expect((await set(0)).weightKg).toBe(20); // session kept intact
    h.failSave = false;
    click(button('Retry'));
    await waitFor(async () => expect((await set(0)).weightKg).toBe(40));
    await waitFor(() => expect(document.body.textContent).not.toContain('Couldn’t save your last change'));
  });
});

describe('logger completion validation', () => {
  it('reproduced defect fixed: 20 kg / 0 reps cannot be marked done, starts no rest and copies nothing forward', async () => {
    type(input('Set 1 reps'), '0');
    click(button('Mark set 1 done'));
    await waitFor(() => expect(document.body.textContent).toContain('Enter at least 1 rep'));
    const s = (await db().sessions.get('s1'))!;
    expect(s.exercises[0].sets[0].completed).toBe(false);
    expect(s.exercises[0].sets[0].reps).toBe(0); // the draft is kept, just not completed work
    expect(s.exercises[0].sets[1].reps).toBeNull();
    expect(s.rest).toBeUndefined();
    expect(document.querySelector('[role="timer"]')).toBeNull();
  });

  it('a timed set needs a time above 0; then it completes and starts rest', async () => {
    click(button('Mark set T1 done'));
    await waitFor(() => expect(document.body.textContent).toContain('Enter a time above 0'));
    type(input('Set T1 duration in seconds'), '35');
    click(button('Mark set T1 done'));
    await waitFor(async () => expect((await db().sessions.get('s1'))!.exercises[1].sets[0]).toMatchObject({ completed: true, durationSec: 35 }));
    await waitFor(async () => expect((await db().sessions.get('s1'))!.rest?.endsAt).toBeGreaterThan(0));
  });

  it('a loaded working set needs a load when logging (no silent known-zero)', async () => {
    type(input('Set 2 reps'), '8');
    click(button('Mark set 2 done'));
    await waitFor(() => expect(document.body.textContent).toContain('Enter the weight used'));
    expect((await set(1)).completed).toBe(false);
  });

  it('a completed set cannot be corrected into invalid work in the logger', async () => {
    click(button('Mark set 1 done'));
    await waitFor(async () => expect((await set(0)).completed).toBe(true));
    const reps = input('Set 1 reps');
    type(reps, '0');
    await tick(500);
    expect((await set(0)).reps).toBe(8); // not saved
    expect(reps.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('progression choices (Apply / Keep previous / Customize; Hide only hides)', () => {
  const done = (id: string, startedAt: number): WorkoutSession => ({
    id, createdAt: 1, updatedAt: 1, name: 'Push', status: 'completed', date: '2026-10-2' + id.slice(-1), timeZone: 'UTC', startedAt, endedAt: startedAt + 1, pausedTotalMs: 0,
    exercises: [{ id: `${id}e`, exerciseId: 'barbell-bench-press', order: 0, sets: [
      { id: `${id}a`, type: 'normal', weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: 10, completed: true },
      { id: `${id}b`, type: 'normal', weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: 10, completed: true },
    ] }],
  });
  beforeEach(async () => {
    unmount();
    await db().sessions.bulkPut([done('h1', 1000), done('h2', 2000)]);
    const s = seed();
    s.exercises[0].sets = s.exercises[0].sets.map((x) => ({ ...x, weightKg: 60, entered: { value: 60, unit: 'kg' as const }, reps: 10 }));
    await db().sessions.put(s);
    mount();
    await waitFor(() => button('Apply'));
  });
  const pressed = (name: string) => button(name).getAttribute('aria-pressed');

  it('shows the target, states that effort wasn’t logged, and applies / keeps / customizes explicitly', async () => {
    expect(document.body.textContent).toMatch(/Increase load → 62\.5 kg × 8 reps/);
    expect(document.body.textContent).toMatch(/Effort wasn’t logged/);
    expect(document.body.textContent).not.toMatch(/at the target effort/);
    expect(pressed('Keep previous')).toBe('true');
    click(button('Apply'));
    await waitFor(async () => expect(await set(0)).toMatchObject({ weightKg: 62.5, reps: 8 }));
    await waitFor(() => expect(pressed('Apply')).toBe('true'));
    click(button('Keep previous'));
    await waitFor(async () => expect(await set(1)).toMatchObject({ weightKg: 60, reps: 10 }));
    click(button('Customize'));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Set 1 load in kg');
    type(input('Set 1 load in kg'), '61');
    await waitFor(() => expect(pressed('Customize')).toBe('true'));
  });

  it('Hide only hides the tip and changes no set', async () => {
    const before = (await db().sessions.get('s1'))!.exercises[0].sets;
    click(button('Hide this tip (your sets stay as they are)'));
    await tick(50);
    expect(document.body.textContent).not.toMatch(/Increase load →/);
    expect((await db().sessions.get('s1'))!.exercises[0].sets).toEqual(before);
  });
});

describe('exercise picker constraints', () => {
  it('limits suggestions to what fits and offers an explicit "Show all exercises" override', async () => {
    unmount();
    const { ExercisePicker } = await import('@/components/ExercisePicker');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(ExercisePicker, {
          open: true, onClose: () => undefined, onPick: () => undefined, suggestIds: ['lat-pulldown', 'band-pulldown', 'pull-up'],
          fits: (e) => e.equipment.every((q) => q === 'bodyweight' || q === 'band'),
        }))),
      ),
    );
    await waitFor(() => expect(document.body.textContent).toContain('Exercises that fit'));
    const names = () => [...document.querySelectorAll('li button')].map((b) => b.textContent ?? '');
    expect(names().some((n) => n.includes('Band lat pulldown'))).toBe(true);
    expect(names().some((n) => n.startsWith('Lat pulldown'))).toBe(false);
    expect(names().some((n) => n.includes('Barbell bench press'))).toBe(false);
    click(button('Show all exercises'));
    await waitFor(() => expect(names().some((n) => n.includes('Barbell bench press'))).toBe(true));
    expect(names().some((n) => n.startsWith('Lat pulldown'))).toBe(true);
  });
});
