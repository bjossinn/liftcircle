/**
 * Icelandic wiring for the logger domain (spec §3): progression text rendered from the single engine's result
 * (reason codes, never parsed English), locale formatting that never changes the arithmetic (61.25 kg → "61,25 kg"),
 * Intl.PluralRules count forms, catalog metadata labels/load notes, logged-set text, records, activity labels, and
 * Icelandic search terms in the exercise picker.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, tp } from '@/i18n';
import { EXERCISES } from '@/data/exercises';
import {
  EQUIPMENT_LABELS, exerciseSubtitle, LIMITATION_LABELS, loadConventionNote, MUSCLE_LABELS, normalizeText, searchExercises,
} from '@/data/exerciseMeta';
import {
  actionLabel, effortCaveat, formatLoad, nextTargetLabel, nextTargetText, PROGRESSION_STRINGS, progressionRuleText, suggestionReasonText,
  suggestNext, type Suggestion,
} from '@/domain/progression';
import { detectRecords, personalRecords, recordKindLabel, volumeConventions } from '@/domain/stats';
import { activityLabel, ACTIVITY_TYPES } from '@/domain/activities';
import { formatLoggedSet } from '@/features/exercises/useExerciseData';
import { formatWeight } from '@/domain/units';
import type { Exercise, LoggedSet, SessionExercise, WorkoutSession } from '@/domain/types';

afterEach(() => setLanguage('en'));

const ex = (id: string) => {
  const e = EXERCISES.find((x) => x.id === id);
  if (!e) throw new Error(`missing ${id}`);
  return e as Exercise;
};
const squat = ex('barbell-back-squat');
const assisted = ex('assisted-pull-up');
const dip = ex('weighted-dip');
const rx = { sets: 3, repMin: 8, repMax: 12, targetRir: 2 };

let n = 0;
type S = { w?: number | null; r?: number | null; rir?: number | null; d?: number };
const sets = (k: number, s: S): LoggedSet[] =>
  Array.from({ length: k }, () => ({ id: `set${n++}`, type: 'normal', weightKg: s.w ?? null, reps: s.r ?? null, rir: s.rir ?? null, durationSec: s.d ?? null, completed: true }));
const se = (exerciseId: string, ss: LoggedSet[], extra: Partial<SessionExercise> = {}): SessionExercise => ({
  id: `se${n++}`, exerciseId, order: 0, prescription: { ...rx, restSec: 90 }, sets: ss, ...extra,
});

describe('progression: next targets and loads', () => {
  it('Icelandic "Næst:" line with a decimal comma; English unchanged', () => {
    const h = [se(squat.id, sets(3, { w: 60, r: 12, rir: 2 })), se(squat.id, sets(3, { w: 60, r: 12, rir: 2 }))];
    const s = suggestNext(squat, rx, h, { unit: 'kg' });
    expect(s.loadKg).toBe(62.5);
    expect(nextTargetText(s, squat, 'kg')).toBe('Next: 62.5 kg × 8 reps');
    expect(nextTargetText(s, squat, 'kg', 'is')).toBe('Næst: 62,5 kg × 8 endurtekningar');
    expect(actionLabel(s.action, 'is')).toBe('Auka þyngd');
    expect(actionLabel(s.action)).toBe('Increase load');
  });

  it('61.25 kg on a 1.25 kg grid renders "61,25 kg" (never rounded for translation)', () => {
    const h = [se(squat.id, sets(3, { w: 60, r: 12, rir: 2 })), se(squat.id, sets(3, { w: 60, r: 12, rir: 2 }))];
    const s = suggestNext(squat, rx, h, { unit: 'kg', incrementKg: 1.25 });
    expect(s.loadKg).toBe(61.25);
    expect(formatLoad(61.25, 'kg', 'is')).toBe('61,25 kg');
    expect(formatLoad(61.25, 'kg')).toBe('61.25 kg');
    expect(nextTargetLabel(s, squat, 'kg', 'is')).toBe('61,25 kg × 8 endurtekningar');
    expect(formatWeight(61.25, 'kg', { value: 61.25, unit: 'kg' }, 'is')).toBe('61,25 kg');
    expect(formatLoad(lbToKgExact(135), 'lb', 'is')).toBe('135 lb');
  });

  it('bodyweight, added load, assistance and calibration labels', () => {
    const base: Suggestion = { action: 'add_reps', reason: '', targetReps: 10 };
    expect(nextTargetLabel({ ...base, loadKg: 0 }, dip, 'kg', 'is')).toBe('eigin þyngd × 10 endurtekningar');
    expect(nextTargetLabel({ ...base, loadKg: 7.5 }, dip, 'kg', 'is')).toBe('+7,5 kg × 10 endurtekningar');
    expect(nextTargetLabel({ ...base, loadKg: 25 }, assisted, 'kg', 'is')).toBe('25 kg aðstoð × 10 endurtekningar');
    expect(nextTargetLabel({ ...base, action: 'calibrate' }, squat, 'kg', 'is')).toBe('finndu byrjunarþyngdina');
    expect(actionLabel('calibrate', 'is')).toBe('Finna viðmið');
  });

  it('Icelandic count forms follow Intl.PluralRules (1, 21, 101 singular; 0, 2, 11, 111 plural)', () => {
    const reps = PROGRESSION_STRINGS.is.reps;
    for (const c of [1, 21, 31, 101]) expect(reps(c)).toBe(`${c} endurtekning`);
    for (const c of [0, 2, 11, 111]) expect(reps(c)).toBe(`${c} endurtekningar`);
    setLanguage('is');
    expect(tp('workout.picker.results', 21)).toBe('21 niðurstaða');
    expect(tp('workout.picker.results', 11)).toBe('11 niðurstöður');
  });

  it('rule text and the effort caveat come from the dictionary; English stays verbatim', () => {
    expect(progressionRuleText(false, 'is')).toMatch(/^Við notum tvöfalda framvindu/);
    expect(progressionRuleText(false)).toMatch(/^Progression uses double progression/);
    const s = suggestNext(squat, rx, [se(squat.id, sets(3, { w: 60, r: 12 }))], { unit: 'kg', beginner: true });
    expect(effortCaveat(s, 2, 'is')).toBe('Áreynsla var ekki skráð. Auktu aðeins ef þér fannst þú eiga um 2 í varasjóði í lok þessara setta.');
  });
});

describe('progression: reasons from the engine’s reason code', () => {
  const effortSentences = (text: string) => ['Áreynslan var eins og áætlað var.', 'Áreynsla var aðeins skráð', 'Áreynsla var ekki skráð'].filter((x) => text.includes(x)).length;

  it('standard increase: one complete sentence plus exactly one effort sentence (recorded)', () => {
    const h = [se(squat.id, sets(3, { w: 60, r: 12, rir: 2 })), se(squat.id, sets(3, { w: 60, r: 12, rir: 2 }))];
    const s = suggestNext(squat, rx, h, { unit: 'kg', incrementKg: 1.25 });
    expect(s.reasonCode?.key).toBe('progression.reason.increaseLoadedStandard');
    const text = suggestionReasonText(s, 'is');
    expect(text).toBe(
      'Þú náðir 12 í öllum 3 settunum með 60 kg á tveimur æfingum. Prófaðu 61,25 kg, stefndu fyrst á að ná 8 í hverju setti og fjölgaðu svo endurtekningum aftur. Áreynslan var eins og áætlað var.',
    );
    expect(effortSentences(text)).toBe(1);
    // English is the engine's own text, unchanged.
    expect(suggestionReasonText(s)).toBe(s.reason);
    expect(s.reason).toBe('You reached 12 reps on all 3 sets at 60 kg in two sessions at the target effort. Try 61.25 kg and aim for 8 reps, then build back up.');
  });

  it('beginner increase without logged effort ends with the not-recorded sentence, once', () => {
    const s = suggestNext(squat, rx, [se(squat.id, sets(3, { w: 60, r: 12 }))], { unit: 'kg', beginner: true });
    const text = suggestionReasonText(s, 'is');
    expect(text).toBe(
      'Þú náðir 12 í öllum 3 settunum með 60 kg á síðustu æfingu. Fyrir byrjendur nægir ein vel heppnuð æfing. Prófaðu 62,5 kg, stefndu fyrst á að ná 8 í hverju setti og fjölgaðu svo endurtekningum aftur. Áreynsla var ekki skráð og því byggir tillagan aðeins á endurtekningum og þyngd. Auktu aðeins ef þér fannst þú eiga um 2 í varasjóði í lok settanna.',
    );
    expect(effortSentences(text)).toBe(1);
  });

  it('partial effort on reduced assistance; added load from zero uses the "bæta við" variant', () => {
    const partial = [...sets(2, { w: 30, r: 12, rir: 2 }), ...sets(1, { w: 30, r: 12 })];
    const a = suggestNext(assisted, rx, [se(assisted.id, partial)], { unit: 'kg', beginner: true });
    expect(a.action).toBe('reduce_assistance');
    const at = suggestionReasonText(a, 'is');
    expect(at).toMatch(/^Þú náðir efri mörkum endurtekningabilsins á síðustu æfingu með 30 kg aðstoð\. .*Minnkaðu aðstoðina í 25 kg/);
    expect(at.endsWith('Áreynsla var aðeins skráð í sumum settum. Auktu aðeins ef þér fannst þú eiga um 2 í varasjóði í lok settanna.')).toBe(true);
    expect(effortSentences(at)).toBe(1);

    const d = suggestNext(dip, rx, [se(dip.id, sets(3, { w: 0, r: 12, rir: 2 })), se(dip.id, sets(3, { w: 0, r: 12, rir: 2 }))], { unit: 'kg' });
    expect(d.reasonCode?.key).toBe('progression.reason.increaseUnloadedStandard');
    expect(suggestionReasonText(d, 'is')).toMatch(/^Þú náðir 12 í öllum 3 settunum á tveimur æfingum\. Prófaðu að bæta við 2,5 kg,/);
  });

  it('non-increase reasons carry no effort sentence; discomfort is never softened', () => {
    const hold = suggestNext(squat, rx, [se(squat.id, sets(3, { w: 61.25, r: 10, rir: 2 }))], { unit: 'kg' });
    expect(suggestionReasonText(hold, 'is')).toBe(
      'Haltu sömu þyngd (61,25 kg). Reyndu að bæta við einni endurtekningu í settunum með fæstar endurtekningar þar til þú nærð 12 í öllum settum.',
    );
    const hurt = suggestNext(squat, rx, [se(squat.id, sets(3, { w: 60, r: 12 }), { discomfort: true })], { unit: 'kg' });
    expect(suggestionReasonText(hurt, 'is')).toMatch(/^Þú skráðir nýlega óþægindi og því leggjum við ekki til aukningu\./);
    const first = suggestNext(squat, rx, [], { unit: 'kg' });
    expect(suggestionReasonText(first, 'is')).toBe(
      'Engin þyngd hefur verið skráð: byrjaðu létt og þyngdu í litlum skrefum þar til þú átt um 2 í varasjóði eftir 8–12 endurtekningar. Skráðu það sem byrjunarþyngd.',
    );
  });

  it('a suggestion without a code (not from the engine) shows its stored text as is', () => {
    expect(suggestionReasonText({ reason: 'Coach note' }, 'is')).toBe('Coach note');
  });
});

describe('catalog metadata, load notes and search', () => {
  it('labels follow the current language; enum keys never change', () => {
    expect(MUSCLE_LABELS.shoulders).toBe('Shoulders');
    setLanguage('is');
    expect(MUSCLE_LABELS.shoulders).toBe('Axlarvöðvar');
    expect(EQUIPMENT_LABELS.band).toBe('Teygja');
    expect(LIMITATION_LABELS.shoulder).toBe('Axlir');
    expect(Object.keys(EQUIPMENT_LABELS)).toContain('pullup_bar');
    expect(exerciseSubtitle(ex('overhead-press'))).toContain('Stöng');
  });

  it('load-convention notes are complete approved sentences', () => {
    expect(loadConventionNote(ex('one-arm-dumbbell-row'), 'is')).toBe(
      'Skráðu þyngd handlóðsins sem þú heldur á. Endurtekningar eru taldar fyrir hvora hlið.',
    );
    expect(loadConventionNote(ex('barbell-back-squat'), 'is')).toBe('Skráðu heildarþyngdina með stönginni.');
    expect(loadConventionNote(ex('one-arm-dumbbell-row'), 'en')).toBe('Enter the weight of the single dumbbell you hold. Reps are per side.');
  });

  it('Icelandic queries find English catalog entries; English aliases keep working', () => {
    const ids = (q: string) => searchExercises(EXERCISES, q).map((e) => e.id);
    expect(ids('axlir')).toContain('overhead-press');
    expect(ids('Axlarvöðvar')).toContain('overhead-press');
    expect(ids('teygja')).toContain('band-row');
    expect(ids('hnébeygja')).toContain('barbell-back-squat');
    expect(ids('þríhöfði').length).toBeGreaterThan(0);
    expect(ids('shoulder press')).toContain('overhead-press');
    expect(ids('OHP')[0]).toBe('overhead-press');
    // Search does not depend on the UI language.
    setLanguage('is');
    expect(ids('axlir')).toContain('overhead-press');
    expect(ids('shoulders')).toContain('overhead-press');
    expect(normalizeText('Þríhöfði')).toBe('thrihofdi');
  });
});

describe('logged sets, records and activities', () => {
  const row = ex('one-arm-dumbbell-row');
  const set = (p: Partial<LoggedSet>): LoggedSet => ({ id: `s${n++}`, type: 'normal', weightKg: null, reps: null, completed: true, ...p });

  it('formatLoggedSet: localized /hlið suffix (never "/side") and decimal comma', () => {
    expect(formatLoggedSet(set({ weightKg: 22.5, reps: 8 }), row, 'kg', 'km', 'is')).toBe('22,5 kg × 8/hlið');
    expect(formatLoggedSet(set({ weightKg: 22.5, reps: 8 }), row, 'kg', 'km', 'en')).toBe('22.5 kg × 8/side');
    expect(formatLoggedSet(set({ reps: 8 }), squat, 'kg', 'km', 'is')).toBe('8 endurt. (þyngd ekki skráð)');
    expect(formatLoggedSet(set({ weightKg: 0, reps: 10 }), dip, 'kg', 'km', 'is')).toBe('Eigin þyngd × 10');
    expect(formatLoggedSet(set({ weightKg: 20, reps: 6 }), assisted, 'kg', 'km', 'is')).toBe('20 kg aðstoð × 6');
  });

  const session = (id: string, date: string, exercises: SessionExercise[]): WorkoutSession => ({
    id, createdAt: 1, updatedAt: 1, name: 'W', status: 'completed', date, timeZone: 'UTC', startedAt: Date.parse(`${date}T17:00:00Z`), pausedTotalMs: 0, exercises,
  });
  const bench = ex('barbell-bench-press');
  const byId = new Map<string, Exercise>([[bench.id, bench]]);

  it('record lines: catalog exercise name in the sentence language, Icelandic sentence and plural forms', () => {
    const h1 = session('h1', '2026-01-01', [se(bench.id, [set({ weightKg: 80, reps: 5 }), set({ weightKg: 70, reps: 20 })])]);
    const cur = session('c', '2026-01-08', [se(bench.id, [set({ weightKg: 82.5, reps: 5 }), set({ weightKg: 70, reps: 21 })])]);
    const hits = detectRecords(cur, [h1], byId, 'kg', 'is');
    expect(hits.find((h) => h.kind === 'heaviest')!.label).toBe('Bekkpressa með stöng: þyngsta sett 82,5 kg × 5');
    expect(hits.find((h) => h.kind === 'reps_at_weight')!.label).toBe('Bekkpressa með stöng: 21 endurtekning með 70 kg');
    expect(detectRecords(cur, [h1], byId, 'kg', 'en').find((h) => h.kind === 'reps_at_weight')!.label).toBe('Barbell bench press: 21 reps at 70 kg');
    expect(recordKindLabel('heaviest', 'is')).toBe('Þyngsta vinnusett');
    const pr = personalRecords([h1, cur], bench, 'kg', 'is');
    expect(pr.find((r) => r.kind === 'reps_at_weight' && r.value === 21)!.label).toBe('21 endurtekning með 70 kg');
    expect(volumeConventions('is')[0]).toBe('Upphitunarsett eru talin sérstaklega og telja ekki með í vinnusettum, æfingamagni eða metum.');
  });

  it('activity labels: dictionary labels, stored type and custom names unchanged', () => {
    setLanguage('is');
    expect(activityLabel({ type: 'run' })).toBe('Hlaup');
    expect(activityLabel({ type: 'custom', customName: 'Klifur' })).toBe('Klifur');
    expect(ACTIVITY_TYPES.find((x) => x.type === 'class')!.label).toBe('Hóptími');
    setLanguage('en');
    expect(activityLabel({ type: 'run' })).toBe('Run');
    expect(activityLabel({ type: 'custom' })).toBe('Custom activity');
  });
});

function lbToKgExact(lb: number) {
  return lb * 0.45359237;
}
