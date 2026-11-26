// @vitest-environment jsdom
/**
 * Icelandic workout logger (roadmap item 8): labels come from the approved dictionary, numeric entry accepts a decimal
 * comma or point but rejects grouped/mixed input, and switching language mid-workout never changes logged data.
 * Rendered with the real SessionPage and Dexie (fake-indexeddb), like loggingUi.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown, account: null as unknown }));

vi.mock('@/state/app', () => ({
  useApp: () => ({ db: h.db, account: h.account, auth: { status: 'guest' }, updateAccount: async () => undefined }),
  useDb: () => h.db,
}));
vi.mock('@/social/autoShare', () => ({ maybeAutoShare: async () => false }));

import { LiftDb } from '@/db/db';
import { defaultAccountState } from '@/state/defaults';
import { ToastProvider } from '@/components/toast';
import SessionPage from '@/features/train/SessionPage';
import { parseNumberText, formatNumber } from '@/features/train/setDraft';
import { validateLoggedSet } from '@/domain/setValidation';
import { validateLoggedSet as validateShared } from '../../supabase/functions/_shared/training/sets';
import { adjustmentLines, applySessionAdjustment } from '@/domain/sessionAdjust';
import { LanguageProvider, setLanguage, type Language } from '@/i18n';
import type { Exercise, WorkoutSession } from '@/domain/types';
import type { SessionAdjustmentAction } from '../../supabase/functions/_shared/ai/workout';

let dbCount = 0;
let root: Root | null = null;
let container: HTMLElement | null = null;

function render(language: Language) {
  setLanguage(language);
  act(() => {
    root!.render(
      createElement(LanguageProvider, {
        language,
        children: createElement(
          ToastProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/train/session/s1'] }, createElement(Routes, null, createElement(Route, { path: '/train/session/:id', element: createElement(SessionPage) }))),
        ),
      }),
    );
  });
}
function mount(language: Language) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render(language);
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
const buttonText = (text: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
  if (!el) throw new Error(`no button ${text}`);
  return el;
};
function type(el: HTMLInputElement, value: string) {
  act(() => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const db = () => h.db as LiftDb;
const stored = async () => (await db().sessions.get('s1'))!;

function seed(): WorkoutSession {
  return {
    id: 's1', createdAt: 1, updatedAt: 1, name: 'Push', status: 'active', date: '2026-10-28', timeZone: 'UTC', startedAt: Date.now() - 60_000, pausedTotalMs: 0,
    notes: 'Felt strong',
    exercises: [
      {
        id: 'e1', exerciseId: 'barbell-bench-press', order: 0, prescription: { sets: 2, repMin: 8, repMax: 10, targetRir: 2, restSec: 90 },
        discomfort: true,
        notes: 'Left shoulder',
        sets: [
          { id: 'a', type: 'normal', weightKg: 61.25, entered: { value: 61.25, unit: 'kg' }, reps: 8, rir: 2, completed: true, completedAt: 5 },
          { id: 'b', type: 'normal', weightKg: null, reps: null, completed: false },
        ],
      },
    ],
  };
}

beforeEach(async () => {
  h.db = new LiftDb(`i18n-logger-${++dbCount}`);
  h.account = defaultAccountState();
  localStorage.clear();
  await db().sessions.put(seed());
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setLanguage('en');
});

describe('Icelandic logger', () => {
  it('renders the approved Icelandic labels and numbers with a decimal comma', async () => {
    mount('is');
    await waitFor(() => input('Þyngd í setti 1, í kg'));
    expect(buttonText('Ljúka æfingu')).toBeTruthy();
    expect(buttonText('Bæta við setti')).toBeTruthy();
    expect(input('Endurtekningar í setti 2')).toBeTruthy();
    expect(input('Þyngd í setti 1, í kg').value).toBe('61,25');
    expect(container!.textContent).toContain('Óþægindi skráð');
    expect(container!.textContent).not.toMatch(/Add set|Finish|Discomfort noted/);
  });

  it('the progression hint is the engine target in Icelandic (decimal comma, unit unchanged)', async () => {
    const done = (id: string, startedAt: number): WorkoutSession => ({
      id, createdAt: startedAt, updatedAt: startedAt, name: 'Push', status: 'completed', date: '2026-10-20', timeZone: 'UTC', startedAt, endedAt: startedAt + 1000, pausedTotalMs: 0,
      exercises: [{
        id: `${id}-e`, exerciseId: 'barbell-bench-press', order: 0, prescription: { sets: 2, repMin: 8, repMax: 10, targetRir: 2, restSec: 90 },
        sets: [1, 2].map((n) => ({ id: `${id}-${n}`, type: 'normal' as const, weightKg: 60, entered: { value: 60, unit: 'kg' as const }, reps: 10, rir: 2, completed: true, completedAt: startedAt })),
      }],
    });
    await db().sessions.bulkPut([done('h1', Date.now() - 4 * 86400_000), done('h2', Date.now() - 2 * 86400_000)]);
    await db().sessions.put({ ...seed(), exercises: seed().exercises.map((e) => ({ ...e, discomfort: false })) });
    mount('is');
    await waitFor(() => expect(container!.textContent).toContain('62,5 kg'));
    expect(container!.textContent).toContain('Síðast: 60×10, 60×10');
    expect(container!.textContent).not.toContain('62.5');
  });

  it('comma input "62,5" saves 62.5; "62.5" is accepted too', async () => {
    mount('is');
    const el = await waitFor(() => input('Þyngd í setti 2, í kg'));
    type(el, '62,5');
    await waitFor(async () => expect((await stored()).exercises[0].sets[1].weightKg).toBe(62.5));
    expect((await stored()).exercises[0].sets[1].entered).toEqual({ value: 62.5, unit: 'kg' });
    type(el, '62.5');
    await tick(500);
    expect((await stored()).exercises[0].sets[1].weightKg).toBe(62.5);
    act(() => el.blur());
    await tick();
    expect(input('Þyngd í setti 2, í kg').value).toBe('62,5');
  });

  it('grouped/mixed "1.234,5" is rejected with a clear message and nothing is saved; the draft stays', async () => {
    mount('is');
    const el = await waitFor(() => input('Þyngd í setti 2, í kg'));
    type(el, '1.234,5');
    await tick(500);
    expect(container!.textContent).toContain('Sláðu inn tölu.');
    expect(el.value).toBe('1.234,5');
    expect((await stored()).exercises[0].sets[1].weightKg).toBeNull();
  });

  it('switching language mid-workout leaves sets, loads, notes and discomfort unchanged', async () => {
    mount('is');
    const el = await waitFor(() => input('Þyngd í setti 2, í kg'));
    type(el, '62,5');
    await waitFor(async () => expect((await stored()).exercises[0].sets[1].weightKg).toBe(62.5));
    act(() => el.blur());
    await tick(50);
    const before = await stored();

    render('en');
    await waitFor(() => input('Set 2 load in kg'));
    expect(buttonText('Finish')).toBeTruthy();
    expect(input('Set 1 load in kg').value).toBe('61.25');
    expect(input('Set 2 load in kg').value).toBe('62.5');
    await tick(500);
    render('is');
    await waitFor(() => input('Þyngd í setti 2, í kg'));
    expect(input('Þyngd í setti 2, í kg').value).toBe('62,5');
    await tick(500);

    const after = await stored();
    expect(after.exercises).toEqual(before.exercises);
    expect(after.notes).toBe('Felt strong');
    expect(after.exercises[0].notes).toBe('Left shoulder');
    expect(after.exercises[0].discomfort).toBe(true);
    expect(after.exercises[0].sets.map((s) => [s.weightKg, s.reps, s.completed])).toEqual([
      [61.25, 8, true],
      [62.5, null, false],
    ]);
  });
});

describe('Icelandic logger domain text', () => {
  it('parses decimal comma/point, rejects grouped input, keeps min/max checks', () => {
    setLanguage('is');
    expect(parseNumberText('62,5')).toEqual({ kind: 'number', value: 62.5 });
    expect(parseNumberText('62.5')).toEqual({ kind: 'number', value: 62.5 });
    const grouped = parseNumberText('1.234,5');
    expect(grouped.kind).toBe('invalid');
    expect(grouped.kind === 'invalid' && grouped.reason).toBe('Sláðu inn tölu.');
    expect(parseNumberText('1 234').kind).toBe('invalid');
    expect(parseNumberText('11', { max: 10 }).kind).toBe('invalid');
    expect(parseNumberText('8,5', { decimals: false }).kind).toBe('invalid');
    expect(formatNumber(61.25, 'is')).toBe('61,25');
    expect(formatNumber(61.25, 'en')).toBe('61.25');
  });

  it('set validation messages follow the language; the shared engine stays English by default', () => {
    setLanguage('is');
    const ex = { tracking: 'weight_reps', load: 'total' } as const;
    const set = { id: 'x', type: 'normal', weightKg: 60, reps: null, completed: false } as const;
    expect(validateLoggedSet({ ...set }, ex, { mode: 'log', asCompleted: true }).errors).toEqual(['Skráðu að minnsta kosti eina endurtekningu.']);
    expect(validateShared({ ...set }, ex, { mode: 'log', asCompleted: true }).errors).toEqual(['Enter at least 1 rep.']);
    expect(validateShared({ ...set }, ex, { mode: 'log', asCompleted: true, lang: 'is' }).ok).toBe(false);
  });

  it('session adjustment lines and refusals are Icelandic; names stay as they are', () => {
    setLanguage('is');
    const action = {
      kind: 'session_adjustment', id: 'm1', sessionId: 's1', change: 'shorten', summary: '', warnings: [],
      removeSets: [{ sessionExerciseId: 'e1', name: 'Bench press', count: 2 }],
      dropExercises: [{ sessionExerciseId: 'e2', name: 'Lateral raise' }],
    } as unknown as SessionAdjustmentAction;
    expect(adjustmentLines(action)).toEqual(['Sleppa: Lateral raise', 'Bench press: fækka um 2 sett']);
    const r = applySessionAdjustment({ ...seed(), id: 'other' }, action, new Map<string, Exercise>());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('Þessi breyting er fyrir aðra æfingu.');
  });
});
