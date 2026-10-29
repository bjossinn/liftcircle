/** Individual wizard steps. Each step edits the draft answers; validation lives in draft.ts. */
import { useId, useState, type ReactNode } from 'react';
import { Check, Info, Plus, X } from 'lucide-react';
import { Badge, Button, Card, ChipGroup, Field, Input, Notice, NumberInput, Segmented, Select, Textarea, Toggle, cx } from '@/components/ui';
import { ExercisePicker } from '@/components/ExercisePicker';
import { EQUIPMENT_LABELS, LIMITATION_LABELS } from '@/data/exerciseMeta';
import { cmToFtIn, fromKg, fromMeters, ftInToCm, round, toKg, toMeters } from '@/domain/units';
import { RIR_PLAIN } from '@/domain/program/explain';
import { WEEK_ORDER } from '@/domain/program/generator';
import { availableDayCount, effectiveLiftingDays, resolveSplit } from '@/domain/program/splits';
import { WEEKDAY_SHORT } from '@/lib/dates';
import type { ActivityLevel, ActivityType, Allergen, DietTag, Equipment, Exercise, Experience, Goal, ID, LimitationArea, OnboardingAnswers, SplitKey } from '@/domain/types';
import { ALL_GYM, ALLERGEN_LABELS, DIET_TAG_LABELS, isUnder18, LOCATION_PRESETS, type Draft } from './draft';

export interface StepProps {
  d: Draft;
  set: (patch: Partial<OnboardingAnswers>) => void;
  setDraft: (fn: (d: Draft) => Draft) => void;
  errors: Record<string, string>;
  byId: Map<ID, Exercise>;
}

/* ------------------------------------------------------------- helpers */
export function OptionCard({ selected, onClick, title, body, role = 'radio' }: { selected: boolean; onClick: () => void; title: ReactNode; body?: ReactNode; role?: 'radio' | 'checkbox' }) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      onClick={onClick}
      className={cx(
        'w-full text-left rounded-2xl border px-4 py-3 min-h-14 transition-colors flex items-start gap-3',
        selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2',
      )}
    >
      <span className={cx('mt-0.5 size-5 shrink-0 rounded-full border flex items-center justify-center', selected ? 'bg-accent border-accent text-accent-ink' : 'border-line')}>
        {selected && <Check className="size-3.5" aria-hidden />}
      </span>
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        {body && <span className="block text-sm text-muted mt-0.5">{body}</span>}
      </span>
    </button>
  );
}

function WhyWeAsk({ children }: { children: ReactNode }) {
  return (
    <Notice className="flex gap-2 items-start">
      <Info className="size-4 mt-0.5 shrink-0 text-info" aria-hidden />
      <div>{children}</div>
    </Notice>
  );
}

const weightIn = (kg: number | undefined, unit: 'kg' | 'lb') => (kg == null ? null : round(fromKg(kg, unit), 1));
const weightOut = (v: number | null, unit: 'kg' | 'lb') => (v == null ? undefined : toKg(v, unit));
const WEEKDAY_OPTIONS = WEEK_ORDER.map((w) => ({ value: w, label: WEEKDAY_SHORT[w] }));

