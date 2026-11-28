// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { CoachCard } from '@/backend/coachingContract';
import { setLanguage, t } from '@/i18n';
import { COACH_GOALS, SPECIALTIES, countryName, specialtyLabel } from '@/domain/coaching/options';
import { STATUS_LABELS, formatsText } from '@/domain/coaching/display';
import { QUEUE_TABS, ACTION_COPY, reasonProblem } from '@/domain/coaching/admin';
import { submitProblems, formFromProfile } from '@/domain/coaching/application';
import { REQUEST_BLOCK_TEXT } from '@/domain/coaching/eligibility';
import { distanceText } from '@/domain/coaching/search';

const api = vi.hoisted(() => ({ searchCoaches: vi.fn(), geocode: vi.fn() }));
vi.mock('@/backend/coaching', () => ({ coachingApi: api }));

const fakeApp = vi.hoisted(() => ({
  backendConfigured: true,
  auth: { status: 'signed_in', userId: 'me' },
  online: true,
  account: { settings: { timeZone: 'Atlantic/Reykjavik', units: { weight: 'kg' } }, profile: { displayName: 'Me', limitations: [] } },
}));
vi.mock('@/state/app', async (orig) => ({ ...(await orig<typeof import('@/state/app')>()), useApp: () => fakeApp }));

const card = (over: Partial<CoachCard> = {}): CoachCard => ({
  userId: 'c1',
  displayName: 'Anna Jónsdóttir',
  bio: 'Strength coach',
  specialties: ['powerlifting', 'beginners'],
  goals: ['strength'],
  languages: ['is', 'en'],
  city: 'Reykjavík',
  region: null,
  country: 'IS',
  formats: ['in_person', 'online'],
  acceptingClients: true,
  serviceAreas: [{ id: 'a1', kind: 'city', city: 'Reykjavík', country: 'IS' }],
  match: 'local',
  distanceKm: null,
  ...over,
});

afterEach(() => setLanguage('en'));

describe('coaching directory domain labels follow the language', () => {
  it('keeps stored values and localizes labels', () => {
    setLanguage('is');
    const power = SPECIALTIES.find((o) => o.value === 'powerlifting')!;
    expect(power.label).toBe(t('ui.powerlifting', undefined, 'is'));
    expect(specialtyLabel('fat_loss')).toBe(t('ui.fat_loss', undefined, 'is'));
    expect(specialtyLabel('custom_thing')).toBe('Custom thing'); // unknown slugs: prettified, not translated
    expect(COACH_GOALS.map((o) => o.value)).toEqual(['build_muscle', 'strength', 'lose_fat', 'general_fitness', 'endurance']);
    expect(STATUS_LABELS.approved).toBe('Samþykktur þjálfari');
    expect(formatsText(['in_person', 'online'])).toBe('Í eigin persónu og á netinu');
    expect(QUEUE_TABS[0]!.label).toBe('Innsent');
    expect(ACTION_COPY.suspend.confirm).toBe('Setja þjálfara í bann');
    expect(ACTION_COPY.reject.danger).toBe(true);
    expect(reasonProblem('reject', ' ')).toBe('Bættu við ástæðu. Þjálfarinn sér hana.');
    expect(REQUEST_BLOCK_TEXT.too_many_pending).toContain('3');
    expect(distanceText(23)).toBe('um 25 km í burtu');
    expect(countryName('IS')).toBe('Ísland');
    const errs = submitProblems(formFromProfile(null, { country: '' }));
    expect(errs.specialties).toBe('Veldu að minnsta kosti eina sérgrein.');

    setLanguage('en');
    expect(power.label).toBe('Powerlifting');
    expect(STATUS_LABELS.approved).toBe('Approved coach');
  });
});

describe('FindCoachPage in Icelandic', () => {
  let root: Root | null = null;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    api.searchCoaches.mockReset();
    api.searchCoaches.mockResolvedValue({ items: [card(), card({ userId: 'c2', displayName: 'Online Óli', match: 'remote', serviceAreas: [], city: null })], distanceAvailable: false });
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
  });

  it('renders search UI and results in Icelandic, leaving coach content untouched', async () => {
    setLanguage('is');
    const { default: FindCoachPage } = await import('@/features/coaching/FindCoachPage');
    const router = createMemoryRouter([{ path: '/coaching/find', element: createElement(FindCoachPage) }], { initialEntries: ['/coaching/find?s=1&city=Reykjav%C3%ADk&country=IS&specialty=powerlifting'] });
    root = createRoot(host);
    await act(async () => root!.render(createElement(RouterProvider, { router })));
    for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));

    // Search still sends the stored slug.
    expect(api.searchCoaches.mock.calls[0]![0]).toMatchObject({ city: 'Reykjavík', country: 'IS', specialty: 'powerlifting' });
    const text = host.textContent ?? '';
    expect(text).toContain('Nálægt Reykjavík, Ísland');
    expect(text).toContain(t('coaching.directory.online_coaches', undefined, 'is'));
    expect(text).toContain(t('coaching.hub.listed_coach', undefined, 'is'));
    expect(text).toContain(t('ui.powerlifting', undefined, 'is'));
    expect(text).toContain('2 þjálfarar fundust');
    expect(text).toContain('Anna Jónsdóttir');
    expect(text).not.toContain('Accepting new clients');
    expect(text).not.toContain('Online coaches');
  });
});
