/**
 * Applying an AI proposal on this device, then recording the response on the server.
 * All rules (stale versions, coach-managed plans, validation) come from domain/program/proposals.ts.
 */
import type { ProgramProposal } from '@/backend/coachingContract';
import { kvGet, kvSet, saveRecord } from '@/db/repo';
import type { LiftDb } from '@/db/db';
import { applyProposal, takeOverPlan } from '@/domain/program/proposals';
import type { Exercise, ID, ISODate, Program } from '@/domain/types';
import { AI_ACK_QUEUE_KEY, liveActive, STALE_MESSAGE, type QueuedAck } from './model';

type Respond = (id: ID, accept: boolean, applied?: { programId: ID; version: number }) => Promise<void>;

export type AiApplyOutcome =
  | { ok: true; program: Program; recorded: boolean }
  | { ok: false; reason: 'stale' | 'coach_managed' | 'not_found' | 'invalid' | 'not_applicable'; message: string };

export async function applyAiProposal(args: {
  proposal: ProgramProposal;
  programs: Program[];
  db: LiftDb;
  today: ISODate;
  catalog: Map<ID, Exercise>;
  respond: Respond;
  /** Only true after the user explicitly confirmed leaving their coach-managed plan. */
  switchFromCoach?: boolean;
}): Promise<AiApplyOutcome> {
  const { proposal, programs, db } = args;
  if (proposal.authorKind !== 'ai') return { ok: false, reason: 'not_applicable', message: 'This isn’t an AI suggestion.' };
  const res = applyProposal(proposal, programs, { today: args.today, catalog: args.catalog, switchFromCoach: args.switchFromCoach === true });
  if (!res.ok) return { ok: false, reason: res.reason, message: res.reason === 'stale' ? STALE_MESSAGE : res.message };
  for (const p of res.deactivated) await saveRecord('programs', p, db);
  const saved = await saveRecord('programs', res.program, db);
  const applied = { programId: saved.id, version: saved.currentVersion };
  const recorded = await respondOrQueue(db, args.respond, { id: proposal.id, accept: true, applied });
  return { ok: true, program: saved, recorded };
}

/** Explicit choice: the coach-managed active plan becomes self-managed (new version; workouts untouched). */
export async function switchToSelfManaged(programs: Program[], db: LiftDb): Promise<Program | null> {
  const active = liveActive(programs);
  if (!active || active.managedBy?.kind !== 'coach') return null;
  return saveRecord('programs', takeOverPlan(active), db);
}

/**
 * A refusal the server will give again on every retry (stale plan, suggestion no longer open, wrong plan,
 * invalid arguments). Retrying those forever would be pointless, so they're dropped instead of queued.
 * Network errors, timeouts, 5xx and auth problems are transient and stay queued.
 */
export function isPermanentRefusal(e: unknown): boolean {
  const reason = (e as { reason?: unknown })?.reason;
  if (typeof reason === 'string' && ['stale', 'not_applicable', 'not_found', 'not_open', 'wrong_program'].includes(reason)) return true;
  const code = (e as { code?: unknown })?.code;
  return code === '22023' || code === 'P0001';
}

/** Try to record a response now; queue it locally if the server can't be reached. */
export async function respondOrQueue(db: LiftDb, respond: Respond, ack: QueuedAck): Promise<boolean> {
  try {
    await respond(ack.id, ack.accept, ack.applied);
    return true;
  } catch (e) {
    if (isPermanentRefusal(e)) return false;
    const q = ((await kvGet<QueuedAck[]>(AI_ACK_QUEUE_KEY, db)) ?? []).filter((x) => x.id !== ack.id);
    await kvSet(AI_ACK_QUEUE_KEY, [...q, ack], db);
    return false;
  }
}

/** Retry queued responses (called when the proposals list loads). Returns how many are still queued. */
export async function flushAcks(db: LiftDb, respond: Respond): Promise<number> {
  const q = (await kvGet<QueuedAck[]>(AI_ACK_QUEUE_KEY, db)) ?? [];
  if (!q.length) return 0;
  const left: QueuedAck[] = [];
  for (const a of q) {
    try {
      await respond(a.id, a.accept, a.applied);
    } catch (e) {
      if (isPermanentRefusal(e)) continue;
      // The server may refuse until this device's new plan version has synced; give up after a few tries.
      if ((a.attempts ?? 0) < 5) left.push({ ...a, attempts: (a.attempts ?? 0) + 1 });
    }
  }
  await kvSet(AI_ACK_QUEUE_KEY, left, db);
  return left.length;
}
