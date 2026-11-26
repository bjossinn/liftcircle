/**
 * Coach cheers in Icelandic (roadmap item 8): every line the module can produce comes from the Icelandic dictionary,
 * rep-count lines use the Icelandic plural forms (1, 21 → one; 2, 11 → other), the next-set label, record details and
 * numbers are localized, and the English output is unchanged for a fixed seed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as cheers from '@/domain/coachCheers';
import { CHEER_KEYS, cheerForSet, nextSet, pickLine, recordForSet, restOverCheer, type CheerSituation } from '@/domain/coachCheers';
import { EXERCISES } from '@/data/exercises';
import { EN, IS, setLanguage } from '@/i18n';
import type { CoachStyle, LoggedSet, SessionExercise, WeightUnit, WorkoutSession } from '@/domain/types';

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const STYLES: CoachStyle[] = ['supportive', 'balanced', 'strict'];
const SITUATIONS = Object.keys(CHEER_KEYS) as CheerSituation[];
const ISD = IS as Record<string, string>;
const END = EN as Record<string, string>;

const set = (id: string, over: Partial<LoggedSet> = {}): LoggedSet => ({ id, type: 'normal', weightKg: 60, entered: { value: 60, unit: 'kg' }, reps: 8, completed: false, ...over });
const ex = (id: string, exerciseId: string, sets: LoggedSet[], over: Partial<SessionExercise> = {}): SessionExercise => ({
  id, exerciseId, order: 0, prescription: { sets: sets.length, repMin: 8, repMax: 10, targetRir: 2, restSec: 90 }, sets, ...over,
});
const session = (exercises: SessionExercise[], over: Partial<WorkoutSession> = {}): WorkoutSession => ({
  id: 'now', createdAt: 1, updatedAt: 1, name: 'Upper A', status: 'active', date: '2026-10-30', timeZone: 'UTC', startedAt: Date.parse('2026-10-30T17:00:00Z'), pausedTotalMs: 0, exercises, ...over,
});
const past = (exerciseId: string, over: Partial<LoggedSet>): WorkoutSession =>
  session([ex('old', exerciseId, [set('o1', { completed: true, ...over })])], { id: 'past', status: 'completed', date: '2026-10-23', startedAt: Date.parse('2026-10-23T17:00:00Z') });

/** One done set on `exerciseId` with an open set after it, compared with one earlier session. */
const recordCase = (exerciseId: string, done: Partial<LoggedSet>, before: Partial<LoggedSet>) => ({
  s: session([ex('e1', exerciseId, [set('a', { completed: true, ...done }), set('b', done)])]),
  history: [past(exerciseId, before)],
});
const RECORD_CASES = {
  heaviest: recordCase('barbell-bench-press', { weightKg: 62.5, entered: { value: 62.5, unit: 'kg' } }, { weightKg: 60 }),
  e1rm: recordCase('barbell-bench-press', { reps: 10 }, { reps: 8 }),
  repsAtWeight: recordCase('barbell-bench-press', { reps: 12 }, { reps: 11 }),
  mostReps: recordCase('bodyweight-squat', { weightKg: undefined, entered: undefined, reps: 21 }, { weightKg: undefined, entered: undefined, reps: 15 }),
  longest: recordCase('plank', { weightKg: undefined, entered: undefined, reps: undefined, durationSec: 90 }, { weightKg: undefined, entered: undefined, reps: undefined, durationSec: 60 }),
  longestShort: recordCase('plank', { weightKg: undefined, entered: undefined, reps: undefined, durationSec: 45 }, { weightKg: undefined, entered: undefined, reps: undefined, durationSec: 30 }),
  leastAssist: recordCase('assisted-pull-up', { weightKg: 20, entered: { value: 20, unit: 'kg' } }, { weightKg: 30, entered: { value: 30, unit: 'kg' } }),
  noAssist: recordCase('assisted-pull-up', { weightKg: 0, entered: { value: 0, unit: 'kg' } }, { weightKg: 10, entered: { value: 10, unit: 'kg' } }),
};

