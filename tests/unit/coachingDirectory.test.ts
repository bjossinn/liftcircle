// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { CoachCard, CoachingRelationship, CoachProfile } from '@/backend/coachingContract';
import {
  decodeSearch, distanceText, emptySearch, encodeSearch, mergePages, placeLabel, radiusUsable, requestDeviceLocation, roundCoord, searchPoint, splitResults, toCoachSearch,
} from '@/domain/coaching/search';
import { buildIntake, introProblem, prefillIntake, scopeNeeds } from '@/domain/coaching/intake';
import {
  changedApprovedQualifications, documentProblem, emptyArea, formFromProfile, formToInput, safeFileName, submitProblems, validateDraft, type ApplicationForm,
} from '@/domain/coaching/application';
import { requestBlock } from '@/domain/coaching/eligibility';
import { availableActions, reasonProblem } from '@/domain/coaching/admin';
import { countryFromTimeZone, countryName } from '@/domain/coaching/options';

/* ------------------------------------------------------------------ mocks */
const api = vi.hoisted(() => ({
  searchCoaches: vi.fn(),
  geocode: vi.fn(),
  getCoach: vi.fn(),
  myRelationships: vi.fn(),
  myRoles: vi.fn(),
}));
vi.mock('@/backend/coaching', () => ({ coachingApi: api }));

const fakeApp = vi.hoisted(() => ({
  backendConfigured: true,
  auth: { status: 'signed_in', userId: 'me' },
  online: true,
  account: { settings: { timeZone: 'Atlantic/Reykjavik', units: { weight: 'kg' } }, profile: { displayName: 'Me', limitations: [] } },
}));
vi.mock('@/state/app', async (orig) => ({ ...(await orig<typeof import('@/state/app')>()), useApp: () => fakeApp }));

