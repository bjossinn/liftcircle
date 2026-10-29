// @vitest-environment jsdom
/**
 * Coach tools: coach-message outbox state machine (mocked coachingApi), local proposal acceptance via
 * applyProposal (real Dexie through fake-indexeddb), and permission-aware dashboard panels.
 * These are mocked integration tests — no live backend is involved.
 *
 * @testing-library/dom (peer of @testing-library/react) isn't installed, so rendering uses
 * react-dom/client + act directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { ClientOverview, CoachMessage, CoachingRelationship, ProgramProposal, ProposedProgram } from '@/backend/coachingContract';
import type { Program, WorkoutSession } from '@/domain/types';

/* ---------------------------------------------------------------- coachingApi mock */
const api = vi.hoisted(() => {
  const state = {
    messages: new Map<string, CoachMessage>(),
    seq: 0,
    relStatus: 'active' as 'active' | 'ended' | 'requested',
    coachSuspended: false,
    failSendOnceAfterPersist: false,
    failSendNetworkOnce: false,
  };
  const rel = (): CoachingRelationship => ({
    id: 'rel-1',
    coachId: 'coach-1',
    clientId: 'user-1',
    coach: { userId: 'coach-1', displayName: 'Coach Kári', photoUrl: null, suspended: state.coachSuspended, approved: true },
    client: { userId: 'user-1', displayName: 'Ana' },
    status: state.relStatus,
    intake: {},
    introMessage: '',
    scopes: { training: true, measurements: false, nutrition: false, checkins: true },
    requestedAt: '2026-10-01T10:00:00Z',
    unread: 0,
    viewerIsCoach: false,
  });
  const coachingApi = {
    myRelationships: vi.fn(async () => [rel()]),
    sendMessage: vi.fn(async (input: { id: string; relationshipId: string; body: string; mediaIds?: string[] }) => {
      if (state.failSendNetworkOnce) {
        state.failSendNetworkOnce = false;
        throw new Error('Failed to fetch');
      }
      // Idempotent on id, like send_coach_message: an existing id returns the existing row.
      let m = state.messages.get(input.id);
      if (!m) {
        m = { id: input.id, relationshipId: input.relationshipId, senderId: 'user-1', body: input.body, media: [], status: 'sent', seq: ++state.seq, createdAt: new Date().toISOString() };
        state.messages.set(input.id, m);
      }
      if (state.failSendOnceAfterPersist) {
        state.failSendOnceAfterPersist = false;
        throw new Error('The server had a problem'); // persisted, but the response was lost
      }
      return m;
    }),
    uploadMessageMedia: vi.fn(async () => {}),
  };
  return { state, coachingApi };
});
vi.mock('@/backend/coaching', () => ({ coachingApi: api.coachingApi }));
vi.mock('@/backend/social', () => ({ socialApi: {} }));

import { LiftDb } from '@/db/db';
import { discardCoachMessage, outboxStatusLabel, processCoachOutbox, queueCoachMessage, retryCoachMessage } from '@/coaching/outbox';
import { acceptProposalLocally } from '@/coaching/acceptProposal';
import { moveSessions } from '@/coaching/programDraft';
import { createProgram } from '@/domain/program/program';
import { EXERCISES } from '@/data/exercises';
import { ClientCard, TrainingSummary } from '@/features/coaching/tools/coach';
import { Panel } from '@/features/coaching/tools/common';

/* ---------------------------------------------------------------- helpers */
let onLine = true;
Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => onLine });

let dbs: LiftDb[] = [];
let n = 0;
function freshDb(account: string) {
  const db = new LiftDb(`${account}-${++n}`);
  dbs.push(db);
  return db;
}

beforeEach(() => {
  onLine = true;
  api.state.messages.clear();
  api.state.seq = 0;
  api.state.relStatus = 'active';
  api.state.coachSuspended = false;
  api.state.failSendOnceAfterPersist = false;
  api.state.failSendNetworkOnce = false;
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const d of dbs) {
    d.close();
    await d.delete();
  }
  dbs = [];
});

