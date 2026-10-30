/**
 * Coach cheers phrase picker (src/domain/coachCheers.ts): pure, local, no network or AI.
 * Situations × styles, discomfort override, warm-ups skipped, never the same line twice in a row,
 * the rest-over line naming the right next set, and the wording rules (≤ 12 words, no body-weight/food talk).
 */
import { describe, expect, it } from 'vitest';
import { CHEER_LINES, cheerForSet, nextSet, pickLine, recordForSet, restOverCheer, type CheerSituation } from '@/domain/coachCheers';
import { EXERCISES } from '@/data/exercises';
import type { CoachStyle, LoggedSet, SessionExercise, WorkoutSession } from '@/domain/types';

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const STYLES: CoachStyle[] = ['supportive', 'balanced', 'strict'];
const SITUATIONS = Object.keys(CHEER_LINES) as CheerSituation[];
const words = (s: string) => s.trim().split(/\s+/).length;

const set = (id: string, over: Partial<LoggedSet> = {}): LoggedSet => ({ id, type: 'normal', weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: 8, completed: false, ...over });
const ex = (id: string, exerciseId: string, sets: LoggedSet[], over: Partial<SessionExercise> = {}): SessionExercise => ({
  id, exerciseId, order: 0, prescription: { sets: sets.length, repMin: 8, repMax: 10, targetRir: 2, restSec: 90 }, sets, ...over,
});
const session = (exercises: SessionExercise[], over: Partial<WorkoutSession> = {}): WorkoutSession => ({
  id: 'now', createdAt: 1, updatedAt: 1, name: 'Upper A', status: 'active', date: '2026-10-30', timeZone: 'UTC', startedAt: Date.parse('2026-10-30T17:00:00Z'), pausedTotalMs: 0, exercises, ...over,
});
const past = (kg: number, reps: number): WorkoutSession =>
  session([ex('old', 'barbell-bench-press', [set('o1', { weightKg: kg, entered: { value: kg, unit: 'kg' }, reps, completed: true })])], { id: 'past', status: 'completed', date: '2026-10-23', startedAt: Date.parse('2026-10-23T17:00:00Z') });

const cheer = (s: WorkoutSession, seId: string, setId: string, style: CoachStyle = 'balanced', history: WorkoutSession[] = []) =>
  cheerForSet({ session: s, seId, setId, style, history, byId, unit: 'kg', rand: () => 0 });

describe('phrase library', () => {
  it('has 15+ lines for every situation and style', () => {
    for (const sit of SITUATIONS) for (const st of STYLES) expect(CHEER_LINES[sit][st].length, `${sit}/${st}`).toBeGreaterThanOrEqual(15);
  });

  it('set cheers are ≤ 12 words even with long names filled in', () => {
    const vars = { record: '102.5 kg × 10', next: 'Single-arm dumbbell row' };
    for (const sit of SITUATIONS.filter((s) => !s.startsWith('rest_over'))) for (const st of STYLES)
      for (const t of CHEER_LINES[sit][st]) {
        const line = t.replace(/\{(\w+)\}/g, (_, k: string) => vars[k as keyof typeof vars] ?? '');
        expect(words(line), `${sit}/${st}: ${line}`).toBeLessThanOrEqual(12);
      }
  });

  it('never talks about body weight, food or appearance, and never shames', () => {
    const all = SITUATIONS.flatMap((s) => STYLES.flatMap((st) => CHEER_LINES[s][st])).join('\n');
    expect(all).not.toMatch(/\b(body ?weight|fat|calorie|calories|food|eat|eating|diet|belly|skinny|lazy|pathetic|weak|disappoint)/i);
  });

  it('never picks the same line twice in a row', () => {
    for (const sit of SITUATIONS) for (const st of STYLES) {
      let last: string | null = null;
      for (let i = 0; i < 60; i++) {
        const r = [0, 0.999, 0.5, 0.01][i % 4];
        const line = pickLine(sit, st, { record: '60 kg × 8', next: 'Row', set: 'Row set 2' }, last, () => r);
        expect(line).not.toBe(last);
        last = line;
      }
    }
  });
});

