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
import { t, tp } from '@/i18n';
import { weekdayShort } from '@/lib/dates';

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
  if (!p.name?.trim()) errors.push(t('aiCard.validation.programName'));
  if (!Array.isArray(p.templates) || p.templates.length === 0) errors.push(t('aiCard.validation.noSessions'));
  if (p.templates?.length > 14) errors.push(t('aiCard.validation.tooManySessions'));
  const ids = new Set<string>();
  for (const tpl of p.templates ?? []) {
    if (!tpl.id || ids.has(tpl.id)) errors.push(t('aiCard.validation.sessionId', { name: tpl.name }));
    ids.add(tpl.id);
    if (!tpl.name?.trim()) errors.push(t('aiCard.validation.sessionName'));
    if (tpl.exercises.length > 20) errors.push(t('aiCard.validation.tooManyExercises', { name: tpl.name }));
    const slotIds = new Set<string>();
    for (const rx of tpl.exercises) {
      if (slotIds.has(rx.id)) errors.push(t('aiCard.validation.duplicateExercise', { name: tpl.name }));
      slotIds.add(rx.id);
      if (!has(rx.exerciseId)) errors.push(t('aiCard.validation.unknownExercise', { exerciseId: rx.exerciseId, sessionName: tpl.name }));
      if (!(rx.sets >= 1 && rx.sets <= 10)) errors.push(t('aiCard.validation.sets', { exerciseId: rx.exerciseId }));
      if (!(rx.repMin >= 1 && rx.repMax <= 100 && rx.repMin <= rx.repMax)) errors.push(t('aiCard.validation.reps', { exerciseId: rx.exerciseId }));
      if (!(rx.targetRir >= 0 && rx.targetRir <= 5)) errors.push(t('aiCard.validation.rir', { exerciseId: rx.exerciseId }));
      if (!(rx.restSec >= 0 && rx.restSec <= 600)) errors.push(t('aiCard.validation.rest', { exerciseId: rx.exerciseId }));
      for (const alt of rx.alternatives ?? []) if (!has(alt)) errors.push(t('aiCard.validation.substitute', { exerciseId: alt }));
    }
  }
  const days = new Set<number>();
  for (const s of p.schedule ?? []) {
    if (!(Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6)) errors.push(t('aiCard.validation.weekday'));
    if (days.has(s.weekday)) errors.push(t('aiCard.validation.twoSessions'));
    days.add(s.weekday);
    if (!ids.has(s.templateId)) errors.push(t('aiCard.validation.missingSession'));
  }
  if (!(p.weeks >= 1 && p.weeks <= 52)) errors.push(t('aiCard.validation.block'));
  return [...new Set(errors)];
}