/* ================================================================ outbox */
describe('coach message outbox', () => {
  it('queues offline and sends on reconnect; only then is it gone from the outbox', async () => {
    const db = freshDb('user-1');
    onLine = false;
    await queueCoachMessage({ id: 'm1', relationshipId: 'rel-1', body: 'Hi coach' }, db);
    await processCoachOutbox(db, { accountId: db.accountKey });
    expect(api.coachingApi.sendMessage).not.toHaveBeenCalled();
    const row = await db.coachOutbox.get('m1');
    expect(row?.status).toBe('queued');
    expect(outboxStatusLabel(row!, false)).toBe('Queued — will send when you’re back online');

    onLine = true;
    await processCoachOutbox(db, { accountId: db.accountKey });
    expect(api.coachingApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.coachingApi.sendMessage.mock.calls[0][0]).toMatchObject({ id: 'm1', relationshipId: 'rel-1', body: 'Hi coach' });
    expect(await db.coachOutbox.count()).toBe(0);
    expect([...api.state.messages.values()].map((m) => m.body)).toEqual(['Hi coach']);
  });

  it('a network failure keeps it queued; a later pass sends it', async () => {
    const db = freshDb('user-1');
    api.state.failSendNetworkOnce = true;
    await queueCoachMessage({ id: 'm-net', relationshipId: 'rel-1', body: 'Flaky' }, db);
    await processCoachOutbox(db, { accountId: db.accountKey });
    expect((await db.coachOutbox.get('m-net'))?.status).toBe('queued');
    await processCoachOutbox(db, { accountId: db.accountKey });
    expect(await db.coachOutbox.count()).toBe(0);
    expect(api.state.messages.size).toBe(1);
  });

  it('retry reuses the same id and never duplicates the message', async () => {
    const db = freshDb('user-1');
    api.state.failSendOnceAfterPersist = true;
    await queueCoachMessage({ id: 'm2', relationshipId: 'rel-1', body: 'Did this arrive?' }, db);
    // Same id queued twice (double tap) is a no-op.
    await queueCoachMessage({ id: 'm2', relationshipId: 'rel-1', body: 'Did this arrive?' }, db);
    expect(await db.coachOutbox.count()).toBe(1);

    await processCoachOutbox(db, { accountId: db.accountKey });
    const failed = await db.coachOutbox.get('m2');
    expect(failed?.status).toBe('failed');
    expect(outboxStatusLabel(failed!, true)).toBe('Failed — Retry');

    await retryCoachMessage('m2', db, db.accountKey);
    expect(api.coachingApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.coachingApi.sendMessage.mock.calls.map((c) => c[0].id)).toEqual(['m2', 'm2']);
    expect(api.state.messages.size).toBe(1);
    expect(await db.coachOutbox.count()).toBe(0);
  });

  it('relationship ended before sending → failed with an explanation, no send call, text kept', async () => {
    const db = freshDb('user-1');
    onLine = false;
    await queueCoachMessage({ id: 'm3', relationshipId: 'rel-1', body: 'Queued while offline' }, db);
    api.state.relStatus = 'ended';
    onLine = true;
    await processCoachOutbox(db, { accountId: db.accountKey });
    expect(api.coachingApi.myRelationships).toHaveBeenCalled();
    expect(api.coachingApi.sendMessage).not.toHaveBeenCalled();
    const row = await db.coachOutbox.get('m3');
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/Coaching has ended/);
    expect(row?.error).toMatch(/copy/);
    expect(row?.body).toBe('Queued while offline');
    await discardCoachMessage('m3', db);
    expect(await db.coachOutbox.count()).toBe(0);
  });

  it('a suspended coach also blocks queued sends', async () => {
    const db = freshDb('user-1');
    api.state.coachSuspended = true;
    await queueCoachMessage({ id: 'm4', relationshipId: 'rel-1', body: 'x' }, db);
    await processCoachOutbox(db, { accountId: db.accountKey });
    expect(api.coachingApi.sendMessage).not.toHaveBeenCalled();
    expect((await db.coachOutbox.get('m4'))?.error).toMatch(/suspended/);
  });

  it('never sends with another account’s credentials', async () => {
    const db = freshDb('user-1');
    await queueCoachMessage({ id: 'm5', relationshipId: 'rel-1', body: 'mine' }, db);
    await processCoachOutbox(db, { accountId: 'someone-else' });
    await processCoachOutbox(db, { accountId: null });
    expect(api.coachingApi.myRelationships).not.toHaveBeenCalled();
    expect(api.coachingApi.sendMessage).not.toHaveBeenCalled();
    expect((await db.coachOutbox.get('m5'))?.status).toBe('queued');
  });
});

