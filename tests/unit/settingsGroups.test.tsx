// @vitest-environment jsdom
/**
 * Roadmap item 11 — Settings: /settings is an index of exactly five groups; ?section= opens a group (unknown →
 * index); legacy hashes open their group and win over a conflicting section; entering focuses the heading; Back from a
 * direct entry replaces to the index and focus returns to the row; groups mount lazily and stay mounted hidden (out of
 * the accessibility tree); a typed draft is committed by its blur before Back; every existing control is still there;
 * PushSection is not mounted on the untouched index; the sign-out labels are localized.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Fragment, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { AccountState } from '@/domain/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ app: null as unknown, updates: [] as AccountState[], auth: { status: 'signed_out' } as Record<string, unknown>, location: '' }));
vi.mock('@/state/app', () => ({ useApp: () => h.app }));
vi.mock('@/features/settings/UpdateCheckRow', () => ({ UpdateCheckRow: () => null }));
vi.mock('@/features/settings/PushSection', () => ({ PushSection: () => createElement('section', { 'data-testid': 'push' }, createElement('h2', { id: 'push-title' }, 'Push'), createElement('h3', { id: 'quiet-push-title' }, 'Quiet')) }));

import { ToastProvider } from '@/components/toast';
import SettingsPage, { SETTINGS_SECTIONS, sectionFor } from '@/features/settings/SettingsPage';
import { LanguageProvider, setLanguage } from '@/i18n';
import { defaultAccountState } from '@/state/defaults';

let root: Root | null = null;
let el: HTMLElement | null = null;

function Probe() {
  const l = useLocation();
  h.location = `${l.pathname}${l.search}${l.hash}`;
  return null;
}
function Harness({ initial }: { initial: AccountState }) {
  const [account, setAccount] = useState(initial);
  h.app = {
    account,
    updateAccount: async (fn: (a: AccountState) => AccountState) => {
      const next = fn(account);
      h.updates.push(next);
      setAccount(next);
    },
    auth: h.auth,
    backendConfigured: true,
    online: true,
    db: { isDemo: false, isGuest: true, accountKey: 'guest' },
    finishSignOut: () => undefined,
  };
  return createElement(LanguageProvider, {
    language: account.settings.language ?? 'en',
    children: createElement(Routes, null, createElement(Route, { path: '/settings', element: createElement(Fragment, null, createElement(SettingsPage), createElement(Probe)) })),
  });
}
async function render(url: string, initial = defaultAccountState()) {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [url] }, createElement(Harness, { initial })))));
}
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const visibleGroup = () => [...document.querySelectorAll('section[aria-labelledby^="settings-group-"]')].filter((s) => !s.hasAttribute('hidden')).map((s) => s.getAttribute('aria-labelledby'));
const rows = () => [...document.querySelectorAll('nav a[id^="settings-row-"]')] as HTMLAnchorElement[];
const click = async (e: Element) => act(async () => void (e as HTMLElement).click());

beforeEach(() => {
  vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '');
  h.updates = [];
  h.auth = { status: 'signed_out' };
  setLanguage('en');
});
afterEach(() => {
  act(() => root?.unmount());
  el?.remove();
  root = null;
  vi.unstubAllEnvs();
  setLanguage('en');
});

describe('Settings index', () => {
  it('shows exactly five groups in order as real links, and mounts no group (no push) when untouched', async () => {
    await render('/settings');
    expect(rows().map((a) => a.getAttribute('href'))).toEqual(['/settings?section=app', '/settings?section=training', '/settings?section=coaching', '/settings?section=privacy', '/settings?section=account']);
    expect(rows().map((a) => norm(a.querySelector('.font-medium')?.textContent))).toEqual(['Language & display', 'Training & nutrition', 'Coach & notifications', 'Sharing & privacy', 'Account & data']);
    expect(document.querySelectorAll('section[aria-labelledby^="settings-group-"]')).toHaveLength(0);
    expect(document.querySelector('[data-testid="push"]')).toBeNull();
  });

  it('an unknown section shows the index', async () => {
    await render('/settings?section=nope');
    expect(document.querySelector('nav')?.hasAttribute('hidden')).toBe(false);
    expect(visibleGroup()).toEqual([]);
  });

  it('renders the Icelandic group titles', async () => {
    const a = defaultAccountState();
    a.settings = { ...a.settings, language: 'is' };
    setLanguage('is');
    await render('/settings', a);
    expect(rows().map((r) => norm(r.querySelector('.font-medium')?.textContent))).toEqual(['Tungumál og birting', 'Æfingar og næring', 'Þjálfari og tilkynningar', 'Deiling og persónuvernd', 'Reikningur og gögn']);
  });
});

describe('Settings groups', () => {
  const expectations: Record<string, string[]> = {
    app: ['Language', 'Appearance', 'Units & display', 'Weight', 'Height & measurements', 'Distance', 'Week starts on', 'Time zone'],
    training: ['Default rest', 'Default sets', 'Start rest timer after each set', 'Nutrition features', 'Nutrition targets', 'Program & schedule'],
    coaching: ['Training assistant settings', 'Friend requests', 'Likes', 'Comments', 'Coaching updates'],
    privacy: ['Let people find me by username', 'Default audience for posts', 'Share product usage events'],
    account: ['Your name (private)', 'Your data', 'Install on your phone', 'About'],
  };
  for (const s of SETTINGS_SECTIONS) {
    it(`?section=${s.id} opens "${s.id}", focuses its heading, and keeps its controls`, async () => {
      await render(`/settings?section=${s.id}`);
      expect(visibleGroup()).toEqual([`settings-group-${s.id}`]);
      expect(document.querySelector('nav')?.hasAttribute('hidden')).toBe(true);
      expect(document.activeElement?.id).toBe(`settings-group-${s.id}`);
      const text = norm(document.querySelector(`section[aria-labelledby="settings-group-${s.id}"]`)?.textContent);
      for (const label of expectations[s.id]) expect(text, label).toContain(label);
    });
  }

  it('the coaching group links to the training assistant settings and mounts the push section', async () => {
    await render('/settings?section=coaching');
    expect(document.querySelector('a[href="/coaching/ai/settings"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="push"]')).not.toBeNull();
  });

  it('legacy hashes open their group and win over a conflicting section; the heading gets focus', async () => {
    expect(sectionFor('?section=privacy', '#language-title')).toBe('app');
    expect(sectionFor('', '#coach-push-title')).toBe('coaching');
    expect(sectionFor('?section=account', '')).toBe('account');
    expect(sectionFor('?section=x', '#other')).toBeNull();
    await render('/settings?section=privacy#quiet-push-title');
    expect(visibleGroup()).toEqual(['settings-group-coaching']);
    expect(document.activeElement?.id).toBe('quiet-push-title');
  });

  it('Back from a direct entry replaces to the index; focus returns to the originating row; groups stay mounted hidden', async () => {
    await render('/settings?section=privacy');
    await click(document.querySelector('button[aria-label="Back"]')!);
    expect(h.location).toBe('/settings');
    expect(document.activeElement?.id).toBe('settings-row-privacy');
    const hidden = document.querySelector('section[aria-labelledby="settings-group-privacy"]')!;
    expect(hidden.hasAttribute('hidden')).toBe(true);
    // From the index, a row is a real link; Back then uses history and lands on the index again.
    await click(document.querySelector('#settings-row-training')!);
    expect(h.location).toBe('/settings?section=training');
    await click(document.querySelector('button[aria-label="Back"]')!);
    expect(h.location).toBe('/settings');
    expect(document.activeElement?.id).toBe('settings-row-training');
    expect(document.querySelectorAll('section[aria-labelledby^="settings-group-"]')).toHaveLength(2);
  });

  it('a typed draft is committed by its blur when Back is pressed', async () => {
    await render('/settings?section=account');
    const input = [...document.querySelectorAll('input')].find((i) => i.closest('div')?.textContent?.includes('Your name (private)') || i.maxLength === 40) as HTMLInputElement;
    act(() => {
      input.focus();
      input.value = 'Sigga';
    });
    await click(document.querySelector('button[aria-label="Back"]')!);
    expect(h.updates.at(-1)?.profile.displayName).toBe('Sigga');
    expect(h.location).toBe('/settings');
  });

  it('language changes keep units, time zone and theme', async () => {
    const a = defaultAccountState();
    a.settings = { ...a.settings, units: { weight: 'lb', length: 'ftin', distance: 'mi' }, timeZone: 'America/New_York', theme: 'dark' };
    await render('/settings?section=app', a);
    const is = [...document.querySelectorAll('[role="radio"]')].find((b) => norm(b.textContent) === 'Íslenska')!;
    await click(is);
    const next = h.updates.at(-1)!;
    expect(next.settings.language).toBe('is');
    expect({ ...next.settings, language: a.settings.language }).toEqual(a.settings);
  });

  it('signed in: the sign-out button is localized in both languages', async () => {
    h.auth = { status: 'signed_in', userId: 'u1', email: 'x@example.com' };
    await render('/settings?section=account');
    expect([...document.querySelectorAll('button')].some((b) => norm(b.textContent) === 'Sign out')).toBe(true);
    act(() => root!.unmount());
    el!.remove();
    const a = defaultAccountState();
    a.settings = { ...a.settings, language: 'is' };
    setLanguage('is');
    await render('/settings?section=account', a);
    expect([...document.querySelectorAll('button')].some((b) => norm(b.textContent) === 'Skrá út')).toBe(true);
  });
});
