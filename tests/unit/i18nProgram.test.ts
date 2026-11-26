import { afterEach, describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { setLanguage, t } from '@/i18n';
import { generateProgram, regenerateTemplates, suggestProgramName } from '@/domain/program/generator';
import { resolveSplit, splitOptions } from '@/domain/program/splits';
import { createProgram, restoreVersion } from '@/domain/program/program';
import {
  CALIBRATION_CUE, currentRationale, exerciseCue, exerciseNote, isGeneratedProgressionText, prescriptionText, restText, weekdaysText, WARMUP_SECONDARY,
} from '@/domain/program/explain';
import { activityName, localizeGeneratedText, programDisplayName, sessionDisplayFocus, sessionDisplayName } from '@/domain/program/localize';
import { progressionRuleText } from '@/domain/progression';
import type { OnboardingAnswers, Prescription } from '@/domain/types';

const START = '2026-11-02';
function answers(over: Partial<OnboardingAnswers> = {}): OnboardingAnswers {
  return {
    displayName: 'Test',
    units: { weight: 'kg', length: 'cm', distance: 'km' },
    goal: 'build_muscle',
    experience: 'intermediate',
    totalDaysPerWeek: 3,
    liftingDaysPerWeek: 3,
    availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
    preferredLiftingWeekdays: [],
    sessionMinutes: 60,
    location: 'full_gym',
    equipment: [],
    preferredActivities: [],
    enjoyedExerciseIds: [],
    excludedExerciseIds: [],
    limitations: [],
    activityLevel: 'moderate',
    wantsNutrition: false,
    diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 },
    ...over,
  };
}
const gen = (over: Partial<OnboardingAnswers> = {}, variant = 0) => generateProgram(answers(over), EXERCISES, { startDate: START, variant });

afterEach(() => setLanguage('en'));

