// @vitest-environment jsdom
/**
 * CSV workout import UI (Settings → Data): choosing a Strong/Hevy export shows a preview before anything is written,
 * the weight-unit question appears only when the file doesn't say, importing writes the workouts, a second import of
 * the same file offers nothing new, unsupported files show an error, and the copy is translated (English/Icelandic).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountState } from '@/domain/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ app: null as unknown }));
vi.mock('@/state/app', () => ({ useApp: () => h.app, useDb: () => (h.app as { db: unknown }).db }));

import { ToastProvider } from '@/components/toast';
import { LanguageProvider, setLanguage, type Language } from '@/i18n';
import { defaultAccountState } from '@/state/defaults';
import { LiftDb } from '@/db/db';
import { WorkoutImportSection } from '@/features/import/WorkoutImportSection';

const fixture = (name: string) => readFileSync(join(process.cwd(), 'tests/unit/fixtures/import', name), 'utf8');
let root: Root | null = null;
let el: HTMLElement | null = null;
let db: LiftDb;
let n = 0;

async function render(language: Language = 'en') {
  const account: AccountState = defaultAccountState();
  account.settings = { ...account.settings, language, timeZone: 'UTC', units: { ...account.settings.units, weight: 'kg' } };
  h.app = { account, db, auth: { status: 'signed_out' }, online: true };
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(tree(language)));
}
const tree = (language: Language = 'en') => createElement(ToastProvider, null, createElement(LanguageProvider, { language, children: createElement(WorkoutImportSection) }));

/** Another account becomes the open database (e.g. signed in as B in another tab), without remounting the section. */
async function switchDb(next: LiftDb) {
  h.app = { ...(h.app as object), db: next };
  await act(async () => root!.render(tree()));
}

async function freshDb() {
  const d = new LiftDb(`00000000-eeee-4eee-8eee-0000000000${String(++n).padStart(2, '0')}`);
  await d.delete();
  await d.open();
  return d;
}

const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';
const button = (name: string | RegExp) =>
  [...document.querySelectorAll('button')].find((b) => (typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent ?? ''))) ?? null;

async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
  throw new Error(`Timed out waiting for: ${label}\n${text()}`);
}

