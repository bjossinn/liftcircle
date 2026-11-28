import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronLeft } from 'lucide-react';
import { Button, Card, IconButton, Notice, NumberInput, Page, SectionTitle, Segmented, Select, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import type { ActivityLevel, Goal, NutritionTargets, SexParam } from '@/domain/types';
import { cmToFtIn, formatWeight, fromKg, ftInToCm, round, toKg } from '@/domain/units';
import {
  ACTIVITY_FACTORS, GOAL_ADJUST_PCT, GOAL_LABELS, PROTEIN_RANGE, activityLabel, computeNutritionTargets, goalLabel, reconcileMacros,
} from '@/domain/nutrition/targets';
import { numberText, useT } from '@/i18n';
import { proteinDistribution } from '@/domain/nutrition/log';
import { useLatestWeightKg } from './shared';

type Mode = NutritionTargets['mode'];
type RefSource = 'current' | 'goal' | 'custom';

export default function TargetsPage() {
  const nav = useNavigate();
  const { accountReady } = useApp();
  const weight = useLatestWeightKg();
  const { t } = useT();
  return (
    <Page
      title={t('nutrition.home.targets')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)} iconSize="lg">
          <ChevronLeft />
        </IconButton>
      }
    >
      {!accountReady || weight === undefined ? <Spinner /> : <TargetsForm weightKg={weight} />}
    </Page>
  );
}

