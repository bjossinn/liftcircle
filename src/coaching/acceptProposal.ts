/**
 * Client-side acceptance of a program proposal: runs the shared `applyProposal` rules against the
 * programs on this device and persists the result through `saveRecord` (so it flows into Train/Today,
 * the logger and the normal sync). Workouts are separate records and are never read or written here.
 */
import type { Exercise, ID, ISODate, Program } from '@/domain/types';
import type { ProgramProposal } from '@/backend/coachingContract';
import type { LiftDb } from '@/db/db';
import { alive, saveRecord } from '@/db/repo';
import { applyProposal, type ApplyResult } from '@/domain/program/proposals';

export type AcceptLocalResult =
  | { ok: true; program: Program; alreadyApplied: boolean; createdNew: boolean }
  | Extract<ApplyResult, { ok: false }>;

/** The local program produced by this proposal, if it was already applied on this device. */
export function findAppliedProgram(programs: Program[], proposalId: ID): Program | undefined {
  return alive(programs).find((p) => p.managedBy?.proposalId === proposalId);
}

export async function acceptProposalLocally(
  db: LiftDb,
  proposal: ProgramProposal,
  opts: { today: ISODate; catalog: Map<ID, Exercise> | Set<ID>; coachName?: string; switchFromCoach?: boolean },
): Promise<AcceptLocalResult> {
  const programs = await db.programs.toArray();
  // Idempotent: accepting twice (double tap, retry after a failed notify) never appends a second version.
  const existing = findAppliedProgram(programs, proposal.id);
  if (existing) return { ok: true, program: existing, alreadyApplied: true, createdNew: false };

  const r = applyProposal(proposal, programs, opts);
  if (!r.ok) return r;
  let saved = r.program;
  await db.transaction('rw', db.programs, db.outbox, async () => {
    for (const d of r.deactivated) await saveRecord('programs', d, db);
    saved = await saveRecord('programs', r.program, db);
  });
  return { ok: true, program: saved, alreadyApplied: false, createdNew: r.createdNew };
}

/* ---------------------------------------------------------- pending "notify the coach" */
const notifyKey = (proposalId: ID) => `coach-proposal-notify:${proposalId}`;

export interface PendingNotify {
  programId: ID;
  version: number;
}

export async function setPendingNotify(db: LiftDb, proposalId: ID, v: PendingNotify | null): Promise<void> {
  try {
    if (v) await db.kv.put({ key: notifyKey(proposalId), value: v });
    else await db.kv.delete(notifyKey(proposalId));
  } catch {
    /* best-effort */
  }
}

export async function getPendingNotify(db: LiftDb, proposalId: ID): Promise<PendingNotify | null> {
  try {
    return ((await db.kv.get(notifyKey(proposalId)))?.value as PendingNotify | undefined) ?? null;
  } catch {
    return null;
  }
}
