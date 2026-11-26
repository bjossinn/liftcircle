/**
 * Draft handling for workout number fields (weight, reps, duration, distance, RIR/RPE).
 *
 * - Parsing keeps decimal comma/point entry and empty drafts.
 * - Every keystroke is mirrored to a small local draft (localStorage, synchronous) so a value typed
 *   just before a reload/close is restored even if the debounced database write never finished.
 * - A per-page registry lets the logger flush every pending field before completing a set, navigating,
 *   finishing, or when the page is hidden / unloaded.
 */
import { createContext, useContext } from 'react';
import { decimalInput, getLanguage, t, type Language, type MessageKey, type Params } from '@/i18n';

/** Why a typed value was rejected: a message key and its params, so the text follows the current language. */
export interface DraftProblem {
  key: MessageKey;
  params?: Params;
}

export type ParsedNumber =
  | { kind: 'empty' }
  | { kind: 'number'; value: number }
  | { kind: 'invalid'; reason: string; problem: DraftProblem };

export interface ParseOptions {
  decimals?: boolean;
  min?: number;
  max?: number;
}

const invalid = (problem: DraftProblem): ParsedNumber => ({ kind: 'invalid', reason: t(problem.key, problem.params), problem });

/**
 * Parse what the user typed. "2,5" and "2.5" are both 2.5 (decimal comma or point, in every language); "" is an empty
 * draft; "2." is 2. Entry is ungrouped: grouped or mixed input such as "1.234,5" or "1 234" is rejected with a
 * message instead of being guessed. The domain min/max checks are unchanged.
 */
export function parseNumberText(text: string, opts: ParseOptions = {}): ParsedNumber {
  const parsed = decimalInput(text);
  if (parsed.kind === 'empty') return { kind: 'empty' };
  if (parsed.kind === 'invalid') return invalid({ key: 'workout.validation.enterNumber' });
  const n = parsed.value;
  if (n < 0 || (opts.min != null && n < opts.min))
    return invalid(opts.min != null && opts.min > 0 ? { key: 'workout.validation.minimum', params: { min: opts.min } } : { key: 'workout.validation.nonnegative' });
  if (opts.max != null && n > opts.max) return invalid({ key: 'workout.validation.maximum', params: { max: opts.max } });
  if (opts.decimals === false && !Number.isInteger(n)) return invalid({ key: 'workout.validation.wholeNumber' });
  return { kind: 'number', value: n };
}

/**
 * The saved value as editable text, with the language's decimal separator ("62,5" in Icelandic) and full precision,
 * so parsing it back gives exactly the same number (an unchanged value is never re-written).
 */
export function formatNumber(v: number | null | undefined, language: Language = getLanguage()): string {
  if (v == null) return '';
  const s = String(v);
  return language === 'is' ? s.replace('.', ',') : s;
}

/* ------------------------------------------------------------ local draft */
const PREFIX = 'lc.setdraft:';
const MAX_AGE_MS = 24 * 3600 * 1000;

interface StoredDraft {
  text: string;
  t: number;
}

export function draftKey(sessionId: string, setId: string, field: string): string {
  return `${sessionId}:${setId}:${field}`;
}

export function saveLocalDraft(key: string, text: string): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ text, t: Date.now() } satisfies StoredDraft));
  } catch {
    /* storage unavailable (private mode / quota) — the debounced DB write is still the primary path */
  }
}

export function readLocalDraft(key: string): string | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const d = JSON.parse(raw) as StoredDraft;
    if (typeof d?.text !== 'string' || typeof d.t !== 'number' || Date.now() - d.t > MAX_AGE_MS) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return d.text;
  } catch {
    return null;
  }
}

export function clearLocalDraft(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Remove every draft of a session (after finishing or discarding it). */
export function clearSessionDrafts(sessionId: string): void {
  try {
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`${PREFIX}${sessionId}:`)) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------------------- registry */
export interface FlushResult {
  /** Fields whose text is not a valid number (nothing was saved for them). */
  invalid: { setId?: string; reason: string }[];
}

export interface DraftEntry {
  setId?: string;
  /** Synchronously hand a pending value to the save queue. Returns an error reason if the draft is invalid. */
  flush: () => string | null;
}

export class DraftRegistry {
  private entries = new Set<DraftEntry>();
  register(e: DraftEntry): () => void {
    this.entries.add(e);
    return () => this.entries.delete(e);
  }
  /** Flush all (or one set's) pending drafts synchronously, in registration order. */
  flushAll(setId?: string): FlushResult {
    const invalid: FlushResult['invalid'] = [];
    for (const e of this.entries) {
      if (setId && e.setId !== setId) continue;
      const reason = e.flush();
      if (reason) invalid.push({ setId: e.setId, reason });
    }
    return { invalid };
  }
}

export const DraftRegistryContext = createContext<DraftRegistry | null>(null);
export const useDraftRegistry = () => useContext(DraftRegistryContext);