/* ---------------------------------------------------------------- fixtures */
const card = (over: Partial<CoachCard> = {}): CoachCard => ({
  userId: 'c1',
  displayName: 'Anna Jónsdóttir',
  bio: 'Strength coach',
  specialties: ['strength'],
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

const rel = (over: Partial<CoachingRelationship>): CoachingRelationship => ({
  id: 'r1',
  coachId: 'c1',
  clientId: 'me',
  coach: { userId: 'c1', displayName: 'Anna', suspended: false, approved: true },
  client: { userId: 'me', displayName: 'Me' },
  status: 'active',
  intake: {},
  introMessage: 'hi',
  scopes: { training: true, measurements: false, nutrition: false, checkins: false },
  requestedAt: '2026-10-01T10:00:00Z',
  unread: 0,
  viewerIsCoach: false,
  ...over,
});

const goodForm = (): ApplicationForm => ({
  ...formFromProfile(null, { displayName: 'Anna Coach', country: 'IS' }),
  bio: 'I coach strength training for beginners and returning lifters, online and in Reykjavík.',
  specialties: ['strength'],
  languages: ['is'],
  formats: ['online'],
});

/* ================================================================ search */
describe('directory search params', () => {
  it('round-trips state through the URL and omits defaults', () => {
    const s = { ...emptySearch('IS'), searched: true, city: '  Reykjavík ', format: 'online' as const, specialty: 'strength', acceptingOnly: true, radiusKm: 25, pages: 3 };
    const p = encodeSearch(s);
    expect(p.get('city')).toBe('Reykjavík');
    expect(p.has('region')).toBe(false);
    expect(p.has('goal')).toBe(false);
    const back = decodeSearch(new URLSearchParams(p.toString()));
    expect(back).toMatchObject({ searched: true, city: 'Reykjavík', country: 'IS', format: 'online', specialty: 'strength', acceptingOnly: true, radiusKm: 25, pages: 3, place: null });
    expect(encodeSearch(emptySearch()).toString()).toBe('');
  });

  it('sanitizes tampered params instead of throwing', () => {
    const s = decodeSearch(new URLSearchParams('s=1&country=XX&format=teleport&radius=33&lang=english&pages=999&plat=95&plng=10'), 'IS');
    expect(s.country).toBe('');
    expect(s.format).toBe('any');
    expect(s.radiusKm).toBeNull();
    expect(s.language).toBe('');
    expect(s.pages).toBe(10);
    expect(s.place).toBeNull();
  });

  it('uses the default country only when the URL has none', () => {
    expect(decodeSearch(new URLSearchParams(''), 'IS').country).toBe('IS');
    expect(decodeSearch(new URLSearchParams('country=NO'), 'IS').country).toBe('NO');
    expect(countryFromTimeZone('Atlantic/Reykjavik')).toBe('IS');
    expect(countryFromTimeZone('Mars/Olympus')).toBe('');
  });

  it('keeps picked place coordinates (rounded) in the URL but has no field for device coordinates', () => {
    const s = { ...emptySearch(), searched: true, place: { lat: 64.146582, lng: -21.942635, label: 'Reykjavík, Iceland' } };
    const p = encodeSearch(s);
    expect(p.get('plat')).toBe('64.15');
    expect(p.get('plng')).toBe('-21.94');
    expect([...p.keys()]).not.toContain('lat');
  });

  it('builds requests: coordinates rounded, radius only when distance is genuinely available', () => {
    const s = { ...emptySearch('IS'), searched: true, city: 'Akureyri', radiusKm: 50 };
    const point = searchPoint(s, { lat: 65.68834, lng: -18.12624, source: 'device' });
    expect(point).toMatchObject({ lat: 65.69, lng: -18.13 });
    expect(toCoachSearch(s, point, { distanceAvailable: false })).toMatchObject({ city: 'Akureyri', lat: 65.69, lng: -18.13 });
    expect(toCoachSearch(s, point, { distanceAvailable: false }).radiusKm).toBeUndefined();
    expect(toCoachSearch(s, point, { distanceAvailable: true }).radiusKm).toBe(50);
    const noPoint = toCoachSearch(s, null, { distanceAvailable: true });
    expect(noPoint.lat).toBeUndefined();
    expect(noPoint.radiusKm).toBeUndefined();
    expect(radiusUsable(null, true)).toBe(false);
    expect(radiusUsable(point, false)).toBe(false);
    expect(radiusUsable(point, true)).toBe(true);
  });

  it('labels the searched place', () => {
    const s = { ...emptySearch('IS'), city: 'Selfoss' };
    expect(placeLabel(s, null, countryName)).toBe('Selfoss, Iceland');
    expect(placeLabel(s, { lat: 1, lng: 1, source: 'device' }, countryName)).toBe('your location');
  });
});

describe('distance display', () => {
  it('never fabricates a distance', () => {
    expect(distanceText(null)).toBeNull();
    expect(distanceText(undefined)).toBeNull();
    expect(distanceText(NaN)).toBeNull();
    expect(distanceText(-3)).toBeNull();
  });
  it('rounds to an approximate value', () => {
    expect(distanceText(0.4)).toBe('less than 1 km away');
    expect(distanceText(7.4)).toBe('about 7 km away');
    expect(distanceText(23)).toBe('about 25 km away');
    expect(distanceText(143)).toBe('about 140 km away');
  });
  it('splits local and remote matches and de-duplicates pages', () => {
    const { local, remote } = splitResults([card(), card({ userId: 'c2', match: 'remote' })]);
    expect(local.map((c) => c.userId)).toEqual(['c1']);
    expect(remote.map((c) => c.userId)).toEqual(['c2']);
    expect(mergePages([card()], [card(), card({ userId: 'c3' })]).map((c) => c.userId)).toEqual(['c1', 'c3']);
  });
});

describe('geolocation', () => {
  it('rounds coordinates to 2 decimals', async () => {
    expect(roundCoord(64.146582)).toBe(64.15);
    const geo = { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: 64.146582, longitude: -21.942635 } } as GeolocationPosition) };
    await expect(requestDeviceLocation(geo)).resolves.toEqual({ ok: true, point: { lat: 64.15, lng: -21.94, source: 'device' } });
  });

  it('turns a denied permission into a usable manual-search state', async () => {
    const geo = { getCurrentPosition: (_ok: PositionCallback, err?: PositionErrorCallback | null) => err?.({ code: 1 } as GeolocationPositionError) };
    const r = await requestDeviceLocation(geo);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('denied');
      expect(r.message).toMatch(/still search by typing a city or region/);
    }
  });

  it('handles unsupported, timeout and a prompt that never answers', async () => {
    expect((await requestDeviceLocation(undefined)) as { reason?: string }).toMatchObject({ ok: false, reason: 'unsupported' });
    const timeout = { getCurrentPosition: (_o: PositionCallback, e?: PositionErrorCallback | null) => e?.({ code: 3 } as GeolocationPositionError) };
    expect(await requestDeviceLocation(timeout)).toMatchObject({ ok: false, reason: 'timeout' });
    vi.useFakeTimers();
    try {
      const silent = requestDeviceLocation({ getCurrentPosition: () => {} }, 1000);
      await vi.advanceTimersByTimeAsync(3100);
      expect(await silent).toMatchObject({ ok: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ================================================================ intake */
describe('intake builder', () => {
  const profile = { displayName: 'Me', goal: 'strength' as const, experience: 'returning' as const, limitations: ['knee' as const], injuryNotes: 'ACL surgery 2019', age: 41 };
  const inputs = { totalDaysPerWeek: 3, sessionMinutes: 45, equipment: ['barbell' as const, 'rack' as const], goal: 'build_muscle' as const };

  it('prefills from profile and program inputs without private free text', () => {
    const d = prefillIntake(profile, inputs, ['online']);
    expect(d).toMatchObject({ goal: 'strength', experience: 'returning', daysPerWeek: 3, sessionMinutes: 45, limitations: ['knee'], preferredFormat: 'online' });
    const sent = buildIntake(d);
    expect(JSON.stringify(sent)).not.toMatch(/ACL|41/);
    expect(sent).toEqual({ goal: 'strength', experience: 'returning', daysPerWeek: 3, sessionMinutes: 45, equipment: ['barbell', 'rack'], limitations: ['knee'], preferredFormat: 'online' });
  });

  it('omits fields the user removed, even when they have a value', () => {
    const d = prefillIntake(profile, inputs);
    d.kept.limitations = false;
    d.kept.equipment = false;
    d.kept.daysPerWeek = false;
    const sent = buildIntake(d);
    expect(sent).not.toHaveProperty('limitations');
    expect(sent).not.toHaveProperty('equipment');
    expect(sent).not.toHaveProperty('daysPerWeek');
    expect(sent.goal).toBe('strength');
  });

  it('drops empty values, trims notes, clamps numbers, and avoids a duplicate second goal', () => {
    const d = prefillIntake(null, null);
    expect(buildIntake(d)).toEqual({});
    Object.assign(d, { goal: 'strength', secondaryGoal: 'strength', daysPerWeek: 12, notes: '  mornings only  ', equipment: [] });
    d.kept = { ...d.kept, goal: true, secondaryGoal: true, daysPerWeek: true, notes: true, equipment: true };
    expect(buildIntake(d)).toEqual({ goal: 'strength', daysPerWeek: 7, notes: 'mornings only' });
  });

  it('requires an intro message of at most 2000 characters', () => {
    expect(introProblem('   ')).toMatch(/introduction/);
    expect(introProblem('x'.repeat(2001))).toMatch(/2000/);
    expect(introProblem('Hi! I want to get stronger.')).toBeNull();
  });

  it('explains which sharing categories a coach typically needs', () => {
    expect(scopeNeeds({ specialties: ['strength'], goals: [] })).toEqual({ training: 'recommended', measurements: 'optional', nutrition: 'optional', checkins: 'optional' });
    expect(scopeNeeds({ specialties: ['nutrition'], goals: ['lose_fat'] })).toMatchObject({ measurements: 'often_useful', nutrition: 'often_useful' });
  });
});

describe('request eligibility', () => {
  const base = { coachId: 'c1', acceptingClients: true, meId: 'me' };
  it('blocks self, existing coach, pending, not accepting and too many open requests', () => {
    expect(requestBlock({ ...base, meId: 'c1', relationships: [] })).toBe('self');
    expect(requestBlock({ ...base, relationships: [rel({})] })).toBe('already_coach');
    expect(requestBlock({ ...base, relationships: [rel({ status: 'requested' })] })).toBe('pending');
    expect(requestBlock({ ...base, acceptingClients: false, relationships: [] })).toBe('not_accepting');
    const three = ['x', 'y', 'z'].map((c, i) => rel({ id: `r${i}`, coachId: c, status: 'requested' }));
    expect(requestBlock({ ...base, relationships: three })).toBe('too_many_pending');
    expect(requestBlock({ ...base, relationships: [rel({ coachId: 'other' })] })).toBeNull();
    // Being this coach's coach (viewerIsCoach) doesn't block requesting them.
    expect(requestBlock({ ...base, relationships: [rel({ viewerIsCoach: true })] })).toBeNull();
  });
});

/* =========================================================== application */
describe('application validation mirror', () => {
  it('accepts a complete online application', () => {
    expect(submitProblems(goodForm())).toEqual({});
  });

  it('lists every missing submit requirement for an empty draft', () => {
    const errs = submitProblems(formFromProfile(null));
    expect(Object.keys(errs).sort()).toEqual(['bio', 'country', 'displayName', 'formats', 'languages', 'specialties']);
    // …but an empty draft can still be saved.
    expect(validateDraft(formFromProfile(null))).toEqual({});
  });

  it('requires a service area for in-person coaching and validates rows', () => {
    const f = { ...goodForm(), formats: ['in_person' as const] };
    expect(submitProblems(f)).toHaveProperty('serviceAreas');
    const withArea = { ...f, serviceAreas: [{ ...emptyArea('IS'), city: '' }] };
    expect(validateDraft(withArea)).toHaveProperty(['serviceAreas.0.city']);
    const ok = { ...f, serviceAreas: [{ ...emptyArea('IS'), city: 'Hafnarfjörður' }] };
    expect(submitProblems(ok)).toEqual({});
  });

  it('enforces formats and lengths on drafts', () => {
    const f = { ...goodForm(), bio: 'x'.repeat(2001), experienceYears: 3.5, country: 'ZZ', qualifications: [{ id: 'q', title: 'A', issuer: '', year: 2999, documentPath: null, documentName: null }] };
    const errs = validateDraft(f);
    expect(errs).toHaveProperty('bio');
    expect(errs).toHaveProperty('experienceYears');
    expect(errs).toHaveProperty('country');
    expect(errs).toHaveProperty(['qualifications.0.title']);
    expect(errs).toHaveProperty(['qualifications.0.year']);
  });

  it('never sends a radius or label without geocoder coordinates', () => {
    const f = { ...goodForm(), serviceAreas: [{ ...emptyArea('is'), city: 'Vík', radiusKm: 30, label: 'typed' }] };
    const input = formToInput(f);
    expect(input.serviceAreas[0]).toMatchObject({ country: 'IS', city: 'Vík', lat: null, lng: null, radiusKm: null, label: null });
  });

  it('detects edits to reviewed qualifications', () => {
    const profile = {
      ...formToInput(goodForm()),
      userId: 'me', status: 'approved', suspended: false, serviceAreas: [],
      qualifications: [{ id: 'q1', title: 'PT Level 3', issuer: 'REPs', year: 2020, reviewStatus: 'approved' }],
    } as unknown as CoachProfile;
    const f = formFromProfile(profile);
    expect(changedApprovedQualifications(f, profile)).toEqual([]);
    f.qualifications[0]!.year = 2021;
    expect(changedApprovedQualifications(f, profile)).toEqual(['q1']);
  });

  it('checks qualification documents by content and size', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const exe = new Uint8Array([0x4d, 0x5a, 0, 0, 0, 0]);
    expect(documentProblem({ size: 1000, name: 'cert.pdf' }, pdf)).toBeNull();
    expect(documentProblem({ size: 1000, name: 'cert.pdf' }, exe)).toMatch(/PDF, JPG or PNG/);
    expect(documentProblem({ size: 11 * 1024 * 1024, name: 'big.pdf' }, pdf)).toMatch(/10 MB/);
    expect(documentProblem({ size: 0, name: 'x.pdf' }, pdf)).toMatch(/empty/);
    expect(safeFileName('../../Skírteini mitt.PDF', 'pdf')).toBe('Skirteini_mitt.pdf');
  });
});

describe('admin rules', () => {
  it('offers actions that match the current state', () => {
    expect(availableActions({ status: 'submitted', suspended: false })).toEqual(['approve', 'request_changes', 'reject']);
    expect(availableActions({ status: 'approved', suspended: false })).toEqual(['suspend']);
    expect(availableActions({ status: 'approved', suspended: true })).toEqual(['reinstate']);
    expect(availableActions({ status: 'draft', suspended: false })).toEqual([]);
  });
  it('requires reasons for negative actions', () => {
    expect(reasonProblem('request_changes', ' ')).toMatch(/change/);
    expect(reasonProblem('reject', '')).toBeTruthy();
    expect(reasonProblem('suspend', '')).toBeTruthy();
    expect(reasonProblem('approve', '')).toBeNull();
    expect(reasonProblem('suspend', 'Fake credentials')).toBeNull();
  });
});

/* ============================================================ component */
describe('FindCoachPage', () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  const realGeo = Object.getOwnPropertyDescriptor(navigator, 'geolocation');

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    api.searchCoaches.mockReset();
    api.geocode.mockReset();
    api.searchCoaches.mockResolvedValue({ items: [card(), card({ userId: 'c2', displayName: 'Online Óli', match: 'remote', serviceAreas: [], city: null })], distanceAvailable: false });
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
    if (realGeo) Object.defineProperty(navigator, 'geolocation', realGeo);
    else delete (navigator as { geolocation?: unknown }).geolocation;
  });

  const flush = async () => {
    for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  };
  const button = (text: RegExp) => [...host.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
  const click = async (el: Element | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => void el!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
  };
  async function renderAt(url: string) {
    const { default: FindCoachPage } = await import('@/features/coaching/FindCoachPage');
    const router = createMemoryRouter([{ path: '/coaching/find', element: createElement(FindCoachPage) }], { initialEntries: [url] });
    root = createRoot(host);
    await act(async () => root!.render(createElement(RouterProvider, { router })));
    await flush();
    return router;
  }

  it('shows place matches and online coaches without inventing distances', async () => {
    await renderAt('/coaching/find?s=1&city=Reykjav%C3%ADk&country=IS');
    expect(api.searchCoaches).toHaveBeenCalledTimes(1);
    const q = api.searchCoaches.mock.calls[0]![0];
    expect(q).toMatchObject({ city: 'Reykjavík', country: 'IS', offset: 0 });
    expect(q.lat).toBeUndefined();
    const text = host.textContent ?? '';
    expect(text).toContain('Near Reykjavík, Iceland');
    expect(text).toContain('Online coaches');
    expect(text).toContain('Listed coach');
    expect(text).not.toMatch(/km away/);
    expect(text).not.toMatch(/verified|certified/i);
  });

  it('keeps manual search working when location permission is denied', async () => {
    const getCurrentPosition = vi.fn((_ok: PositionCallback, err?: PositionErrorCallback | null) => err?.({ code: 1 } as GeolocationPositionError));
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
    const router = await renderAt('/coaching/find?country=IS');
    // Nothing is requested until the user taps the button.
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(api.searchCoaches).not.toHaveBeenCalled();

    await click(button(/Use my location/));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Location permission was declined');
    expect(api.searchCoaches).not.toHaveBeenCalled();

    const city = [...host.querySelectorAll('label')].find((l) => l.textContent === 'City or town')!;
    const input = host.querySelector<HTMLInputElement>(`#${CSS.escape(city.htmlFor)}`)!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Selfoss');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(/^Search$/));
    expect(api.searchCoaches).toHaveBeenCalledTimes(1);
    expect(api.searchCoaches.mock.calls[0]![0]).toMatchObject({ city: 'Selfoss', country: 'IS' });
    expect(api.searchCoaches.mock.calls[0]![0].lat).toBeUndefined();
    expect(router.state.location.search).toContain('city=Selfoss');
    expect(host.textContent).toContain('Near Selfoss, Iceland');
  });

  it('sends only rounded device coordinates and keeps them out of the URL', async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) => ok({ coords: { latitude: 64.146582, longitude: -21.942635 } } as GeolocationPosition));
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
    const router = await renderAt('/coaching/find?country=IS');
    await click(button(/Use my location/));
    expect(api.searchCoaches).toHaveBeenCalledTimes(1);
    expect(api.searchCoaches.mock.calls[0]![0]).toMatchObject({ lat: 64.15, lng: -21.94 });
    expect(api.searchCoaches.mock.calls[0]![0].radiusKm).toBeUndefined();
    expect(router.state.location.search).not.toMatch(/64\.1|21\.9/);
    // Server said distance isn't available → truthful notice, radius stays disabled.
    expect(host.textContent).toContain('Distance search isn’t available. Showing matches by place.');
    const distance = [...host.querySelectorAll('label')].find((l) => l.textContent === 'Distance')!;
    expect(host.querySelector<HTMLSelectElement>(`#${CSS.escape(distance.htmlFor)}`)!.disabled).toBe(true);
  });
});
