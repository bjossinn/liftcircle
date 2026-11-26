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
}));
vi.mock('@/state/app', () => ({
  useApp: () => ({ backendConfigured: true, auth: { status: 'signed_in', userId: 'me' }, online: true }),
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
  await waitFor(() => expect(el.textContent).toContain('Training assistant'));
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
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
});

describe('coaching hub: no coach recruitment for lifters', () => {
  it('a regular lifter sees My coach and the training assistant, but no coach pitch or apply link', async () => {
    await mount();
    expect(el.textContent).toContain('My coach');
    expect(el.textContent).toContain('Look for a coach');
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