export const GOAL_OPTIONS: { value: Goal; title: string; body: string }[] = [
  { value: 'build_muscle', title: 'Build muscle', body: 'Get bigger and stronger with moderate reps.' },
  { value: 'strength', title: 'Improve strength', body: 'Lift heavier on the main lifts.' },
  { value: 'lose_fat', title: 'Lose fat', body: 'Keep muscle while losing fat; lifting plus easy activity.' },
  { value: 'general_fitness', title: 'General fitness', body: 'Feel fitter and stronger for everyday life.' },
  { value: 'endurance', title: 'Improve endurance', body: 'Run, ride, swim or row further — with supporting strength.' },
];
export const EXPERIENCE_OPTIONS: { value: Experience; title: string; body: string }[] = [
  { value: 'new', title: 'New to lifting', body: 'Little or no regular strength training.' },
  { value: 'returning', title: 'Returning after a break', body: 'Trained before, out of practice now.' },
  { value: 'intermediate', title: 'Intermediate', body: 'Training consistently for a year or more.' },
  { value: 'advanced', title: 'Advanced', body: 'Several years of structured training.' },
];
export const ACTIVITY_LEVELS: { value: ActivityLevel; title: string; body: string }[] = [
  { value: 'sedentary', title: 'Mostly sitting', body: 'Desk job, little walking.' },
  { value: 'light', title: 'Lightly active', body: 'Some walking most days.' },
  { value: 'moderate', title: 'Moderately active', body: 'On your feet a lot, or walk/cycle daily.' },
  { value: 'very', title: 'Very active', body: 'Physical job or lots of daily movement.' },
  { value: 'extra', title: 'Extra active', body: 'Hard physical work most of the day.' },
];
export const ACTIVITY_OPTIONS: { value: ActivityType; label: string }[] = [
  { value: 'walk', label: 'Walking' },
  { value: 'run', label: 'Running' },
  { value: 'cycle', label: 'Cycling' },
  { value: 'hike', label: 'Hiking' },
  { value: 'swim', label: 'Swimming' },
  { value: 'row', label: 'Rowing' },
  { value: 'sport', label: 'Sports' },
  { value: 'class', label: 'Fitness classes' },
  { value: 'yoga', label: 'Yoga' },
  { value: 'mobility', label: 'Mobility' },
  { value: 'stretch', label: 'Stretching' },
];
const ENDURANCE_CHOICES: ActivityType[] = ['run', 'cycle', 'swim', 'row', 'hike', 'walk'];
export const LOCATION_LABELS: Record<OnboardingAnswers['location'], string> = { full_gym: 'Full gym', home_gym: 'Home gym', minimal: 'Minimal / bodyweight' };

/* --------------------------------------------------------------- steps */
export function WelcomeStep({ d, setDraft }: StepProps) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted">A few quick questions (about 3 minutes) and we’ll suggest a starting program you can edit. You can skip anything optional and change it all later.</p>
      <OptionCard
        selected={d.mode === 'plan'}
        onClick={() => setDraft((x) => ({ ...x, mode: 'plan' }))}
        title="Suggest a program for me"
        body="Based on your goal, schedule, equipment and anything to go easy on."
      />
      <OptionCard
        selected={d.mode === 'manual'}
        onClick={() => setDraft((x) => ({ ...x, mode: 'manual' }))}
        title="I already have a program / I’ll set my own targets"
        body="Start with empty sessions you fill in yourself, and enter your own nutrition targets if you want them."
      />
    </div>
  );
}

export function AboutStep({ d, set, errors }: StepProps) {
  const u = d.a.units;
  return (
    <div className="flex flex-col gap-5">
      <Input label="What should we call you?" value={d.a.displayName} maxLength={60} autoComplete="nickname" onChange={(e) => set({ displayName: e.target.value })} error={errors.displayName} hint="Shown in the app. Your social profile is set up separately." />
      <Field label="Weights">
        <Segmented label="Weight unit" value={u.weight} onChange={(weight) => set({ units: { ...u, weight } })} options={[{ value: 'kg', label: 'Kilograms' }, { value: 'lb', label: 'Pounds' }]} />
      </Field>
      <Field label="Height">
        <Segmented label="Height unit" value={u.length} onChange={(length) => set({ units: { ...u, length } })} options={[{ value: 'cm', label: 'Centimetres' }, { value: 'ftin', label: 'Feet & inches' }]} />
      </Field>
      <Field label="Distance">
        <Segmented label="Distance unit" value={u.distance} onChange={(distance) => set({ units: { ...u, distance } })} options={[{ value: 'km', label: 'Kilometres' }, { value: 'mi', label: 'Miles' }]} />
      </Field>
    </div>
  );
}

