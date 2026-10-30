// @vitest-environment jsdom
/**
 * AI coach UI (mocked aiApi / coachingApi; real Dexie via fake-indexeddb).
 * These are UI-level tests only — no live AI provider is involved.
 *
 * @testing-library/react is installed but its peer @testing-library/dom is not (and we can't install
 * packages here), so this file uses a tiny equivalent harness on react-dom/client + act.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

/* ---------------------------------------------------------- mini harness */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Matcher = string | RegExp;
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const matches = (text: string, m: Matcher) => (typeof m === 'string' ? text === m : m.test(text));
const ROLE_SELECTORS: Record<string, string> = {
  button: 'button:not([role]), [role="button"]',
  switch: '[role="switch"]',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  link: 'a[href]',
  article: 'article, [role="article"]',
};
function accName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return norm(aria);
  const id = el.getAttribute('id');
  const lab = id ? el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
  if (lab) return norm(lab.textContent);
  const wrap = el.closest('label');
  if (wrap) return norm(wrap.textContent);
  return norm(el.textContent);
}
function queries(scope: () => ParentNode) {
  const allByText = (m: Matcher) => {
    const els = [...scope().querySelectorAll('*')].filter((e) => matches(norm(e.textContent), m));
    return els.filter((e) => !els.some((o) => o !== e && e.contains(o)));
  };
  const allByRole = (role: string, opts: { name?: Matcher } = {}) =>
    [...scope().querySelectorAll(ROLE_SELECTORS[role])].filter((e) => opts.name === undefined || matches(accName(e), opts.name)) as HTMLElement[];
  const one = <T,>(xs: T[], what: string): T => {
    if (!xs.length) throw new Error(`Not found: ${what}\n${norm((scope() as Element).textContent ?? document.body.textContent).slice(0, 600)}`);
    return xs[0];
  };
  const q = {
    queryByText: (m: Matcher) => (allByText(m)[0] as HTMLElement | undefined) ?? null,
    getByText: (m: Matcher) => one(allByText(m), `text ${m}`) as HTMLElement,
    getAllByText: (m: Matcher) => {
      const xs = allByText(m) as HTMLElement[];
      one(xs, `text ${m}`);
      return xs;
    },
    queryByRole: (role: string, opts?: { name?: Matcher }) => allByRole(role, opts)[0] ?? null,
    getByRole: (role: string, opts?: { name?: Matcher }) => one(allByRole(role, opts), `role ${role} ${opts?.name ?? ''}`),
    getAllByRole: (role: string, opts?: { name?: Matcher }) => {
      const xs = allByRole(role, opts);
      one(xs, `role ${role}`);
      return xs;
    },
    queryByLabelText: (m: Matcher) => {
      const lab = [...scope().querySelectorAll('label')].find((l) => matches(norm(l.textContent), m));
      const forId = lab?.getAttribute('for');
      return ((forId ? document.getElementById(forId) : null) ?? [...scope().querySelectorAll('[aria-label]')].find((e) => matches(norm(e.getAttribute('aria-label')), m)) ?? null) as HTMLElement | null;
    },
    getByDisplayValue: (v: string) => one([...scope().querySelectorAll('input, textarea')].filter((e) => (e as HTMLInputElement).value === v), `value ${v}`) as HTMLElement,
  };
  const find =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    (...a: A) =>
      waitFor(() => fn(...a));
  return {
    ...q,
    getByLabelText: (m: Matcher) => one([q.queryByLabelText(m)].filter(Boolean) as HTMLElement[], `label ${m}`),
    findByText: find(q.getByText),
    findByRole: find(q.getByRole),
    findByDisplayValue: find(q.getByDisplayValue),
    findByLabelText: find((m: Matcher) => one([q.queryByLabelText(m)].filter(Boolean) as HTMLElement[], `label ${m}`)),
  };
}
const screen = queries(() => document.body);
const within = (el: Element) => queries(() => el);
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
const fireEvent = {
  click(el: Element) {
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  },
  change(el: Element, { target: { value } }: { target: { value: string } }) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  },
};
const mounted: { root: Root; container: HTMLElement }[] = [];
function render(el: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(el));
  mounted.push({ root, container });
}
function cleanup() {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.container.remove();
  }
}

const h = vi.hoisted(() => ({
  online: true,
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
    online: h.online,
    backendConfigured: true,
    updateAccount: h.updateAccount,
    finishSignOut: () => undefined,
  }),
  useDb: () => h.db,
  useSettings: () => (h.account as { settings: unknown }).settings,
}));

vi.mock('@/backend/ai', () => ({
  aiApi: {
    status: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    history: vi.fn(),
    send: vi.fn(),
    clearHistory: vi.fn(),
    listProposals: vi.fn(),
    respondProposal: vi.fn(),
  },
}));
vi.mock('@/backend/coaching', () => ({
  coachingApi: { myRelationships: vi.fn(async () => []), sendMessage: vi.fn() },
}));

