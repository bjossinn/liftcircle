// @vitest-environment jsdom
/**
 * Workout summary "Next:" line, rendered with the real SummaryPage, real Dexie (fake-indexeddb) and a mocked app
 * context: the engine's target per exercise, its condition when effort wasn't logged, and the discomfort hold.
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
vi.mock('@/features/social/SharePreview', () => ({ SharePreview: () => null }));
vi.mock('@/components/celebrate', () => ({ celebrateOnce: () => undefined }));

import { LiftDb } from '@/db/db';
import { defaultAccountState } from '@/state/defaults';
import SummaryPage from '@/features/train/SummaryPage';
import type { AccountState, LoggedSet, WorkoutSession } from '@/domain/types';

let dbCount = 0;
let root: Root | null = null;
let container: HTMLElement | null = null;
const tick = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function waitFor<T>(fn: () => T, timeout = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (Date.now() - start > timeout) throw e;
      await tick(15);
    }
  }
}

const sets = (n: number, s: Partial<LoggedSet>): LoggedSet[] =>
  Array.from({ length: n }, (_, i) => ({ id: `x${i}-${Math.random()}`, type: 'normal', weightKg: 60, reps: 12, completed: true, ...s }));
const workout = (id: string, day: number, exSets: LoggedSet[], extra: object = {}): WorkoutSession => ({
  id, createdAt: day, updatedAt: day, name: 'Lower', status: 'completed', date: `2026-11-0${day}`, timeZone: 'UTC',
  startedAt: Date.parse(`2026-11-0${day}T17:00:00Z`), endedAt: Date.parse(`2026-11-0${day}T18:00:00Z`), pausedTotalMs: 0,
  exercises: [{ id: `${id}-e`, exerciseId: 'barbell-back-squat', order: 0, prescription: { sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 120 }, sets: exSets, ...extra }],
});

async function show(id: string, rows: WorkoutSession[], experience: AccountState['profile']['experience']) {
  const db = h.db as LiftDb;
  await db.sessions.bulkPut(rows);
  (h.account as AccountState).profile.experience = experience;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(MemoryRouter, { initialEntries: [`/train/summary/${id}`] }, createElement(Routes, null, createElement(Route, { path: '/train/summary/:id', element: createElement(SummaryPage) }))));
  });
  return waitFor(() => {
    const el = container!.querySelector('[data-testid="next-target"]');
    if (!el) throw new Error('no next-target yet');
    return el.textContent ?? '';
  });
}

beforeEach(() => {
  h.db = new LiftDb(`summary-next-ui-${++dbCount}`);
  h.account = defaultAccountState();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

describe('workout summary renders the engine’s next target', () => {
  it('unlogged effort: shows the increase together with the engine’s condition, never as unconditional', async () => {
    const text = await show('w1', [workout('w1', 1, sets(3, {}))], 'new');
    expect(text).toContain('Next: 62.5 kg × 8 reps');
    expect(text).toContain('Increase load');
    expect(text).toContain('Effort wasn’t logged: increase only if those sets felt like about 2 reps left in the tank.');
  });

  it('logged effort at target: the increase without a condition', async () => {
    const text = await show('w1', [workout('w1', 1, sets(3, { rir: 2 }))], 'new');
    expect(text).toContain('Next: 62.5 kg × 8 reps');
    expect(text).not.toContain('increase only if');
  });

  it('not a beginner: one good session means repeat the load', async () => {
    const text = await show('w1', [workout('w1', 1, sets(3, { rir: 2 }))], 'advanced');
    expect(text).toContain('Next: 60 kg × 12 reps');
    expect(text).toContain('Hold');
  });

  it('discomfort flagged with only a warm-up done: no increase', async () => {
    const hurt = workout('w2', 2, [{ id: 'wu', type: 'warmup', weightKg: 40, reps: 5, completed: true }, ...sets(3, { completed: false })], { discomfort: true });
    const text = await show('w2', [workout('w1', 1, sets(3, { rir: 2 })), hurt], 'new');
    expect(text).toContain('No increase');
    expect(text).not.toContain('62.5');
  });
});
