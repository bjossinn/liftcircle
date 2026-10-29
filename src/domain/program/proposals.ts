/**
 * Applying coach / AI program proposals to the client's own Program records.
 *
 * Rules (enforced here on the client AND re-checked by the server when the response is recorded):
 *  - A proposal that revises an existing program applies only if that program's currentVersion still
 *    equals proposal.baseVersion (no stale overwrite of a newer plan).
 *  - Applying always APPENDS a new ProgramVersion (completed workouts are separate records and untouched).
 *  - Exactly one program stays active; activating a new plan deactivates the others.
 *  - An AI proposal can never replace or revise a coach-managed active plan unless the user explicitly
 *    switches to a self/AI-managed plan (switchFromCoach = true). 'for_coach_review' proposals never apply.
 */
import type { Exercise, ID, ISODate, Program, ProgramVersion, SessionTemplate } from '@/domain/types';
import type { ProgramProposal, ProposedProgram } from '@/backend/coachingContract';
import { createProgram, currentVersion, withNewVersion } from './program';

export type ApplyResult =
  | { ok: true; program: Program; deactivated: Program[]; createdNew: boolean }
  | { ok: false; reason: 'stale' | 'coach_managed' | 'not_found' | 'invalid' | 'not_applicable'; message: string };

export function activeProgram(programs: Program[]): Program | undefined {
  return programs.find((p) => p.active && !p.deletedAt);
}

/** Schema-level validation of proposed program content against the exercise catalog. */
export function validateProposedProgram(p: ProposedProgram, catalog: Map<ID, Exercise> | Set<ID>): string[] {
  const errors: string[] = [];
  const has = (id: ID) => (catalog instanceof Map ? catalog.has(id) : catalog.has(id));
  if (!p.name?.trim()) errors.push('The program needs a name.');
  if (!Array.isArray(p.templates) || p.templates.length === 0) errors.push('The program has no sessions.');
  if (p.templates?.length > 14) errors.push('Too many sessions (max 14).');
  const ids = new Set<string>();
  for (const t of p.templates ?? []) {
    if (!t.id || ids.has(t.id)) errors.push(`Session "${t.name}" has a missing or duplicate id.`);
    ids.add(t.id);
    if (!t.name?.trim()) errors.push('A session is missing its name.');
    if (t.exercises.length > 20) errors.push(`"${t.name}" has too many exercises (max 20).`);
    const slotIds = new Set<string>();
    for (const rx of t.exercises) {
      if (slotIds.has(rx.id)) errors.push(`"${t.name}" has a duplicate exercise slot.`);
      slotIds.add(rx.id);
      if (!has(rx.exerciseId)) errors.push(`Unknown exercise "${rx.exerciseId}" in "${t.name}".`);
      if (!(rx.sets >= 1 && rx.sets <= 10)) errors.push(`Sets must be 1–10 (${rx.exerciseId}).`);
      if (!(rx.repMin >= 1 && rx.repMax <= 100 && rx.repMin <= rx.repMax)) errors.push(`Rep range is invalid (${rx.exerciseId}).`);
      if (!(rx.targetRir >= 0 && rx.targetRir <= 5)) errors.push(`Reps in reserve must be 0–5 (${rx.exerciseId}).`);
      if (!(rx.restSec >= 0 && rx.restSec <= 600)) errors.push(`Rest must be 0–600 s (${rx.exerciseId}).`);
      for (const alt of rx.alternatives ?? []) if (!has(alt)) errors.push(`Unknown substitution "${alt}".`);
    }
  }
  const days = new Set<number>();
  for (const s of p.schedule ?? []) {
    if (!(Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6)) errors.push('Schedule has an invalid weekday.');
    if (days.has(s.weekday)) errors.push('Two sessions are scheduled on the same weekday.');
    days.add(s.weekday);
    if (!ids.has(s.templateId)) errors.push('Schedule refers to a session that does not exist.');
  }
  if (!(p.weeks >= 1 && p.weeks <= 52)) errors.push('Block length must be 1–52 weeks.');
  return [...new Set(errors)];
}