import { aiApi } from '@/backend/ai';
import type { AiSettings, ProgramProposal } from '@/backend/coachingContract';
import { LiftDb } from '@/db/db';
import { kvGet, kvSet, saveRecord } from '@/db/repo';
import { ToastProvider } from '@/components/toast';
import { defaultAccountState } from '@/state/defaults';
import { EXERCISES } from '@/data/exercises';
import { createProgram, withNewVersion } from '@/domain/program/program';
import type { Program, ProgramVersion, WorkoutSession } from '@/domain/types';
import AiChatPage from '@/features/coaching/AiChatPage';
import AiSettingsPage from '@/features/coaching/AiSettingsPage';
import AiSetupPage from '@/features/coaching/AiSetupPage';
import AiProposalsPage from '@/features/coaching/AiProposalsPage';
import { AI_DRAFT_KEY, AI_PENDING_KEY, STALE_MESSAGE } from '@/features/coaching/ai/model';
import { applyAiProposal } from '@/features/coaching/ai/apply';

const api = aiApi as unknown as Record<keyof typeof aiApi, ReturnType<typeof vi.fn>>;
let dbCount = 0;

const SETTINGS_ON: AiSettings = {
  enabled: true,
  paused: false,
  consentAt: '2026-10-01T10:00:00Z',
  scopes: { profile: true, training: true, measurements: false, nutrition: false },
  profileNotes: '',
  coachStyle: 'balanced',
};

function renderAt(path: string, el: ReactElement) {
  return render(createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [path] }, el)));
}

function version(n = 3): ProgramVersion {
  const ex = EXERCISES.slice(0, 2);
  return {
    version: 1,
    createdAt: Date.now(),
    reason: 'test',
    templates: [
      {
        id: 'tA',
        name: 'Full body A',
        focus: 'Full body',
        kind: 'lifting',
        estimatedMinutes: 45,
        exercises: ex.map((e, i) => ({ id: `s${i}`, exerciseId: e.id, sets: n, repMin: 8, repMax: 12, targetRir: 2, restSec: 90, warmup: '', priority: 1, alternatives: [] })),
      },
    ],
    schedule: [{ weekday: 1, templateId: 'tA' }],
    weeks: 8,
    reviewWeek: 8,
    rationale: [],
    warnings: [],
  };
}