describe('generated program text in Icelandic', () => {
  it('stored plan data does not depend on the UI language', () => {
    const cases: Partial<OnboardingAnswers>[] = [
      {},
      { goal: 'endurance', liftingDaysPerWeek: 2, totalDaysPerWeek: 5, endurance: { activity: 'cycle', recentMinutes: 30, recentDistanceKm: 12.5 } },
      { experience: 'new', location: 'minimal', equipment: ['dumbbell'], sessionMinutes: 30, limitations: ['knee'], preferredActivities: ['cycle', 'yoga'], totalDaysPerWeek: 5 },
    ];
    for (const c of cases) {
      setLanguage('en');
      const en = gen(c, 2);
      const enName = suggestProgramName(answers(c), en);
      setLanguage('is');
      const is = gen(c, 2);
      expect(is).toEqual(en);
      expect(suggestProgramName(answers(c), is)).toBe(enName);
    }
    setLanguage('is');
    const v = gen();
    expect(v.reason).toBe('Generated from onboarding');
    expect(v.rationale[0]).toBe('Built to help you build muscle, for someone intermediate.');
    const p = createProgram(answers(), v, START, 'x', 'generated');
    expect(restoreVersion(p, 1).versions[1].reason).toBe('Restored version 1');
  });

  it('renders the rationale, warnings, names and cues of a new plan in Icelandic', () => {
    setLanguage('is');
    const v = gen({ availableWeekdays: [1, 3, 5], preferredLiftingWeekdays: [1, 3, 5] }, 3);
    const shown = currentRationale(v.rationale, false);
    expect(shown[0]).toBe('Áætlunin hjálpar þér að byggja upp vöðva. Reynslustig: nokkur reynsla.');
    expect(shown).toContain('Styrktardagar: mán., mið. og fös. Aðeins dagar sem þú sagðir að hentuðu.');
    expect(shown).toContain(
      'Allur líkaminn A/B/C: Þrjár æfingar fyrir allan líkamann (A, B og C). Þú æfir aðallyfturnar oft en gerir færri æfingar í hvert sinn. Þetta er sjálfgefna skiptingin sem við mælum með fyrir 3 styrktardaga í viku. Þú getur valið aðra skiptingu.',
    );
    expect(shown).toContain(t('program.rationale.fullGym'));
    expect(shown).toContain('Þetta er 8 vikna áætlun. Í viku 8 biðjum við þig um að meta hvernig æfingarnar gengu, hvar framfarir urðu og hvort breyta eigi dögum eða æfingum.');
    // The progression sentence still comes from the progression engine (one description).
    expect(shown).toContain(currentRationale([progressionRuleText(false)], false)[0]);
    // Nothing generated is left in English.
    for (const line of [...shown, ...v.warnings.map((w) => localizeGeneratedText(w))]) expect(line).not.toMatch(/ and |Built to help|Lifting on/);
    expect(localizeGeneratedText(v.reason)).toBe('Búið til úr upphafssvörum (æfingum skipt út 3 sinnum)');

    const names = v.templates.map((s) => sessionDisplayName(s));
    expect(names).toEqual(['Allur líkaminn A', 'Allur líkaminn B', 'Allur líkaminn C']);
    expect(sessionDisplayFocus(v.templates[0])).toBe('Allur líkaminn');
    expect(programDisplayName(suggestProgramName(answers(), v))).toBe('Allur líkaminn A/B/C');
    expect(suggestProgramName(answers(), v, 'is')).toBe('Allur líkaminn A/B/C');
  });

  it('endurance plans: enum-based activity names, notes with a decimal comma, plural by session count', () => {
    setLanguage('is');
    const v = gen({ goal: 'endurance', liftingDaysPerWeek: 2, totalDaysPerWeek: 4, endurance: { activity: 'cycle', recentMinutes: 30, recentDistanceKm: 12.5 } });
    const easy = v.templates.find((s) => s.id === 'end:easy')!;
    const long = v.templates.find((s) => s.id === 'end:long')!;
    expect(easy.name).toBe('Easy ride');
    expect(sessionDisplayName(easy)).toBe('Rólegar hjólreiðar');
    expect(sessionDisplayName(long)).toBe(t('program.activity.cycle.long'));
    expect(localizeGeneratedText(easy.cardio!.notes)).toBe(
      'Æfðu í um 30 mín. á léttu álagi sem leyfir samræður (um 12,5 km er gott viðmið). Þegar það er orðið þægilegt skaltu bæta um 5–10% við næstu viku. Haltu óbreyttu álagi fjórðu hverja viku.',
    );
    const shown = currentRationale(v.rationale, false);
    expect(shown).toContain('Aðalhreyfing: hjólreiðar. 2 æfingar á viku. Áætlunin byrjar á 30 mínútum sem þú hefur nýlega ráðið vel við og eykst smám saman.');
    expect(programDisplayName(suggestProgramName(answers({ goal: 'endurance', endurance: { activity: 'cycle' } }), v))).toBe('Úthald og styrkur: Hjólreiðar');
    expect(activityName('cycle', 'steady')).toBe('Hjólreiðar á jöfnu álagi');
  });

  it('displays historical English generated text in Icelandic (exact match only)', () => {
    setLanguage('is');
    expect(localizeGeneratedText('Built to help you get stronger (with build muscle as a secondary goal), for someone returning after a break.')).toBe(
      'Áætlunin hjálpar þér að auka styrk. Aukamarkmið: byggja upp vöðva. Reynslustig: aftur af stað eftir hlé.',
    );
    expect(localizeGeneratedText('Lifting on Mon, Wed and Fri; easier days on Tue and Sat: only days you said you’re available.')).toBe(
      'Styrktardagar: mán., mið. og fös. Léttari dagar: þri. og lau. Aðeins dagar sem þú sagðir að hentuðu.',
    );
    expect(localizeGeneratedText('Compromise: chest is trained about once a week in this plan.')).toBe(
      'Málamiðlun: þessi vöðvahópur fær þjálfun um einu sinni í viku í áætluninni: brjóst.',
    );
    expect(localizeGeneratedText('Your available days make back-to-back lifting unavoidable (Mon–Tue). Keep the second day conservative and stop sets with 3 reps in reserve.')).toContain('(mán.–þri.)');
    expect(localizeGeneratedText('Restored version 3')).toBe('Útgáfa 3 endurheimt');
    expect(localizeGeneratedText('Regenerated Upper A and Lower B')).toBe('Æfingar endurgerðar: Efri líkami A og Neðri líkami B');
    expect(localizeGeneratedText('Easy walk')).toBe('Róleg ganga');
    expect(localizeGeneratedText(`If these muscles haven’t worked yet today, do one lighter set of 8 first. ${CALIBRATION_CUE}`)).toBe(
      `${t('program.explain.warmupSecondary')} ${t('program.explain.calibrationCue')}`,
    );
    // Unknown, user-written or merely similar text is shown exactly as stored.
    for (const s of ['My heavy day', 'Coach note: Easy walk after dinner', 'Built to help you dance, for someone intermediate.', 'Lifting on Mon and Funday: only days you said you’re available.'])
      expect(localizeGeneratedText(s)).toBe(s);
    // English UI is unchanged.
    setLanguage('en');
    expect(localizeGeneratedText('Easy walk')).toBe('Easy walk');
  });

  it('keeps exact-English recognisers working and localizes cues for display', () => {
    setLanguage('is');
    const v = gen();
    expect(v.rationale.some(isGeneratedProgressionText)).toBe(true);
    const rx = v.templates[0].exercises.find((x) => x.priority === 2 && x.calibrate)!;
    expect(rx.warmup).toBe(`${WARMUP_SECONDARY} ${CALIBRATION_CUE}`);
    expect(exerciseCue(rx)).toEqual({ cue: null, generic: true });
    expect(exerciseNote(rx)).toBeNull();
    const main = v.templates[0].exercises.find((x) => x.priority === 1)!;
    expect(exerciseCue(main).cue).toMatch(/^Hitaðu upp|^Gerðu eitt/);
    expect(exerciseCue({ warmup: 'Two easy sets with the bar.' })).toEqual({ cue: 'Two easy sets with the bar.', generic: false });
    expect(exerciseNote({ notes: 'Start with bodyweight only. The app suggests added load when your sets show you’re ready.' })).toBe(t('program.generator.bodyweightStart'));
    expect(exerciseNote({ notes: 'Pause at the bottom' })).toBe('Pause at the bottom');
  });

  it('formats prescriptions, rests and weekday lists for Icelandic', () => {
    setLanguage('is');
    const rx = { sets: 3, repMin: 8, repMax: 12, targetRir: 2, restSec: 90 } as Prescription;
    expect(prescriptionText(rx)).toBe('3 × 8–12 · RIR 2 · hvíld 1:30 mín.');
    expect(restText(45)).toBe('45 sek.');
    expect(restText(120)).toBe('2 mín.');
    expect(weekdaysText([5, 1, 3])).toBe('mán., mið. og fös.');
    setLanguage('en');
    expect(prescriptionText(rx)).toBe('3 × 8–12 · RIR 2 · rest 1:30 min');
    expect(weekdaysText([5, 1, 3])).toBe('Mon, Wed and Fri');
  });

  it('split choices: Icelandic labels and trade-offs at render time; stored adjustment message stays English', () => {
    setLanguage('is');
    const opts = splitOptions({ goal: 'build_muscle', experience: 'new' }, 2);
    expect(opts.map((o) => o.label)).toEqual(['Allur líkaminn A/B', 'Efri / neðri líkami']);
    expect(opts[1].tradeoff).toBe(`${t('program.split.tradeoff.ul2')} ${t('program.split.tradeoff.newer')}`);
    const r = resolveSplit({ goal: 'build_muscle', experience: 'intermediate', splitPreference: 'ppl3' }, 1);
    expect(r.adjustment?.message).toBe('Push / Pull / Legs doesn’t fit 1 lifting day, so the plan uses the closest structure: Full-body session.');
    expect(localizeGeneratedText(r.adjustment!.message)).toBe(
      'Skiptingin „Pressur / tog / fætur“ passar ekki við 1 styrktardag. Áætlunin notar því líkustu skiptinguna: Allur líkaminn.',
    );
  });

  it('regenerated sessions keep stored English names and reason', () => {
    setLanguage('is');
    const v = gen();
    const r = regenerateTemplates(v, [v.templates[0].id], answers(), EXERCISES, 1);
    expect(r.reason).toBe('Regenerated Full body A');
    expect(localizeGeneratedText(r.reason)).toBe('Æfingar endurgerðar: Allur líkaminn A');
  });
});
