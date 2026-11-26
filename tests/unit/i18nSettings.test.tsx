// @vitest-environment jsdom
/**
 * Icelandic Settings (roadmap item 8): the language switcher changes Settings.language only, Settings renders the
 * approved Icelandic labels, backups without a language or with an unknown one restore (normalized, never rejected),
 * and backup/restore messages are localized with a typed "nothing was changed" state (no English text inspection).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { AccountState } from '@/domain/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ app: null as unknown, updates: [] as unknown[], fail: false }));
vi.mock('@/state/app', () => ({ useApp: () => h.app }));
vi.mock('@/features/settings/UpdateCheckRow', () => ({ UpdateCheckRow: () => null }));

import { ToastProvider } from '@/components/toast';
import SettingsPage from '@/features/settings/SettingsPage';
import { LanguageProvider, setLanguage, t } from '@/i18n';
import { defaultAccountState } from '@/state/defaults';
import { LiftDb } from '@/db/db';
import { saveRecord } from '@/db/repo';
import { SINGLETON_PARTS, applyImport, countText, parseBackup, previewImport } from '@/features/settings/backup';
import { BackupValidationError } from '@/features/settings/backupSchema';
import { ENTITY_LABELS } from '@/features/auth/guestImport';
import { restoreErrorText } from '@/features/settings/errorText';

let root: Root | null = null;
let el: HTMLElement | null = null;

function Harness({ initial }: { initial: AccountState }) {
  const [account, setAccount] = useState(initial);
  h.app = {
    account,
    updateAccount: async (fn: (a: AccountState) => AccountState) => {
      if (h.fail) throw new Error('IndexedDB write failed');
      const next = fn(account);
      h.updates.push(next);
      setAccount(next);
    },
    auth: { status: 'signed_out' },
    backendConfigured: false,
    online: true,
    db: { isDemo: false, isGuest: true, accountKey: 'guest' },
  };
  return createElement(LanguageProvider, { language: account.settings.language ?? 'en', children: createElement(SettingsPage) });
}

async function render(initial: AccountState) {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(Harness, { initial })))));
}
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';
const radio = (name: string) => [...document.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.trim() === name) ?? null;

beforeEach(() => {
  vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '');
  h.updates = [];
  h.fail = false;
  setLanguage('en');
});
afterEach(() => {
  act(() => root?.unmount());
  el?.remove();
  root = null;
  vi.unstubAllEnvs();
  setLanguage('en');
});

describe('Settings language switcher', () => {
  it('switching to Íslenska updates Settings.language only and renders Icelandic labels', async () => {
    const initial = defaultAccountState();
    initial.settings = { ...initial.settings, language: 'en', units: { weight: 'lb', length: 'ftin', distance: 'mi' }, timeZone: 'America/New_York', weekStart: 0, theme: 'dark' };
    initial.nutrition = { ...initial.nutrition, mode: 'protein_only', proteinG: 150 };
    await render(initial);
    expect(text()).toMatch(/Units & display/);

    await act(async () => void radio('Íslenska')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(h.updates).toHaveLength(1);
    const next = h.updates[0] as AccountState;
    expect(next.settings.language).toBe('is');
    expect({ ...next.settings, language: 'en' }).toEqual(initial.settings);
    expect(next.nutrition).toEqual(initial.nutrition);
    expect(next.profile).toEqual(initial.profile);

    const page = text();
    for (const s of ['Stillingar', 'Tungumál', 'Mælieiningar og birting', 'Vikan hefst á', 'Kílógrömm']) expect(page).toContain(s);
    expect(page).not.toMatch(/Units & display/);
    // Contextual dative weekday options after "Vikan hefst á".
    expect([...document.querySelectorAll('option')].map((o) => o.textContent)).toEqual(expect.arrayContaining(['Mánudegi', 'Sunnudegi']));
    // Autonyms stay in their own language.
    expect(radio('English')).not.toBeNull();
    expect(radio('Íslenska')?.getAttribute('aria-checked')).toBe('true');
  });
});

describe('Settings language save result', () => {
  it('shows "Language changed" only after a successful save', async () => {
    await render(defaultAccountState());
    await act(async () => void radio('Íslenska')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(text()).toContain(t('settings.languageSaved', undefined, 'is'));
  });

  it('a rejected write shows the error and never the "language changed" toast', async () => {
    h.fail = true;
    await render(defaultAccountState());
    await act(async () => void radio('Íslenska')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {});
    expect(h.updates).toHaveLength(0);
    const page = text();
    expect(page).toContain(t('common.error', undefined, 'en'));
    expect(page).not.toContain(t('settings.languageSaved', undefined, 'is'));
    expect(page).not.toContain(t('settings.languageSaved', undefined, 'en'));
    expect(radio('English')?.getAttribute('aria-checked')).toBe('true');
  });

  it('unfocused numeric fields switch to the decimal comma with the language', async () => {
    const initial = defaultAccountState();
    initial.settings = { ...initial.settings, workout: { ...initial.settings.workout, plateIncrementKg: 2.5 } };
    await render(initial);
    const values = () => [...document.querySelectorAll('input')].map((i) => i.value);
    expect(values()).toContain('2.5');
    await act(async () => void radio('Íslenska')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(values()).toContain('2,5');
    expect(values()).not.toContain('2.5');
  });
});

/* ------------------------------------------------------------------ backups */
const ACCT = '00000000-cccc-4ccc-8ccc-0000000000';
let n = 0;
async function fresh() {
  const db = new LiftDb(`${ACCT}${String(++n).padStart(2, '0')}`);
  await db.delete();
  await db.open();
  return db;
}
const env = (records: object) => JSON.stringify({ format: 'liftcircle-backup', version: 1, exportedAt: '2026-10-28T10:00:00.000Z', records });