function proposalFor(base: Program, over: Partial<ProgramProposal> = {}): ProgramProposal {
  const { version: _v, createdAt: _c, ...content } = version(4);
  void _v;
  void _c;
  return {
    id: 'prop-1',
    authorKind: 'ai',
    clientId: 'user-1',
    status: 'draft',
    baseProgramId: base.id,
    baseVersion: base.currentVersion,
    revision: 1,
    program: { ...content, name: 'Two-day plan' },
    changeSummary: ['Adds a set to each exercise'],
    message: 'You said you can train less this month.',
    target: 'apply',
    createdAt: '2026-10-27T10:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  h.online = true;
  h.db = new LiftDb(`ai-ui-test-${++dbCount}`);
  h.account = defaultAccountState();
  h.updateAccount = vi.fn(async () => undefined);
  for (const fn of Object.values(api)) fn.mockReset();
  api.status.mockResolvedValue({ available: true, usage: { day: '2026-10-28', requests: 3, inputTokens: 100, outputTokens: 50, limitRequests: 40 } });
  api.getSettings.mockResolvedValue(SETTINGS_ON);
  api.history.mockResolvedValue([]);
  api.listProposals.mockResolvedValue([]);
  api.respondProposal.mockResolvedValue(undefined);
  // jsdom lacks the modal dialog API used by Sheet/ConfirmDialog.
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(async () => {
  cleanup();
  await (h.db as LiftDb).delete();
});

describe('AI chat', () => {
  it('shows a truthful not-configured state with no way to send', async () => {
    api.status.mockResolvedValue({ available: false, reason: 'not_configured' });
    renderAt('/coaching/ai', createElement(AiChatPage));
    expect(await screen.findByText('AI coach isn’t set up on this server yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByLabelText('Message the AI coach')).toBeNull();
    expect(api.history).not.toHaveBeenCalled();
  });

  it('treats a missing backend implementation as not set up (no fake chat)', async () => {
    api.status.mockRejectedValue(new Error('AI backend not implemented yet'));
    api.getSettings.mockRejectedValue(new Error('AI backend not implemented yet'));
    renderAt('/coaching/ai', createElement(AiChatPage));
    expect(await screen.findByText('AI coach isn’t set up on this server yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('offline: keeps the draft in kv and disables sending', async () => {
    h.online = false;
    const db = h.db as LiftDb;
    await kvSet(AI_DRAFT_KEY, 'Half-written question', db);
    renderAt('/coaching/ai', createElement(AiChatPage));
    const box = (await screen.findByDisplayValue('Half-written question')) as HTMLTextAreaElement;
    expect(screen.getByText(/You’re offline/)).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Half-written question, continued' } });
    await waitFor(async () => expect(await kvGet(AI_DRAFT_KEY, db)).toBe('Half-written question, continued'));
    fireEvent.click(send);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.status).not.toHaveBeenCalled();
  });

  it('retrying a failed send reuses the same client id', async () => {
    api.send
      .mockRejectedValueOnce(Object.assign(new Error('Server hiccup'), { code: 'PGRST500', status: 500 }))
      .mockResolvedValueOnce({ reply: { id: 'r1', role: 'assistant', content: 'Do two full-body sessions.', createdAt: '2026-10-28T10:00:01Z' }, proposal: null });
    renderAt('/coaching/ai', createElement(AiChatPage));
    const box = await screen.findByLabelText('Message the AI coach');
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(box, { target: { value: 'I can only train twice this week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Not sent/)).toBeTruthy();
    const pending = await kvGet<{ id: string }>(AI_PENDING_KEY, h.db as LiftDb);
    expect(pending?.id).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Do two full-body sessions.')).toBeTruthy();
    expect(api.send).toHaveBeenCalledTimes(2);
    const [a, b] = api.send.mock.calls.map((c) => c[0] as { id: string; text: string });
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(pending!.id);
    expect(b.text).toBe('I can only train twice this week');
    await waitFor(async () => expect(await kvGet(AI_PENDING_KEY, h.db as LiftDb)).toBeNull());
  });

  it('labels every AI message, shows grounding and links proposals', async () => {
    api.history.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'Review my last two weeks', createdAt: '2026-10-28T09:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'You completed 5 of 6 planned sessions.', createdAt: '2026-10-28T09:00:05Z', grounding: ['last 4 workouts', 'protein target'], proposalId: 'prop-9' },
      { id: 'a2', role: 'assistant', content: 'Try adding one rep per set next week.', createdAt: '2026-10-28T09:01:00Z' },
    ]);
    renderAt('/coaching/ai', createElement(AiChatPage));
    await screen.findByText('You completed 5 of 6 planned sessions.');
    const ai = screen.getAllByRole('article', { name: 'AI coach message' });
    expect(ai).toHaveLength(2);
    for (const m of ai) {
      expect(within(m).getByText('AI coach')).toBeTruthy();
      expect(within(m).getByText('AI')).toBeTruthy();
      expect(within(m).getByText(/AI suggestion/)).toBeTruthy();
    }
    expect(within(ai[0]).getByText('Based on:')).toBeTruthy();
    expect(within(ai[0]).getByText('last 4 workouts')).toBeTruthy();
    const link = within(ai[0]).getByRole('link', { name: /Suggested plan change — review/ });
    expect(link.getAttribute('href')).toBe('/coaching/ai/proposals?id=prop-9');
    // The user's own message is not labelled as AI.
    expect(screen.getByText('Review my last two weeks').closest('article')).toBeNull();
  });
});

describe('AI proposals', () => {
  it('refuses to apply over a coach-managed plan without an explicit switch', async () => {
    const db = h.db as LiftDb;
    const coachPlan: Program = { ...createProgram(null, version(), '2026-10-01', 'Coach plan', 'manual'), managedBy: { kind: 'coach', coachName: 'Sigga', relationshipId: 'rel-1' } };
    await saveRecord('programs', coachPlan, db);
    const proposal = proposalFor(coachPlan);

    // Domain wrapper: no switch → refused, nothing saved, nothing recorded.
    const catalog = new Map(EXERCISES.map((e) => [e.id, e]));
    const refused = await applyAiProposal({ proposal, programs: [coachPlan], db, today: '2026-10-28', catalog, respond: (id, accept, applied) => aiApi.respondProposal(id, accept, applied) });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('coach_managed');
    expect(api.respondProposal).not.toHaveBeenCalled();
    expect((await db.programs.get(coachPlan.id))?.managedBy?.kind).toBe('coach');

    // UI: no Apply button; the explicit switch requires a confirm.
    api.listProposals.mockResolvedValue([proposal]);
    renderAt(`/coaching/ai/proposals?id=${proposal.id}`, createElement(AiProposalsPage));
    expect(await screen.findByText('Your plan is managed by your coach')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply suggestion' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to a self-managed plan' }));
    expect(await screen.findByText('Switch to a self-managed plan?')).toBeTruthy();
    expect(api.respondProposal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Switch and apply' }));
    await waitFor(() => expect(api.respondProposal).toHaveBeenCalledWith('prop-1', true, { programId: coachPlan.id, version: 2 }));
    const saved = await db.programs.get(coachPlan.id);
    expect(saved?.managedBy?.kind).toBe('ai');
    expect(saved?.currentVersion).toBe(2);
  });

  it('shows the stale message when the plan changed since the suggestion', async () => {
    const db = h.db as LiftDb;
    const v1 = createProgram(null, version(), '2026-10-01', 'My plan', 'manual');
    const proposal = proposalFor(v1); // based on version 1
    const { version: _v, createdAt: _c, ...rest } = version(5);
    void _v;
    void _c;
    const v2 = withNewVersion(v1, { ...rest, reason: 'Edited by me' });
    await saveRecord('programs', v2, db);
    api.listProposals.mockResolvedValue([proposal]);
    renderAt(`/coaching/ai/proposals?id=${proposal.id}`, createElement(AiProposalsPage));
    expect(await screen.findByText(STALE_MESSAGE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply suggestion' })).toBeNull();
    expect(screen.getAllByText('AI suggestion').length).toBeGreaterThan(0);
  });

  it('applies a valid suggestion only after a deliberate confirm', async () => {
    const db = h.db as LiftDb;
    const plan = createProgram(null, version(), '2026-10-01', 'My plan', 'manual');
    await saveRecord('programs', plan, db);
    api.listProposals.mockResolvedValue([proposalFor(plan)]);
    renderAt('/coaching/ai/proposals?id=prop-1', createElement(AiProposalsPage));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply suggestion' }));
    expect(api.respondProposal).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.respondProposal).toHaveBeenCalledWith('prop-1', true, { programId: plan.id, version: 2 }));
    expect((await db.programs.get(plan.id))?.managedBy?.kind).toBe('ai');
  });
});

describe('AI data access', () => {
  it('settings: toggling a data category saves exactly the new scopes', async () => {
    api.saveSettings.mockImplementation(async (patch: Partial<AiSettings>) => ({ ...SETTINGS_ON, ...patch }));
    renderAt('/coaching/ai/settings', createElement(AiSettingsPage));
    fireEvent.click(await screen.findByRole('switch', { name: 'Measurements' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ scopes: { profile: true, training: true, measurements: true, nutrition: false } }));
    const training = screen.getByRole('switch', { name: 'Training' }) as HTMLButtonElement;
    await waitFor(() => expect(training.disabled).toBe(false)); // re-enabled once the first save finished
    fireEvent.click(training);
    await waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith({ scopes: { profile: true, training: false, measurements: true, nutrition: false } }));
  });

  it('setup: requires explicit consent and enables with the chosen scopes', async () => {
    api.getSettings.mockResolvedValue(null);
    api.saveSettings.mockImplementation(async (patch: Partial<AiSettings>) => ({ ...SETTINGS_ON, ...patch }));
    renderAt('/coaching/ai/setup', createElement(AiSetupPage));
    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Nutrition' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const enable = (await screen.findByRole('button', { name: /Turn on AI coach/ })) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(enable.disabled).toBe(false);
    fireEvent.click(enable);
    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, acceptConsent: true, scopes: { profile: true, training: true, measurements: false, nutrition: true } }),
      ),
    );
  });
});

