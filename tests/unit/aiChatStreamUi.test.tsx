// @vitest-environment jsdom
/**
 * Roadmap item 10, chat UI (MOCKED aiApi; real AiChatPage and Dexie via fake-indexeddb):
 *  - the status line shows server phases (approved copy), the preview is plain text with no links or cards, and the
 *    final reply replaces it through the normal mappers; usage comes from the server; completion is announced;
 *  - Stop only when the server supports it; Stop during sync, model wait, retry polling and delivery; a confirmed Stop
 *    keeps the message and a resend gets a NEW id; the next send works;
 *  - an interrupted stream is recovered with the SAME id (no second generation); unmount detaches without late writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ db: null as unknown, account: null as unknown, syncGate: null as null | Promise<void> }));
vi.mock('@/state/app', () => ({
  useApp: () => ({
    db: h.db, account: h.account, accountReady: true, auth: { status: 'signed_in', userId: 'user-1' }, online: true, backendConfigured: true,
    updateAccount: async () => undefined,
  }),
  useDb: () => h.db,
  useSettings: () => (h.account as { settings: unknown }).settings,
}));
vi.mock('@/backend/ai', () => ({
  aiApi: {
    status: vi.fn(), getSettings: vi.fn(), saveSettings: vi.fn(), history: vi.fn(), send: vi.fn(), sendStream: vi.fn(), cancel: vi.fn(), requestStatus: vi.fn(),
    clearHistory: vi.fn(), listProposals: vi.fn(), respondProposal: vi.fn(),
  },
}));
vi.mock('@/backend/coaching', () => ({ coachingApi: { myRelationships: vi.fn(async () => []) } }));
vi.mock('@/sync/engine', () => ({ syncNow: vi.fn(async () => h.syncGate ?? undefined) }));

import { aiApi } from '@/backend/ai';
import type { AiSettings } from '@/backend/coachingContract';
import { LiftDb } from '@/db/db';
import { kvGet } from '@/db/repo';
import { ToastProvider } from '@/components/toast';
import { defaultAccountState } from '@/state/defaults';
import AiChatPage from '@/features/coaching/AiChatPage';
import { AI_HISTORY_CACHE_KEY, AI_PENDING_KEY, type PendingSend } from '@/features/coaching/ai/model';
import { setLanguage } from '@/i18n';

const api = aiApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
const db = () => h.db as LiftDb;
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const SETTINGS: AiSettings = { enabled: true, paused: false, consentAt: '2026-11-01T10:00:00Z', scopes: { profile: true, training: true, measurements: false, nutrition: false }, profileNotes: '', coachStyle: 'supportive' };
const USAGE = { day: '2026-11-26', requests: 1, inputTokens: 0, outputTokens: 0, limitRequests: 40 };
const status = (protocol: { stream: boolean; cancel: boolean } | undefined) => ({ available: true, provider: 'openai', providerName: 'OpenAI', consentCurrent: true, usage: USAGE, ...(protocol ? { protocol } : {}) });
let n = 0;
const result = (content = 'Rest today.', extra: Record<string, unknown> = {}) => ({
  reply: { id: `r-${++n}`, role: 'assistant', content, createdAt: new Date().toISOString(), status: 'sent', proposalId: null, grounding: ['Profile & preferences'] },
  proposal: null, duplicate: false, usage: { ...USAGE, requests: 7 }, ...extra,
});

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
function render() {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  act(() => root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: ['/coach'] }, createElement(Routes, null, createElement(Route, { path: '/coach', element: createElement(AiChatPage) }))))));
}
const text = () => norm(document.body.textContent);
const statusLine = () => norm(el!.querySelector('[data-testid="ai-status-line"]')?.textContent);
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];
const button = (name: string | RegExp) => {
  const b = buttons().find((x) => {
    const t = norm(x.getAttribute('aria-label') || x.textContent);
    return typeof name === 'string' ? t === name : name.test(t);
  });
  if (!b) throw new Error(`no button ${name}: ${text().slice(0, 300)}`);
  return b;
};
const click = (b: Element) => act(() => void b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
async function sendText(t: string) {
  const c = await waitFor(() => {
    const x = el!.querySelector<HTMLTextAreaElement>('#ai-composer');
    if (!x || x.disabled) throw new Error('composer not ready');
    return x;
  });
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(c, t);
    c.dispatchEvent(new Event('input', { bubbles: true }));
  });
  click(await waitFor(() => button('Send')));
}
/** A sendStream that reports phases/text and then waits until aborted (rejects) or released. */
function controllableStream() {
  const ctl: { expectedUserId?: string; handlers?: { onPhase?: (p: string) => void; onText?: (t: string) => void }; resolve?: (r: unknown) => void; reject?: (e: unknown) => void; signal?: AbortSignal } = {};
  api.sendStream.mockImplementation((_input: unknown, handlers: typeof ctl.handlers, opts?: { signal?: AbortSignal; expectedUserId?: string }) => {
    const signal = opts?.signal;
    ctl.expectedUserId = opts?.expectedUserId;
    ctl.handlers = handlers;
    ctl.signal = signal;
    return new Promise((resolve, reject) => {
      ctl.resolve = resolve;
      ctl.reject = reject;
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  });
  return ctl;
}

beforeEach(() => {
  setLanguage('en');
  h.db = new LiftDb(`ai-stream-ui-${++n}`);
  h.account = defaultAccountState();
  h.syncGate = null;
  for (const fn of Object.values(api)) fn.mockReset();
  api.status.mockResolvedValue(status({ stream: true, cancel: true }));
  api.getSettings.mockResolvedValue(SETTINGS);
  api.history.mockResolvedValue([]);
  api.send.mockImplementation(async () => result('JSON reply.'));
  api.requestStatus.mockResolvedValue({ state: 'running' });
});
afterEach(async () => {
  if (root) act(() => root!.unmount());
  el?.remove();
  root = null;
  await db().delete();
});

describe('streaming status line and preview', () => {
  it('shows server phases, a plain-text preview, then the final reply; usage from the server; completion announced', async () => {
    const s = controllableStream();
    render();
    await sendText('Should I train today?');
    await waitFor(() => expect(api.sendStream).toHaveBeenCalledTimes(1));
    expect(s.expectedUserId).toBe('user-1'); // bound to the account that wrote it (review P1-1)
    act(() => s.handlers!.onPhase!('training'));
    expect(statusLine()).toMatch(/^Checking your training history…/);
    expect(button('Stop reply')).toBeTruthy();
    act(() => s.handlers!.onPhase!('writing'));
    expect(statusLine()).toMatch(/^Writing your reply…/);
    act(() => s.handlers!.onText!('Rest today. '));
    act(() => s.handlers!.onText!('Sleep comes first.\n[[open:/settings|Open Settings]]'));
    expect(statusLine()).toMatch(/^Receiving your reply…/);
    const preview = el!.querySelector('[data-testid="ai-reply-preview"]')!;
    expect(norm(preview.textContent)).toBe('Rest today. Sleep comes first.');
    expect(preview.querySelector('a, button')).toBeNull(); // no clickable links or cards in the preview
    expect((await kvGet<unknown[]>(AI_HISTORY_CACHE_KEY, db())) ?? []).toEqual([]); // no history writes before completion
    await act(async () => s.resolve!(result('Rest today. Sleep comes first.\n[[open:/settings|Open Settings]]')));
    await waitFor(() => expect(el!.querySelector('[data-testid="ai-reply-preview"]')).toBeNull());
    expect(el!.querySelector('[data-testid="ai-status-line"]')).toBeNull();
    expect(text()).toContain('Rest today. Sleep comes first.');
    expect(button('Open Settings')).toBeTruthy(); // the link becomes a button only on the final reply
    expect(norm(el!.querySelector('[data-testid="ai-announce"]')?.textContent)).toBe('Your reply is ready.');
    expect(text()).toContain('7 of 40'); // usage refreshed from the server (7), not +1
    const first = api.sendStream.mock.calls[0][0] as { id: string };
    expect(await kvGet(AI_PENDING_KEY, db())).toBeNull();
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('older servers: JSON request, no Stop button', async () => {
    api.status.mockResolvedValue(status(undefined));
    let release!: () => void;
    api.send.mockImplementation(() => new Promise((r) => (release = () => r(result('JSON reply.')))));
    render();
    await sendText('hi');
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.sendStream).not.toHaveBeenCalled();
    expect(statusLine()).toMatch(/Preparing your reply…/);
    expect(buttons().some((b) => norm(b.textContent) === 'Stop reply')).toBe(false);
    await act(async () => release());
    await waitFor(() => expect(text()).toContain('JSON reply.'));
  });

  it('streaming without cancellation support: no Stop button', async () => {
    api.status.mockResolvedValue(status({ stream: true, cancel: false }));
    controllableStream();
    render();
    await sendText('hi');
    await waitFor(() => expect(api.sendStream).toHaveBeenCalledTimes(1));
    expect(buttons().some((b) => norm(b.textContent) === 'Stop reply')).toBe(false);
  });
});

describe('Stop', () => {
  it('during the model wait: “Stopping…” until acknowledged; message kept; resend gets a new id; the next send works', async () => {
    const s = controllableStream();
    api.cancel.mockResolvedValue({ state: 'cancel_requested' });
    let ack!: () => void;
    api.requestStatus.mockImplementation(() => new Promise((r) => (ack = () => r({ state: 'cancelled', usage: { requests: 1 } }))));
    render();
    await sendText('Plan my week');
    await waitFor(() => expect(api.sendStream).toHaveBeenCalledTimes(1));
    act(() => s.handlers!.onPhase!('writing'));
    click(button('Stop reply'));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledTimes(1));
    expect(statusLine()).toMatch(/Stopping your reply…/);
    expect(s.signal!.aborted).toBe(true); // the reader stopped; the server decides the outcome
    await waitFor(() => expect(api.requestStatus).toHaveBeenCalled());
    expect(statusLine()).toMatch(/Stopping your reply…/); // cancel_requested is not yet stopped
    await act(async () => ack());
    await waitFor(() => expect(text()).toContain('The reply was stopped. Your message is kept.'));
    const firstId = (api.sendStream.mock.calls[0][0] as { id: string }).id;
    expect(api.cancel.mock.calls[0][0]).toBe(firstId);
    expect(((await kvGet<PendingSend>(AI_PENDING_KEY, db())) as PendingSend).stopped).toBe(true);
    // Resend: a deliberate new request with a NEW id.
    api.sendStream.mockImplementation(async () => result('Second answer.'));
    click(button('Retry'));
    await waitFor(() => expect(text()).toContain('Second answer.'));
    expect((api.sendStream.mock.calls[1][0] as { id: string }).id).not.toBe(firstId);
    // And a fresh message works too.
    api.sendStream.mockImplementation(async () => result('Third answer.'));
    await sendText('And tomorrow?');
    await waitFor(() => expect(text()).toContain('Third answer.'));
  });

  it('during the sync barrier: nothing is sent; the server records the cancel', async () => {
    let release!: () => void;
    h.syncGate = new Promise<void>((r) => (release = r));
    api.cancel.mockResolvedValue({ state: 'cancelled' });
    render();
    await waitFor(() => expect(el!.querySelector('#ai-composer')).not.toBeNull());
    await db().outbox.add({ table: 'sessions', recordId: 'x', op: 'put', createdAt: Date.now() } as never); // something to sync
    await sendText('hi');
    await waitFor(() => expect(statusLine()).toMatch(/Syncing your latest changes…/));
    click(button('Stop reply'));
    await waitFor(() => expect(text()).toContain('The reply was stopped. Your message is kept.'));
    await act(async () => release());
    await tick(30);
    expect(api.sendStream).not.toHaveBeenCalled();
    expect(api.cancel).toHaveBeenCalledTimes(1);
  });

  it('during in_progress retry polling: the wait ends at once; no second send', async () => {
    api.sendStream.mockRejectedValue(Object.assign(new Error('busy'), { code: 'in_progress' }));
    api.cancel.mockResolvedValue({ state: 'cancelled' });
    render();
    await sendText('hi');
    await waitFor(() => expect(api.sendStream).toHaveBeenCalledTimes(1));
    click(button('Stop reply'));
    await waitFor(() => expect(text()).toContain('The reply was stopped.'));
    await tick(50);
    expect(api.sendStream).toHaveBeenCalledTimes(1);
  });

  it('during delivery: success won → the stored exchange is shown and the user is told', async () => {
    const s = controllableStream();
    api.cancel.mockResolvedValue({ state: 'succeeded', result: result('Already finished.') });
    render();
    await sendText('hi');
    await waitFor(() => expect(api.sendStream).toHaveBeenCalledTimes(1));
    act(() => s.handlers!.onText!('Already '));
    click(button('Stop reply'));
    await waitFor(() => expect(text()).toContain('Already finished.'));
    expect(text()).toContain('The reply finished before it could be stopped.');
    expect(await kvGet(AI_PENDING_KEY, db())).toBeNull();
  });

  it('a lost acknowledgement says so and keeps checking the same id', async () => {
    controllableStream();
    api.cancel.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ state: 'cancel_requested' });
    let ack!: () => void;
    api.requestStatus.mockImplementation(() => new Promise((r) => (ack = () => r({ state: 'cancelled' }))));
    render();
    await sendText('hi');
    await waitFor(() => expect(api.sendStream).toHaveBeenCalledTimes(1));
    click(button('Stop reply'));
    await waitFor(() => expect(statusLine()).toContain('Couldn’t confirm that the reply stopped. Checking its status…'));
    await act(async () => ack());
    await waitFor(() => expect(text()).toContain('The reply was stopped.'));
  });
});