export function BodyStep({ d, set, errors }: StepProps) {
  const a = d.a;
  const unit = a.units.weight;
  const ft = a.heightCm != null ? cmToFtIn(a.heightCm) : null;
  return (
    <div className="flex flex-col gap-5">
      <WhyWeAsk>
        <strong className="font-medium">Why we ask:</strong> age, weight and height are used to estimate nutrition targets (protein and, if you want it, calories). They’re never shown on your social profile or to other members,
        are only shared with a coach or the AI coach if you choose to, and are never used to guess starting weights. Not interested in nutrition? Skip this step.
      </WhyWeAsk>
      <NumberInput label="Age (optional)" decimals={false} value={a.age ?? null} onChange={(v) => set({ age: v ?? undefined })} error={errors.age} suffix="years" />
      {isUnder18(a) && (
        <Notice tone="warn">
          Because you’re under 18, we won’t create calorie or weight-loss targets. You’ll get a conservative training plan and can set your own nutrition targets — a doctor, coach or dietitian can help.
        </Notice>
      )}
      <NumberInput label="Current weight (optional)" value={weightIn(a.weightKg, unit)} onChange={(v) => set({ weightKg: weightOut(v, unit) })} error={errors.weightKg} suffix={unit} />
      {a.units.length === 'cm' ? (
        <NumberInput label="Height (optional)" value={a.heightCm != null ? round(a.heightCm, 1) : null} onChange={(v) => set({ heightCm: v ?? undefined })} error={errors.heightCm} suffix="cm" />
      ) : (
        <Field label="Height (optional)" error={errors.heightCm}>
          <div className="grid grid-cols-2 gap-3">
            <NumberInput ariaLabel="Height feet" decimals={false} value={ft?.ft ?? null} suffix="ft" onChange={(v) => set({ heightCm: v == null && !ft ? undefined : ftInToCm(v ?? 0, ft?.inch ?? 0) })} />
            <NumberInput ariaLabel="Height inches" value={ft?.inch ?? null} suffix="in" max={11.9} onChange={(v) => set({ heightCm: ftInToCm(ft?.ft ?? 0, v ?? 0) })} />
          </div>
        </Field>
      )}
    </div>
  );
}

export function GoalStep({ d, set, errors }: StepProps) {
  const a = d.a;
  const unit = a.units.weight;
  const dist = a.units.distance;
  return (
    <div className="flex flex-col gap-5">
      <div role="radiogroup" aria-label="Primary goal" className="flex flex-col gap-2">
        {GOAL_OPTIONS.map((g) => (
          <OptionCard
            key={g.value}
            selected={a.goal === g.value}
            onClick={() =>
              set({
                goal: g.value,
                secondaryGoal: a.secondaryGoal === g.value ? undefined : a.secondaryGoal,
                endurance: g.value === 'endurance' ? (a.endurance ?? { activity: a.preferredActivities.find((x) => ENDURANCE_CHOICES.includes(x)) ?? 'run' }) : a.endurance,
              })
            }
            title={g.title}
            body={g.body}
          />
        ))}
      </div>
      {a.goal === 'endurance' && (
        <Card className="p-4 flex flex-col gap-4">
          <Select label="Main activity" value={a.endurance?.activity ?? 'run'} onChange={(e) => set({ endurance: { ...(a.endurance ?? {}), activity: e.target.value as ActivityType } })}>
            {ENDURANCE_CHOICES.map((t) => (
              <option key={t} value={t}>
                {ACTIVITY_OPTIONS.find((o) => o.value === t)?.label}
              </option>
            ))}
          </Select>
          <NumberInput
            label="A recent comfortable session (optional)"
            decimals={false}
            suffix="min"
            value={a.endurance?.recentMinutes ?? null}
            onChange={(v) => set({ endurance: { ...(a.endurance ?? { activity: 'run' }), recentMinutes: v ?? undefined } })}
            error={errors['endurance.recentMinutes']}
            hint="How long you can go at an easy, chatty pace."
          />
          <NumberInput
            label="…and roughly how far (optional)"
            suffix={dist}
            value={a.endurance?.recentDistanceKm != null ? round(fromMeters(a.endurance.recentDistanceKm * 1000, dist), 1) : null}
            onChange={(v) => set({ endurance: { ...(a.endurance ?? { activity: 'run' }), recentDistanceKm: v == null ? undefined : toMeters(v, dist) / 1000 } })}
            error={errors['endurance.recentDistanceKm']}
          />
          <p className="text-xs text-muted">Not sure? Leave these blank and we’ll start with a gentle calibration session.</p>
        </Card>
      )}
      <Select
        label="Secondary goal (optional)"
        value={a.secondaryGoal ?? ''}
        onChange={(e) => set({ secondaryGoal: (e.target.value || undefined) as Goal | undefined })}
        error={errors.secondaryGoal}
      >
        <option value="">None</option>
        {GOAL_OPTIONS.filter((g) => g.value !== a.goal).map((g) => (
          <option key={g.value} value={g.value}>
            {g.title}
          </option>
        ))}
      </Select>
      <NumberInput
        label="Target weight (optional)"
        value={weightIn(a.targetWeightKg, unit)}
        onChange={(v) => set({ targetWeightKg: weightOut(v, unit) })}
        suffix={unit}
        error={errors.targetWeightKg}
        hint="Only used if you choose to base protein on a goal weight. We never suggest an “ideal” weight."
      />
    </div>
  );
}