async function chooseFile(content: string | File | object, name = 'export.csv') {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = typeof content === 'string' ? new File([content], name, { type: 'text/csv' }) : content;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(async () => {
  db = new LiftDb(`00000000-dddd-4ddd-8ddd-0000000000${String(++n).padStart(2, '0')}`);
  await db.delete();
  await db.open();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  el?.remove();
  root = null;
  setLanguage('en');
  db.close();
});

describe('workout import flow', () => {
  it('previews a Strong file before writing, asks for the unit, then imports once', async () => {
    await render();
    expect(document.querySelector('input[type="file"]')?.getAttribute('aria-label')).toBe('Choose Strong or Hevy CSV file');
    await chooseFile(fixture('strong.csv'));
    await waitFor(() => text().includes('Strong export: 2 workouts · 18 sets'), 'preview');
    expect(text()).toContain('From 15 Jan 2024 to 17 Jan 2024');
    expect(text()).toContain('Matched to your exercises (8)');
    expect(text()).toContain('Bench Press (Barbell) → Barbell bench press');
    expect(text()).toContain('New custom exercises (2)');
    expect(text()).toContain('Landmine Press');
    expect(text()).toContain('2 new workouts will be added.');
    expect(text()).toContain('Includes 2 warm-up sets.');
    expect(text()).toContain('2 rows without usable data were skipped.');
    expect(text()).toContain('Weights in this file are in');
    // Nothing is written by the preview.
    expect(await db.sessions.count()).toBe(0);
    expect(await db.customExercises.count()).toBe(0);

    // Choosing pounds re-plans with converted weights.
    const pounds = [...document.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.trim() === 'Pounds') as HTMLElement;
    await act(async () => pounds.click());
    await waitFor(() => pounds.getAttribute('aria-checked') === 'true', 'pounds selected');
    // Import waits until the preview has been rebuilt for pounds.
    await waitFor(() => !!button('Import 2 workouts') && !button('Import 2 workouts')!.disabled, 'plan rebuilt');

    await act(async () => button('Import 2 workouts')!.click());
    await waitFor(() => text().includes('Imported 2 workouts'), 'toast');
    const sessions = await db.sessions.toArray();
    expect(sessions).toHaveLength(2);
    const bench = sessions.find((s) => s.name === 'Push Day')!.exercises[0].sets[1];
    expect(bench.entered).toEqual({ value: 80, unit: 'lb' });
    expect(await db.customExercises.count()).toBe(2);
    expect(document.querySelector('[data-testid="workout-import-preview"]')).toBeNull();

    // The same file again: nothing new.
    await chooseFile(fixture('strong.csv'));
    await waitFor(() => text().includes('Everything in this file has already been imported.'), 'nothing new');
    expect(text()).toContain('2 workouts were imported before and will be skipped.');
    expect(button(/^Import \d/)).toBeNull();
    await act(async () => button('Close')!.click());
    expect(await db.sessions.count()).toBe(2);
  });

  it('does not ask for the unit when the file states it (Hevy)', async () => {
    await render();
    await chooseFile(fixture('hevy.csv'));
    await waitFor(() => text().includes('Hevy export: 2 workouts'), 'preview');
    expect(text()).not.toContain('Weights in this file are in');
    await act(async () => button('Cancel')!.click());
    expect(document.querySelector('[data-testid="workout-import-preview"]')).toBeNull();
    expect(await db.sessions.count()).toBe(0);
  });

  it('shows a clear error for files that are not Strong or Hevy exports', async () => {
    await render();
    await chooseFile('date,kind,value\n2024-01-01,bodyweight,80');
    await waitFor(() => !!document.querySelector('[role="alert"]'), 'error');
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('This file doesn’t look like a Strong or Hevy CSV export. Nothing was imported.');
    expect(await db.sessions.count()).toBe(0);
  });

  it('renders the preview in Icelandic', async () => {
    await render('is');
    expect(text()).toContain('Velja CSV-skrá…');
    await chooseFile(fixture('hevy.csv'));
    await waitFor(() => text().includes('Útflutningur úr Hevy: 2 æfingar'), 'preview');
    expect(text()).toContain('2 nýjar æfingar bætast við.');
    expect(text()).toContain('Nýjar sérsniðnar æfingar (2)');
    await act(async () => button('Flytja inn 2 æfingar')!.click());
    await waitFor(() => text().includes('2 æfingar fluttar inn'), 'toast');
    expect(await db.sessions.count()).toBe(2);
  });
});

describe('account boundaries', () => {
  it('an open preview from account A is dropped when account B becomes current; nothing is written to either', async () => {
    const a = db;
    await render();
    await chooseFile(fixture('hevy.csv'));
    await waitFor(() => !!button('Import 2 workouts'), 'preview in A');
    const b = await freshDb();
    await switchDb(b);
    expect(document.querySelector('[data-testid="workout-import-preview"]')).toBeNull();
    expect(button(/^Import \d/)).toBeNull();
    // Give any re-plan a chance to run: it must not bring A's file back against B.
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(document.querySelector('[data-testid="workout-import-preview"]')).toBeNull();
    expect(await b.sessions.count()).toBe(0);
    expect(await b.customExercises.count()).toBe(0);
    expect(await b.outbox.count()).toBe(0);
    expect(await a.sessions.count()).toBe(0);
    b.close();
  });

  it('a file still being read when the account changes is discarded, never previewed or imported into B', async () => {
    await render();
    let finish!: (text: string) => void;
    const slow = { name: 'strong.csv', size: 2000, type: 'text/csv', text: () => new Promise<string>((r) => (finish = r)) };
    await chooseFile(slow);
    const b = await freshDb();
    await switchDb(b);
    await act(async () => finish(fixture('strong.csv')));
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(document.querySelector('[data-testid="workout-import-preview"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(await b.sessions.count()).toBe(0);
    expect(await b.customExercises.count()).toBe(0);
    // B can still import its own file normally.
    await chooseFile(fixture('hevy.csv'));
    await waitFor(() => !!button('Import 2 workouts'), 'preview in B');
    await act(async () => button('Import 2 workouts')!.click());
    await waitFor(() => text().includes('Imported 2 workouts'), 'toast');
    expect(await b.sessions.count()).toBe(2);
    expect(await db.sessions.count()).toBe(0);
    b.close();
  });
});

describe('ambiguous slash dates', () => {
  const csv = 'Date,Workout Name,Exercise Name,Set Order,Weight (kg),Reps\n01/02/2024 10:00,A,Squat (Barbell),1,100,5\n03/04/2024 10:00,B,Squat (Barbell),1,100,5';

  it('asks day/month vs month/day and waits for the answer before importing', async () => {
    await render();
    await chooseFile(csv);
    await waitFor(() => text().includes('How are dates written in this file?'), 'question');
    const radios = [...document.querySelectorAll('[role="radio"]')] as HTMLElement[];
    const mdy = radios.find((r) => r.textContent?.includes('Month/day'))!;
    expect(radios.filter((r) => r.textContent?.includes('/')).every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(button('Import 2 workouts')!.disabled).toBe(true);
    expect(text()).not.toContain('From ');
    await act(async () => mdy.click());
    await waitFor(() => text().includes('From 2 Jan 2024 to 4 Mar 2024') && !button('Import 2 workouts')!.disabled, 'month first');
    await act(async () => button('Import 2 workouts')!.click());
    await waitFor(() => text().includes('Imported 2 workouts'), 'toast');
    expect((await db.sessions.toArray()).map((s) => s.date).sort()).toEqual(['2024-01-02', '2024-03-04']);
  });

  it('does not ask when the file proves the order, and rejects files that mix both', async () => {
    await render();
    await chooseFile('Date,Workout Name,Exercise Name,Set Order,Weight (kg),Reps\n01/02/2024 10:00,A,Squat (Barbell),1,100,5\n13/02/2024 10:00,B,Squat (Barbell),1,100,5');
    await waitFor(() => text().includes('From 1 Feb 2024 to 13 Feb 2024'), 'day first');
    expect(text()).not.toContain('How are dates written');
    await chooseFile('Date,Workout Name,Exercise Name,Set Order,Weight (kg),Reps\n13/02/2024 10:00,A,Squat (Barbell),1,100,5\n02/14/2024 10:00,B,Squat (Barbell),1,100,5');
    await waitFor(() => !!document.querySelector('[role="alert"]'), 'error');
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('mixes day/month and month/day dates');
  });
});