/** Every distinct kind of output, for a fixed seed: each line of each situation/style, set cheers, rest-over and records. */
function produceAll(m: typeof cheers): string[] {
  const out: string[] = [];
  const vars = { record: 'R', next: 'N', set: 'S' };
  for (const sit of SITUATIONS) for (const st of STYLES) {
    const n = CHEER_KEYS[sit][st].length;
    for (let i = 0; i < n; i++) {
      const r = () => (i + 0.5) / n;
      out.push(m.pickLine(sit, st, { ...vars, reps: '10' }, null, r));
      if (sit === 'top_of_range') for (const reps of [1, 2, 11, 21]) out.push(m.pickLine(sit, st, { reps: String(reps) }, null, r));
    }
  }
  for (const [name, c] of Object.entries(RECORD_CASES)) for (const unit of ['kg', 'lb'] as WeightUnit[]) {
    out.push(`${name}/${unit}: ${m.recordForSet(c.s, 'e1', 'a', c.history, byId, unit)}`);
    for (const st of STYLES) out.push(m.cheerForSet({ session: c.s, seId: 'e1', setId: 'a', style: st, history: c.history, byId, unit, rand: () => 0.3 })?.line ?? '-');
  }
  const rest = (sets: LoggedSet[], over: Partial<SessionExercise> = {}) =>
    session([ex('e1', 'barbell-bench-press', [set('a', { completed: true }), ...sets], over)], { rest: { endsAt: 1, durationMs: 1, forExerciseId: 'e1' } });
  const restCases = [
    rest([set('b')]),
    rest([set('b', { weightKg: 61.25, entered: { value: 61.25, unit: 'kg' } })]),
    rest([set('b', { weightKg: undefined, entered: undefined, reps: 1 })]),
    rest([set('b', { weightKg: undefined, entered: undefined, reps: undefined })], { prescription: { sets: 2, repMin: 21, repMax: 21, targetRir: 2, restSec: 90 } }),
    rest([set('b', { weightKg: undefined, entered: undefined, reps: undefined, durationSec: 45 })]),
    rest([set('b', { weightKg: undefined, entered: undefined, reps: undefined })]),
    rest([set('b')], { discomfort: true }),
    session([ex('e1', 'no-such-exercise', [set('a')])]),
  ];
  for (const s of restCases) for (const unit of ['kg', 'lb'] as WeightUnit[]) {
    out.push(m.nextSet(s, byId, unit, 'e1')?.label ?? '-');
    for (const st of STYLES) out.push(m.restOverCheer(s, byId, unit, st, null, () => 0.6)?.line ?? '-');
  }
  return out;
}
/** cyrb53: a small stable 53-bit string hash (no Node crypto types in the app tsconfig). */
function digest(lines: string[]): string {
  const str = lines.join('\n');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${lines.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)}`;
}

afterEach(() => setLanguage('en'));

describe('English output is unchanged', () => {
  it('matches the pre-localization module for a fixed seed', () => {
    setLanguage('en');
    const all = produceAll(cheers);
    // Spot checks of exact English (the full sweep is pinned by the digest, recorded from the pre-i18n module).
    expect(all).toContain('heaviest/kg: 62.5 kg × 8');
    expect(all).toContain('e1rm/kg: est. 1RM 80 kg (Epley)');
    expect(all).toContain('repsAtWeight/kg: 12 reps at 60 kg');
    expect(all).toContain('mostReps/kg: 21 reps in a set');
    expect(all).toContain('longest/kg: longest 1:30 min');
    expect(all).toContain('longestShort/kg: longest 45 s');
    expect(all).toContain('leastAssist/kg: least assistance 20 kg');
    expect(all).toContain('noAssist/kg: least assistance none');
    expect(all).toContain('Barbell bench press set 2: 61.25 kg × 8');
    expect(all).toContain('Barbell bench press set 2: 45 s');
    expect(all).toContain('Next exercise set 1: 60 kg × 8');
    expect(digest(all)).toBe(ENGLISH_DIGEST);
  });
});

describe('Icelandic', () => {
  it('every preset line comes from the Icelandic dictionary', () => {
    setLanguage('is');
    for (const sit of SITUATIONS) for (const st of STYLES) {
      const n = CHEER_KEYS[sit][st].length;
      for (let i = 0; i < n; i++) {
        const key = CHEER_KEYS[sit][st][i];
        const line = pickLine(sit, st, { record: 'R', reps: 2, next: 'N', set: 'S' }, null, () => (i + 0.5) / n);
        const template = ISD[key] ?? ISD[`${key}.other`];
        expect(template, key).toBeDefined();
        expect(line).toBe(template.replace('{{record}}', 'R').replace('{{reps}}', '2').replace('{{next}}', 'N').replace('{{set}}', 'S'));
        expect(line).not.toBe(END[key] ?? END[`${key}.other`]);
      }
    }
  });

  it('rep-count lines use Intl plural forms: 1 and 21 → one, 2 and 11 → other', () => {
    setLanguage('is');
    const pick = (reps: number) => pickLine('top_of_range', 'balanced', { reps }, null, () => 0);
    expect(pick(1)).toBe('1 endurtekning, efri mörkum náð.');
    expect(pick(21)).toBe('21 endurtekning, efri mörkum náð.');
    expect(pick(2)).toBe('2 endurtekningar, efri mörkum náð.');
    expect(pick(11)).toBe('11 endurtekningar, efri mörkum náð.');
    // Lines without a rep-count noun have a single form.
    expect(pickLine('top_of_range', 'balanced', { reps: 11 }, null, () => 3.5 / 15)).toBe(ISD['workout.cheer.top_of_range.balanced.04'].replace('{{reps}}', '11'));
    // Next-set detail when only reps are known.
    const s = (reps: number) =>
      session([ex('e1', 'bodyweight-squat', [set('a', { weightKg: undefined, entered: undefined, reps, completed: true }), set('b', { weightKg: undefined, entered: undefined, reps })])]);
    expect(nextSet(s(1), byId, 'kg')!.detail).toBe('1 endurtekning');
    expect(nextSet(s(21), byId, 'kg')!.detail).toBe('21 endurtekning');
    expect(nextSet(s(2), byId, 'kg')!.detail).toBe('2 endurtekningar');
    expect(nextSet(s(11), byId, 'kg')!.detail).toBe('11 endurtekningar');
  });

  it('set cheers, record details and the rest-over line are Icelandic with localized numbers', () => {
    setLanguage('is');
    const h = RECORD_CASES.heaviest;
    expect(recordForSet(h.s, 'e1', 'a', h.history, byId, 'kg')).toBe('62,5 kg × 8');
    const c = cheerForSet({ session: h.s, seId: 'e1', setId: 'a', style: 'balanced', history: h.history, byId, unit: 'kg', rand: () => 0 })!;
    expect(c).toEqual({ situation: 'pr', line: 'Nýtt met: 62,5 kg × 8. Vel gert.' });
    const r = (k: keyof typeof RECORD_CASES) => recordForSet(RECORD_CASES[k].s, 'e1', 'a', RECORD_CASES[k].history, byId, 'kg');
    expect(r('e1rm')).toBe('Áætlað 1RM: 80 kg (Epley)');
    expect(r('repsAtWeight')).toBe('12 endurtekningar með 60 kg');
    expect(r('mostReps')).toBe('21 endurtekning í setti');
    expect(r('longest')).toBe('lengsti tími 1:30 mín.');
    expect(r('longestShort')).toBe('lengsti tími 45 sek.');
    expect(r('leastAssist')).toBe('minnsta aðstoð 20 kg');
    expect(r('noAssist')).toBe('án aðstoðar');

    const rest = session([ex('e1', 'barbell-bench-press', [set('a', { completed: true }), set('b', { weightKg: 61.25, entered: { value: 61.25, unit: 'kg' } })])], { rest: { endsAt: 1, durationMs: 1, forExerciseId: 'e1' } });
    expect(nextSet(rest, byId, 'kg')!.label).toBe('Barbell bench press · sett 2: 61,25 kg × 8');
    expect(restOverCheer(rest, byId, 'kg', 'balanced', null, () => 0)!.line).toBe('Hvíldinni lokið. Barbell bench press · sett 2: 61,25 kg × 8. Af stað.');
    const timed = session([ex('e1', 'plank', [set('a', { completed: true }), set('b', { weightKg: undefined, entered: undefined, reps: undefined, durationSec: 45 })])]);
    expect(nextSet(timed, byId, 'kg')!.detail).toBe('45 sek.');
    const unknown = session([ex('e1', 'no-such-exercise', [set('a', { weightKg: undefined, entered: undefined, reps: undefined })])]);
    expect(nextSet(unknown, byId, 'kg')!.label).toBe('Næsta æfing · sett 1');
  });

  it('nothing the module produces is English', () => {
    setLanguage('is');
    const all = produceAll(cheers);
    const english = new Set(SITUATIONS.flatMap((sit) => STYLES.flatMap((st) => CHEER_KEYS[sit][st].map((k) => END[k] ?? END[`${k}.other`]))));
    const enWords = /\b(reps?|set|Rest’s|record|est\.|longest|least|assistance|none|Next exercise|range|done)\b/;
    for (const line of all) {
      const text = line.replace(/^\w+\/(kg|lb): /, '').replace(/Barbell (bench press|back squat)|Bodyweight squat|Plank|Assisted pull-up/g, '');
      expect(english.has(line), line).toBe(false);
      expect(text, line).not.toMatch(enWords);
    }
  });

  it('never picks the same line twice in a row in Icelandic either', () => {
    setLanguage('is');
    for (const sit of SITUATIONS) for (const st of STYLES) {
      let last: string | null = null;
      for (let i = 0; i < 30; i++) {
        const line = pickLine(sit, st, { record: '60 kg × 8', reps: 10, next: 'Row', set: 'Row · sett 2' }, last, () => [0, 0.999, 0.5][i % 3]);
        expect(line).not.toBe(last);
        last = line;
      }
    }
  });
});

/** digest of produceAll() in English, recorded from the pre-localization coachCheers.ts (git HEAD before roadmap item 8). */
const ENGLISH_DIGEST = '719:18f2f2a7e46a02';