export function ExperienceStep({ d, set }: StepProps) {
  return (
    <div role="radiogroup" aria-label="Experience" className="flex flex-col gap-2">
      {EXPERIENCE_OPTIONS.map((o) => (
        <OptionCard key={o.value} selected={d.a.experience === o.value} onClick={() => set({ experience: o.value })} title={o.title} body={o.body} />
      ))}
      <p className="text-sm text-muted mt-2">You don’t need to know your 1-rep max. If you’re unsure of a weight, your first session of each lift is a light calibration session.</p>
    </div>
  );
}

export function ScheduleStep({ d, set, errors }: StepProps) {
  const a = d.a;
  const beginner = a.experience === 'new' || a.experience === 'returning';
  return (
    <div className="flex flex-col gap-5">
      <Field label="Active days per week (all activity)" error={errors.totalDaysPerWeek}>
        <Segmented
          label="Active days per week"
          value={a.totalDaysPerWeek}
          onChange={(v) => set({ totalDaysPerWeek: v, liftingDaysPerWeek: Math.min(a.liftingDaysPerWeek, v, 6) })}
          options={[1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) }))}
        />
      </Field>
      <Field label="Of those, hard lifting days" error={errors.liftingDaysPerWeek} hint="The rest become easier days such as walks, mobility or your favourite activity.">
        <Segmented
          label="Lifting days per week"
          value={a.liftingDaysPerWeek}
          onChange={(v) => set({ liftingDaysPerWeek: v, preferredLiftingWeekdays: a.preferredLiftingWeekdays.slice(0, v) })}
          options={[0, 1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))}
        />
      </Field>
      {a.liftingDaysPerWeek > 0 && <SplitPicker a={a} onSelect={(splitPreference) => set({ splitPreference })} />}
      {beginner && a.liftingDaysPerWeek >= 5 && a.goal !== 'endurance' && (
        <Notice tone="warn">For newer lifters, 3–4 lifting days usually gives great progress with easier recovery. You can keep {a.liftingDaysPerWeek} — we’ll explain the trade-offs.</Notice>
      )}
      <Field label="Days you could train" error={errors.availableWeekdays}>
        <ChipGroup
          label="Available weekdays"
          values={a.availableWeekdays}
          onChange={(v) => set({ availableWeekdays: v, preferredLiftingWeekdays: a.preferredLiftingWeekdays.filter((x) => v.includes(x)) })}
          options={WEEKDAY_OPTIONS}
        />
      </Field>
      {a.liftingDaysPerWeek > 0 && (
        <Field label="Preferred lifting days (optional)" error={errors.preferredLiftingWeekdays} hint="Leave empty and we’ll spread sessions out with rest days in between.">
          <ChipGroup
            label="Preferred lifting weekdays"
            values={a.preferredLiftingWeekdays}
            onChange={(v) => set({ preferredLiftingWeekdays: v })}
            options={WEEKDAY_OPTIONS.filter((o) => a.availableWeekdays.includes(o.value))}
          />
        </Field>
      )}
      <Field label="Time per session" error={errors.sessionMinutes} hint="Including warm-up and rests. We trim lower-priority accessories to fit.">
        <Segmented label="Session length" value={a.sessionMinutes} onChange={(v) => set({ sessionMinutes: v })} options={[30, 45, 60, 75, 90].map((n) => ({ value: n, label: `${n}` }))} />
      </Field>
    </div>
  );
}