/* ================================================================ proposals */
const exId = EXERCISES[0].id;
const catalog = new Set(EXERCISES.map((e) => e.id));
const content = (sets: number): ProposedProgram => ({
  name: 'Coach plan',
  reason: '',
  templates: [
    {
      id: 't1',
      name: 'Full body',
      focus: 'Full body',
      kind: 'lifting',
      estimatedMinutes: 45,
      exercises: [{ id: 't1:0', exerciseId: exId, sets, repMin: 8, repMax: 12, targetRir: 2, restSec: 90, warmup: '', priority: 1, alternatives: [] }],
    },
  ],
  schedule: [{ weekday: 1, templateId: 't1' }],
  weeks: 8,
  reviewWeek: 8,
  rationale: [],
  warnings: [],
  progressionNotes: 'Add a rep each week.',
});
const proposal = (id: string, extra: Partial<ProgramProposal>): ProgramProposal => ({
  id,
  authorKind: 'coach',
  relationshipId: 'rel-1',
  coachId: 'coach-1',
  clientId: 'user-2',
  status: 'sent',
  baseProgramId: null,
  baseVersion: null,
  revision: 1,
  program: content(3),
  changeSummary: [],
  target: 'apply',
  createdAt: '2026-10-20T10:00:00Z',
  ...extra,
});

describe('accepting a program proposal', () => {
  it('new plan becomes the single active program; revision appends a version; stale base rejected; workouts untouched', async () => {
    const db = freshDb('user-2');
    const own: Program = createProgram(null, { ...content(2), version: 1, createdAt: 0 }, '2026-10-01', 'My own plan', 'manual');
    await db.programs.put(own);
    const done: WorkoutSession = {
      id: 'w1', createdAt: 1, updatedAt: 1, name: 'Full body', status: 'completed', programId: own.id, programVersion: 1, templateId: 't1', date: '2026-10-05',
      timeZone: 'UTC', startedAt: 1, endedAt: 2, pausedTotalMs: 0,
      exercises: [{ id: 'e1', exerciseId: exId, order: 0, sets: [{ id: 's1', type: 'normal', weightKg: 60, reps: 10, completed: true }] }],
    };
    await db.sessions.put(done);
    const sessionsBefore = JSON.stringify(await db.sessions.toArray());

    // 1) New plan
    const r1 = await acceptProposalLocally(db, proposal('p1', {}), { today: '2026-10-21', catalog, coachName: 'Coach Kári' });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.createdNew).toBe(true);
    let programs = await db.programs.toArray();
    expect(programs.filter((p) => p.active)).toHaveLength(1);
    const coachPlan = programs.find((p) => p.active)!;
    expect(coachPlan.id).toBe(r1.program.id);
    expect(coachPlan.managedBy).toMatchObject({ kind: 'coach', relationshipId: 'rel-1', coachName: 'Coach Kári', proposalId: 'p1' });
    expect(programs.find((p) => p.id === own.id)?.active).toBe(false);
    expect(await db.outbox.count()).toBeGreaterThanOrEqual(2); // persisted via saveRecord → queued for sync

    // Accepting the same proposal again is a no-op.
    const again = await acceptProposalLocally(db, proposal('p1', {}), { today: '2026-10-21', catalog });
    expect(again.ok && again.alreadyApplied).toBe(true);
    expect((await db.programs.get(coachPlan.id))?.versions).toHaveLength(1);

    // 2) Revision of version 1 → appends version 2
    const r2 = await acceptProposalLocally(db, proposal('p2', { baseProgramId: coachPlan.id, baseVersion: 1, revision: 2, program: content(4) }), { today: '2026-10-22', catalog });
    expect(r2.ok).toBe(true);
    const revised = (await db.programs.get(coachPlan.id))!;
    expect(revised.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(revised.currentVersion).toBe(2);
    expect(revised.versions[0].templates[0].exercises[0].sets).toBe(3); // earlier version untouched
    expect(revised.versions[1].templates[0].exercises[0].sets).toBe(4);
    programs = await db.programs.toArray();
    expect(programs.filter((p) => p.active)).toHaveLength(1);

    // 3) Stale: written for version 1, plan is now version 2
    const r3 = await acceptProposalLocally(db, proposal('p3', { baseProgramId: coachPlan.id, baseVersion: 1, revision: 3, program: content(5) }), { today: '2026-10-23', catalog });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toBe('stale');
    expect((await db.programs.get(coachPlan.id))?.versions).toHaveLength(2);

    // Completed workouts never change.
    expect(JSON.stringify(await db.sessions.toArray())).toBe(sessionsBefore);
  });

  it('rejects content with unknown exercises', async () => {
    const db = freshDb('user-2');
    const bad = content(3);
    bad.templates[0].exercises[0].exerciseId = 'not-a-real-exercise';
    const r = await acceptProposalLocally(db, proposal('p-bad', { program: bad }), { today: '2026-10-21', catalog });
    expect(r.ok).toBe(false);
    expect(await db.programs.count()).toBe(0);
  });
});