describe('interrupted streams and leaving the chat', () => {
  it('EOF without a terminal event: the SAME id is checked (never a second generation) and the stored reply appears', async () => {
    api.sendStream.mockRejectedValue(Object.assign(new Error('interrupted'), { code: 'stream_interrupted' }));
    api.requestStatus.mockResolvedValueOnce({ state: 'running' }).mockResolvedValueOnce({ state: 'succeeded', result: result('Recovered reply.', { duplicate: true }) });
    render();
    await sendText('hi');
    await waitFor(() => expect(text()).toContain('Recovered reply.'), 8000);
    const id = (api.sendStream.mock.calls[0][0] as { id: string }).id;
    expect(api.requestStatus.mock.calls.every((c) => c[0] === id)).toBe(true);
    expect(api.sendStream).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled();
  });

  it('unmount detaches: the preview is gone and nothing is written late; the message keeps its id', async () => {
    const s = controllableStream();
    render();
    await sendText('hi');
    await waitFor(() => expect(api.sendStream).toHaveBeenCalledTimes(1));
    act(() => s.handlers!.onText!('Partial'));
    const pendingBefore = (await kvGet<PendingSend>(AI_PENDING_KEY, db()))!;
    act(() => root!.unmount());
    root = null;
    expect(s.signal!.aborted).toBe(true); // detached, not cancelled
    expect(api.cancel).not.toHaveBeenCalled();
    await tick(30);
    expect((await kvGet<unknown[]>(AI_HISTORY_CACHE_KEY, db())) ?? []).toEqual([]);
    expect((await kvGet<PendingSend>(AI_PENDING_KEY, db()))!.id).toBe(pendingBefore.id);
  });
});
