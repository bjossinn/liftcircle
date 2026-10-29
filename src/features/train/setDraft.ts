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

export type ParsedNumber = { kind: 'empty' } | { kind: 'number'; value: number } | { kind: 'invalid'; reason: string };

export interface ParseOptions {
  decimals?: boolean;
  min?: number;
  max?: number;
}

/** Parse what the user typed. "2,5" and "2.5" are both 2.5; "" is an empty draft; "2." is 2. */
export function parseNumberText(text: string, opts: ParseOptions = {}): ParsedNumber {
  const s = text.trim().replace(/\s+/g, '').replace(',', '.');
  if (s === '') return { kind: 'empty' };
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return { kind: 'invalid', reason: 'Enter a number.' };
  const n = Number(s);
  if (!Number.isFinite(n)) return { kind: 'invalid', reason: 'Enter a number.' };
  if (n < 0 || (opts.min != null && n < opts.min)) return { kind: 'invalid', reason: opts.min != null && opts.min > 0 ? `Must be at least ${opts.min}.` : 'Must be zero or more.' };
  if (opts.max != null && n > opts.max) return { kind: 'invalid', reason: `Must be ${opts.max} or less.` };
  if (opts.decimals === false && !Number.isInteger(n)) return { kind: 'invalid', reason: 'Use a whole number.' };
  return { kind: 'number', value: n };
}

export function formatNumber(v: number | null | undefined): string {
  return v == null ? '' : String(v);
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
