/**
 * Program records and immutable versioning. Every edit appends a ProgramVersion; completed
 * workouts are separate records and are never touched by program changes.
 */
import type { ID, ISODate, OnboardingAnswers, Program, ProgramVersion, SessionTemplate } from '@/domain/types';
import { uuid } from '@/lib/id';

export function createProgram(answers: OnboardingAnswers | null, version: ProgramVersion, startDate: ISODate, name: string, source: 'generated' | 'manual'): Program {
  const now = Date.now();
  const v: ProgramVersion = { ...structuredCloneSafe(version), version: 1, createdAt: now };
  const p: Program = {
    id: uuid(),
    createdAt: now,
    updatedAt: now,
    name,
    source,
    startDate,
    active: true,
    currentVersion: 1,
    versions: [v],
    rotationIndex: 0,
    overrides: [],
  };
  if (answers) p.inputs = structuredCloneSafe(answers);
  return p;
}

export function currentVersion(p: Program): ProgramVersion {
  return p.versions.find((v) => v.version === p.currentVersion) ?? p.versions[p.versions.length - 1];
}

/** Append a new version (never edits earlier versions or any logged workout). */
export function withNewVersion(p: Program, version: Omit<ProgramVersion, 'version' | 'createdAt'>): Program {
  const next = Math.max(0, ...p.versions.map((v) => v.version)) + 1;
  const now = Date.now();
  const { version: _v, createdAt: _c, ...rest } = version as ProgramVersion;
  void _v;
  void _c;
  const v: ProgramVersion = { ...structuredCloneSafe(rest), version: next, createdAt: now };
  return { ...p, versions: [...p.versions, v], currentVersion: next, updatedAt: now };
}

/** Template from the current version, falling back to older versions (for history display). */
export function templateById(p: Program, id: ID): SessionTemplate | undefined {
  const cur = currentVersion(p)?.templates.find((t) => t.id === id);
  if (cur) return cur;
  for (const v of [...p.versions].sort((a, b) => b.version - a.version)) {
    const t = v.templates.find((x) => x.id === id);
    if (t) return t;
  }
  return undefined;
}

/** Restore an old version by appending a copy of it as the newest version. */
export function restoreVersion(p: Program, versionNumber: number): Program {
  const old = p.versions.find((v) => v.version === versionNumber);
  if (!old) return p;
  return withNewVersion(p, { ...old, reason: `Restored version ${versionNumber}` });
}

/** Which week of the block a date falls in (1-based, capped at the block length + 1). */
export function blockWeek(p: Program, today: ISODate): number {
  const [y1, m1, d1] = p.startDate.split('-').map(Number);
  const [y2, m2, d2] = today.split('-').map(Number);
  const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  return Math.max(1, Math.floor(days / 7) + 1);
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