describe('cheerForSet: situation from the set just logged', () => {
  it('new record → celebrates with the number (each style)', () => {
    const s = session([ex('e1', 'barbell-bench-press', [set('a', { weightKg: 62.5, entered: { value: 62.5, unit: 'kg' }, completed: true }), set('b')])]);
    for (const st of STYLES) {
      const c = cheer(s, 'e1', 'a', st, [past(60, 8)])!;
      expect(c.situation).toBe('pr');
      expect(c.line).toContain('62.5 kg × 8');
    }
    expect(recordForSet(s, 'e1', 'a', [past(60, 8)], byId, 'kg')).toBe('62.5 kg × 8');
    // An earlier set in this same workout counts as "before": repeating it is not a record.
    const twice = session([ex('e1', 'barbell-bench-press', [set('a', { weightKg: 62.5, entered: { value: 62.5, unit: 'kg' }, completed: true }), set('b', { weightKg: 62.5, entered: { value: 62.5, unit: 'kg' }, completed: true }), set('c')])]);
    expect(cheer(twice, 'e1', 'b', 'balanced', [past(60, 8)])!.situation).not.toBe('pr');
  });

  it('top of the rep range → "weight goes up next time"', () => {
    const s = session([ex('e1', 'barbell-bench-press', [set('a', { reps: 10, completed: true }), set('b')])]);
    for (const st of STYLES) expect(CHEER_LINES.top_of_range[st]).toContain(cheer(s, 'e1', 'a', st)!.line);
    expect(cheer(s, 'e1', 'a')!.line).toBe('That’s the top of the range, weight goes up next time.');
  });

  it('reps below target → encouraging; firmer in Strict', () => {
    const s = session([ex('e1', 'barbell-bench-press', [set('a', { reps: 5, completed: true }), set('b')])]);
    expect(cheer(s, 'e1', 'a', 'supportive')!).toMatchObject({ situation: 'below_target' });
    expect(CHEER_LINES.below_target.supportive).toContain(cheer(s, 'e1', 'a', 'supportive')!.line);
    expect(CHEER_LINES.below_target.strict).toContain(cheer(s, 'e1', 'a', 'strict')!.line);
  });

  it('last set of an exercise → nudges to the next exercise by name', () => {
    const s = session([
      ex('e1', 'barbell-bench-press', [set('a', { completed: true }), set('b', { completed: true })]),
      ex('e2', 'barbell-back-squat', [set('c')], { order: 1 }),
    ]);
    const c = cheer(s, 'e1', 'b')!;
    expect(c.situation).toBe('last_set_exercise');
    expect(c.line).toContain('Barbell back squat');
  });

  it('last set of the workout → "Last one done, finish strong!"', () => {
    const s = session([ex('e1', 'barbell-bench-press', [set('w', { type: 'warmup', weightKg: 20 }), set('a', { completed: true }), set('b', { completed: true })])]);
    const c = cheer(s, 'e1', 'b')!;
    expect(c.situation).toBe('last_set_workout');
    expect(c.line).toBe('Last one done, finish strong!');
    for (const st of STYLES) expect(CHEER_LINES.last_set_workout[st]).toContain(cheer(s, 'e1', 'b', st)!.line);
  });

  it('otherwise → a rotating general line', () => {
    const s = session([ex('e1', 'barbell-bench-press', [set('a', { completed: true }), set('b')])]);
    const first = cheerForSet({ session: s, seId: 'e1', setId: 'a', history: [], byId, unit: 'kg', rand: () => 0 })!;
    expect(first.situation).toBe('general');
    const second = cheerForSet({ session: s, seId: 'e1', setId: 'a', history: [], byId, unit: 'kg', rand: () => 0, last: first.line })!;
    expect(second.line).not.toBe(first.line);
  });

  it('"Felt discomfort" → only caring lines, even for a record or the last set', () => {
    const s = session([ex('e1', 'barbell-bench-press', [set('a', { weightKg: 80, entered: { value: 80, unit: 'kg' }, reps: 10, completed: true })], { discomfort: true })]);
    for (const st of STYLES) {
      const c = cheer(s, 'e1', 'a', st, [past(60, 8)])!;
      expect(c.situation).toBe('discomfort');
      expect(CHEER_LINES.discomfort[st]).toContain(c.line);
    }
    expect(cheer(s, 'e1', 'a', 'balanced')!.line).toBe('Take it easy, swap it if it still hurts.');
  });

  it('quiet cases: warm-up sets and not-completed (undone) sets get nothing', () => {
    const s = session([ex('e1', 'barbell-bench-press', [set('w', { type: 'warmup', weightKg: 20, completed: true }), set('a')])]);
    expect(cheer(s, 'e1', 'w')).toBeNull();
    expect(cheer(s, 'e1', 'a')).toBeNull();
    expect(cheer(s, 'nope', 'a')).toBeNull();
  });
});

describe('rest over: names the next set', () => {
  it('"Rest’s up, Barbell bench press set 2: 60 kg × 8. Let’s go!" — the rested-for exercise first', () => {
    const s = session(
      [
        ex('e1', 'barbell-bench-press', [set('w', { type: 'warmup', weightKg: 20, completed: true }), set('a', { completed: true }), set('b'), set('c')]),
        ex('e2', 'barbell-back-squat', [set('d')], { order: 1 }),
      ],
      { rest: { endsAt: 1, durationMs: 90_000, forExerciseId: 'e1' } },
    );
    expect(restOverCheer(s, byId, 'kg', 'balanced', null, () => 0)!.line).toBe('Rest’s up, Barbell bench press set 2: 60 kg × 8. Let’s go!');
    expect(nextSet(s, byId, 'kg', 'e2')!.label).toBe('Barbell back squat set 1: 60 kg × 8');
  });

  it('moves on to the next exercise when the rested-for one is finished; null when everything is done', () => {
    const s = session(
      [ex('e1', 'barbell-bench-press', [set('a', { completed: true })]), ex('e2', 'barbell-back-squat', [set('d', { weightKg: 100, entered: { value: 100, unit: 'kg' }, reps: 5 })], { order: 1 })],
      { rest: { endsAt: 1, durationMs: 90_000, forExerciseId: 'e1' } },
    );
    expect(restOverCheer(s, byId, 'kg', 'strict', null, () => 0)!.line).toBe('Rest’s up, Barbell back squat set 1: 100 kg × 5. Go. Now.');
    const all = session([ex('e1', 'barbell-bench-press', [set('a', { completed: true })])], { rest: { endsAt: 1, durationMs: 1, forExerciseId: 'e1' } });
    expect(restOverCheer(all, byId, 'kg')).toBeNull();
  });

  it('next set on an exercise flagged "Felt discomfort" → a caring rest line', () => {
    const s = session([ex('e1', 'barbell-bench-press', [set('a', { completed: true }), set('b')], { discomfort: true })], { rest: { endsAt: 1, durationMs: 1, forExerciseId: 'e1' } });
    const c = restOverCheer(s, byId, 'kg', 'strict', null, () => 0)!;
    expect(c.situation).toBe('rest_over_discomfort');
    expect(c.line).toMatch(/^Rest’s up, Barbell bench press set 2: 60 kg × 8\. /);
  });
});