/**
 * Radio-style split selector for the current lifting-day count. The selection is stored as
 * `splitPreference`; when the day count changes the resolver keeps the intent and says so.
 */
export function SplitPicker({ a, onSelect, showTitle = true }: { a: OnboardingAnswers; onSelect: (key: SplitKey) => void; showTitle?: boolean }) {
  const titleId = useId();
  const lifting = effectiveLiftingDays(a);
  const res = resolveSplit(a, lifting);
  const requested = Math.min(Math.round(a.liftingDaysPerWeek || 0), availableDayCount(a));
  if (lifting === 0) return <p className="text-sm text-muted">No lifting days, so there’s no split to choose.</p>;
  return (
    <div className="flex flex-col gap-2">
      {showTitle && (
        <span id={titleId} className="text-sm font-medium">
          Workout split
        </span>
      )}
      {a.goal === 'endurance' && requested > lifting && (
        <p className="text-xs text-muted">With an endurance goal the plan has up to 2 strength sessions; your other active days become endurance sessions.</p>
      )}
      {res.adjustment && (
        <Notice tone="warn" className="py-2.5">
          <span role="status">{res.adjustment.message}</span>
        </Notice>
      )}
      <div role="radiogroup" aria-labelledby={showTitle ? titleId : undefined} aria-label={showTitle ? undefined : 'Workout split'} className="flex flex-col gap-2">
        {res.options.map((o) => (
          <OptionCard
            key={o.key}
            selected={res.key === o.key}
            onClick={() => onSelect(o.key)}
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                {o.label}
                {o.recommended && (
                  <>
                    {' '}
                    <Badge tone="accent">Recommended</Badge>
                  </>
                )}
              </span>
            }
            body={o.tradeoff}
          />
        ))}
      </div>
      <p className="text-xs text-muted">
        {res.options.length === 1
          ? `With ${lifting} lifting day${lifting === 1 ? '' : 's'}, this is the structure that fits. More lifting days unlock other splits.`
          : `Structures that fit ${lifting} lifting day${lifting === 1 ? '' : 's'}${a.goal === 'endurance' ? ' alongside your endurance sessions' : ''}. Experience changes exercise choice, sets and effort — not which splits you can pick.`}
      </p>
    </div>
  );
}

export function EquipmentStep({ d, set }: StepProps) {
  const a = d.a;
  return (
    <div className="flex flex-col gap-5">
      <Field label="Where do you train?">
        <Segmented
          label="Training location"
          value={a.location}
          onChange={(location) => set({ location, equipment: [...LOCATION_PRESETS[location]] })}
          options={(['full_gym', 'home_gym', 'minimal'] as const).map((v) => ({ value: v, label: v === 'minimal' ? 'Minimal' : LOCATION_LABELS[v] }))}
        />
      </Field>
      <Field label="Equipment you have" hint="Bodyweight exercises are always included. We only pick exercises you can do with what’s selected.">
        <ChipGroup label="Equipment" values={a.equipment} onChange={(v: Equipment[]) => set({ equipment: v })} options={ALL_GYM.map((e) => ({ value: e, label: EQUIPMENT_LABELS[e] }))} />
      </Field>
      {a.equipment.length === 0 && <Notice>Bodyweight only — great. Adding resistance bands or a pull-up bar widens the exercise choice a lot.</Notice>}
    </div>
  );
}