/* ================================================================== v2: greeting, "Why this?", this-week plan */
function threeDayPlan(managed?: Program['managedBy']): Program {
  const ex = EXERCISES.slice(0, 2);
  const t = (id: string, name: string) => ({
    id, name, focus: name, kind: 'lifting' as const, estimatedMinutes: 45,
    exercises: ex.map((e, i) => ({ id: `s${i}`, exerciseId: e.id, sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 90, warmup: '', priority: 1 as const, alternatives: [] })),
  });
  const v: ProgramVersion = {
    version: 1, createdAt: 0, reason: 'test', templates: [t('A', 'Full body A'), t('B', 'Full body B'), t('C', 'Full body C')],
    schedule: [{ weekday: 1, templateId: 'A' }, { weekday: 3, templateId: 'B' }, { weekday: 5, templateId: 'C' }], weeks: 8, reviewWeek: 8, rationale: [], warnings: [],
  };
  const p = createProgram(null, v, '2026-10-05', 'Full body 3x', 'generated');
  return managed ? { ...p, managedBy: managed } : p;
}
const completed = (p: Program, templateId: string, name: string, date: string): WorkoutSession => ({
  id: `sess-${templateId}-${date}`, createdAt: 0, updatedAt: 0, name, status: 'completed', programId: p.id, templateId, plannedDate: date, date, timeZone: 'UTC',
  startedAt: Date.parse(`${date}T08:00:00Z`), endedAt: Date.parse(`${date}T08:45:00Z`), pausedTotalMs: 0, exercises: [],
});

