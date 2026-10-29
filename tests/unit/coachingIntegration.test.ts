/**
 * Integration glue between the coaching slices (MOCKED — no server):
 *  - domain/program/proposals.ts: the shared accept rules (stale versions, coach-managed plans, one active plan,
 *    history untouched) used by both the coach and AI flows — requirements §10 (7) and (10)
 *  - AI proposal response queue drops permanent refusals instead of retrying forever
 *  - coaching notifications: wording carries no message text; links go to the right side
 *  - "managed by" labels
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiftDb } from '@/db/db';
import { kvGet } from '@/db/repo';
import { createProgram, currentVersion, withNewVersion } from '@/domain/program/program';
import { activeProgram, applyProposal, describeChanges, takeOverPlan, validateProposedProgram } from '@/domain/program/proposals';
import type { ProgramProposal, ProposedProgram } from '@/backend/coachingContract';
import { COACHING_NOTIFICATION_TYPES, type AppNotification, type Program, type ProgramVersion, type SessionTemplate } from '@/domain/types';
import { AI_ACK_QUEUE_KEY, type QueuedAck } from '@/features/coaching/ai/model';
import { flushAcks, isPermanentRefusal, respondOrQueue } from '@/features/coaching/ai/apply';
import { describeNotification, linkFor } from '@/features/social/NotificationsPage';
import { allNotificationTypesEnabled, enabledNotificationTypes } from '@/features/social/useUnreadCount';
import { planOwnerText } from '@/features/program/PlanOwner';

vi.mock('@/backend/social', () => ({ socialApi: {} }));

const CATALOG = new Set(['barbell-back-squat', 'barbell-front-squat', 'goblet-squat']);
const TODAY = '2026-10-29';

function template(id: string, exerciseId = 'barbell-back-squat', sets = 3): SessionTemplate {
  return {
    id,
    name: `Session ${id}`,
    focus: 'Full body',
    kind: 'lifting',
    estimatedMinutes: 45,
    exercises: [{ id: `${id}-1`, exerciseId, sets, repMin: 5, repMax: 8, targetRir: 2, restSec: 120, warmup: '', priority: 1, alternatives: [] }],
  };
}
function version(templates: SessionTemplate[]): ProgramVersion {
  return {
    version: 1,
    createdAt: Date.now(),
    reason: 'test',
    templates,
    schedule: templates.map((t, i) => ({ weekday: i + 1, templateId: t.id })),
    weeks: 8,
    reviewWeek: 8,
    rationale: [],
    warnings: [],
  };
}
function proposed(templates: SessionTemplate[], name = 'Coach plan'): ProposedProgram {
  const { version: _v, createdAt: _c, ...rest } = version(templates);
  void _v;
  void _c;
  return { ...rest, name };
}
function proposal(over: Partial<ProgramProposal>): ProgramProposal {
  return {
    id: 'prop-1',
    authorKind: 'coach',
    relationshipId: 'rel-1',
    coachId: 'coach-1',
    clientId: 'client-1',
    status: 'sent',
    baseProgramId: null,
    baseVersion: null,
    revision: 1,
    program: proposed([template('a')]),
    changeSummary: ['Adds a squat day'],
    target: 'apply',
    createdAt: new Date().toISOString(),
    ...over,
  };
}
const selfPlan = (): Program => createProgram(null, version([template('a')]), TODAY, 'My plan', 'manual');

describe('applyProposal (shared coach + AI accept rules)', () => {
  it('a new coach plan becomes the single active plan; the old one is kept, inactive', () => {
    const mine = selfPlan();
    const r = applyProposal(proposal({}), [mine], { today: TODAY, catalog: CATALOG, coachName: 'Ada' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.createdNew).toBe(true);
    expect(r.program.active).toBe(true);
    expect(r.program.managedBy).toMatchObject({ kind: 'coach', relationshipId: 'rel-1', coachName: 'Ada', proposalId: 'prop-1' });
    expect(r.deactivated.map((p) => [p.id, p.active])).toEqual([[mine.id, false]]);
    expect(activeProgram([r.program, ...r.deactivated])?.id).toBe(r.program.id);
  });

  it('a revision appends a version and keeps earlier versions (history is never rewritten)', () => {
    const base = { ...selfPlan(), managedBy: { kind: 'coach' as const, relationshipId: 'rel-1' } };
    const r = applyProposal(
      proposal({ baseProgramId: base.id, baseVersion: base.currentVersion, program: proposed([template('a', 'goblet-squat', 4)]) }),
      [base],
      { today: TODAY, catalog: CATALOG },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.program.id).toBe(base.id);
    expect(r.program.currentVersion).toBe(base.currentVersion + 1);
    expect(r.program.versions).toHaveLength(base.versions.length + 1);
    expect(r.program.versions[0]).toEqual(base.versions[0]);
    expect(currentVersion(r.program).templates[0]!.exercises[0]!.exerciseId).toBe('goblet-squat');
  });

  it('rejects a stale proposal written against an older version', () => {
    const base = selfPlan();
    const edited = withNewVersion(base, { ...currentVersion(base), reason: 'my own edit' });
    const r = applyProposal(proposal({ baseProgramId: base.id, baseVersion: 1 }), [edited], { today: TODAY, catalog: CATALOG });
    expect(r).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('an AI proposal cannot replace or revise a coach-managed plan without an explicit switch', () => {
    const coachPlan = { ...selfPlan(), managedBy: { kind: 'coach' as const, relationshipId: 'rel-1' } };
    const ai = proposal({ authorKind: 'ai', relationshipId: null, coachId: null });
    expect(applyProposal(ai, [coachPlan], { today: TODAY, catalog: CATALOG })).toMatchObject({ ok: false, reason: 'coach_managed' });
    const revise = proposal({ authorKind: 'ai', baseProgramId: coachPlan.id, baseVersion: 1 });
    expect(applyProposal(revise, [coachPlan], { today: TODAY, catalog: CATALOG })).toMatchObject({ ok: false, reason: 'coach_managed' });
    const switched = applyProposal(ai, [coachPlan], { today: TODAY, catalog: CATALOG, switchFromCoach: true });
    expect(switched.ok).toBe(true);
    if (switched.ok) expect(switched.program.managedBy?.kind).toBe('ai');
  });

  it('a "for coach review" suggestion never applies; invalid content never applies', () => {
    expect(applyProposal(proposal({ authorKind: 'ai', target: 'for_coach_review' }), [], { today: TODAY, catalog: CATALOG })).toMatchObject({
      ok: false,
      reason: 'not_applicable',
    });
    const bad = proposal({ program: proposed([template('a', 'made-up-exercise')]) });
    expect(applyProposal(bad, [], { today: TODAY, catalog: CATALOG })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('validation catches unknown exercises, bad ranges and broken schedules', () => {
    const p = proposed([template('a', 'nope', 0)]);
    p.schedule = [
      { weekday: 1, templateId: 'a' },
      { weekday: 1, templateId: 'missing' },
    ];
    const errs = validateProposedProgram(p, CATALOG).join(' | ');
    expect(errs).toMatch(/Unknown exercise "nope"/);
    expect(errs).toMatch(/Sets must be 1–10/);
    expect(errs).toMatch(/same weekday/);
    expect(errs).toMatch(/does not exist/);
  });

  it('describeChanges lists what a revision changes', () => {
    const base = version([template('a')]);
    const next = proposed([template('a', 'goblet-squat', 4), template('b')]);
    const out = describeChanges(base, next, (id) => id);
    expect(out).toContain('Adds session "Session b".');
    expect(out.some((l) => l.includes('swaps barbell-back-squat for goblet-squat'))).toBe(true);
    expect(out.some((l) => l.includes('3×5–8 → 4×5–8'))).toBe(true);
  });

  it('takeOverPlan makes the plan self-managed as a new version with the same content', () => {
    const coachPlan = { ...selfPlan(), managedBy: { kind: 'coach' as const } };
    const mine = takeOverPlan(coachPlan);
    expect(mine.managedBy).toEqual({ kind: 'self' });
    expect(mine.currentVersion).toBe(2);
    expect(currentVersion(mine).templates).toEqual(currentVersion(coachPlan).templates);
  });
});

describe('AI proposal response queue', () => {
  const dbs: LiftDb[] = [];
  const fresh = () => {
    const d = new LiftDb(`integ-${dbs.length}-${Date.now()}`);
    dbs.push(d);
    return d;
  };
  afterEach(async () => {
    for (const d of dbs.splice(0)) {
      d.close();
      await d.delete();
    }
  });
  const refusal = (reason: string) => Object.assign(new Error('refused'), { code: 'P0001', reason });
  const network = () => Object.assign(new Error('offline'), { code: 'network', reason: 'offline' });

  it('classifies permanent refusals vs transient failures', () => {
    for (const r of ['stale', 'not_open', 'not_found', 'not_applicable']) expect(isPermanentRefusal(refusal(r))).toBe(true);
    expect(isPermanentRefusal({ code: '22023' })).toBe(true);
    expect(isPermanentRefusal(network())).toBe(false);
    expect(isPermanentRefusal({ code: '500', status: 503 })).toBe(false);
  });

  it('queues a response only when the failure is transient, and flush drops permanent refusals', async () => {
    const db = fresh();
    const ack: QueuedAck = { id: 'p1', accept: true, applied: { programId: 'x', version: 2 } };
    expect(await respondOrQueue(db, async () => Promise.reject(refusal('stale')), ack)).toBe(false);
    expect((await kvGet<QueuedAck[]>(AI_ACK_QUEUE_KEY, db)) ?? []).toEqual([]);

    expect(await respondOrQueue(db, async () => Promise.reject(network()), ack)).toBe(false);
    expect(await kvGet<QueuedAck[]>(AI_ACK_QUEUE_KEY, db)).toHaveLength(1);

    // Next attempt: server now says the suggestion is no longer open → dropped, not retried.
    expect(await flushAcks(db, async () => Promise.reject(refusal('not_open')))).toBe(0);
    expect(await kvGet<QueuedAck[]>(AI_ACK_QUEUE_KEY, db)).toEqual([]);
  });

  it('flush keeps transient failures (bounded) and clears on success', async () => {
    const db = fresh();
    await respondOrQueue(db, async () => Promise.reject(network()), { id: 'p2', accept: false });
    expect(await flushAcks(db, async () => Promise.reject(network()))).toBe(1);
    const respond = vi.fn(async () => {});
    expect(await flushAcks(db, respond)).toBe(0);
    expect(respond).toHaveBeenCalledWith('p2', false, undefined);
  });
});

describe('coaching notifications', () => {
  const base = (type: AppNotification['type'], over: Partial<AppNotification> = {}): AppNotification => ({
    id: 'n1',
    type,
    actor: { id: 'u2', username: 'ada', displayName: 'Ada', avatarUrl: null },
    createdAt: new Date().toISOString(),
    ...over,
  });

  it('every coaching type has wording and a link, and never includes message content', () => {
    for (const t of COACHING_NOTIFICATION_TYPES) {
      const n = base(t, { relationshipId: 'rel-1', coachId: 'coach-1', proposalId: 'prop-1' });
      const d = describeNotification(n, 'client-1');
      expect(d.text.length).toBeGreaterThan(5);
      expect(linkFor(n, 'client-1')).toMatch(/^\/coaching/);
      expect(Object.keys(n)).not.toContain('body');
    }
  });

  it('routes two-sided notifications to the right side', () => {
    const checkin = base('coach_checkin', { relationshipId: 'rel-1', coachId: 'coach-1' });
    expect(linkFor(checkin, 'coach-1')).toBe('/coaching/client/rel-1');
    expect(linkFor(checkin, 'client-1')).toBe('/coaching/checkin/rel-1');
    const app = base('coach_application', { coachId: 'coach-1' });
    expect(linkFor(app, 'coach-1')).toBe('/coaching/apply');
    expect(linkFor(app, 'admin-1')).toBe('/coaching/admin/coach-1');
    expect(describeNotification(app, 'coach-1').who).toBeNull(); // reviewer identity isn't shown to the applicant
    expect(linkFor(base('coach_message', { relationshipId: 'rel-9' }), 'x')).toBe('/coaching/messages/rel-9');
    expect(linkFor(base('coach_proposal', { proposalId: 'prop-7' }), 'x')).toBe('/coaching/proposal/prop-7');
  });

  it('coaching notifications are on by default and can be turned off', () => {
    const prefs = { friendRequests: true, likes: true, comments: true };
    expect(enabledNotificationTypes(prefs)).toContain('coach_message');
    expect(allNotificationTypesEnabled(prefs)).toBe(true);
    const off = { ...prefs, coaching: false };
    expect(enabledNotificationTypes(off)).not.toContain('coach_message');
    expect(allNotificationTypesEnabled(off)).toBe(false);
  });
});

describe('plan owner label', () => {
  it('describes coach and AI plans and stays silent for self-managed ones', () => {
    expect(planOwnerText({ managedBy: { kind: 'coach', coachName: 'Ada' } })).toBe('Managed by your coach, Ada');
    expect(planOwnerText({ managedBy: { kind: 'ai' } })).toMatch(/AI-suggested/);
    expect(planOwnerText({ managedBy: { kind: 'self' } })).toBeNull();
    expect(planOwnerText({})).toBeNull();
  });
});
