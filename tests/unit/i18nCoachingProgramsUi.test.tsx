// @vitest-environment jsdom
/**
 * Icelandic copy in the human-coaching program screens: client cards, "Not shared" panels, proposal status badges,
 * intake and check-in summaries, the program preview footer and the coach-message outbox status lines.
 * User content (names, program names, check-in answers) is shown as typed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { ClientOverview, CoachingRelationship } from '@/backend/coachingContract';
import { setLanguage } from '@/i18n';
import { CheckInAnswers, IntakeSummary, NotShared, ProposalStatusBadge } from '@/features/coaching/tools/common';
import { ClientCard } from '@/features/coaching/tools/coach';
import { outboxStatusLabel } from '@/coaching/outbox';
import { blankProposed, intakeToAnswers } from '@/coaching/programDraft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function render(el: ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(MemoryRouter, null, el)));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setLanguage('en');
});

const rel: CoachingRelationship = {
  id: 'rel-1', coachId: 'coach-1', clientId: 'c-1', coach: { userId: 'coach-1', displayName: 'Coach', suspended: false, approved: true },
  client: { userId: 'c-1', displayName: 'Ana' }, status: 'active', intake: {}, introMessage: '', scopes: { training: true, measurements: false, nutrition: false, checkins: true },
  requestedAt: '2026-10-01T00:00:00Z', unread: 2, viewerIsCoach: true,
};
const overview: ClientOverview = {
  relationship: rel,
  training: { activeProgram: { id: 'p', name: 'Upper/Lower', currentVersion: 3 }, recentSessions: [], plannedLast28: 4, completedLast28: 3 },
  measurements: null,
  nutrition: null,
  checkins: [{ id: 'ci', relationshipId: 'rel-1', clientId: 'c-1', createdAt: '2026-10-20T00:00:00Z', answers: { energy: 3 } }],
};

describe('coaching program screens in Icelandic', () => {
  it('client card: adherence, unread and open check-ins', async () => {
    setLanguage('is');
    const el = await render(createElement(ClientCard, { rel, overview }));
    expect(el.textContent).toContain('3 af 4 fyrirhuguðum æfingum síðustu 28 daga · Upper/Lower v3');
    expect(el.textContent).toContain('2 ólesið');
    expect(el.textContent).toContain('1 ósvöruð stöðuskýrsla');
    expect(el.textContent).toContain('Skilaboð');
    expect(el.textContent).not.toMatch(/planned sessions|unread|to answer/);
  });

  it('not-shared panel, status badge, intake and check-in answers', async () => {
    setLanguage('is');
    const el = await render(
      createElement('div', null, [
        createElement(NotShared, { key: 'a', who: 'Ana', what: 'Mælingar' }),
        createElement(ProposalStatusBadge, { key: 'b', status: 'sent' }),
        createElement(IntakeSummary, { key: 'c', intake: { goal: 'strength', daysPerWeek: 3, sessionMinutes: 45, preferredFormat: 'online' } }),
        createElement(CheckInAnswers, { key: 'd', c: { ...overview.checkins![0], answers: { energy: 4, wins: 'Nýtt met' } }, unit: 'kg' }),
      ]),
    );
    expect(el.textContent).toContain('Ekki deilt af Ana. Mælingar: aðeins sýnilegt ef Ana virkjar þennan flokk');
    expect(el.textContent).toContain('Bíður svars');
    expect(el.textContent).toContain('Dagar á viku');
    expect(el.textContent).toContain('45 mín.');
    expect(el.textContent).toContain('Á netinu');
    expect(el.textContent).toContain('Orka 4/5');
    expect(el.textContent).toContain('Það sem gekk vel: Nýtt met');
  });

  it('outbox status lines, generator assumptions and default names follow the language', () => {
    setLanguage('is');
    expect(outboxStatusLabel({ status: 'failed' }, true)).toBe('Mistókst: Reyndu aftur');
    expect(outboxStatusLabel({ status: 'queued' }, false)).toBe('Í biðröð: sendist þegar nettenging er komin aftur');
    expect(intakeToAnswers({}, { weight: 'kg', length: 'cm', distance: 'km' } as never).assumed).toContain('3 æfingadögum á viku');
    expect(blankProposed().name).toBe('Ný áætlun');
    setLanguage('en');
    expect(outboxStatusLabel({ status: 'failed' }, true)).toBe('Failed: Retry');
    expect(blankProposed().templates[0].name).toBe('Session A');
  });
});