/** Human-readable list of what changes between the base version and the proposal (display text, current language). */
export function describeChanges(base: ProgramVersion | null | undefined, next: ProposedProgram, nameOf: (id: ID) => string): string[] {
  if (!base) return [tp('aiCard.changes.newPlan', next.templates.length, { weeks: next.weeks })];
  const out: string[] = [];
  const byId = (ts: SessionTemplate[]) => new Map(ts.map((tpl) => [tpl.id, tpl]));
  const a = byId(base.templates);
  const b = byId(next.templates);
  for (const [id, tpl] of b) if (!a.has(id)) out.push(t('aiCard.changes.addSession', { name: tpl.name }));
  for (const [id, tpl] of a) if (!b.has(id)) out.push(t('aiCard.changes.removeSession', { name: tpl.name }));
  for (const [id, nt] of b) {
    const ot = a.get(id);
    if (!ot) continue;
    if (ot.name !== nt.name) out.push(t('aiCard.changes.renameSession', { oldName: ot.name, newName: nt.name }));
    const oEx = new Map(ot.exercises.map((x) => [x.id, x]));
    const nEx = new Map(nt.exercises.map((x) => [x.id, x]));
    const sessionName = nt.name;
    for (const [sid, x] of nEx) {
      const o = oEx.get(sid);
      const exerciseName = nameOf(x.exerciseId);
      if (!o) out.push(t('aiCard.changes.addExercise', { sessionName, exerciseName }));
      else {
        if (o.exerciseId !== x.exerciseId)
          out.push(t('aiCard.changes.swapExercise', { sessionName, oldExercise: nameOf(o.exerciseId), newExercise: exerciseName }));
        if (o.sets !== x.sets || o.repMin !== x.repMin || o.repMax !== x.repMax)
          out.push(
            t('aiCard.changes.prescription', {
              sessionName, exerciseName, oldSets: o.sets, oldRepMin: o.repMin, oldRepMax: o.repMax, sets: x.sets, repMin: x.repMin, repMax: x.repMax,
            }),
          );
        if (o.restSec !== x.restSec) out.push(t('aiCard.changes.rest', { sessionName, exerciseName, oldSeconds: o.restSec, seconds: x.restSec }));
        if (o.targetRir !== x.targetRir) out.push(t('aiCard.changes.rir', { sessionName, exerciseName, oldRir: o.targetRir, rir: x.targetRir }));
      }
    }
    for (const [sid, x] of oEx) if (!nEx.has(sid)) out.push(t('aiCard.changes.removeExercise', { sessionName, exerciseName: nameOf(x.exerciseId) }));
    const oOrder = ot.exercises.map((x) => x.id).filter((i) => nEx.has(i)).join();
    const nOrder = nt.exercises.map((x) => x.id).filter((i) => oEx.has(i)).join();
    if (oOrder !== nOrder) out.push(t('aiCard.changes.order', { sessionName }));
  }
  // Comparison key only (stable, language-independent).
  const sched = (v: { schedule: { weekday: number; templateId: ID }[] }) =>
    [...v.schedule].sort((x, y) => x.weekday - y.weekday).map((s) => `${s.weekday}:${s.templateId}`).join(',');
  if (sched(base) !== sched(next)) {
    const fmt = (v: { schedule: { weekday: number; templateId: ID }[] }, ts: Map<ID, SessionTemplate>) =>
      [...v.schedule].sort((x, y) => x.weekday - y.weekday).map((s) => `${weekdayShort(s.weekday)} ${ts.get(s.templateId)?.name ?? '?'}`).join(', ');
    const none = t('aiCard.changes.none');
    out.push(t('aiCard.changes.schedule', { before: fmt(base, a) || none, after: fmt(next, b) || none }));
  }
  if (base.weeks !== next.weeks) out.push(t('aiCard.changes.block', { oldWeeks: base.weeks, weeks: next.weeks }));
  if ((next.progressionNotes ?? '') !== '') out.push(t('aiCard.changes.progression'));
  return out.length ? out : [t('aiCard.changes.unchanged')];
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
    return { ok: false, reason: 'not_applicable', message: t('aiCard.apply.reviewOnly') };
  const errors = validateProposedProgram(proposal.program, opts.catalog);
  if (errors.length) return { ok: false, reason: 'invalid', message: errors[0] };

  const live = programs.filter((p) => !p.deletedAt);
  const active = activeProgram(live);
  if (proposal.authorKind === 'ai' && active?.managedBy?.kind === 'coach' && !opts.switchFromCoach) {
    return {
      ok: false,
      reason: 'coach_managed',
      message: t('aiCard.apply.coachManaged'),
    };
  }

  const managedBy: Program['managedBy'] =
    proposal.authorKind === 'coach'
      ? { kind: 'coach', relationshipId: proposal.relationshipId ?? undefined, coachId: proposal.coachId ?? undefined, coachName: opts.coachName, proposalId: proposal.id }
      : { kind: 'ai', proposalId: proposal.id };
  const { name, progressionNotes, ...content } = proposal.program;
  // Persisted canonical English (version history); shown localized through versionReasonText / rationaleLineText.
  const reason =
    (proposal.authorKind === 'coach' ? REASON_COACH : REASON_AI) + (proposal.changeSummary[0] ? `: ${proposal.changeSummary[0]}` : '');
  const versionContent = {
    ...content,
    rationale: [...(content.rationale ?? []), ...(progressionNotes ? [`${PROGRESSION_PREFIX}${progressionNotes}`] : [])],
    reason,
  };

  if (proposal.baseProgramId) {
    const base = live.find((p) => p.id === proposal.baseProgramId);
    if (!base) return { ok: false, reason: 'not_found', message: t('aiCard.apply.planMissing') };
    if (base.currentVersion !== proposal.baseVersion)
      return { ok: false, reason: 'stale', message: t('aiCard.apply.planChanged') };
    if (proposal.authorKind === 'ai' && base.managedBy?.kind === 'coach' && !opts.switchFromCoach)
      return { ok: false, reason: 'coach_managed', message: t('aiCard.apply.managed') };
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
  return withNewVersion({ ...p, managedBy: { kind: 'self' } }, { ...currentVersion(p), reason: REASON_TOOK_OVER });
}

/* Stored (canonical, English) version texts written above. They stay English in the database/backup so history reads
 * the same on every device; these helpers localize them at render. Only these exact strings (and the exact
 * "<reason>: <summary>" form applyProposal writes) are recognized; anything else is shown as stored. */
const REASON_COACH = 'Coach update';
const REASON_AI = 'AI-suggested update';
const REASON_TOOK_OVER = 'Switched to a self-managed plan';
const PROGRESSION_PREFIX = 'Progression: ';
const REASON_KEYS = {
  [REASON_COACH]: 'aiCard.apply.coachUpdate',
  [REASON_AI]: 'aiCard.apply.aiUpdate',
  [REASON_TOOK_OVER]: 'aiCard.apply.tookOver',
} as const;

/** A ProgramVersion.reason written by applyProposal / takeOverPlan, in the current language; other reasons unchanged. */
export function versionReasonText(reason: string): string {
  const exact = REASON_KEYS[reason as keyof typeof REASON_KEYS];
  if (exact) return t(exact);
  for (const prefix of [REASON_COACH, REASON_AI] as const) {
    if (reason.startsWith(`${prefix}: `)) return `${t(REASON_KEYS[prefix])}: ${reason.slice(prefix.length + 2)}`;
  }
  return reason;
}

/** A rationale line written by applyProposal ("Progression: …"), in the current language; other lines unchanged. */
export function rationaleLineText(line: string): string {
  return line.startsWith(PROGRESSION_PREFIX) ? t('aiCard.apply.progressionNotes', { notes: line.slice(PROGRESSION_PREFIX.length) }) : line;
}