describe('missed-session helper', () => {
  it('moves sessions to new weekdays and reports clashes', () => {
    const sched = [
      { weekday: 1, templateId: 'a' },
      { weekday: 3, templateId: 'b' },
    ];
    expect(moveSessions(sched, [2, 3])).toEqual({ schedule: [{ weekday: 2, templateId: 'a' }, { weekday: 3, templateId: 'b' }], clashes: [] });
    expect(moveSessions(sched, [3, 3]).clashes).toEqual([3]);
  });
});

/* ================================================================ dashboard panels */
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
});

const relFor = (): CoachingRelationship => ({
  id: 'rel-9', coachId: 'coach-1', clientId: 'c-9', coach: { userId: 'coach-1', displayName: 'Coach', suspended: false, approved: true },
  client: { userId: 'c-9', displayName: 'Ana' }, status: 'active', intake: {}, introMessage: '', scopes: { training: false, measurements: false, nutrition: false, checkins: false },
  requestedAt: '2026-10-01T00:00:00Z', unread: 2, viewerIsCoach: true,
});
const overviewWith = (training: ClientOverview['training'], checkins: ClientOverview['checkins'] = null): ClientOverview => ({ relationship: relFor(), training, measurements: null, nutrition: null, checkins });

describe('dashboard panels respect sharing', () => {
  it('shows "Not shared" for a null training panel and never the numbers', async () => {
    const el = await render(createElement(ClientCard, { rel: relFor(), overview: overviewWith(null) }));
    expect(el.textContent).toContain('Training not shared by Ana');
    expect(el.textContent).not.toMatch(/planned sessions/);
    expect(el.textContent).toContain('2 unread');
  });

  it('shows adherence when training is shared', async () => {
    const el = await render(
      createElement(ClientCard, {
        rel: relFor(),
        overview: overviewWith({ activeProgram: { id: 'p', name: 'Upper/Lower', currentVersion: 3 }, recentSessions: [], plannedLast28: 4, completedLast28: 3 }, [
          { id: 'ci', relationshipId: 'rel-9', clientId: 'c-9', createdAt: '2026-10-20T00:00:00Z', answers: { energy: 3 } },
        ]),
      }),
    );
    expect(el.textContent).toContain('3 of 4 planned sessions in the last 28 days');
    expect(el.textContent).toContain('Upper/Lower v3');
    expect(el.textContent).toContain('1 check-in to answer');
    expect(el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('3');
  });

  it('generic panels render children only when permitted', async () => {
    const el = await render(
      createElement('div', null, [
        createElement(Panel<number[]>, { key: 'a', value: null, who: 'Ana', what: 'Measurements', children: () => 'SECRET' }),
        createElement(Panel<number[]>, { key: 'b', value: [80], who: 'Ana', what: 'Nutrition', children: (v: number[]) => `shown ${v[0]}` }),
        createElement(TrainingSummary, { key: 'c', training: null, who: 'Ana' }),
      ]),
    );
    expect(el.textContent).toContain('Not shared by Ana. Measurements is visible only if Ana turns on this category');
    expect(el.textContent).not.toContain('SECRET');
    expect(el.textContent).toContain('shown 80');
    expect(el.textContent).toContain('Training not shared by Ana');
  });
});