function TargetsForm({ weightKg }: { weightKg: number | null }) {
  const { account, updateAccount } = useApp();
  const toast = useToast();
  const { t, tp, language } = useT();
  const factorText = (v: number) => numberText(v, 3);
  const unit = account.settings.units.weight;
  const lengthUnit = account.settings.units.length;
  const p = account.profile;
  const n = account.nutrition;
  const restrictedReason = p.individualizedNutrition ? 'individualized' : null;

  const [mode, setMode] = useState<Mode>(account.settings.nutritionEnabled ? n.mode : 'none');
  const [age, setAge] = useState<number | null>(p.age ?? null);
  const [heightCm, setHeightCm] = useState<number | null>(p.heightCm ?? null);
  const [sex, setSex] = useState<SexParam | 'skip'>(p.sexParam ?? 'skip');
  const [activity, setActivity] = useState<ActivityLevel>(p.activityLevel ?? 'light');
  const [goal, setGoal] = useState<Goal>(p.goal ?? 'general_fitness');
  const [goalWeightKg, setGoalWeightKg] = useState<number | null>(p.targetWeightKg ?? null);
  const [perKg, setPerKg] = useState<number>(n.proteinPerKg || PROTEIN_RANGE.default);
  const [refSource, setRefSource] = useState<RefSource>(n.referenceWeightSource ?? (weightKg == null && p.targetWeightKg ? 'goal' : 'current'));
  const [customRefKg, setCustomRefKg] = useState<number | null>(n.referenceWeightSource === 'custom' ? (n.referenceWeightKg ?? null) : null);
  const [factor, setFactor] = useState<number | null>(n.activityFactor != null && n.activityFactor !== ACTIVITY_FACTORS[p.activityLevel ?? 'light'] ? n.activityFactor : null);
  const [adjPct, setAdjPct] = useState<number | null>(n.goalAdjustPct != null && n.goalAdjustPct !== GOAL_ADJUST_PCT[p.goal ?? 'general_fitness'] ? n.goalAdjustPct : null);
  const [meals, setMeals] = useState<number>(p.diet.mealsPerDay || n.mealsPerDay || 3);
  const [manual, setManual] = useState({ proteinG: n.proteinG ?? null, calories: n.calories ?? null, carbsG: n.carbsG ?? null, fatG: n.fatG ?? null });
  const [busy, setBusy] = useState(false);
  const under18 = age != null && age < 18;
  const restricted = restrictedReason ?? (under18 ? 'under_18' : null);

  const calc = useMemo(
    () =>
      computeNutritionTargets({
        age: age ?? undefined,
        weightKg: weightKg ?? undefined,
        heightCm: heightCm ?? undefined,
        sexParam: sex === 'skip' ? undefined : sex,
        activityLevel: activity,
        goal,
        mode: mode === 'protein_only' ? 'protein_only' : 'full',
        proteinPerKg: perKg,
        referenceWeightSource: refSource,
        referenceWeightKg: refSource === 'goal' ? (goalWeightKg ?? undefined) : refSource === 'custom' ? (customRefKg ?? undefined) : undefined,
        mealsPerDay: meals,
        individualizedNutrition: p.individualizedNutrition,
        activityFactor: factor ?? undefined,
        goalAdjustPct: adjPct ?? undefined,
        weightUnit: unit,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- language: the explanation text is in the app language
    [age, weightKg, heightCm, sex, activity, goal, mode, perKg, refSource, goalWeightKg, customRefKg, meals, p.individualizedNutrition, factor, adjPct, unit, language],
  );
  const manualCheck = reconcileMacros({
    calories: manual.calories ?? undefined,
    proteinG: manual.proteinG ?? undefined,
    carbsG: manual.carbsG ?? undefined,
    fatG: manual.fatG ?? undefined,
  });
  const effectiveMode: Mode = restricted && (mode === 'protein_only' || mode === 'full') ? 'manual' : mode;

  async function save() {
    setBusy(true);
    try {
      let nutrition: NutritionTargets;
      if (effectiveMode === 'none') nutrition = { ...n, mode: 'none', updatedAt: Date.now() };
      else if (effectiveMode === 'manual')
        nutrition = {
          ...n,
          mode: 'manual',
          proteinG: manual.proteinG ?? undefined,
          calories: manual.calories ?? undefined,
          carbsG: manual.carbsG ?? undefined,
          fatG: manual.fatG ?? undefined,
          proteinPerKg: perKg,
          mealsPerDay: meals,
          autoDisabledReason: restricted,
          updatedAt: Date.now(),
        };
      else nutrition = { ...calc.targets, mode: effectiveMode, activityFactor: factor ?? calc.targets.activityFactor, updatedAt: Date.now() };
      await updateAccount((a) => ({
        ...a,
        settings: { ...a.settings, nutritionEnabled: effectiveMode !== 'none' },
        profile: {
          ...a.profile,
          age: age ?? undefined,
          ageRecordedAt: age !== a.profile.age ? Date.now() : a.profile.ageRecordedAt,
          heightCm: heightCm ?? undefined,
          sexParam: sex === 'skip' ? undefined : sex,
          activityLevel: activity,
          goal,
          targetWeightKg: goalWeightKg ?? undefined,
          diet: { ...a.profile.diet, mealsPerDay: meals },
        },
        nutrition,
      }));
      toast.show(effectiveMode === 'none' ? t('nutrition.targets.nutrition_turned_off_your_food_log') : t('nutrition.targets.targets_saved'), { tone: 'success' });
    } catch {
      toast.show(t('foodLog.saveError'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const modeOptions: { value: Mode; label: string }[] = restricted
    ? [
        { value: 'none', label: t('ai.settings.off') },
        { value: 'manual', label: t('nutrition.targets.my_own') },
      ]
    : [
        { value: 'none', label: t('ai.settings.off') },
        { value: 'protein_only', label: t('progress.protein') },
        { value: 'full', label: t('nutrition.targets.full') },
        { value: 'manual', label: t('nutrition.targets.manual') },
      ];
  const ft = heightCm != null ? cmToFtIn(heightCm) : null;
  const perMeal = (effectiveMode === 'manual' ? manual.proteinG : calc.targets.proteinG) ?? null;

  return (
    <div className="flex flex-col">
      <Segmented label={t('nutrition.targets.nutrition_mode')} value={effectiveMode} onChange={setMode} options={modeOptions} />
      <p className="text-xs text-muted mt-2 px-1">
        {t(`nutrition.targets.mode_help.${effectiveMode}`)}
      </p>

      {restricted && (
        <Notice className="mt-3">
          {restricted === 'under_18'
            ? t('nutrition.targets.automatic_calorie_weight_loss_and_protein')
            : t('nutrition.targets.because_your_nutrition_needs_are_individual')}
        </Notice>
      )}

      {effectiveMode !== 'none' && (
        <>
          <SectionTitle>{t('nutrition.targets.your_details')}</SectionTitle>
          <Card className="p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>{t('nutrition.targets.current_weight')}</span>
              {weightKg != null ? (
                <span className="font-semibold tabular">{formatWeight(weightKg, unit)}</span>
              ) : (
                <Link to="/progress" className="text-accent font-medium min-h-9 inline-flex items-center">
                  {t('nutrition.targets.log_your_weight')}
                </Link>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <NumberInput label={t('nutrition.targets.age')} suffix={t('nutrition.targets.age_suffix')} decimals={false} min={10} max={110} value={age} onChange={setAge} />
              {lengthUnit === 'cm' ? (
                <NumberInput label={t('nutrition.targets.height')} suffix="cm" min={100} max={250} value={heightCm != null ? round(heightCm, 1) : null} onChange={setHeightCm} />
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <NumberInput label={t('nutrition.targets.height_ft')} suffix="ft" decimals={false} min={3} max={8} value={ft?.ft ?? null} onChange={(v) => setHeightCm(v == null ? null : ftInToCm(v, ft?.inch ?? 0))} />
                  <NumberInput label="in" suffix="in" min={0} max={11.9} value={ft?.inch ?? null} onChange={(v) => setHeightCm(ftInToCm(ft?.ft ?? 5, v ?? 0))} />
                </div>
              )}
            </div>
            {effectiveMode === 'full' && (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">{t('nutrition.targets.equation_variant')}</span>
                <Segmented<SexParam | 'skip'>
                  label={t('nutrition.targets.equation_variant')}
                  value={sex}
                  onChange={setSex}
                  options={[
                    { value: 'male', label: t('nutrition.targets.male') },
                    { value: 'female', label: t('nutrition.targets.female') },
                    { value: 'skip', label: t('activities.timer.skip') },
                  ]}
                />
                <p className="text-xs text-muted">{t('nutrition.targets.only_used_to_pick_the_mifflin')}</p>
              </div>
            )}
            <Select label={t('nutrition.targets.everyday_activity')} value={activity} onChange={(e) => setActivity(e.target.value as ActivityLevel)}>
              {(Object.keys(ACTIVITY_FACTORS) as ActivityLevel[]).map((a) => (
                <option key={a} value={a}>
                  {activityLabel(a)} (× {factorText(ACTIVITY_FACTORS[a])})
                </option>
              ))}
            </Select>
            <Select label={t('onboarding.goal.group')} value={goal} onChange={(e) => setGoal(e.target.value as Goal)}>
              {(Object.keys(GOAL_LABELS) as Goal[]).map((g) => (
                <option key={g} value={g}>
                  {goalLabel(g)}
                </option>
              ))}
            </Select>
            <NumberInput label={t('nutrition.targets.usual_meals_per_day')} decimals={false} min={1} max={6} value={meals} onChange={(v) => v != null && setMeals(v)} />
          </Card>
        </>
      )}

      {(effectiveMode === 'protein_only' || effectiveMode === 'full') && (
        <>
          <SectionTitle>{t('nutrition.targets.protein_assumptions')}</SectionTitle>
          <Card className="p-4 flex flex-col gap-3">
            <NumberInput
              label={t('nutrition.targets.protein_per_kg_of_reference_weight')}
              suffix="g/kg"
              min={0.8}
              max={3}
              value={perKg}
              onChange={(v) => v != null && setPerKg(round(v, 2))}
              hint={t('nutrition.targets.x_x_g_kg_is_a', { min: PROTEIN_RANGE.min, max: PROTEIN_RANGE.max, default: PROTEIN_RANGE.default })}
            />
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('nutrition.targets.reference_weight')}</span>
              <Segmented<RefSource>
                label={t('nutrition.targets.reference_weight')}
                value={refSource}
                onChange={setRefSource}
                options={[
                  { value: 'current', label: t('nutrition.targets.current') },
                  { value: 'goal', label: t('nutrition.targets.goal_option') },
                  { value: 'custom', label: t('nutrition.targets.custom') },
                ]}
              />
              <p className="text-xs text-muted">{t('nutrition.targets.we_never_estimate_an_ideal_weight')}</p>
            </div>
            {refSource === 'goal' && (
              <NumberInput
                label={t('nutrition.targets.goal_weight')}
                suffix={unit}
                min={1}
                max={unit === 'kg' ? 300 : 660}
                value={goalWeightKg != null ? round(fromKg(goalWeightKg, unit), 1) : null}
                onChange={(v) => setGoalWeightKg(v == null ? null : toKg(v, unit))}
              />
            )}
            {refSource === 'custom' && (
              <NumberInput
                label={t('nutrition.targets.reference_weight')}
                suffix={unit}
                min={1}
                max={unit === 'kg' ? 300 : 660}
                value={customRefKg != null ? round(fromKg(customRefKg, unit), 1) : null}
                onChange={(v) => setCustomRefKg(v == null ? null : toKg(v, unit))}
              />
            )}
          </Card>
        </>
      )}

      {effectiveMode === 'full' && (
        <>
          <SectionTitle>{t('nutrition.targets.energy_assumptions')}</SectionTitle>
          <Card className="p-4 flex flex-col gap-3">
            <NumberInput
              label={t('nutrition.targets.activity_factor')}
              suffix="×"
              min={1}
              max={2.5}
              value={factor ?? ACTIVITY_FACTORS[activity]}
              onChange={(v) => setFactor(v == null || v === ACTIVITY_FACTORS[activity] ? null : round(v, 3))}
              hint={factor == null ? t('nutrition.targets.standard_multiplier_for_x_its_an', { activity: activityLabel(activity) }) : t('nutrition.targets.custom_value')}
            />
            {factor != null && (
              <Button size="sm" variant="ghost" className="self-start" onClick={() => setFactor(null)}>
                {t('nutrition.targets.use_standard', { value: factorText(ACTIVITY_FACTORS[activity]) })}
              </Button>
            )}
            <NumberInput
              label={t('nutrition.targets.goal_adjustment')}
              suffix="%"
              min={-20}
              max={15}
              value={adjPct ?? GOAL_ADJUST_PCT[goal]}
              onChange={(v) => setAdjPct(v == null || v === GOAL_ADJUST_PCT[goal] ? null : v)}
              hint={t('nutrition.targets.starting_assumption_0_for_maintenance_about')}
            />
            {adjPct != null && (
              <Button size="sm" variant="ghost" className="self-start" onClick={() => setAdjPct(null)}>
                {t('nutrition.targets.use_default', { value: GOAL_ADJUST_PCT[goal] })}
              </Button>
            )}
          </Card>
        </>
      )}

      {(effectiveMode === 'protein_only' || effectiveMode === 'full') && (
        <>
          <SectionTitle>{t('nutrition.targets.how_its_calculated')}</SectionTitle>
          <Card className="p-4">
            <ResultSummary targets={calc.targets} full={effectiveMode === 'full'} />
            {calc.explanation.length > 0 && (
              <ol className="list-decimal pl-5 mt-3 flex flex-col gap-2 text-sm">
                {calc.explanation.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ol>
            )}
            {calc.warnings.map((w) => (
              <Notice key={w} tone="warn" className="mt-3">
                {w}
              </Notice>
            ))}
          </Card>
        </>
      )}

      {effectiveMode === 'manual' && (
        <>
          <SectionTitle>{t('nutrition.targets.your_targets')}</SectionTitle>
          <Card className="p-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <NumberInput label={t('progress.protein')} suffix="g" decimals={false} min={0} max={500} value={manual.proteinG} onChange={(v) => setManual({ ...manual, proteinG: v })} placeholder={t('nutrition.targets.none')} />
              <NumberInput label={t('aiCard.macro.calories')} suffix="kcal" decimals={false} min={0} max={8000} value={manual.calories} onChange={(v) => setManual({ ...manual, calories: v })} placeholder={t('nutrition.targets.none')} />
              <NumberInput label={t('aiCard.macro.carbs')} suffix="g" decimals={false} min={0} max={1000} value={manual.carbsG} onChange={(v) => setManual({ ...manual, carbsG: v })} placeholder={t('nutrition.targets.none')} />
              <NumberInput label={t('aiCard.macro.fat')} suffix="g" decimals={false} min={0} max={400} value={manual.fatG} onChange={(v) => setManual({ ...manual, fatG: v })} placeholder={t('nutrition.targets.none')} />
            </div>
            {manualCheck.energyKcal != null && manualCheck.ok && (
              <p className="text-xs text-muted">
                {t('nutrition.targets.check', {
                  protein: manual.proteinG ?? 0,
                  carbs: manual.carbsG ?? 0,
                  fat: manual.fatG ?? 0,
                  kcal: Math.round(manualCheck.energyKcal),
                  target: manual.calories ?? 0,
                })}
              </p>
            )}
            {manualCheck.warnings.map((w) => (
              <Notice key={w} tone="warn">
                {w}
              </Notice>
            ))}
            <div className="flex flex-wrap gap-2">
              {manual.calories != null && manual.proteinG != null && manual.fatG != null && (
                <Button
                  size="sm"
                  onClick={() => {
                    const left = manual.calories! - manual.proteinG! * 4 - manual.fatG! * 9;
                    if (left < 0) toast.show(t('nutrition.targets.protein_and_fat_already_exceed_your'), { tone: 'warn' });
                    else setManual({ ...manual, carbsG: Math.round(left / 4) });
                  }}
                >
                  {t('nutrition.targets.fill_carbs_from_calories')}
                </Button>
              )}
              {!restricted && (calc.targets.proteinG != null || calc.targets.calories != null) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setManual({ proteinG: calc.targets.proteinG ?? null, calories: calc.targets.calories ?? null, carbsG: calc.targets.carbsG ?? null, fatG: calc.targets.fatG ?? null })
                  }
                >
                  {t('nutrition.targets.start_from_the_estimate')}
                </Button>
              )}
            </div>
          </Card>
        </>
      )}

      {effectiveMode !== 'none' && perMeal != null && perMeal > 0 && (
        <p className="text-sm text-muted mt-4 px-1">
          {tp('nutrition.targets.across', meals, { split: proteinDistribution(perMeal, meals).map((g) => numberText(g)).join(' + ') })}
        </p>
      )}

      <Card className="p-4 mt-4 text-sm text-muted flex flex-col gap-2">
        <p>{t('nutrition.targets.these_numbers_are_adjustable_starting_points')}</p>
        {effectiveMode === 'full' && <p>{t('nutrition.targets.exercise_calories_are_not_added_back')}</p>}
        <p>{t('nutrition.targets.protein_powders_and_other_supplements_are')}</p>
      </Card>

      <div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] mt-4">
        <Button variant="primary" size="lg" block onClick={save} loading={busy}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

function ResultSummary({ targets: tg, full }: { targets: NutritionTargets; full: boolean }) {
  const { t } = useT();
  const items: [string, string][] = [[t('progress.protein'), tg.proteinG != null ? `${numberText(tg.proteinG)} g` : '–']];
  if (full)
    items.push(
      [t('aiCard.macro.calories'), tg.calories != null ? numberText(tg.calories) : '–'],
      [t('aiCard.macro.carbs'), tg.carbsG != null ? `${numberText(tg.carbsG)} g` : '–'],
      [t('aiCard.macro.fat'), tg.fatG != null ? `${numberText(tg.fatG)} g` : '–'],
    );
  return (
    <div className={full ? 'grid grid-cols-4 gap-2' : 'grid grid-cols-1'}>
      {items.map(([k, v]) => (
        <div key={k}>
          <div className="text-xs text-muted">{k}</div>
          <div className="text-xl font-semibold tabular">{v}</div>
        </div>
      ))}
    </div>
  );
}
