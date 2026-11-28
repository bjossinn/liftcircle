/**
 * Session marks: a deterministic family + variant letter per program session, so every session the generator builds
 * looks different from the others in the same plan (Upper A ≠ Upper B, Full body A ≠ B ≠ C, easy run ≠ long run, …).
 *
 * Derived only from stable stored data, never from the localized display string:
 *  1. a generated template id (`<split>:<day>`, `act:*`, `end:*`; see generator.ts) — survives a rename;
 *  2. otherwise the canonical English stored `name` / `focus` (`Upper B`, `Lower body`, manual `Session C`, …).
 * Nothing is persisted; the mark is recomputed when shown.
 */
import type { SessionTemplate, SplitKey } from '@/domain/types';
import { SPLITS } from './templates';

export type SessionFamily =
  | 'upper'
  | 'lower'
  | 'push'
  | 'pull'
  | 'legs'
  | 'full_body'
  | 'strength'
  | 'lifting'
  | 'walk'
  | 'cardio'
  | 'cardio_long'
  | 'cardio_steady'
  | 'mobility'
  | 'conditioning';

export interface SessionMark {
  family: SessionFamily;
  /** Variant letter (A, B, C, …) or null when the session has none (plain `Full body`, `act:walk`). */
  letter: string | null;
}

type MarkSource = Pick<SessionTemplate, 'id' | 'kind' | 'name'> & Partial<Pick<SessionTemplate, 'focus' | 'nameEdited'>>;

/** Day-key prefix → lifting family (generated ids). Longest prefixes first. */
const DAY_PREFIX: [string, SessionFamily][] = [
  ['pl', 'pull'],
  ['lg', 'legs'],
  ['u', 'upper'],
  ['l', 'lower'],
  ['p', 'push'],
  ['s', 'strength'],
];

function fromDayKey(dayKey: string): SessionMark | null {
  if (dayKey === 'fb' || dayKey === 'f') return { family: 'full_body', letter: null };
  if (/^[a-d]$/.test(dayKey)) return { family: 'full_body', letter: dayKey.toUpperCase() };
  for (const [prefix, family] of DAY_PREFIX) {
    const m = new RegExp(`^${prefix}([a-d])$`).exec(dayKey);
    if (m) return { family, letter: m[1].toUpperCase() };
  }
  return null;
}

function generatedLiftingMark(id: string): SessionMark | null {
  const parts = id.split(':');
  if (parts.length !== 2 || !Object.hasOwn(SPLITS, parts[0])) return null;
  if (!SPLITS[parts[0] as SplitKey].days.some((d) => d.key === parts[1])) return null;
  return fromDayKey(parts[1]);
}

/** Stored English names (`Upper B`, `Full body`, `Session C`) → family + letter. */
const NAME_FAMILY: [RegExp, SessionFamily][] = [
  [/^upper(?: body)?$/i, 'upper'],
  [/^lower(?: body)?$/i, 'lower'],
  [/^push$/i, 'push'],
  [/^pull$/i, 'pull'],
  [/^legs$/i, 'legs'],
  [/^full[- ]body$/i, 'full_body'],
  [/^strength$/i, 'strength'],
];
/** Stored English focus strings of the generated days. */
const FOCUS_FAMILY: Record<string, SessionFamily> = {
  'upper body': 'upper',
  'lower body': 'lower',
  'chest, shoulders, triceps': 'push',
  'shoulders, chest, triceps': 'push',
  'back, rear shoulders, biceps': 'pull',
  'legs & trunk': 'legs',
  'full body': 'full_body',
  'supporting strength': 'strength',
};

function liftingMarkFromText(name: string, focus: string | undefined): SessionMark {
  const trimmed = name.trim();
  const m = /^(.*?)\s+([A-Z])$/.exec(trimmed);
  const stem = m ? m[1] : trimmed;
  const letter = m ? m[2] : null;
  const byName = NAME_FAMILY.find(([re]) => re.test(stem))?.[1];
  const byFocus = focus ? FOCUS_FAMILY[focus.trim().toLowerCase()] : undefined;
  return { family: byName ?? byFocus ?? 'lifting', letter };
}

export function sessionMark(t: MarkSource): SessionMark {
  switch (t.kind) {
    case 'walk':
      return { family: 'walk', letter: null };
    case 'mobility':
      return { family: 'mobility', letter: null };
    case 'conditioning':
      return { family: 'conditioning', letter: null };
    case 'cardio':
      if (t.id === 'end:long') return { family: 'cardio_long', letter: null };
      if (t.id === 'end:steady') return { family: 'cardio_steady', letter: null };
      return { family: 'cardio', letter: null };
    default: {
      const generated = generatedLiftingMark(t.id);
      if (generated) return generated;
      return liftingMarkFromText(t.name, t.focus);
    }
  }
}

/** Stable string for comparing marks (`upper:A`, `full_body:`). */
export const sessionMarkKey = (t: MarkSource): string => {
  const m = sessionMark(t);
  return `${m.family}:${m.letter ?? ''}`;
};