/** Human-readable list of what changes between the base version and the proposal. */
export function describeChanges(base: ProgramVersion | null | undefined, next: ProposedProgram, nameOf: (id: ID) => string): string[] {
  if (!base) return [`New plan: ${next.templates.length} session${next.templates.length === 1 ? '' : 's'} per week over ${next.weeks} weeks.`];
  const out: string[] = [];
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byId = (ts: SessionTemplate[]) => new Map(ts.map((t) => [t.id, t]));
  const a = byId(base.templates);
  const b = byId(next.templates);
  for (const [id, t] of b) if (!a.has(id)) out.push(`Adds session "${t.name}".`);
  for (const [id, t] of a) if (!b.has(id)) out.push(`Removes session "${t.name}".`);
  for (const [id, nt] of b) {
    const ot = a.get(id);
    if (!ot) continue;
    if (ot.name !== nt.name) out.push(`Renames "${ot.name}" to "${nt.name}".`);
    const oEx = new Map(ot.exercises.map((x) => [x.id, x]));
    const nEx = new Map(nt.exercises.map((x) => [x.id, x]));
    for (const [sid, x] of nEx) {
      const o = oEx.get(sid);
      if (!o) out.push(`${nt.name}: adds ${nameOf(x.exerciseId)}.`);
      else {
        if (o.exerciseId !== x.exerciseId) out.push(`${nt.name}: swaps ${nameOf(o.exerciseId)} for ${nameOf(x.exerciseId)}.`);
        if (o.sets !== x.sets || o.repMin !== x.repMin || o.repMax !== x.repMax)
          out.push(`${nt.name}: ${nameOf(x.exerciseId)} ${o.sets}×${o.repMin}–${o.repMax} → ${x.sets}×${x.repMin}–${x.repMax}.`);
        if (o.restSec !== x.restSec) out.push(`${nt.name}: ${nameOf(x.exerciseId)} rest ${o.restSec}s → ${x.restSec}s.`);
        if (o.targetRir !== x.targetRir) out.push(`${nt.name}: ${nameOf(x.exerciseId)} effort ${o.targetRir} → ${x.targetRir} reps in reserve.`);
      }
    }
    for (const [sid, x] of oEx) if (!nEx.has(sid)) out.push(`${nt.name}: removes ${nameOf(x.exerciseId)}.`);
    const oOrder = ot.exercises.map((x) => x.id).filter((i) => nEx.has(i)).join();
    const nOrder = nt.exercises.map((x) => x.id).filter((i) => oEx.has(i)).join();
    if (oOrder !== nOrder) out.push(`${nt.name}: changes exercise order.`);
  }
  const sched = (v: { schedule: { weekday: number; templateId: ID }[] }) =>
    [...v.schedule].sort((x, y) => x.weekday - y.weekday).map((s) => `${day[s.weekday]}:${s.templateId}`).join(',');
  if (sched(base) !== sched(next)) {
    const fmt = (v: { schedule: { weekday: number; templateId: ID }[] }, ts: Map<ID, SessionTemplate>) =>
      [...v.schedule].sort((x, y) => x.weekday - y.weekday).map((s) => `${day[s.weekday]} ${ts.get(s.templateId)?.name ?? '?'}`).join(', ');
    out.push(`Schedule: ${fmt(base, a) || 'none'} → ${fmt(next, b) || 'none'}.`);
  }
  if (base.weeks !== next.weeks) out.push(`Block length ${base.weeks} → ${next.weeks} weeks.`);
  if ((next.progressionNotes ?? '') !== '') out.push('Includes progression instructions.');
  return out.length ? out : ['No changes to sessions or schedule.'];
}

/**
 * Turn an accepted proposal into the client's program state.
 * The caller persists `program` and each of `deactivated` with saveRecord('programs', …).
 */
export function applyProposal(
  proposal: ProgramProposal,
  programs: Program[],
  opts: { today: ISODate; catalog: Map<ID, Exercise> | Set<ID>; switchFromCoach?: boolean; coachName?: string },
): ApplyResult {
  if (proposal.target === 'for_coach_review')
    return { ok: false, reason: 'not_applicable', message: 'This is a suggestion to discuss with your coach, not a plan to apply.' };
  const errors = validateProposedProgram(proposal.program, opts.catalog);
  if (errors.length) return { ok: false, reason: 'invalid', message: errors[0] };

  const live = programs.filter((p) => !p.deletedAt);
  const active = activeProgram(live);
  if (proposal.authorKind === 'ai' && active?.managedBy?.kind === 'coach' && !opts.switchFromCoach) {
    return {
      ok: false,
      reason: 'coach_managed',
      message: 'Your current plan is managed by your coach. Share this suggestion with them, or switch to a self-managed plan first.',
    };
  }

  const managedBy: Program['managedBy'] =
    proposal.authorKind === 'coach'
      ? { kind: 'coach', relationshipId: proposal.relationshipId ?? undefined, coachId: proposal.coachId ?? undefined, coachName: opts.coachName, proposalId: proposal.id }
      : { kind: 'ai', proposalId: proposal.id };
  const { name, progressionNotes, ...content } = proposal.program;
  const reason =
    (proposal.authorKind === 'coach' ? 'Coach update' : 'AI-suggested update') + (proposal.changeSummary[0] ? `: ${proposal.changeSummary[0]}` : '');
  const versionContent = {
    ...content,
    rationale: [...(content.rationale ?? []), ...(progressionNotes ? [`Progression: ${progressionNotes}`] : [])],
    reason,
  };

  if (proposal.baseProgramId) {
    const base = live.find((p) => p.id === proposal.baseProgramId);
    if (!base) return { ok: false, reason: 'not_found', message: 'The plan this update was made for no longer exists on this device.' };
    if (base.currentVersion !== proposal.baseVersion)
      return { ok: false, reason: 'stale', message: 'Your plan changed after this update was written. Ask for a revised version.' };
    if (proposal.authorKind === 'ai' && base.managedBy?.kind === 'coach' && !opts.switchFromCoach)
      return { ok: false, reason: 'coach_managed', message: 'This plan is managed by your coach.' };
    const next = withNewVersion({ ...base, name: name || base.name, active: true, managedBy, source: proposal.authorKind }, versionContent);
    const deactivated = live.filter((p) => p.active && p.id !== base.id).map((p) => ({ ...p, active: false }));
    return { ok: true, program: next, deactivated, createdNew: false };
  }

  const version: ProgramVersion = { ...(versionContent as Omit<ProgramVersion, 'version' | 'createdAt'>), version: 1, createdAt: Date.now() };
  const created = createProgram(null, version, proposal.effectiveDate ?? opts.today, name, 'manual');
  const program: Program = { ...created, source: proposal.authorKind, managedBy };
  const deactivated = live.filter((p) => p.active).map((p) => ({ ...p, active: false }));
  return { ok: true, program, deactivated, createdNew: true };
}

/** Converting a coach/AI-managed plan into a self-managed one (explicit user choice). */
export function takeOverPlan(p: Program): Program {
  return withNewVersion({ ...p, managedBy: { kind: 'self' } }, { ...currentVersion(p), reason: 'Switched to a self-managed plan' });
}
