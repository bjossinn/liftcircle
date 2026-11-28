// @vitest-environment jsdom
/**
 * Icelandic auth, templates and program screens: the sign-in page, guest import and program page render the
 * approved Icelandic copy, while plan text stored as canonical English (names, version reasons) stays English in
 * the database and is localized only for display.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ app: null as unknown }));
vi.mock('@/state/app', () => ({ useApp: () => h.app }));

import { ToastProvider } from '@/components/toast';
import AuthPage from '@/features/auth/AuthPage';
import ImportGuestPage from '@/features/auth/ImportGuestPage';
import ProgramPage from '@/features/program/ProgramPage';
import { planOwnerText } from '@/features/program/PlanOwner';
import { versionReasonText } from '@/features/program/parts';
import { LanguageProvider, setLanguage, t } from '@/i18n';
import { defaultAccountState } from '@/state/defaults';
import { LiftDb } from '@/db/db';
import { saveRecord } from '@/db/repo';
import { createProgram } from '@/domain/program/program';
import { emptyTemplate } from '@/domain/program/generator';
import type { ProgramVersion } from '@/domain/types';

let root: Root | null = null;
let el: HTMLElement | null = null;

async function render(node: ReactElement, language: 'en' | 'is' = 'is') {
  setLanguage(language);
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(LanguageProvider, { language, children: node })))),
  );
}
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';

afterEach(() => {
  act(() => root?.unmount());
  el?.remove();
  root = null;
  el = null;
  setLanguage('en');
});

const app = (over: object = {}) => ({
  account: defaultAccountState(),
  auth: { status: 'signed_out', email: null },
  backendConfigured: true,
  online: true,
  db: { isDemo: false, isGuest: true, accountKey: 'guest' },
  ...over,
});

describe('auth screens in Icelandic', () => {
  it('sign-in page labels and the privacy summary', async () => {
    h.app = app();
    await render(createElement(AuthPage));
    expect(text()).toContain(t('auth.forgot_password', undefined, 'is'));
    expect(text()).toContain('Gleymt lykilorð?');
    expect(text()).toContain('Halda áfram án aðgangs');
    expect(document.querySelector('label')?.textContent).toContain('Netfang');
    expect(text()).not.toContain('Forgot password?');
  });

  it('backend-less notice names the brand inside one sentence', async () => {
    h.app = app({ backendConfigured: false });
    await render(createElement(AuthPage));
    expect(text()).toMatch(/Aðgangar, öryggisafrit og vinir eru ekki virk í þessari útgáfu af \S/);
    expect(text()).not.toContain('{{');
  });

  it('guest import asks to sign in first', async () => {
    h.app = app();
    await render(createElement(ImportGuestPage));
    expect(text()).toContain('Skráðu þig fyrst inn');
    expect(text()).toContain('Skráðu þig inn á aðganginn sem þú vilt flytja gögnin inn á.');
  });
});

describe('program page in Icelandic', () => {
  it('shows Icelandic chrome and localizes the stored English default names', async () => {
    const db = new LiftDb('00000000-dddd-4ddd-8ddd-000000000001');
    await db.delete();
    await db.open();
    const v: ProgramVersion = {
      version: 1,
      createdAt: Date.now(),
      reason: 'Created manually',
      templates: [emptyTemplate('custom:a', 'Session A')],
      schedule: [],
      weeks: 8,
      reviewWeek: 8,
      rationale: [],
      warnings: [],
    };
    const p = createProgram(null, v, '2026-11-01', 'My program', 'manual');
    await saveRecord('programs', p, db);
    h.app = app({ db });
    await render(createElement(ProgramPage));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(text()).toContain('Þín eigin áætlun');
    expect(text()).toContain('Útgáfa 1');
    expect(text()).toContain('Æfingaáætlunin mín');
    expect(text()).toMatch(/Vika \d+ af 8 · endurmat í viku 8 · byrjað/);
    expect((await db.programs.get(p.id))?.name).toBe('My program');
    db.close();
  });

  it('plan owner and stored version reasons', () => {
    setLanguage('is');
    expect(planOwnerText({ managedBy: { kind: 'coach', coachName: 'Ada' } })).toBe('Úthlutað af Ada');
    expect(versionReasonText('Changed days for Push A')).toBe('Dögum breytt fyrir Push A');
    expect(versionReasonText('Added Session B', [{ ...emptyTemplate('custom:b', 'Session B') }])).toBe('Æfing B bætt við');
    setLanguage('en');
    expect(versionReasonText('Deleted Session B')).toBe('Deleted Session B');
  });
});