describe('AI chat v2 (MOCKED aiApi): greeting, Why this?, Apply to this week', () => {
  beforeEach(() => {
    // Wednesday 2026-10-28 (only Date is faked; timers stay real for the harness).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    (h.account as { settings: { timeZone: string; weekStart: number } }).settings.timeZone = 'UTC';
    (h.account as { settings: { weekStart: number } }).settings.weekStart = 1;
    (h.account as { profile: { goal?: string } }).profile.goal = 'build_muscle';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('empty conversation → immediate personalized welcome from permitted context, without any AI call', async () => {
    const db = h.db as LiftDb;
    const p = await saveRecord('programs', threeDayPlan(), db);
    await saveRecord('sessions', completed(p, 'A', 'Full body A', '2026-10-26'), db);
    renderAt('/coaching/ai', createElement(AiChatPage));
    const w = await screen.findByRole('article', { name: 'AI coach welcome' });
    expect(within(w).getByText('Good afternoon!')).toBeTruthy(); // 12:00 UTC, no display name
    expect(within(w).getByText('Full body B today, ready to go?')).toBeTruthy();
    await waitFor(() => expect(within(w).getByText(/You’re on “Full body 3x” — 3 sessions a week \(Mon, Wed, Fri\)/)).toBeTruthy());
    expect(within(w).getByText(/Goal: build muscle/)).toBeTruthy();
    expect(within(w).getByText('This week: 1 of 3 done (Full body A, Mon). Next: Full body B, today.')).toBeTruthy();
    expect(api.send).not.toHaveBeenCalled();
    expect(api.history).toHaveBeenCalledTimes(1);
  });

  it('quick-reply chips under the welcome send the chip as the user’s message (the real AI answers); the welcome itself is never sent', async () => {
    const db = h.db as LiftDb;
    await saveRecord('programs', threeDayPlan(), db);
    api.send.mockResolvedValueOnce({ reply: { id: 'r-chip', role: 'assistant', content: 'Totally normal. Let’s do a lighter Full body B.', createdAt: '2026-10-28T12:00:01Z' }, proposal: null });
    renderAt('/coaching/ai', createElement(AiChatPage));
    await screen.findByRole('article', { name: 'AI coach welcome' });
    for (const c of ['Feeling great 💪', 'Bit tired', 'Sore', 'Short on time', 'Want to skip today']) await screen.findByRole('button', { name: c });
    expect(api.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Bit tired' }));
    expect(await screen.findByText('Totally normal. Let’s do a lighter Full body B.')).toBeTruthy();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect((api.send.mock.calls[0][0] as { text: string; mode: string })).toMatchObject({ text: 'Bit tired', mode: 'chat' });
    expect(screen.queryByRole('article', { name: 'AI coach welcome' })).toBeNull();
  });

  it('activation: setup → chat opens with the welcome immediately', async () => {
    const db = h.db as LiftDb;
    await saveRecord('programs', threeDayPlan(), db);
    api.getSettings.mockResolvedValueOnce(null).mockResolvedValue(SETTINGS_ON);
    api.saveSettings.mockImplementation(async (patch: Partial<AiSettings>) => ({ ...SETTINGS_ON, ...patch }));
    render(createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: ['/coaching/ai/setup'] },
      createElement(Routes, null,
        createElement(Route, { path: '/coaching/ai/setup', element: createElement(AiSetupPage) }),
        createElement(Route, { path: '/coaching/ai', element: createElement(AiChatPage) })))));
    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Turn on AI coach/ }));
    const w = await screen.findByRole('article', { name: 'AI coach welcome' });
    await waitFor(() => expect(within(w).getByText(/Full body 3x/)).toBeTruthy());
    expect(api.send).not.toHaveBeenCalled();
  });

  it('duplicate prevention: refresh and two tabs each show exactly one welcome; nothing is sent or stored', async () => {
    await saveRecord('programs', threeDayPlan(), h.db as LiftDb);
    renderAt('/coaching/ai', createElement(AiChatPage));
    renderAt('/coaching/ai', createElement(AiChatPage)); // second tab
    await waitFor(() => expect(screen.getAllByRole('article', { name: 'AI coach welcome' })).toHaveLength(2));
    cleanup(); // "refresh"
    renderAt('/coaching/ai', createElement(AiChatPage));
    await waitFor(() => expect(screen.getAllByRole('article', { name: 'AI coach welcome' })).toHaveLength(1));
    expect(api.send).not.toHaveBeenCalled();
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(await kvGet(AI_PENDING_KEY, h.db as LiftDb)).toBeFalsy();
  });

  it('training not shared → the welcome says so and never mentions the plan or workouts', async () => {
    const db = h.db as LiftDb;
    const p = await saveRecord('programs', threeDayPlan(), db);
    await saveRecord('sessions', completed(p, 'A', 'Full body A', '2026-10-26'), db);
    api.getSettings.mockResolvedValue({ ...SETTINGS_ON, scopes: { profile: true, training: false, measurements: false, nutrition: false } });
    renderAt('/coaching/ai', createElement(AiChatPage));
    const w = await screen.findByRole('article', { name: 'AI coach welcome' });
    expect(within(w).getByText(/Training isn’t shared with me, so I can’t see your plan or workouts/)).toBeTruthy();
    expect(w.textContent).not.toMatch(/Full body|This week|looked at|reviewed/);
  });

  it('existing conversation resumes normally (no welcome)', async () => {
    api.history.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'Hi', createdAt: '2026-10-27T09:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'Do Full body B tomorrow.', createdAt: '2026-10-27T09:00:05Z' },
    ]);
    renderAt('/coaching/ai', createElement(AiChatPage));
    await screen.findByText('Do Full body B tomorrow.');
    expect(screen.queryByRole('article', { name: 'AI coach welcome' })).toBeNull();
  });

  it('"Why this?" is collapsed by default', async () => {
    api.history.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'What next?', createdAt: '2026-10-27T09:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'Do Full body B tomorrow.', why: 'It keeps a rest day after Monday.', createdAt: '2026-10-27T09:00:05Z' },
    ]);
    renderAt('/coaching/ai', createElement(AiChatPage));
    await screen.findByText('Do Full body B tomorrow.');
    const details = screen.getByText('Why this?').closest('details') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(within(details).getByText('It keeps a rest day after Monday.')).toBeTruthy();
  });

  const weekAction = (p: Program, over: Record<string, unknown> = {}) => ({
    kind: 'week_adjustment', id: 'u-week', baseProgramId: p.id, baseVersion: p.currentVersion, managedBy: 'self', weekStart: '2026-10-26', weekEnd: '2026-11-01', targetSessions: 2,
    completed: [{ date: '2026-10-26', name: 'Full body A' }], sessions: [{ templateId: 'B', name: 'Full body B', date: '2026-10-29', plannedDate: '2026-10-28' }],
    skipped: [{ templateId: 'C', name: 'Full body C', plannedDate: '2026-10-30' }], adjustments: [], warnings: [], summary: '', ...over,
  });

  it('"Apply to this week" writes only this week’s overrides, then offers Undo', async () => {
    const db = h.db as LiftDb;
    const p = await saveRecord('programs', threeDayPlan(), db);
    await saveRecord('sessions', completed(p, 'A', 'Full body A', '2026-10-26'), db);
    const { toWeekPlan } = await vi.importActual<typeof import('@/backend/ai')>('@/backend/ai');
    api.history.mockResolvedValue([
      { id: 'u-week', role: 'user', content: 'I can only train twice this week', createdAt: '2026-10-28T09:00:00Z' },
      { id: 'a-week', role: 'assistant', content: 'Do Full body B on Thursday; Monday counts.', createdAt: '2026-10-28T09:00:05Z', weekPlan: toWeekPlan(weekAction(p)) },
    ]);
    renderAt('/coaching/ai', createElement(AiChatPage));
    const card = (await screen.findByText('This week only')).closest('section')!;
    expect(card.getAttribute('aria-label')).toBe('This week’s plan');
    expect(within(card as HTMLElement).getByText(/Counted as done: Full body A/)).toBeTruthy();
    expect(within(card as HTMLElement).getByText(/Skipped this week: Full body C/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply to this week' }));
    await waitFor(async () => {
      const saved = await db.programs.get(p.id);
      expect(saved!.overrides.map((o) => [o.date, o.templateId, o.status, o.movedTo ?? null])).toEqual([
        ['2026-10-28', 'B', 'moved', '2026-10-29'],
        ['2026-10-30', 'C', 'skipped', null],
      ]);
      expect(saved!.currentVersion).toBe(p.currentVersion);
      expect(saved!.versions).toEqual(p.versions);
    });
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('a week plan made for an older plan version is shown as out of date (no Apply)', async () => {
    const db = h.db as LiftDb;
    const p = await saveRecord('programs', threeDayPlan(), db);
    const { toWeekPlan } = await vi.importActual<typeof import('@/backend/ai')>('@/backend/ai');
    api.history.mockResolvedValue([
      { id: 'u-week', role: 'user', content: 'twice this week', createdAt: '2026-10-28T09:00:00Z' },
      { id: 'a-week', role: 'assistant', content: 'Do B Thursday.', createdAt: '2026-10-28T09:00:05Z', weekPlan: toWeekPlan(weekAction(p, { baseVersion: p.currentVersion - 1 || 99 })) },
    ]);
    renderAt('/coaching/ai', createElement(AiChatPage));
    expect(await screen.findByText(/Your plan changed since this suggestion/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply to this week' })).toBeNull();
  });
});

describe('AI chat v4 (MOCKED aiApi): Markdown, in-app links, meal plan and recipe cards', () => {
  it('AI messages render the Markdown subset; user messages stay literal text', async () => {
    api.history.mockResolvedValue([
      { id: 'u1', role: 'user', content: '**not bold** <b>raw</b> [x](javascript:alert(1))', createdAt: '2026-10-27T09:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'Do **3 × 8** today.\n\n- Squat\n- Bench\n\n<img src=x onerror="alert(1)">', createdAt: '2026-10-27T09:00:05Z' },
    ]);
    renderAt('/coaching/ai', createElement(AiChatPage));
    const body = await waitFor(() => {
      const el = document.querySelector('[data-testid="ai-message-body"]');
      if (!el) throw new Error('no AI message yet');
      return el as HTMLElement;
    });
    expect(body.querySelector('strong')?.textContent).toBe('3 × 8');
    expect([...body.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['Squat', 'Bench']);
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toContain('<img src=x onerror="alert(1)">');
    const user = screen.getByText('**not bold** <b>raw</b> [x](javascript:alert(1))');
    expect(user.querySelector('strong, b, a')).toBeNull();
  });

  it('valid [[open:…]] markers become buttons that navigate in-app; invalid ones are dropped and never shown', async () => {
    api.history.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'Where do I set my protein?', createdAt: '2026-10-27T09:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'I can’t see your nutrition yet.\n[[open:/nutrition/targets|Set your targets]]\n[[open:/evil|Evil]]', createdAt: '2026-10-27T09:00:05Z' },
    ]);
    render(
      createElement(
        ToastProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: ['/coaching/ai'] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/coaching/ai', element: createElement(AiChatPage) }),
            createElement(Route, { path: '/nutrition/targets', element: createElement('h1', null, 'Targets screen') }),
          ),
        ),
      ),
    );
    const btn = await screen.findByRole('button', { name: 'Set your targets' });
    expect(screen.queryByRole('button', { name: 'Evil' })).toBeNull();
    expect(document.body.textContent).not.toContain('[[open:');
    fireEvent.click(btn);
    expect(await screen.findByText('Targets screen')).toBeTruthy();
  });

  it('meal plan card: totals match planStatus, "Add to my meal plan" saves locally, replay is a no-op, Undo restores', async () => {
    const db = h.db as LiftDb;
    const acc = defaultAccountState();
    acc.settings.nutritionEnabled = true;
    acc.nutrition = { ...acc.nutrition, mode: 'protein_only', proteinG: 140 };
    h.account = acc;
    const { todayISO, startOfWeek, addDays } = await import('@/lib/dates');
    const { RECIPES } = await import('@/data/recipes');
    const { toMealPlanSuggestion, previewMealPlan, applyMealPlanSuggestion } = await import('@/domain/nutrition/aiActions');
    const { prefsFromAccount } = await import('@/features/nutrition/shared');
    const today = todayISO(acc.settings.timeZone);
    const ws = startOfWeek(today, acc.settings.weekStart);
    const lunch = RECIPES.find((r) => r.meal === 'lunch')!;
    const plan = toMealPlanSuggestion({
      kind: 'meal_plan', id: 'u-mp', weekStart: ws, weekEnd: addDays(ws, 6), targets: { proteinG: 140, kcal: null }, summary: 'Lunch today', warnings: [],
      days: [{ date: today, items: [{ slot: 'lunch', recipeId: lunch.id, name: lunch.name, servings: 1 }] }],
    })!;
    api.history.mockResolvedValue([
      { id: 'u-mp', role: 'user', content: 'Plan lunch', createdAt: '2026-10-27T09:00:00Z' },
      { id: 'a-mp', role: 'assistant', content: 'Here you go.', createdAt: '2026-10-27T09:00:05Z', mealPlan: plan },
    ]);
    renderAt('/coaching/ai', createElement(AiChatPage));
    const card = (await screen.findByRole('button', { name: 'Add to my meal plan' })).closest('section') as HTMLElement;
    const expected = previewMealPlan(plan, prefsFromAccount(acc)).status.days[0];
    const totals = card.querySelector('[data-testid="ai-mealplan-totals"]')!;
    expect(totals.textContent).toContain(`${Math.round(expected.totals.protein)} g protein / 140 g`);
    fireEvent.click(screen.getByRole('button', { name: 'Add to my meal plan' }));
    const saved = await waitFor(async () => {
      const rows = await db.mealPlans.where('weekStart').equals(ws).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].days.find((d) => d.date === today)!.items.map((i) => i.id)).toEqual([`ai:u-mp:${today}:0`]);
      return rows[0];
    });
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add to my meal plan' })).toBeNull();
    expect(applyMealPlanSuggestion(saved, plan, 'replace', prefsFromAccount(acc))!.alreadyApplied).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => {
      const rows = await db.mealPlans.where('weekStart').equals(ws).toArray();
      expect(rows[0].days.find((d) => d.date === today)!.items).toEqual([]);
    });
    expect(await screen.findByRole('button', { name: 'Add to my meal plan' })).toBeTruthy();
  });

  it('recipe cards: name, time and protein; Open links to the recipe, Save updates favourites, Add to plan… adds it to this week', async () => {
    const db = h.db as LiftDb;
    const { RECIPES } = await import('@/data/recipes');
    const { toRecipeSuggestions } = await import('@/domain/nutrition/aiActions');
    const r = RECIPES[0];
    api.history.mockResolvedValue([
      { id: 'u-r', role: 'user', content: 'Ideas?', createdAt: '2026-10-27T09:00:00Z' },
      {
        id: 'a-r', role: 'assistant', content: 'Try this.', createdAt: '2026-10-27T09:00:05Z',
        recipes: toRecipeSuggestions({ kind: 'recipe_suggestions', id: 'u-r', recipes: [{ id: r.id, totalMinutes: 15, perServing: { kcal: 500, protein_g: 40, carbs_g: 50, fat_g: 12 } }] }),
      },
    ]);
    renderAt('/coaching/ai', createElement(AiChatPage));
    const card = (await screen.findByRole('article', { name: r.name })) as HTMLElement;
    expect(within(card).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(`/nutrition/recipes/${r.id}`);
    expect(within(card).getByText(/40 g protein/)).toBeTruthy();
    expect(card.textContent).toContain('15 min');
    expect(card.textContent).not.toMatch(/kcal|carbs/);
    expect(within(card).queryByRole('button', { name: 'Log this meal' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.updateAccount).toHaveBeenCalledTimes(1));
    fireEvent.click(within(card).getByRole('button', { name: 'Add to plan…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to plan' }));
    await waitFor(async () => {
      const plans = await db.mealPlans.toArray();
      expect(plans).toHaveLength(1);
      expect(plans[0].days.flatMap((d) => d.items).map((i) => i.recipeId)).toEqual([r.id]);
    });
  });

  it('a recipe link in the text is a button that opens the recipe page; no dangling lead-in line', async () => {
    const { RECIPES } = await import('@/data/recipes');
    const r = RECIPES[1];
    api.history.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'Breakfast idea?', createdAt: '2026-10-27T09:00:00Z' },
      { id: 'a1', role: 'assistant', content: `**${r.name}** — 30 g protein, 10 min.\n\nOpen it here:\n[[open:/nutrition/recipes/${r.id}|Open recipe]]`, createdAt: '2026-10-27T09:00:05Z' },
    ]);
    render(
      createElement(
        ToastProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: ['/coaching/ai'] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/coaching/ai', element: createElement(AiChatPage) }),
            createElement(Route, { path: '/nutrition/recipes/:id', element: createElement('h1', null, 'Recipe page') }),
          ),
        ),
      ),
    );
    const btn = await screen.findByRole('button', { name: 'Open recipe' });
    const body = document.querySelector('[data-testid="ai-message-body"]')!;
    expect(body.textContent).not.toMatch(/Open it here/);
    fireEvent.click(btn);
    expect(await screen.findByText('Recipe page')).toBeTruthy();
  });

  it('ISO dates in AI text are shown as human dates; "Why this?" only appears with text; old "1 recent workouts" chips read singular', async () => {
    const { todayISO, addDays } = await import('@/lib/dates');
    const today = todayISO((h.account as { settings: { timeZone: string } }).settings.timeZone);
    api.history.mockResolvedValue([
      { id: 'u1', role: 'user', content: 'When?', createdAt: '2026-10-27T09:00:00Z' },
      { id: 'a1', role: 'assistant', content: `Train ${today} and rest ${addDays(today, 1)}. Long one on ${addDays(today, 20)}.`, why: '   ', grounding: ['1 recent workouts'], createdAt: '2026-10-27T09:00:05Z' },
    ]);
    renderAt('/coaching/ai', createElement(AiChatPage));
    const body = await waitFor(() => {
      const el = document.querySelector('[data-testid="ai-message-body"]');
      if (!el) throw new Error('no AI message yet');
      return el as HTMLElement;
    });
    expect(body.textContent).toMatch(/^Train today and rest tomorrow\. Long one on (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}\.$/);
    expect(body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(screen.queryByText('Why this?')).toBeNull();
    expect(screen.getByText('1 recent workout')).toBeTruthy();
  });

  it('week plan card warnings show human dates', async () => {
    const db = h.db as LiftDb;
    const p = await saveRecord('programs', threeDayPlan(), db);
    const { toWeekPlan } = await vi.importActual<typeof import('@/backend/ai')>('@/backend/ai');
    api.history.mockResolvedValue([
      { id: 'u-week', role: 'user', content: 'twice this week', createdAt: '2026-10-28T09:00:00Z' },
      {
        id: 'a-week', role: 'assistant', content: 'Here’s this week.', createdAt: '2026-10-28T09:00:05Z',
        weekPlan: toWeekPlan({
          kind: 'week_adjustment', id: 'u-week', baseProgramId: p.id, baseVersion: p.currentVersion, managedBy: 'self', weekStart: '2026-10-26', weekEnd: '2026-11-01', targetSessions: 2,
          completed: [], sessions: [{ templateId: 'B', name: 'Full body B', date: '2026-10-30', plannedDate: '2026-10-28' }], skipped: [],
          adjustments: ['Add rows on 2026-10-30'], warnings: ['Sessions on back-to-back days (2026-10-30 and 2026-10-31) — older wording'], summary: '',
        }),
      },
    ]);
    renderAt('/coaching/ai', createElement(AiChatPage));
    const card = (await screen.findByText('This week only')).closest('section') as HTMLElement;
    expect(card.textContent).toContain('Fri 30 Oct');
    expect(card.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
