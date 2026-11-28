// @vitest-environment jsdom
/** Coaching hub, My coach and relationship helpers in Icelandic: UI text follows the app language, coach content does not. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { CoachingRelationship, CoachProfile } from '@/backend/coachingContract';
import { setLanguage } from '@/i18n';
import { RELATIONSHIP_STATUS_LABEL, SCOPE_INFO, closedExplanation, relationshipWritable, retentionText } from '@/coaching/relationship';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ rels: [] as CoachingRelationship[], profile: null as CoachProfile | null }));
vi.mock('@/state/app', () => ({
  useApp: () => ({ backendConfigured: true, auth: { status: 'signed_in', userId: 'me' }, online: true }),
}));
vi.mock('@/app/TopActions', () => ({ TopActions: () => null }));
vi.mock('@/backend/coaching', () => ({
  coachingApi: {
    myRelationships: async () => h.rels,
    getMyCoachProfile: async () => h.profile,
    myRoles: async () => ({ admin: false }),
  },
}));
vi.mock('@/backend/ai', () => ({ aiApi: { status: async () => ({ available: false, reason: 'offline' }), getSettings: async () => null } }));

const CoachingHubPage = (await import('@/features/coaching/CoachingHubPage')).default;

const rel = (over: Partial<CoachingRelationship> = {}): CoachingRelationship =>
  ({
    id: 'r1', coachId: 'c1', clientId: 'me', status: 'active', viewerIsCoach: false, unread: 3,
    requestedAt: '2026-11-01T10:00:00Z', respondedAt: '2026-11-02T10:00:00Z', endedAt: null, endedBy: null, endReason: null,
    coach: { displayName: 'Anna Coach', photoUrl: null, approved: true, suspended: false },
    client: { displayName: 'Me', avatarUrl: null },
    scopes: { training: true, measurements: false, nutrition: false, checkins: true },
    ...over,
  }) as unknown as CoachingRelationship;

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

beforeEach(() => setLanguage('is'));
afterEach(() => {
  if (root) act(() => root.unmount());
  el?.remove();
  setLanguage('en');
});

describe('coaching hub in Icelandic', () => {
  it('renders hub text in Icelandic and keeps the coach name as is', async () => {
    h.rels = [rel()];
    el = document.createElement('div');
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root.render(createElement(MemoryRouter, null, createElement(CoachingHubPage))));
    await waitFor(() => expect(el.textContent).toContain('Þjálfarinn minn'));
    await waitFor(() => expect(el.textContent).toContain('Æfingaaðstoðin þarf nettengingu.'));
    expect(el.textContent).toContain('Anna Coach');
    expect(el.textContent).toContain('Þjálfarinn þinn');
    expect(el.textContent).toContain('3 ólesin');
    expect(el.textContent).not.toContain('My coach');
    expect(el.textContent).not.toContain('unread');
  });
});

describe('relationship helpers in Icelandic', () => {
  it('translates states, scopes and explanations into whole sentences', () => {
    expect(RELATIONSHIP_STATUS_LABEL.ended).toBe('Lokið');
    expect(SCOPE_INFO.checkins.label).toBe('Stöðuskýrslur');
    expect(retentionText()).toMatch(/^Samtöl sem er lokið/);
    expect(relationshipWritable(rel({ status: 'ended' }))).toEqual({ ok: false, reason: 'Þjálfun er lokið, svo ekki er hægt að senda ný skilaboð.' });
    expect(closedExplanation(rel({ status: 'declined', endReason: 'Fullbókað' }))).toBe(
      'Anna Coach hafnaði beiðninni þinni: “Fullbókað” Þú getur leitað að öðrum þjálfara hvenær sem er.',
    );
    setLanguage('en');
    expect(RELATIONSHIP_STATUS_LABEL.ended).toBe('Ended');
    expect(closedExplanation(rel({ status: 'ended', endedBy: 'c1' }))).toBe(
      'Anna Coach ended coaching. Your workouts and accepted programs stay yours, and the conversation stays readable.',
    );
  });
});
