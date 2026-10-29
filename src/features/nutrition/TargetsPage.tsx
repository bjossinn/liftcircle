import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronLeft } from 'lucide-react';
import { Button, Card, IconButton, Notice, NumberInput, Page, SectionTitle, Segmented, Select, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import type { ActivityLevel, Goal, NutritionTargets, SexParam } from '@/domain/types';
import { cmToFtIn, formatWeight, fromKg, ftInToCm, round, toKg } from '@/domain/units';
import {
  ACTIVITY_FACTORS, ACTIVITY_LABELS, GOAL_ADJUST_PCT, GOAL_LABELS, PROTEIN_RANGE, computeNutritionTargets, reconcileMacros,
} from '@/domain/nutrition/targets';
import { proteinDistribution } from '@/domain/nutrition/log';
import { useLatestWeightKg } from './shared';

type Mode = NutritionTargets['mode'];
type RefSource = 'current' | 'goal' | 'custom';

export default function TargetsPage() {
  const nav = useNavigate();
  const { accountReady } = useApp();
  const weight = useLatestWeightKg();
  return (
    <Page
      title="Targets"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
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
    [age, weightKg, heightCm, sex, activity, goal, mode, perKg, refSource, goalWeightKg, customRefKg, meals, p.individualizedNutrition, factor, adjPct, unit],
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
      toast.show(effectiveMode === 'none' ? 'Nutrition turned off. Your food log is kept.' : 'Targets saved', { tone: 'success' });
    } catch {
      toast.show('Could not save. Please try again.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const modeOptions: { value: Mode; label: string }[] = restricted
    ? [
        { value: 'none', label: 'Off' },
        { value: 'manual', label: 'My own' },
      ]
    : [
        { value: 'none', label: 'Off' },
        { value: 'protein_only', label: 'Protein' },
        { value: 'full', label: 'Full' },
        { value: 'manual', label: 'Manual' },
      ];
  const ft = heightCm != null ? cmToFtIn(heightCm) : null;
  const perMeal = (effectiveMode === 'manual' ? manual.proteinG : calc.targets.proteinG) ?? null;

  return (
    <div className="flex flex-col">
      <Segmented label="Nutrition mode" value={effectiveMode} onChange={setMode} options={modeOptions} />
      <p className="text-xs text-muted mt-2 px-1">
        {effectiveMode === 'none' && 'Nutrition tracking is off. Everything else in the app works as normal.'}
        {effectiveMode === 'protein_only' && 'A daily protein target only.'}
        {effectiveMode === 'full' && 'Protein plus an estimated calorie target with carbs and fat.'}
        {effectiveMode === 'manual' && 'Set your own numbers. Leave any of them empty if you don’t want that target.'}
      </p>

      {restricted && (
        <Notice className="mt-3">
          {restricted === 'under_18'
            ? 'Automatic calorie, weight-loss and protein targets are designed for adults, so they are off for under-18s. You can still log food and set your own targets, ideally with a doctor or registered dietitian.'
            : 'Because your nutrition needs are individual, we don’t generate targets. You can log food and enter targets agreed with your healthcare professional.'}
        </Notice>
      )}

      {effectiveMode !== 'none' && (
        <>
          <SectionTitle>Your details</SectionTitle>
          <Card className="p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>Current weight</span>
              {weightKg != null ? (
                <span className="font-semibold tabular">{formatWeight(weightKg, unit)}</span>
              ) : (
                <Link to="/progress" className="text-accent font-medium min-h-9 inline-flex items-center">
                  Log your weight
                </Link>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <NumberInput label="Age" suffix="y" decimals={false} min={10} max={110} value={age} onChange={setAge} />
              {lengthUnit === 'cm' ? (
                <NumberInput label="Height" suffix="cm" min={100} max={250} value={heightCm != null ? round(heightCm, 1) : null} onChange={setHeightCm} />
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <NumberInput label="Height ft" suffix="ft" decimals={false} min={3} max={8} value={ft?.ft ?? null} onChange={(v) => setHeightCm(v == null ? null : ftInToCm(v, ft?.inch ?? 0))} />
                  <NumberInput label="in" suffix="in" min={0} max={11.9} value={ft?.inch ?? null} onChange={(v) => setHeightCm(ftInToCm(ft?.ft ?? 5, v ?? 0))} />
                </div>
              )}
            </div>
            {effectiveMode === 'full' && (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  Equation variant
                </span>
                <Segmented<SexParam | 'skip'>
                  label="Equation variant"
                  value={sex}
                  onChange={setSex}
                  options={[
                    { value: 'male', label: 'Male' },
                    { value: 'female', label: 'Female' },
                    { value: 'skip', label: 'Skip' },
                  ]}
                />
                <p className="text-xs text-muted">Only used to pick the Mifflin–St Jeor equation variant. Skip it to set calories manually.</p>
              </div>
            )}
            <Select label="Everyday activity" value={activity} onChange={(e) => setActivity(e.target.value as ActivityLevel)}>
              {(Object.keys(ACTIVITY_FACTORS) as ActivityLevel[]).map((a) => (
                <option key={a} value={a}>
                  {ACTIVITY_LABELS[a]} (× {ACTIVITY_FACTORS[a]})
                </option>
              ))}
            </Select>
            <Select label="Main goal" value={goal} onChange={(e) => setGoal(e.target.value as Goal)}>
              {(Object.keys(GOAL_LABELS) as Goal[]).map((g) => (
                <option key={g} value={g}>
                  {GOAL_LABELS[g]}
                </option>
              ))}
            </Select>
            <NumberInput label="Usual meals per day" decimals={false} min={1} max={6} value={meals} onChange={(v) => v != null && setMeals(v)} />
          </Card>
        </>
      )}

      {(effectiveMode === 'protein_only' || effectiveMode === 'full') && (
        <>
          <SectionTitle>Protein assumptions</SectionTitle>
          <Card className="p-4 flex flex-col gap-3">
            <NumberInput
              label="Protein per kg of reference weight"
              suffix="g/kg"
              min={0.8}
              max={3}
              value={perKg}
              onChange={(v) => v != null && setPerKg(round(v, 2))}
              hint={`${PROTEIN_RANGE.min}–${PROTEIN_RANGE.max} g/kg is a practical range for adults who lift. ${PROTEIN_RANGE.default} is our editable default, not an exact requirement.`}
            />
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Reference weight</span>
              <Segmented<RefSource>
                label="Reference weight"
                value={refSource}
                onChange={setRefSource}
                options={[
                  { value: 'current', label: 'Current' },
                  { value: 'goal', label: 'Goal' },
                  { value: 'custom', label: 'Custom' },
                ]}
              />
              <p className="text-xs text-muted">We never estimate an "ideal weight". Use your current weight, or a goal or reference weight you choose.</p>
            </div>
            {refSource === 'goal' && (
              <NumberInput
                label="Goal weight"
                suffix={unit}
                min={1}
                max={unit === 'kg' ? 300 : 660}
                value={goalWeightKg != null ? round(fromKg(goalWeightKg, unit), 1) : null}
                onChange={(v) => setGoalWeightKg(v == null ? null : toKg(v, unit))}
              />
            )}
            {refSource === 'custom' && (
              <NumberInput
                label="Reference weight"
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
          <SectionTitle>Energy assumptions</SectionTitle>
          <Card className="p-4 flex flex-col gap-3">
            <NumberInput
              label="Activity factor"
              suffix="×"
              min={1}
              max={2.5}
              value={factor ?? ACTIVITY_FACTORS[activity]}
              onChange={(v) => setFactor(v == null || v === ACTIVITY_FACTORS[activity] ? null : round(v, 3))}
              hint={factor == null ? `Standard multiplier for "${ACTIVITY_LABELS[activity]}". It's an assumption: adjust if your weight trend disagrees.` : 'Custom value.'}
            />
            {factor != null && (
              <Button size="sm" variant="ghost" className="self-start" onClick={() => setFactor(null)}>
                Use standard ({ACTIVITY_FACTORS[activity]})
              </Button>
            )}
            <NumberInput
              label="Goal adjustment"
              suffix="%"
              min={-20}
              max={15}
              value={adjPct ?? GOAL_ADJUST_PCT[goal]}
              onChange={(v) => setAdjPct(v == null || v === GOAL_ADJUST_PCT[goal] ? null : v)}
              hint="Starting assumption: 0% for maintenance, about +5% for muscle gain, about −10% for fat loss. Limited to −20…+15%."
            />
            {adjPct != null && (
              <Button size="sm" variant="ghost" className="self-start" onClick={() => setAdjPct(null)}>
                Use default ({GOAL_ADJUST_PCT[goal]}%)
              </Button>
            )}
          </Card>
        </>
      )}

      {(effectiveMode === 'protein_only' || effectiveMode === 'full') && (
        <>
          <SectionTitle>How it's calculated</SectionTitle>
          <Card className="p-4">
            <ResultSummary t={calc.targets} full={effectiveMode === 'full'} />
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
          <SectionTitle>Your targets</SectionTitle>
          <Card className="p-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <NumberInput label="Protein" suffix="g" decimals={false} min={0} max={500} value={manual.proteinG} onChange={(v) => setManual({ ...manual, proteinG: v })} placeholder="None" />
              <NumberInput label="Calories" suffix="kcal" decimals={false} min={0} max={8000} value={manual.calories} onChange={(v) => setManual({ ...manual, calories: v })} placeholder="None" />
              <NumberInput label="Carbs" suffix="g" decimals={false} min={0} max={1000} value={manual.carbsG} onChange={(v) => setManual({ ...manual, carbsG: v })} placeholder="None" />
              <NumberInput label="Fat" suffix="g" decimals={false} min={0} max={400} value={manual.fatG} onChange={(v) => setManual({ ...manual, fatG: v })} placeholder="None" />
            </div>
            {manualCheck.energyKcal != null && manualCheck.ok && (
              <p className="text-xs text-muted">
                Check: {manual.proteinG} × 4 + {manual.carbsG} × 4 + {manual.fatG} × 9 = {Math.round(manualCheck.energyKcal)} kcal (target {manual.calories}).
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
                    if (left < 0) toast.show('Protein and fat already exceed your calories. Lower one of them first.', { tone: 'warn' });
                    else setManual({ ...manual, carbsG: Math.round(left / 4) });
                  }}
                >
                  Fill carbs from calories
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
                  Start from the estimate
                </Button>
              )}
            </div>
          </Card>
        </>
      )}

      {effectiveMode !== 'none' && perMeal != null && perMeal > 0 && (
        <p className="text-sm text-muted mt-4 px-1">
          Across {meals} meal{meals === 1 ? '' : 's'}: {proteinDistribution(perMeal, meals).join(' + ')} g protein.
        </p>
      )}

      <Card className="p-4 mt-4 text-sm text-muted flex flex-col gap-2">
        <p>These numbers are adjustable starting points, not prescriptions or guaranteed results. Higher intake isn't automatically better.</p>
        {effectiveMode === 'full' && <p>Exercise calories are not added back automatically. Review after two to three weeks of consistent logging and weigh-ins, then adjust in small steps.</p>}
        <p>Protein powders and other supplements are optional.</p>
      </Card>

      <div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] mt-4">
        <Button variant="primary" size="lg" block onClick={save} loading={busy}>
          Save
        </Button>
      </div>
    </div>
  );
}

function ResultSummary({ t, full }: { t: NutritionTargets; full: boolean }) {
  const items: [string, string][] = [['Protein', t.proteinG != null ? `${t.proteinG} g` : '–']];
  if (full) items.push(['Calories', t.calories != null ? `${t.calories}` : '–'], ['Carbs', t.carbsG != null ? `${t.carbsG} g` : '–'], ['Fat', t.fatG != null ? `${t.fatG} g` : '–']);
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
