// @vitest-environment jsdom
/**
 * Update flow during an active workout (src/pwa/UpdateBanner.tsx + update.ts) and the device-health banner
 * (src/pwa/HealthBanner.tsx). Real Dexie (fake-indexeddb); the service-worker module is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { LiftDb } from '@/db/db';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { needRefresh: false, offlineReady: false, reloadPending: false };
  return {
    state,
    listeners,
    set(p: Partial<typeof state>) {
      Object.assign(state, p);
      listeners.forEach((l) => l());
    },
    reloadPage: vi.fn(),
    applyUpdate: vi.fn(async () => {}),
    db: null as unknown as LiftDb,
  };
});
vi.mock('@/pwa/update', () => ({
  pwaState: () => ({ ...h.state }),
  subscribePwa: (fn: () => void) => {
    h.listeners.add(fn);
    return () => h.listeners.delete(fn);
  },
  reloadPage: h.reloadPage,
  applyUpdate: h.applyUpdate,
}));
vi.mock('@/state/app', () => ({ useApp: () => ({ db: h.db }) }));

const { UpdateBanner } = await import('@/pwa/UpdateBanner');
const { HealthBanner } = await import('@/pwa/HealthBanner');
const { ToastProvider } = await import('@/components/toast');
const health = await import('@/pwa/health');

let root: Root;
let el: HTMLDivElement;
const text = () => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const buttons = () => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() || b.getAttribute('aria-label'));
const flush = async (ms = 60) => {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, ms / 4)));
};
const session = (status: 'active' | 'completed') => ({
  id: `s-${status}`, date: '2026-10-29', status, name: 'Push', startedAt: Date.now() - 60_000, pausedTotalMs: 0, createdAt: 1, updatedAt: 1, exercises: [],
});

async function mount(node: 'update' | 'health') {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(ToastProvider, null, createElement(node === 'update' ? UpdateBanner : HealthBanner))));
  });
  await flush();
}

beforeEach(async () => {
  h.db = new LiftDb(`update-test-${Math.random().toString(36).slice(2)}`);
  await h.db.open();
  Object.assign(h.state, { needRefresh: false, offlineReady: false, reloadPending: false });
  h.reloadPage.mockClear();
  h.applyUpdate.mockClear();
  health.resetHealth();
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  h.db.close();
  await h.db.delete();
});

describe('update banner', () => {
  it('offers Update when no workout is active', async () => {
    await mount('update');
    await act(async () => h.set({ needRefresh: true }));
    await flush();
    expect(text()).toContain('Update available.');
    expect(buttons()).toContain('Update');
  });

  it('during an active workout the update waits: no Update button, honest text, no reload', async () => {
    await h.db.sessions.put(session('active') as never);
    await mount('update');
    await act(async () => h.set({ needRefresh: true }));
    await flush();
    expect(text()).toContain('You can install it after you finish your workout.');
    expect(buttons()).not.toContain('Update');
    expect(h.applyUpdate).not.toHaveBeenCalled();
    // finishing the workout makes the button available
    await act(async () => h.db.sessions.update('s-active', { status: 'completed' }));
    await flush();
    expect(buttons()).toContain('Update');
  });

  it('a new version activated elsewhere reloads only after the workout ends', async () => {
    await h.db.sessions.put(session('active') as never);
    await mount('update');
    await act(async () => h.set({ reloadPending: true }));
    await flush();
    expect(text()).toContain('It will reload when you finish this workout.');
    expect(h.reloadPage).not.toHaveBeenCalled();
    await act(async () => h.db.sessions.update('s-active', { status: 'completed' }));
    await flush();
    expect(h.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('a deleted (tombstoned) active session does not block updates', async () => {
    await h.db.sessions.put({ ...session('active'), deletedAt: Date.now() } as never);
    await mount('update');
    await act(async () => h.set({ reloadPending: true }));
    await flush();
    expect(h.reloadPage).toHaveBeenCalledTimes(1);
  });
});

describe('health banner', () => {
  it('shows a clear alert when the browser blocks local storage', async () => {
    await mount('health');
    expect(text()).toBe('');
    await act(async () => void health.reportStorageError(Object.assign(new Error('IndexedDB API missing'), { name: 'MissingAPIError' })));
    await flush();
    expect(el.querySelector('[role="alert"]')?.textContent).toMatch(/isn’t letting LiftCircle save on this device/);
  });

  it('shows a dismissible notice when offline mode could not be set up', async () => {
    await mount('health');
    await act(async () => health.reportSwError(new Error('404')));
    await flush();
    expect(text()).toMatch(/Offline mode couldn’t be set up/);
    const dismiss = el.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement;
    await act(async () => dismiss.click());
    expect(text()).toBe('');
  });

  it('asks a guest to protect device-only data only once there is a finished workout (dismiss is remembered)', async () => {
    h.db.close();
    await h.db.delete();
    h.db = new LiftDb('guest');
    await h.db.delete();
    await h.db.open();
    localStorage.removeItem('lc-persist-notice-dismissed');
    await mount('health');
    await act(async () => {
      health.reportStorageOk();
      health.reportPersisted(false);
    });
    await flush();
    expect(text()).toBe('');
    await act(async () => h.db.sessions.put(session('completed') as never));
    await flush();
    expect(text()).toMatch(/only on this device/);
    expect(el.querySelector('a[href="/settings/data"]')).toBeTruthy();
    await act(async () => (el.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click());
    expect(text()).toBe('');
    expect(localStorage.getItem('lc-persist-notice-dismissed')).toBe('1');
  });
});