describe('backup restore and language', () => {
  it('restores an old backup without a language (keeps this device’s language when replacing settings)', async () => {
    const db = await fresh();
    const local = defaultAccountState();
    local.settings = { ...local.settings, language: 'is' };
    await saveRecord('account_state', local, db);
    const old = defaultAccountState() as unknown as { settings: Record<string, unknown> };
    delete old.settings.language;
    old.settings.units = { weight: 'lb', length: 'cm', distance: 'km' };
    const backup = parseBackup(env({ account_state: [old] }));
    expect((await applyImport(db, backup, { entities: ['account_state'], singleton: { settings: 'replace' } })).replaced).toBe(1);
    const a = (await db.account.get('account'))!;
    expect(a.settings.units.weight).toBe('lb');
    expect(a.settings.language).toBe('is');
  });

  it('adds an old backup without a language as English on a fresh device', async () => {
    const db = await fresh();
    const old = defaultAccountState() as unknown as { settings: Record<string, unknown> };
    delete old.settings.language;
    expect((await applyImport(db, parseBackup(env({ account_state: [old] })), ['account_state'])).added).toBe(1);
    expect((await db.account.get('account'))!.settings.language).toBe('en');
  });

  it('normalizes an unknown language value to en instead of rejecting the backup', async () => {
    const db = await fresh();
    const future = defaultAccountState() as unknown as { settings: Record<string, unknown> };
    future.settings.language = 'fo';
    const backup = parseBackup(env({ account_state: [future] }));
    expect((await previewImport(db, backup)).rows[0]).toMatchObject({ entity: 'account_state', newCount: 1 });
    expect((await applyImport(db, backup, ['account_state'])).added).toBe(1);
    expect((await db.account.get('account'))!.settings.language).toBe('en');
  });
});

describe('Icelandic backup copy', () => {
  it('validation errors, labels and import notes use the approved Icelandic', async () => {
    setLanguage('is');
    expect(() => parseBackup('   ')).toThrow('Þessi skrá er tóm.');
    expect(() => parseBackup('{"a":1}')).toThrow('Þetta virðist ekki vera Hard Earned-öryggisafrit.');
    expect(ENTITY_LABELS.sessions).toBe('Æfingar');
    expect(SINGLETON_PARTS[0].label).toBe('Stillingar forrits (mælieiningar, hvíldartímamælir, deiling og tilkynningar)');
    // Count-neutral Icelandic, also for 1 and 21 (no English count === 1 wording).
    expect(countText('settings.backupProgramsInactive', 1, 'unused')).toBe('Æfingaáætlanir fluttar inn sem óvirkar: 1. Önnur áætlun er þegar virk.');
    expect(countText('settings.backupProgramsInactive', 21, 'unused')).toBe('Æfingaáætlanir fluttar inn sem óvirkar: 21. Önnur áætlun er þegar virk.');
    setLanguage('en');
    expect(ENTITY_LABELS.sessions).toBe('Workouts');
    expect(countText('settings.backupProgramsInactive', 1, '1 program added as inactive because another program is active.')).toBe('1 program added as inactive because another program is active.');
    expect(countText('settings.backupProgramsInactive', 2, 'unused')).toBe('2 programs added as inactive because another program is active.');
  });

  it('adds "nothing was changed" from a typed error state, never twice', () => {
    setLanguage('is');
    const saysIt = new BackupValidationError(t('validation.backupInvalidRecords'), [], 'invalid_records');
    expect(restoreErrorText(saysIt)).toBe('Ekki er hægt að flytja þetta öryggisafrit inn því sumar skráningar eru ógildar. Ekkert var flutt inn.');
    const other = new BackupValidationError(t('validation.backupUnrecognized'), [], 'unrecognized');
    expect(restoreErrorText(other)).toBe('Þetta virðist ekki vera Hard Earned-öryggisafrit. Engu var breytt.');
    // A raw, unknown error message is never shown.
    expect(restoreErrorText(new Error('QuotaExceededError: internal'))).toBe('Innflutningurinn fór ekki fram. Engu var breytt.');
    setLanguage('en');
    expect(restoreErrorText(new BackupValidationError(t('settings.backupImportFailed'), [], 'import_failed'))).toBe('The import didn’t run. Nothing was changed.');
  });
});
