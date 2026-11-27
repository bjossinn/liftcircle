// @vitest-environment jsdom
/**
 * Roadmap item 11 — Progress shows existing data and discloses unused metrics gradually: one neutral empty state
 * for a new account; sections appear only with recorded data (existing order); food is read regardless of the
 * nutrition setting; zero protein is data and unknown protein is not; period-empty + "Show all time"; measured kinds
 * only; cardio without distance; discomfort-only sessions; bodyweight/timed/assisted-zero sets; account switch; the
 * first measurement/goal editors are reachable from "Add a record". Pure selectors are tested separately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown, account: null as unknown }));
vi.mock('@/state/app', () => ({
  useApp: () => ({ db: h.db, account: h.account, accountReady: true, auth: { status: 'signed_out' }, online: true, updateAccount: async () => undefined }),
  useDb: () => h.db,
}));
vi.mock('@/app/TopActions', () => ({ TopActions: () => null }));

import { ToastProvider } from '@/components/toast';
import { LiftDb } from '@/db/db';
import { LanguageProvider, setLanguage, type Language } from '@/i18n';
import { defaultAccountState } from '@/state/defaults';
import { addDays, todayISO } from '@/lib/dates';
import type { AccountState, ActivityLog, FoodLogEntry, LoggedSet, Measurement, UserGoal, WorkoutSession } from '@/domain/types';
import ProgressPage from '@/features/progress/ProgressPage';
import { earliestDate, loadBuckets, measuredKinds, pickMeasurementKind, proteinView, sectionAvailability, validChoice } from '@/features/progress/visibility';
import { EXERCISES } from '@/data/exercises';

const dialogProto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const text = () => norm(document.body.textContent);
const TODAY = todayISO('UTC');
let root: Root | null = null;
let container: HTMLElement | null = null;
let db: LiftDb;
let n = 0;
const sync = () => ({ id: `r${++n}`, createdAt: n, updatedAt: n });

function render(language: Language = 'en') {
  return act(() =>
    root!.render(
      createElement(LanguageProvider, {
        language,
        children: createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(ProgressPage))),
      }),
    ),
  );
}
function mount(language: Language = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render(language);
}
async function waitFor<T>(fn: () => T | Promise<T>, tries = 200): Promise<T> {
  for (;; tries--) {
    try {
      return await fn();
    } catch (e) {
      if (tries <= 0) throw e;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15));
      });
    }
  }
}
const sections = () => [...document.querySelectorAll('section[aria-labelledby^="p-"]')].map((s) => s.getAttribute('aria-labelledby'));
const button = (label: string) => {
  const b = [...document.querySelectorAll('button')].find((x) => norm(x.textContent) === label || x.getAttribute('aria-label') === label);
  expect(b, label).toBeTruthy();
  return b as HTMLButtonElement;
};
const click = (b: HTMLElement) => act(() => void b.dispatchEvent(new MouseEvent('click', { bubbles: true })));

const food = (over: Partial<FoodLogEntry>): FoodLogEntry => ({ ...sync(), name: 'x', source: { kind: 'quick' }, date: TODAY, meal: 'lunch', ...over }) as FoodLogEntry;
const set = (over: Partial<LoggedSet>): LoggedSet => ({ id: `s${++n}`, type: 'normal', completed: true, ...over });
const session = (date: string, exercises: { exerciseId: string; sets: LoggedSet[]; discomfort?: boolean }[]): WorkoutSession =>
  ({ ...sync(), name: 'W', status: 'completed', date, timeZone: 'UTC', startedAt: 1, endedAt: 3_600_001, pausedTotalMs: 0, exercises: exercises.map((e, i) => ({ id: `se${i}`, order: i, ...e })) }) as unknown as WorkoutSession;
const measurement = (kind: Measurement['kind'], value: number, date = TODAY): Measurement => ({ ...sync(), kind, value, date });
const activity = (over: Partial<ActivityLog>): ActivityLog => ({ ...sync(), type: 'walk', date: TODAY, timeZone: 'UTC', durationSec: 1800, ...over }) as ActivityLog;

function account(over: (a: AccountState) => void = () => {}): AccountState {
  const a = defaultAccountState();
  a.settings = { ...a.settings, timeZone: 'UTC', weekStart: 1, nutritionEnabled: false };
  a.nutrition = { ...a.nutrition, proteinG: undefined };
  over(a);
  return a;
}

beforeEach(() => {
  localStorage.clear();
  db = new LiftDb(`progress-${Math.random().toString(36).slice(2)}`);
  h.db = db;
  h.account = account();
  setLanguage('en');
});
afterEach(async () => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  await db.delete();
  setLanguage('en');
});

describe('Progress visibility (UI)', () => {
  it('a new account gets one neutral empty state with every first-entry action and no sections', async () => {
    mount();
    await waitFor(() => expect(text()).toContain('Your progress will appear here'));
    expect(sections()).toEqual([]);
    expect(text()).not.toMatch(/No workouts or activities logged yet/);
    for (const label of ['Log a workout', 'Log an activity', 'Log food', 'Add a measurement', 'Add a goal']) expect(text()).toContain(label);
    click(button('Add a measurement'));
    const kinds = [...document.querySelectorAll('dialog[open] select option')].map((o) => o.getAttribute('value'));
    expect(kinds).toEqual(['bodyweight', 'waist', 'chest', 'hips', 'arm', 'thigh', 'bodyfat_pct']);
    click(button('Cancel'));
    click(button('Add a goal'));
    expect(text()).toContain('New goal');
  });

  it('food-only with nutrition disabled and no target: protein section with the target-free summary, zero counts as data', async () => {
    await db.foodLogs.bulkPut([food({ protein: 0, date: addDays(TODAY, -1) }), food({ protein: 30 })]);
    mount();
    await waitFor(() => expect(sections()).toEqual(['p-nutrition']));
    expect(text()).toContain('Days with protein logged: 2. Average on those days: 15 g.');
    expect(text()).not.toMatch(/Target met|No workouts or activities/);
  });

  it('unknown-protein-only logs get the compact explanation and a Food log link, not a zero chart', async () => {
    await db.foodLogs.bulkPut([food({ kcal: 500 })]);
    mount();
    await waitFor(() => expect(text()).toContain('Food is logged, but its protein amount is unknown.'));
    expect(document.querySelector('a[href="/nutrition/log"]')).not.toBeNull();
    expect(document.querySelector('[role="img"]')).toBeNull();
  });

  it('old food history: one period-empty message, "Show all time" switches range; "All" starts at the food date', async () => {
    const old = addDays(TODAY, -400);
    await db.foodLogs.bulkPut([food({ protein: 25, date: old })]);
    mount();
    await waitFor(() => expect(text()).toContain('No data in this period.'));
    expect(text().match(/No data in this period\./g)).toHaveLength(1);
    click(button('Show all time'));
    await waitFor(() => expect(text()).toContain('Days with protein logged: 1.'));
    expect(localStorage.getItem('lc-progress-range')).toBe('all');
    const year = old.slice(0, 4);
    expect(document.querySelector('.sticky p')?.textContent).toContain(year);
  });

  it('with a target: the existing target summary (localized Met/Below headers)', async () => {
    h.account = account((a) => (a.nutrition = { ...a.nutrition, proteinG: 100 }));
    await db.foodLogs.bulkPut([food({ protein: 120 })]);
    mount();
    await waitFor(() => expect(text()).toContain('Protein target: 100 g. Logged days: 1; target reached: 1.'));
  });

  it('waist-only: the selector offers only waist; a single point is shown', async () => {
    await db.measurements.bulkPut([measurement('waist', 82)]);
    mount();
    await waitFor(() => expect(sections()).toEqual(['p-body']));
    const opts = [...document.querySelectorAll('#p-body ~ * select option, section[aria-labelledby="p-body"] select option')].map((o) => o.getAttribute('value'));
    expect(opts).toEqual(['waist']);
    expect(text()).toContain('One entry: 82 cm.');
  });

  it('cardio without distance keeps minutes and hides distance and pace', async () => {
    await db.activities.bulkPut([activity({ type: 'run' })]);
    mount();
    await waitFor(() => expect(sections()).toEqual(['p-consistency', 'p-cardio']));
    const cardio = document.querySelector('section[aria-labelledby="p-cardio"]')!;
    expect(norm(cardio.textContent)).not.toMatch(/Distance|Pace trend|Speed trend/);
    expect(cardio.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('discomfort-only session: Consistency only; no exercise/volume sections', async () => {
    await db.sessions.bulkPut([session(TODAY, [{ exerciseId: 'push-up', sets: [], discomfort: true }])]);
    mount();
    await waitFor(() => expect(sections()).toEqual(['p-consistency']));
    expect(text()).not.toContain('Plan adherence');
  });

  it('bodyweight, timed and assisted-zero sets count as working sets without inventing load volume', async () => {
    await db.sessions.bulkPut([
      session(TODAY, [
        { exerciseId: 'push-up', sets: [set({ reps: 10 })] },
        { exerciseId: 'plank', sets: [set({ durationSec: 60 })] },
        { exerciseId: 'assisted-pull-up', sets: [set({ reps: 5, weightKg: 0 })] },
      ]),
    ]);
    mount();
    await waitFor(() => expect(sections()).toEqual(['p-consistency', 'p-exercise', 'p-volume']));
    const volume = document.querySelector('section[aria-labelledby="p-volume"]')!;
    const stats = norm(volume.querySelector('.grid')!.textContent);
    expect(stats).toContain('Working sets3');
    expect(stats).not.toMatch(/Free weights|Machines/);
    expect(norm(volume.textContent)).not.toMatch(/Volume type|volume \(kg\)/i);
  });

  it('protein and custom goals stay visible with nutrition disabled; missing target is explained', async () => {
    await db.goals.bulkPut([
      { ...sync(), title: 'Protein', kind: 'protein_days', target: 5 } as UserGoal,
      { ...sync(), title: 'Marathon', kind: 'custom', target: 1, achievedAt: 5 } as UserGoal,
    ]);
    mount();
    await waitFor(() => expect(sections()).toEqual(['p-goals']));
    expect(text()).toContain('Set a protein target to track this goal.');
    expect(text()).toContain('Marathon');
  });

  it('an account switch never shows the previous account’s data', async () => {
    await db.measurements.bulkPut([measurement('bodyweight', 80)]);
    mount();
    await waitFor(() => expect(sections()).toEqual(['p-body']));
    const other = new LiftDb(`progress-other-${Math.random().toString(36).slice(2)}`);
    h.db = other;
    render();
    expect(sections()).toEqual([]); // loading, not the old account's body chart
    await waitFor(() => expect(text()).toContain('Your progress will appear here'));
    await other.delete();
  });

  it('renders Icelandic copy for the period-empty and add actions', async () => {
    setLanguage('is');
    await db.foodLogs.bulkPut([food({ protein: 25, date: addDays(TODAY, -400) })]);
    mount('is');
    await waitFor(() => expect(text()).toContain('Engin gögn á þessu tímabili.'));
    expect(text()).toContain('Sýna frá upphafi');
    expect(text()).toContain('Bæta við skráningu');
  });
});

describe('visibility selectors (pure)', () => {
  const byId = new Map(EXERCISES.map((e) => [e.id, e]));
  const empty = { sessions: [], activities: [], measurements: [], goals: [], foodLogs: [], byId };
  it('availability per section; a plan alone is not data', () => {
    expect(sectionAvailability(empty).any).toBe(false);
    const a = sectionAvailability({ ...empty, foodLogs: [food({})] });
    expect(a).toMatchObject({ nutrition: true, consistency: false, any: true });
    const s = sectionAvailability({ ...empty, sessions: [session(TODAY, [{ exerciseId: 'push-up', sets: [], discomfort: true }])] });
    expect(s).toMatchObject({ consistency: true, exercise: false, volume: false });
  });
  it('zero protein is numeric data; missing protein is unknown', () => {
    expect(proteinView([])).toBe('none');
    expect(proteinView([food({ protein: 0 })])).toBe('numeric');
    expect(proteinView([food({ kcal: 300 })])).toBe('unknown');
  });
  it('the all-time boundary includes food dates; future records are ignored', () => {
    expect(earliestDate({ sessions: [], activities: [], measurements: [measurement('waist', 1, '2026-05-01')], foodLogs: [food({ date: '2025-01-02' })] }, '2026-11-26')).toBe('2025-01-02');
    expect(earliestDate({ sessions: [], activities: [], measurements: [], foodLogs: [food({ date: '2027-01-01' })] }, '2026-11-26')).toBeNull();
  });
  it('selectors never keep a removed option', () => {
    expect(measuredKinds([measurement('hips', 1), measurement('waist', 1)], ['bodyweight', 'waist', 'chest', 'hips'])).toEqual(['waist', 'hips']);
    expect(pickMeasurementKind('chest', ['waist', 'hips'])).toBe('waist');
    expect(pickMeasurementKind(null, ['waist', 'bodyweight'])).toBe('bodyweight');
    expect(pickMeasurementKind('waist', [])).toBeNull();
    expect(validChoice('b', ['a'])).toBe('a');
    expect(loadBuckets({ freeWeightKg: 0, machineKg: 10, addedBodyweightKg: 0 })).toEqual(['machineKg']);
  });
});
