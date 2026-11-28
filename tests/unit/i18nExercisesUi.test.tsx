// @vitest-environment jsdom
/**
 * Icelandic exercise library / detail and Install page: chrome comes from the dictionary and catalog text (name,
 * aliases, setup, execution, mistakes) is shown through the catalogText helpers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/state/app', async () => {
  const { defaultAccountState } = await import('@/state/defaults');
  const account = defaultAccountState();
  return { useApp: () => ({ db: {}, account, updateAccount: async () => {} }) };
});
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));
vi.mock('@/features/train/hooks', () => ({ useSubstitutionConstraints: () => undefined }));
vi.mock('@/features/exercises/useExerciseData', () => ({
  useFavoriteExercises: () => ({ ids: [], isFav: () => false, toggle: async () => {} }),
  useRecentExerciseIds: () => [],
  useExerciseHistory: () => [],
  useExerciseUsageCount: () => undefined,
  formatLoggedSet: () => '',
}));
vi.mock('@/data/catalog', async () => {
  const actual = await vi.importActual<typeof import('@/data/catalog')>('@/data/catalog');
  const { EXERCISES } = await import('@/data/exercises');
  const byId = new Map(EXERCISES.map((e) => [e.id, e]));
  return { ...actual, useExercises: () => ({ list: EXERCISES, byId, get: (id: string) => byId.get(id) }) };
});

import { ToastProvider } from '@/components/toast';
import ExerciseDetailPage from '@/features/exercises/ExerciseDetailPage';
import ExerciseLibraryPage from '@/features/exercises/ExerciseLibraryPage';
import InstallPage from '@/features/settings/InstallPage';
import { EXERCISES } from '@/data/exercises';
import { exerciseAliases, exerciseDisplayName, exerciseSetup } from '@/data/catalogText';
import { LanguageProvider, listText, setLanguage, t } from '@/i18n';

let root: Root | null = null;
let el: HTMLElement | null = null;

async function render(path: string, url: string, page: () => React.ReactElement | null) {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  const routes = createElement(Routes, null, createElement(Route, { path, element: createElement(page) }));
  await act(async () =>
    root!.render(createElement(LanguageProvider, { language: 'is', children: createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [url] }, routes)) })),
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

describe('Icelandic exercise screens', () => {
  it('detail page shows Icelandic chrome and translated catalog text', async () => {
    setLanguage('is');
    const ex = EXERCISES.find((e) => e.id === 'assisted-pull-up')!;
    await render('/train/exercises/:id', `/train/exercises/${ex.id}`, ExerciseDetailPage);
    const body = text();
    expect(body).toContain(exerciseDisplayName(ex, undefined, 'is'));
    expect(body).toContain(t('exercise.detail.also_called', { names: listText(exerciseAliases(ex, 'is'), 'is') }, 'is'));
    expect(body).toContain('Einnig kallað');
    expect(body).toContain('Uppsetning');
    expect(body).toContain('Nýlegar lotur þínar');
    expect(body).toContain(exerciseSetup(ex, 'is'));
    expect(body).not.toContain('Your recent sets');
    expect(body).not.toContain('Also called');
  });

  it('library page shows Icelandic tabs and count', async () => {
    setLanguage('is');
    await render('/train/exercises', '/train/exercises', ExerciseLibraryPage);
    const body = text();
    expect(body).toContain('Sérsniðnar');
    expect(body).toContain(`${EXERCISES.length} æfingar`);
    expect(body).not.toContain('New custom exercise');
  });

  it('install page is Icelandic, with inline icons kept in the steps', async () => {
    setLanguage('is');
    await render('/settings/install', '/settings/install', InstallPage);
    const body = text();
    expect(body).toContain('Setja upp appið');
    expect(body).toContain('deilingarhnappinn á tækjastiku Safari');
    expect(body).not.toContain('Installing also makes');
    expect(body).not.toMatch(/\{\{\w+\}\}/);
  });
});
