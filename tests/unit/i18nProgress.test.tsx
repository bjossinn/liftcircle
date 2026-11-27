// @vitest-environment jsdom
/**
 * Roadmap item 8: the Progress sections render the approved Icelandic copy, decimal commas and localized
 * default goal titles (stored English defaults are recognized exactly; user-authored titles stay as stored).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { setLanguage } from '@/i18n';
import { ToastProvider } from '@/components/toast';
import { defaultSettings } from '@/state/defaults';
import type { ActivityLog, Measurement, ProgramVersion, SessionTemplate, UserGoal, WorkoutSession } from '@/domain/types';
import { createProgram } from '@/domain/program/program';
import type { ProgressData } from '@/features/progress/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/state/app', () => ({ useApp: () => ({ db: {}, accountReady: true }) }));

const { ConsistencySection } = await import('@/features/progress/ConsistencySection');
const { BodySection } = await import('@/features/progress/BodySection');
const { GoalsSection } = await import('@/features/progress/GoalsSection');

const TODAY = '2026-11-26';
const sync = (id: string) => ({ id, createdAt: 1, updatedAt: 1 });
const session = (id: string, date: string) =>
  ({ ...sync(id), name: 'Push', status: 'completed', date, timeZone: 'UTC', startedAt: 1, endedAt: 3_600_001, pausedTotalMs: 0, exercises: [] }) as unknown as WorkoutSession;
const activity = (id: string, date: string) => ({ ...sync(id), type: 'run', date, timeZone: 'UTC', durationSec: 1800, distanceM: 5000 }) as unknown as ActivityLog;

function data(over: Partial<ProgressData> = {}): ProgressData {
  const settings = { ...defaultSettings(), weekStart: 1 as const, timeZone: 'UTC' };
  settings.units = { ...settings.units, weight: 'kg' };
  return {
    sessions: [],
    rangeSessions: [],
    activities: [],
    rangeActivities: [],
    measurements: [],
    goals: [],
    foodLogs: [],
    program: null,
    exercises: [],
    byId: new Map(),
    from: '2026-10-30',
    to: TODAY,
    today: TODAY,
    settings,
    ...over,
  };
}

let root: Root | null = null;
let el: HTMLDivElement;
async function render(node: ReactElement) {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, null, node))));
}

beforeEach(() => setLanguage('is'));
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  el?.remove();
  setLanguage('en');
});

describe('Progress in Icelandic', () => {
  it('Consistency: count-neutral summary, decimal comma and adherence copy', async () => {
    const sessions = [session('s1', '2026-11-03'), session('s2', '2026-11-10'), session('s3', '2026-11-24')];
    const activities = [activity('a1', '2026-11-12')];
    await render(createElement(ConsistencySection, { d: data({ sessions, rangeSessions: sessions, activities, rangeActivities: activities }) }));
    const text = el.textContent ?? '';
    // 30 Oct → 26 Nov with Monday weeks = 5 weeks; (3 + 1) / 5 = 0.8
    expect(text).toContain('Æfingar: 3 · önnur hreyfing: 1 · vikur: 5. Æfingar á viku að meðaltali: 0,8.');
    // Item 11: no program → no adherence/recruitment block.
    expect(text).not.toContain('Fylgni við áætlun');
    expect(text).not.toContain('Engin virk æfingaáætlun.');
    expect(text).toContain('Æfingar á viku');
    expect(text).not.toContain('Plan adherence');
  });

  it('Consistency: older history + planned sessions with zero completions in the period still shows 0/N adherence', async () => {
    const lift = { id: 'A', name: 'Full body A', focus: 'Full body', kind: 'lifting', exercises: [], estimatedMinutes: 45 } as SessionTemplate;
    const version = { version: 1, createdAt: 0, reason: 'test', templates: [lift], schedule: [1, 3, 5].map((weekday) => ({ weekday, templateId: 'A' })), weeks: 12, reviewWeek: 12, rationale: [], warnings: [] } as ProgramVersion;
    const program = createProgram(null, version, '2026-09-01', 'MWF', 'manual');
    const older = [session('old', '2026-09-15')]; // all-history data (outside the selected period)
    await render(createElement(ConsistencySection, { d: data({ sessions: older, rangeSessions: [], activities: [], rangeActivities: [], program }) }));
    const text = el.textContent ?? '';
    expect(text).toContain('Engin gögn á þessu tímabili.');
    expect(text).toContain('Fylgni við áætlun');
    const m = text.match(/Skipulagðar æfingar: (\d+) af (\d+) lokið/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(0);
    expect(Number(m![2])).toBeGreaterThan(0);
    expect(el.querySelector('[role="progressbar"], progress')).not.toBeNull();
  });

  it('Body: Icelandic labels, list values with decimal commas, trend summary', async () => {
    const measurements = [
      { ...sync('m1'), kind: 'bodyweight', date: '2026-11-20', value: 80.5, entered: { value: 80.5, unit: 'kg' } },
      { ...sync('m2'), kind: 'bodyweight', date: '2026-11-25', value: 81.25, entered: { value: 81.25, unit: 'kg' } },
    ] as Measurement[];
    await render(createElement(BodySection, { d: data({ measurements }), today: TODAY }));
    const text = el.textContent ?? '';
    expect(text).toContain('81,25 kg');
    expect(text).toContain('80,5 kg');
    expect(text).toContain('Skráningar: 2. Sjö daga meðaltal fór úr');
    expect(text).toContain('Sýna gagnatöflu');
    expect(el.querySelector('select')?.textContent).toContain('Líkamsþyngd');
    // Item 11: the chart selector offers only measured kinds.
    expect(el.querySelector('select')?.textContent).not.toContain('Mittismál');
    expect(el.querySelector('button[aria-label^="Breyta mælingu: líkamsþyngd, "]')).not.toBeNull();
  });

  it('Goals: stored English default titles show in Icelandic; user titles stay as stored', async () => {
    const goals = [
      { ...sync('g1'), title: 'Move more', kind: 'cardio_minutes', target: 150 },
      { ...sync('g2'), title: 'Hlaupa maraþon', kind: 'custom', target: 1, deadline: '2027-06-01' },
    ] as UserGoal[];
    await render(createElement(GoalsSection, { d: data({ goals }) }));
    const titles = [...el.querySelectorAll('h3')].map((h) => h.textContent);
    expect(titles).toContain('Hreyfa mig meira');
    expect(titles).toContain('Hlaupa maraþon');
    const text = el.textContent ?? '';
    expect(text).toContain('Hreyfing í mínútum á viku');
    expect(text).toContain('Eigið markmið');
    expect(text).toContain('Bæta við markmiði');
    expect(el.querySelector('button[aria-label="Breyta markmiði: Hreyfa mig meira"]')).not.toBeNull();
  });

  it('English output of the same section is unchanged in wording', async () => {
    setLanguage('en');
    const measurements = [{ ...sync('m1'), kind: 'bodyweight', date: '2026-11-25', value: 81.25, entered: { value: 81.25, unit: 'kg' } }] as Measurement[];
    await render(createElement(BodySection, { d: data({ measurements }), today: TODAY }));
    const text = el.textContent ?? '';
    expect(text).toContain('81.25 kg');
    expect(text).toContain('One entry: 81.3 kg.');
  });

  it('English uses the count-neutral summary for a count of 1 (item 11)', async () => {
    setLanguage('en');
    const sessions = [session('s1', '2026-11-03')];
    const activities = [activity('a1', '2026-11-12')];
    await render(createElement(ConsistencySection, { d: data({ sessions, rangeSessions: sessions, activities, rangeActivities: activities }) }));
    expect(el.textContent).toContain('Workouts: 1 · other activities: 1 · weeks: 5. Sessions per week on average: 0.4.');
  });
});
