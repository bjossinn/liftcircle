/**
 * Server-side validation of AI program proposals (pure).
 *
 * `validateProposedProgram` mirrors src/domain/program/proposals.ts validateProposedProgram (keep the two
 * in sync — same rules and messages). `validateForUser` adds the checks only the server can make against
 * the authenticated user's records: equipment the user has, excluded exercises, and that the proposal is
 * based on the user's CURRENT active program version. Invalid proposals are stored with status 'invalid'
 * and their errors, and are never offered as applicable.
 */
import type { RefExercise, UserFacts } from './types.ts';

/* ------------------------------------------------------------------ normalized shapes */
export interface NormPrescription {
  id: string;
  exerciseId: string;
  sets: number;
  repMin: number;
  repMax: number;
  targetRir: number;
  restSec: number;
  durationSec?: number;
  warmup: string;
  priority: 1 | 2 | 3;
  alternatives: string[];
  notes?: string;
  calibrate?: boolean;
}
export interface NormTemplate {
  id: string;
  name: string;
  focus: string;
  kind: 'lifting' | 'cardio' | 'walk' | 'mobility' | 'conditioning';
  exercises: NormPrescription[];
  estimatedMinutes: number;
}
export interface NormProgram {
  name: string;
  reason: string;
  templates: NormTemplate[];
  schedule: { weekday: number; templateId: string }[];
  weeks: number;
  reviewWeek: number;
  rationale: string[];
  warnings: string[];
  progressionNotes?: string;
}

const KINDS = new Set(['lifting', 'cardio', 'walk', 'mobility', 'conditioning']);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  arr(v).filter((x): x is string => typeof x === 'string').slice(0, maxItems).map((x) => x.trim().slice(0, maxLen)).filter(Boolean);

/**
 * Coerces model output into the ProposedProgram shape (unknown keys dropped, defaults filled).
 * Numbers are NOT clamped — out-of-range values are reported by validation instead of silently fixed.
 */
export function normalizeProposedProgram(raw: unknown): NormProgram {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const templates: NormTemplate[] = arr(r.templates).slice(0, 30).map((tRaw, ti) => {
    const t = (tRaw && typeof tRaw === 'object' ? tRaw : {}) as Record<string, unknown>;
    const exercises: NormPrescription[] = arr(t.exercises).slice(0, 40).map((xRaw, xi) => {
      const x = (xRaw && typeof xRaw === 'object' ? xRaw : {}) as Record<string, unknown>;
      const pr = num(x.priority);
      const p: NormPrescription = {
        id: str(x.id, 100) || `slot-${ti + 1}-${xi + 1}`,
        exerciseId: str(x.exerciseId ?? x.exercise_id, 100),
        sets: num(x.sets),
        repMin: num(x.repMin ?? x.rep_min),
        repMax: num(x.repMax ?? x.rep_max),
        targetRir: num(x.targetRir ?? x.target_rir ?? 2),
        restSec: num(x.restSec ?? x.rest_sec ?? 90),
        warmup: str(x.warmup, 300),
        priority: pr === 1 || pr === 2 || pr === 3 ? pr : 2,
        alternatives: strList(x.alternatives, 6, 100),
      };
      const dur = num(x.durationSec);
      if (Number.isFinite(dur)) p.durationSec = dur;
      const notes = str(x.notes, 300);
      if (notes) p.notes = notes;
      if (x.calibrate === true) p.calibrate = true;
      return p;
    });
    const kind = str(t.kind, 20);
    const est = num(t.estimatedMinutes);
    return {
      id: str(t.id, 100),
      name: str(t.name, 100),
      focus: str(t.focus, 100) || str(t.name, 100),
      kind: (KINDS.has(kind) ? kind : 'lifting') as NormTemplate['kind'],
      exercises,
      estimatedMinutes: Number.isFinite(est) && est > 0 ? Math.min(300, Math.round(est)) : 60,
    };
  });
  const schedule = arr(r.schedule).slice(0, 14).map((sRaw) => {
    const s = (sRaw && typeof sRaw === 'object' ? sRaw : {}) as Record<string, unknown>;
    return { weekday: num(s.weekday), templateId: str(s.templateId ?? s.template_id, 100) };
  });
  const weeks = num(r.weeks);
  const review = num(r.reviewWeek);
  const out: NormProgram = {
    name: str(r.name, 120),
    reason: str(r.reason, 300) || 'AI-suggested update',
    templates,
    schedule,
    weeks,
    reviewWeek: Number.isFinite(review) && review >= 1 ? Math.round(review) : Number.isFinite(weeks) ? Math.max(1, Math.round(weeks)) : 4,
    rationale: strList(r.rationale, 8, 400),
    warnings: strList(r.warnings, 8, 400),
  };
  const notes = str(r.progressionNotes, 1000);
  if (notes) out.progressionNotes = notes;
  return out;
}

/** Mirror of src/domain/program/proposals.ts validateProposedProgram. */
export function validateProposedProgram(p: NormProgram, catalog: Set<string>): string[] {
  const errors: string[] = [];
  const has = (id: string) => catalog.has(id);
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

/** Equipment an exercise needs that the user doesn't have ('bodyweight' is always available). */
export function missingEquipment(ex: RefExercise, userEquipment: string[]): string[] {
  const have = new Set([...userEquipment, 'bodyweight']);
  return (ex.equipment ?? []).filter((e) => !have.has(e));
}

export interface UserValidationInput {
  program: NormProgram;
  baseProgramId: string | null;
  baseVersion: number | null;
}

/** Checks against the authenticated user's records (equipment, exclusions, current plan version). */
export function validateForUser(input: UserValidationInput, facts: UserFacts, catalog: Map<string, RefExercise>): string[] {
  const errors: string[] = [];
  const excluded = new Set(facts.excludedExerciseIds);
  const usedIds = new Set<string>();
  for (const t of input.program.templates) for (const rx of t.exercises) {
    usedIds.add(rx.exerciseId);
    for (const alt of rx.alternatives) usedIds.add(alt);
  }
  for (const id of usedIds) {
    const ex = catalog.get(id);
    if (!ex) continue; // reported by validateProposedProgram
    if (excluded.has(id)) errors.push(`"${ex.name}" is on your excluded exercises list.`);
    if (facts.equipment) {
      const miss = missingEquipment(ex, facts.equipment);
      if (miss.length) errors.push(`"${ex.name}" needs equipment you haven't listed (${miss.join(', ')}).`);
    }
  }
  const active = facts.activeProgram;
  if (input.baseProgramId) {
    if (!active || active.id !== input.baseProgramId) {
      errors.push('This update is based on a plan that is not your current active plan.');
    } else if (input.baseVersion !== active.currentVersion) {
      errors.push(`This update was written for version ${input.baseVersion ?? '?'} of your plan, but the current version is ${active.currentVersion} (stale).`);
    }
  } else if (input.baseVersion != null) {
    errors.push('A base version was given without a base plan.');
  }
  return [...new Set(errors)];
}

/** The AI may never replace a coach-managed plan: such proposals are always 'for_coach_review'. */
export function decideTarget(requested: unknown, facts: UserFacts): 'apply' | 'for_coach_review' {
  if (facts.activeProgram?.managedBy === 'coach') return 'for_coach_review';
  return requested === 'for_coach_review' ? 'for_coach_review' : 'apply';
}
