// @vitest-environment jsdom
/**
 * Coaching hub without coach recruitment (roadmap item 3): a regular lifter sees no "Coach on Hard Earned / Apply to
 * be listed" pitch; applicants and approved coaches keep their section, workspace and application links.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { CoachingRelationship, CoachProfile } from '@/backend/coachingContract';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  profile: null as unknown as () => Promise<CoachProfile | null>,
  rels: [] as CoachingRelationship[],
  auth: 'signed_in' as 'signed_in' | 'guest',
}));
vi.mock('@/state/app', () => ({
  useApp: () => ({ backendConfigured: true, auth: { status: h.auth, userId: h.auth === 'signed_in' ? 'me' : undefined }, online: true }),
}));
vi.mock('@/app/TopActions', () => ({ TopActions: () => null }));
vi.mock('@/backend/coaching', () => ({
  coachingApi: {
    myRelationships: async () => h.rels,
    getMyCoachProfile: () => h.profile(),
    myRoles: async () => ({ admin: false }),
  },
}));
vi.mock('@/backend/ai', () => ({ aiApi: { status: async () => ({ available: false, reason: 'not_configured' }), getSettings: async () => null } }));

const CoachingHubPage = (await import('@/features/coaching/CoachingHubPage')).default;

let root: Root;
let el: HTMLDivElement;
const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));
async function waitFor(fn: () => void, tries = 100) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries) throw e;
      await tick();
    }
  }
}
async function mount() {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(createElement(MemoryRouter, null, createElement(CoachingHubPage))));
  await waitFor(() => expect(el.textContent).toContain(h.auth === 'guest' ? 'training assistant' : 'Training assistant'));
  await waitFor(() => expect(el.textContent).not.toMatch(/Loading your coaching|Checking the training assistant/));
  await tick();
}
const retry = () => {
  const b = [...el.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === 'Retry');
  if (!b) throw new Error('no Retry');
  return b;
};
const links = () => [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));

const coach = (over: Partial<CoachProfile>): CoachProfile => ({
  userId: 'me', displayName: 'Coach Me', bio: '', experience: '', specialties: [], goals: [], languages: [], formats: [], acceptingClients: true, listed: true,
  status: 'approved', suspended: false, serviceAreas: [], qualifications: [], ...over,
});

beforeEach(() => {
  h.rels = [];
  h.profile = async () => null;
  h.auth = 'signed_in';
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllEnvs();
});

describe('coaching hub: no coach recruitment for lifters', () => {
  it('a regular lifter sees the training assistant, but no coach pitch or apply link', async () => {
    await mount();
    expect(el.textContent).toContain('Training assistant');
    expect(el.textContent).not.toContain('For coaches');
    expect(el.textContent).not.toContain('Coach on Hard Earned');
    expect(el.textContent).not.toContain('Apply to be listed');
    expect(links()).not.toContain('/coaching/apply');
  });

  it('a failed coach-profile load shows a neutral Retry (no coach pitch, no apply link)', async () => {
    h.profile = async () => {
      throw new Error('network down');
    };
    await mount();
    await waitFor(() => expect(el.textContent).toContain('Some of your coaching details couldn’t load.'));
    expect(el.textContent).not.toContain('For coaches');
    expect(el.textContent).not.toMatch(/coach on hard earned|apply/i);
    expect(links()).not.toContain('/coaching/apply');
    // Retry for a lifter: the notice goes away and nothing else appears.
    h.profile = async () => null;
    await act(async () => retry().click());
    await waitFor(() => expect(el.textContent).not.toContain('couldn’t load'));
    expect(el.textContent).not.toContain('For coaches');
  });

  it('an applicant whose profile fails to load can Retry and gets their application status back', async () => {
    h.profile = async () => {
      throw new Error('network down');
    };
    await mount();
    await waitFor(() => expect(retry()).toBeTruthy());
    h.profile = async () => coach({ status: 'submitted', listed: false });
    await act(async () => retry().click());
    await waitFor(() => expect(el.textContent).toContain('Your coach application'));
    expect(el.textContent).toContain('View application');
  });

  it('an approved coach with no clients whose profile fails to load can Retry and gets the workspace back', async () => {
    h.profile = async () => {
      throw new Error('network down');
    };
    await mount();
    await waitFor(() => expect(retry()).toBeTruthy());
    h.profile = async () => coach({});
    await act(async () => retry().click());
    await waitFor(() => expect(el.textContent).toContain('Your coaching workspace'));
    expect(links()).toContain('/coaching/dashboard');
  });

  it('an approved coach keeps the workspace and profile links', async () => {
    h.profile = async () => coach({});
    await mount();
    await waitFor(() => expect(el.textContent).toContain('For coaches'));
    expect(el.textContent).toContain('Your coaching workspace');
    expect(links()).toEqual(expect.arrayContaining(['/coaching/dashboard', '/coaching/apply']));
  });

  it('an applicant still sees their application status', async () => {
    h.profile = async () => coach({ status: 'submitted', listed: false });
    await mount();
    await waitFor(() => expect(el.textContent).toContain('Your coach application'));
    expect(el.textContent).toContain('View application');
  });

  it('a coach with clients still sees a retry if the coach profile fails to load', async () => {
    h.profile = async () => {
      throw new Error('network down');
    };
    h.rels = [{ id: 'r1', viewerIsCoach: true, status: 'active', coach: { userId: 'me', displayName: 'Coach Me', suspended: false, approved: true }, client: { userId: 'c', displayName: 'Client' }, unread: 0 } as unknown as CoachingRelationship];
    await mount();
    await waitFor(() => expect(el.textContent).toContain('Couldn’t load your coach profile'));
    expect(el.textContent).toContain('For coaches');
  });
});

const rel = (over: Partial<CoachingRelationship> & { status: CoachingRelationship['status'] }): CoachingRelationship =>
  ({
    id: `r-${over.status}`, viewerIsCoach: false, coach: { userId: 'c1', displayName: 'Coach Kim', suspended: false, approved: true }, client: { userId: 'me', displayName: 'Me' },
    unread: 0, requestedAt: '2026-11-01T00:00:00Z', scopes: {}, ...over,
  }) as unknown as CoachingRelationship;
const sectionTitles = () => [...el.querySelectorAll('h2')].map((x) => x.textContent?.trim());

describe('coach marketplace flag (roadmap item 4)', () => {
  it('OFF by default: a lifter with no coach gets an AI-first hub, no My coach card and no Find a coach link', async () => {
    await mount();
    expect(el.textContent).toContain('Start with the training assistant');
    expect(el.textContent).not.toContain('My coach');
    expect(el.textContent).not.toMatch(/look for a( different)? coach|work with a coach|find a coach/i);
    expect(links()).not.toContain('/coaching/find');
    // The assistant leads the page.
    expect(sectionTitles()[0]).toBe('Training assistant');
  });

  it('OFF: a client with an active coach keeps the coach card (messages/workspace via My coach), without marketplace links', async () => {
    h.rels = [rel({ status: 'active', unread: 2 })];
    await mount();
    await waitFor(() => expect(el.textContent).toContain('Coach Kim'));
    expect(el.textContent).toContain('Your coach');
    expect(el.textContent).toContain('2 unread');
    expect(links()).toContain('/coaching/my');
    expect(links()).not.toContain('/coaching/find');
  });

  it('OFF: a pending request still shows, without "look at other coaches" links', async () => {
    h.rels = [rel({ status: 'requested' })];
    await mount();
    await waitFor(() => expect(el.textContent).toContain('Request pending'));
    expect(links()).toContain('/coaching/my');
    expect(links()).not.toContain('/coaching/find');
    expect(el.textContent).not.toContain('Look for a coach');
  });

  it('OFF: someone with only past coaching gets a quiet link to its history (nothing deleted)', async () => {
    h.rels = [rel({ status: 'ended' })];
    await mount();
    await waitFor(() => expect(el.textContent).toContain('Past coaching'));
    expect(links()).toContain('/coaching/my');
    expect(links()).not.toContain('/coaching/find');
  });

  it('OFF: an approved coach with clients keeps the workspace and client counts', async () => {
    h.profile = async () => coach({});
    h.rels = [rel({ status: 'active', viewerIsCoach: true })];
    await mount();
    await waitFor(() => expect(el.textContent).toContain('Your coaching workspace'));
    expect(links()).toEqual(expect.arrayContaining(['/coaching/dashboard', '/coaching/apply']));
    expect(el.textContent).not.toContain('My coach'); // they aren't anyone's client
  });

  it('OFF: a guest sees only the training assistant intro (no human-coach pitch or browse link)', async () => {
    h.auth = 'guest';
    await mount();
    expect(el.textContent).toContain('The training assistant');
    expect(el.textContent).not.toContain('A human coach');
    expect(links()).not.toContain('/coaching/find');
  });

  it('ON via VITE_ENABLE_COACH_MARKETPLACE: My coach leads with "Look for a coach"', async () => {
    vi.stubEnv('VITE_ENABLE_COACH_MARKETPLACE', 'true');
    await mount();
    expect(sectionTitles()[0]).toBe('My coach');
    expect(el.textContent).toContain('Look for a coach');
    expect(links()).toContain('/coaching/find');
  });

  it('ON: a client with an active coach can look for a different coach', async () => {
    vi.stubEnv('VITE_ENABLE_COACH_MARKETPLACE', '1');
    h.rels = [rel({ status: 'active' })];
    await mount();
    await waitFor(() => expect(el.textContent).toContain('Look for a different coach'));
  });

  it('ON: a guest sees both ways to be coached, with a browse link', async () => {
    vi.stubEnv('VITE_ENABLE_COACH_MARKETPLACE', 'on');
    h.auth = 'guest';
    await mount();
    expect(el.textContent).toContain('A human coach');
    expect(links()).toContain('/coaching/find');
  });
});