export function ExercisesStep({ d, set, byId, errors }: StepProps) {
  const a = d.a;
  const [picker, setPicker] = useState<null | 'enjoy' | 'exclude' | 'load'>(null);
  const unit = a.units.weight;
  const loads = a.knownLoads ?? {};
  const name = (id: ID) => byId.get(id)?.name ?? id;
  const chips = (ids: ID[], onRemove: (id: ID) => void, label: string) => (
    <ul className="flex flex-wrap gap-2" aria-label={label}>
      {ids.map((id) => (
        <li key={id}>
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 pl-3 pr-1 min-h-10 text-sm">
            {name(id)}
            <button type="button" className="size-8 inline-flex items-center justify-center rounded-full hover:bg-surface-3" aria-label={`Remove ${name(id)}`} onClick={() => onRemove(id)}>
              <X className="size-4" />
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="flex flex-col gap-6">
      <Field label="Activities you enjoy (optional)" hint="Used for your easier days.">
        <ChipGroup label="Preferred activities" values={a.preferredActivities} onChange={(v) => set({ preferredActivities: v })} options={ACTIVITY_OPTIONS} />
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Exercises you enjoy (optional)</span>
        {chips(a.enjoyedExerciseIds, (id) => set({ enjoyedExerciseIds: a.enjoyedExerciseIds.filter((x) => x !== id) }), 'Enjoyed exercises')}
        <Button size="sm" className="self-start" icon={<Plus className="size-4" />} onClick={() => setPicker('enjoy')}>
          Add exercise
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Movements to leave out (optional)</span>
        {chips(a.excludedExerciseIds, (id) => set({ excludedExerciseIds: a.excludedExerciseIds.filter((x) => x !== id) }), 'Excluded exercises')}
        <Button size="sm" className="self-start" icon={<Plus className="size-4" />} onClick={() => setPicker('exclude')}>
          Exclude exercise
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Weights you already know (optional)</span>
        <p className="text-xs text-muted">A load you can lift comfortably for about 8–10 reps. Skip this and your first session of each lift will be a light calibration session.</p>
        {Object.keys(loads).length > 0 && (
          <ul className="flex flex-col gap-2">
            {Object.entries(loads).map(([id, kg]) => (
              <li key={id} className="flex items-center gap-2">
                <span className="flex-1 min-w-0 text-sm truncate">
                  {name(id)}
                  {byId.get(id)?.load === 'per_hand' && <span className="text-muted"> (per hand)</span>}
                </span>
                <NumberInput
                  className="w-28"
                  ariaLabel={`Comfortable load for ${name(id)}`}
                  value={round(fromKg(kg, unit), 1)}
                  suffix={unit}
                  onChange={(v) => set({ knownLoads: { ...loads, [id]: v == null ? 0 : toKg(v, unit) } })}
                  error={errors[`knownLoads.${id}`]}
                />
                <button
                  type="button"
                  className="size-11 inline-flex items-center justify-center rounded-xl hover:bg-surface-2"
                  aria-label={`Remove known load for ${name(id)}`}
                  onClick={() => {
                    const next = { ...loads };
                    delete next[id];
                    set({ knownLoads: next });
                  }}
                >
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" className="self-start" icon={<Plus className="size-4" />} onClick={() => setPicker('load')}>
          Add a known weight
        </Button>
      </div>
      <ExercisePicker
        open={picker !== null}
        onClose={() => setPicker(null)}
        title={picker === 'enjoy' ? 'Exercises you enjoy' : picker === 'exclude' ? 'Leave out' : 'Known weight for…'}
        excludeIds={picker === 'enjoy' ? [...a.enjoyedExerciseIds, ...a.excludedExerciseIds] : picker === 'exclude' ? [...a.excludedExerciseIds, ...a.enjoyedExerciseIds] : Object.keys(loads)}
        onPick={(ex) => {
          if (picker === 'enjoy') set({ enjoyedExerciseIds: [...new Set([...a.enjoyedExerciseIds, ex.id])] });
          if (picker === 'exclude') set({ excludedExerciseIds: [...new Set([...a.excludedExerciseIds, ex.id])] });
          if (picker === 'load') set({ knownLoads: { ...loads, [ex.id]: 0 } });
          setPicker(null);
        }}
      />
    </div>
  );
}

export function LimitsStep({ d, set }: StepProps) {
  const a = d.a;
  return (
    <div className="flex flex-col gap-5">
      <Notice>
        This isn’t a diagnosis or medical advice. Telling us an area just means we’ll avoid exercises that commonly load it and suggest alternatives. If something hurts, stop — and if pain persists, see a qualified professional.
      </Notice>
      <Field label="Areas to go easy on (optional)">
        <ChipGroup
          label="Limitation areas"
          values={a.limitations}
          onChange={(v: LimitationArea[]) => set({ limitations: v })}
          options={(Object.keys(LIMITATION_LABELS) as LimitationArea[]).map((k) => ({ value: k, label: LIMITATION_LABELS[k] }))}
        />
      </Field>
      <Textarea label="Notes for yourself (optional, private)" value={a.limitationNotes ?? ''} maxLength={500} onChange={(e) => set({ limitationNotes: e.target.value || undefined })} placeholder="e.g. right knee dislikes deep lunges" />
    </div>
  );
}

export function LifestyleStep({ d, set }: StepProps) {
  const a = d.a;
  const under18 = isUnder18(a);
  return (
    <div className="flex flex-col gap-5">
      <div role="radiogroup" aria-label="Everyday activity" className="flex flex-col gap-2">
        {ACTIVITY_LEVELS.map((o) => (
          <OptionCard key={o.value} selected={a.activityLevel === o.value} onClick={() => set({ activityLevel: o.value })} title={o.title} body={o.body} />
        ))}
      </div>
      <Card className="px-4 py-2">
        <Toggle checked={a.wantsNutrition} onChange={(v) => set({ wantsNutrition: v })} label="I’d like nutrition guidance" description="Optional. Everything else works without it." />
        {a.wantsNutrition && (
          <div className="pb-3 pt-1 flex flex-col gap-2">
            <Segmented
              label="Nutrition guidance type"
              value={under18 ? 'protein_only' : (a.nutritionMode ?? 'protein_only')}
              onChange={(v) => set({ nutritionMode: under18 ? 'protein_only' : v })}
              options={[
                { value: 'protein_only', label: 'Protein target only' },
                { value: 'full', label: 'Calories & macros too' },
              ]}
            />
            {under18 && <p className="text-xs text-muted">Calorie targets aren’t available for under-18s. You can still set your own targets.</p>}
          </div>
        )}
      </Card>
    </div>
  );
}

export function NutritionStep({ d, set, errors }: StepProps) {
  const a = d.a;
  const diet = a.diet;
  const setDiet = (patch: Partial<typeof diet>) => set({ diet: { ...diet, ...patch } });
  const [disliked, setDisliked] = useState(diet.dislikedIngredientIds.join(', '));
  const full = a.nutritionMode === 'full' && !isUnder18(a);
  return (
    <div className="flex flex-col gap-5">
      <Field label="Dietary preferences">
        <ChipGroup label="Diet preferences" values={diet.tags} onChange={(v: DietTag[]) => setDiet({ tags: v })} options={(Object.keys(DIET_TAG_LABELS) as DietTag[]).map((k) => ({ value: k, label: DIET_TAG_LABELS[k] }))} />
      </Field>
      <Field label="Allergies" hint="We leave these out of suggestions, but always check packaged-food labels — filtering can’t guarantee safety.">
        <ChipGroup label="Allergens" values={diet.allergens} onChange={(v: Allergen[]) => setDiet({ allergens: v })} options={(Object.keys(ALLERGEN_LABELS) as Allergen[]).map((k) => ({ value: k, label: ALLERGEN_LABELS[k] }))} />
      </Field>
      <Input
        label="Foods you dislike (optional)"
        value={disliked}
        placeholder="e.g. mushrooms, olives"
        onChange={(e) => setDisliked(e.target.value)}
        onBlur={() =>
          setDiet({
            dislikedIngredientIds: disliked
              .split(',')
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 30),
          })
        }
        hint="Separate with commas."
      />
      <Field label="Cooking time per meal">
        <Segmented label="Cooking time" value={diet.maxCookMinutes} onChange={(v) => setDiet({ maxCookMinutes: v })} options={[10, 20, 30, 45, 60].map((n) => ({ value: n, label: `${n}m` }))} />
      </Field>
      <Field label="Budget">
        <Segmented label="Budget" value={diet.budget} onChange={(v) => setDiet({ budget: v })} options={[{ value: 'low', label: 'Tight' }, { value: 'medium', label: 'Moderate' }, { value: 'any', label: 'Flexible' }]} />
      </Field>
      <Field label="Meals per day" error={errors['diet.mealsPerDay']}>
        <Segmented label="Meals per day" value={diet.mealsPerDay} onChange={(v) => setDiet({ mealsPerDay: v })} options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))} />
      </Field>
      {full && (
        <Card className="p-4 flex flex-col gap-3">
          <span className="text-sm font-medium">For the calorie estimate (optional)</span>
          <p className="text-xs text-muted">
            The Mifflin–St Jeor resting-energy equation has a “male” and a “female” version that differ by a constant. Pick the one you want us to use, or skip it and set calories yourself. It isn’t shown anywhere else.
          </p>
          <Segmented
            label="Equation version"
            value={a.sexParam ?? 'skip'}
            onChange={(v) => set({ sexParam: v === 'skip' ? undefined : v })}
            options={[
              { value: 'female', label: 'Female equation' },
              { value: 'male', label: 'Male equation' },
              { value: 'skip', label: 'Skip' },
            ]}
          />
        </Card>
      )}
      <Card className="px-4 py-2">
        <Toggle
          checked={!!a.individualizedNutrition}
          onChange={(v) => set({ individualizedNutrition: v })}
          label="I’m pregnant or breastfeeding, or have a condition that needs individual nutrition advice"
          description="We’ll skip generated targets — you can still log food and enter targets from your healthcare professional."
        />
      </Card>
    </div>
  );
}

export function ManualStep({ d, setDraft, set, errors }: StepProps) {
  const m = d.manual;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted">We’ll create empty sessions for you to fill in with your own exercises, sets and reps. You can add, rename and reschedule sessions any time.</p>
      <Field label="Sessions in your routine" error={errors.sessions}>
        <Segmented label="Number of sessions" value={m.sessions} onChange={(v) => setDraft((x) => ({ ...x, manual: { ...x.manual, sessions: v } }))} options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))} />
      </Field>
      <Field label="Training days (optional)" hint="Sessions rotate across these days. Leave empty to schedule later.">
        <ChipGroup label="Training days" values={m.days} onChange={(v) => setDraft((x) => ({ ...x, manual: { ...x.manual, days: v } }))} options={WEEKDAY_OPTIONS} />
      </Field>
      <Card className="px-4 py-2">
        <Toggle checked={d.a.wantsNutrition} onChange={(v) => set({ wantsNutrition: v })} label="Track nutrition with my own targets" description="Optional. Enter the targets you already use." />
        {d.a.wantsNutrition && <ManualTargets d={d} setDraft={setDraft} />}
      </Card>
      <p className="text-xs text-muted">{RIR_PLAIN}</p>
    </div>
  );
}

export function ManualTargets({ d, setDraft }: Pick<StepProps, 'd' | 'setDraft'>) {
  const n = d.nutri;
  const setN = (patch: Partial<Draft['nutri']>) => setDraft((x) => ({ ...x, nutri: { ...x.nutri, ...patch } }));
  return (
    <div className="grid grid-cols-2 gap-3 pb-3 pt-1">
      <NumberInput label="Protein" suffix="g" decimals={false} min={0} max={500} value={n.manualProtein ?? null} onChange={(v) => setN({ manualProtein: v })} />
      <NumberInput label="Calories" suffix="kcal" decimals={false} min={0} max={8000} value={n.manualCalories ?? null} onChange={(v) => setN({ manualCalories: v })} />
      <NumberInput label="Carbs (optional)" suffix="g" decimals={false} min={0} max={1500} value={n.manualCarbs ?? null} onChange={(v) => setN({ manualCarbs: v })} />
      <NumberInput label="Fat (optional)" suffix="g" decimals={false} min={0} max={500} value={n.manualFat ?? null} onChange={(v) => setN({ manualFat: v })} />
      <p className="col-span-2 text-xs text-muted">Leave any of these empty — missing targets are simply not shown.</p>
    </div>
  );
}
