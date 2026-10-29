/**
 * Interval timer model (pure). Timing is deadline-based: we store the wall-clock end of the
 * current phase, so remaining time is recomputed correctly after the app is backgrounded,
 * the screen locks or the page reloads.
 */
import type { ActivityTemplate } from '@/domain/types';

export type IntervalItem = NonNullable<ActivityTemplate['intervals']>[number];

export interface Phase {
  label: string;
  seconds: number;
  /** 1-based round number within its block, when the block repeats. */
  round?: number;
  rounds?: number;
}

/**
 * Expand stored intervals into phases. Contiguous items sharing the same `repeat` value form a
 * block that is repeated as a circuit (Work, Rest, Work, Rest…). `repeat` 1 plays once.
 */
export function expandIntervals(items: IntervalItem[]): Phase[] {
  const out: Phase[] = [];
  let i = 0;
  while (i < items.length) {
    const rep = Math.max(1, Math.round(items[i].repeat || 1));
    let j = i;
    while (j < items.length && Math.max(1, Math.round(items[j].repeat || 1)) === rep) j++;
    const block = items.slice(i, j).filter((x) => x.seconds > 0);
    for (let r = 1; r <= rep; r++)
      for (const b of block) out.push(rep > 1 ? { label: b.label || 'Interval', seconds: b.seconds, round: r, rounds: rep } : { label: b.label || 'Interval', seconds: b.seconds });
    i = j;
  }
  return out;
}

export interface RoundsPlan {
  warmupSec: number;
  steps: { label: string; seconds: number }[];
  rounds: number;
  cooldownSec: number;
}

export const WARMUP_LABEL = 'Warm-up';
export const COOLDOWN_LABEL = 'Cool-down';

export function intervalsFromRounds(p: RoundsPlan): IntervalItem[] {
  const out: IntervalItem[] = [];
  if (p.warmupSec > 0) out.push({ label: WARMUP_LABEL, seconds: p.warmupSec, repeat: 1 });
  for (const s of p.steps) out.push({ label: s.label.trim() || 'Interval', seconds: s.seconds, repeat: Math.max(1, p.rounds) });
  if (p.cooldownSec > 0) out.push({ label: COOLDOWN_LABEL, seconds: p.cooldownSec, repeat: 1 });
  return out;
}

export function roundsFromIntervals(items: IntervalItem[]): RoundsPlan {
  const list = [...items];
  let warmupSec = 0;
  let cooldownSec = 0;
  if (list.length > 1 && list[0].label === WARMUP_LABEL && list[0].repeat <= 1) warmupSec = list.shift()!.seconds;
  if (list.length > 1 && list.at(-1)!.label === COOLDOWN_LABEL && list.at(-1)!.repeat <= 1) cooldownSec = list.pop()!.seconds;
  const rounds = Math.max(1, ...list.map((x) => x.repeat || 1));
  return { warmupSec, steps: list.map((x) => ({ label: x.label, seconds: x.seconds })), rounds, cooldownSec };
}

export function totalSeconds(phases: Phase[]): number {
  return phases.reduce((s, p) => s + p.seconds, 0);
}

/* ------------------------------------------------------------------ timer */
export interface TimerState {
  phases: Phase[];
  index: number;
  status: 'idle' | 'running' | 'paused' | 'done';
  /** Wall-clock end of the current phase while running. */
  phaseEndsAt?: number;
  /** Remaining ms of the current phase while paused. */
  pausedRemainingMs?: number;
  startedAt?: number;
  pausedAt?: number;
  pausedTotalMs: number;
  endedAt?: number;
}

export function idleTimer(phases: Phase[]): TimerState {
  return { phases, index: 0, status: 'idle', pausedTotalMs: 0 };
}

export function startTimer(phases: Phase[], now: number): TimerState {
  if (!phases.length) return { ...idleTimer(phases), status: 'done' };
  return { phases, index: 0, status: 'running', phaseEndsAt: now + phases[0].seconds * 1000, startedAt: now, pausedTotalMs: 0 };
}

/** Move past every phase whose deadline has passed. `changed` is true when the phase changed. */
export function advanceTimer(t: TimerState, now: number): { state: TimerState; changed: boolean } {
  if (t.status !== 'running' || t.phaseEndsAt == null) return { state: t, changed: false };
  let { index, phaseEndsAt } = t;
  let changed = false;
  while (now >= phaseEndsAt) {
    index++;
    changed = true;
    if (index >= t.phases.length) {
      return { state: { ...t, index: t.phases.length - 1, status: 'done', phaseEndsAt: undefined, endedAt: phaseEndsAt }, changed };
    }
    phaseEndsAt += t.phases[index].seconds * 1000;
  }
  return { state: changed ? { ...t, index, phaseEndsAt } : t, changed };
}

export function pauseTimer(t: TimerState, now: number): TimerState {
  if (t.status !== 'running' || t.phaseEndsAt == null) return t;
  return { ...t, status: 'paused', pausedRemainingMs: Math.max(0, t.phaseEndsAt - now), pausedAt: now, phaseEndsAt: undefined };
}

export function resumeTimer(t: TimerState, now: number): TimerState {
  if (t.status !== 'paused') return t;
  return {
    ...t,
    status: 'running',
    phaseEndsAt: now + (t.pausedRemainingMs ?? 0),
    pausedRemainingMs: undefined,
    pausedTotalMs: t.pausedTotalMs + (t.pausedAt != null ? now - t.pausedAt : 0),
    pausedAt: undefined,
  };
}

export function skipPhase(t: TimerState, now: number): TimerState {
  if (t.status !== 'running' && t.status !== 'paused') return t;
  const next = t.index + 1;
  if (next >= t.phases.length) {
    const paused = t.status === 'paused' && t.pausedAt != null ? now - t.pausedAt : 0;
    return { ...t, status: 'done', phaseEndsAt: undefined, pausedRemainingMs: undefined, pausedAt: undefined, pausedTotalMs: t.pausedTotalMs + paused, endedAt: now };
  }
  const ms = t.phases[next].seconds * 1000;
  return t.status === 'running' ? { ...t, index: next, phaseEndsAt: now + ms } : { ...t, index: next, pausedRemainingMs: ms };
}

export function remainingMs(t: TimerState, now: number): number {
  if (t.status === 'running' && t.phaseEndsAt != null) return Math.max(0, t.phaseEndsAt - now);
  if (t.status === 'paused') return t.pausedRemainingMs ?? 0;
  if (t.status === 'idle') return (t.phases[0]?.seconds ?? 0) * 1000;
  return 0;
}

/** Active (unpaused) seconds since start. */
export function elapsedSec(t: TimerState, now: number): number {
  if (t.startedAt == null) return 0;
  const end = t.endedAt ?? (t.status === 'paused' && t.pausedAt != null ? t.pausedAt : now);
  return Math.max(0, Math.round((end - t.startedAt - t.pausedTotalMs) / 1000));
}
