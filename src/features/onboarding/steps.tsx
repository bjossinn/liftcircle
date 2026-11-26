/**
 * The onboarding questions. Each step edits the draft answers; validation lives in draft.ts.
 * Six questions: goal, experience, which days, session length, where you train, anything to be careful with.
 */
import { useId, type ReactNode } from 'react';
import { Check, Info } from 'lucide-react';
import { Badge, ChipGroup, Field, Notice, Segmented, Select, cx } from '@/components/ui';
import { EQUIPMENT_LABELS, LIMITATION_LABELS } from '@/data/exerciseMeta';
import { WEEK_ORDER } from '@/domain/program/generator';
import { availableDayCount, effectiveLiftingDays, resolveSplit } from '@/domain/program/splits';
import { WEEKDAY_SHORT } from '@/lib/dates';
import type { ActivityType, Equipment, Exercise, Experience, Goal, ID, LimitationArea, OnboardingAnswers, SplitKey } from '@/domain/types';
import { ALL_GYM, LOCATION_PRESETS, trainingDaysOf, withTrainingDays, type Draft } from './draft';
import { BrandMoment } from '@/components/BrandMark';

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
      <span className={cx('mt-0.5 size-5 shrink-0 rounded-full border flex items-center justify-center', selected ? 'bg-ember border-edge text-accent-ink' : 'border-line')}>
        {selected && <Check className="size-3.5" aria-hidden />}
      </span>
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        {body && <span className="block text-sm text-muted mt-0.5">{body}</span>}
      </span>
    </button>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 items-start text-sm text-muted">
      <Info className="size-4 mt-0.5 shrink-0 text-info" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

const WEEKDAY_OPTIONS = WEEK_ORDER.map((w) => ({ value: w, label: WEEKDAY_SHORT[w] }));

export const GOAL_OPTIONS: { value: Goal; title: string; body: string }[] = [
  { value: 'build_muscle', title: 'Build muscle', body: 'Get bigger and stronger with moderate reps.' },
  { value: 'strength', title: 'Improve strength', body: 'Lift heavier on the main lifts.' },
  { value: 'lose_fat', title: 'Lose fat', body: 'Keep muscle while losing fat; lifting plus easy activity.' },
  { value: 'general_fitness', title: 'General fitness', body: 'Feel fitter and stronger for everyday life.' },
  { value: 'endurance', title: 'Improve endurance', body: 'Run, ride, swim or row further, with supporting strength.' },
];
export const EXPERIENCE_OPTIONS: { value: Experience; title: string; body: string }[] = [
  { value: 'new', title: 'New to lifting', body: 'Little or no regular strength training.' },
  { value: 'returning', title: 'Returning after a break', body: 'Trained before, out of practice now.' },
  { value: 'intermediate', title: 'Intermediate', body: 'Training consistently for a year or more.' },
  { value: 'advanced', title: 'Advanced', body: 'Several years of structured training.' },
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

export const DURATION_OPTIONS: { value: number; title: string; body: string }[] = [
  { value: 30, title: '30 minutes', body: 'Short and focused: the main lifts, fewer sets.' },
  { value: 45, title: '45 minutes', body: 'Main lifts plus a couple of accessories.' },
  { value: 60, title: '60 minutes', body: 'A full session with accessories.' },
  { value: 75, title: '75 minutes', body: 'Extra sets on your main and secondary lifts.' },
  { value: 90, title: '90 minutes', body: 'The most volume, for experienced lifters with time.' },
];
export const LOCATION_OPTIONS: { value: OnboardingAnswers['location']; title: string; body: string }[] = [
  { value: 'full_gym', title: 'Gym', body: 'Barbells, racks, dumbbells, machines and cables.' },
  { value: 'home_gym', title: 'Home gym', body: 'Barbell and rack, bench, dumbbells, pull-up bar, bands.' },
  { value: 'minimal', title: 'Minimal', body: 'Bodyweight, maybe a band or two. Works anywhere.' },
];

/* --------------------------------------------------------------- steps */
export function WelcomeStep({ d, setDraft }: StepProps) {
  return (
    <div className="flex flex-col gap-4">
      <BrandMoment />
      <p className="text-[15px] font-medium">Let’s set up your training.</p>
      <p className="text-muted -mt-2">Six quick questions (about a minute) and we’ll suggest a starting program you can edit. Everything can be changed later.</p>
      <OptionCard
        selected={d.mode === 'plan'}
        onClick={() => setDraft((x) => ({ ...x, mode: 'plan' }))}
        title="Suggest a program for me"
        body="Based on your goal, days, time, equipment and anything to be careful with."
      />
      <OptionCard
        selected={d.mode === 'manual'}
        onClick={() => setDraft((x) => ({ ...x, mode: 'manual' }))}
        title="I already have a program"
        body="Start with empty sessions you fill in yourself."
      />
    </div>
  );
}

/** 1. Goal (five options; an endurance goal also asks which activity). */
export function GoalStep({ d, set }: StepProps) {
  const a = d.a;
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Main goal" className="flex flex-col gap-2">
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
        <Select label="Main activity" value={a.endurance?.activity ?? 'run'} onChange={(e) => set({ endurance: { ...(a.endurance ?? {}), activity: e.target.value as ActivityType } })}>
          {ENDURANCE_CHOICES.map((t) => (
            <option key={t} value={t}>
              {ACTIVITY_OPTIONS.find((o) => o.value === t)?.label}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

/** 2. Experience (four options). */
export function ExperienceStep({ d, set }: StepProps) {
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Experience" className="flex flex-col gap-2">
        {EXPERIENCE_OPTIONS.map((o) => (
          <OptionCard key={o.value} selected={d.a.experience === o.value} onClick={() => set({ experience: o.value })} title={o.title} body={o.body} />
        ))}
      </div>
      <p className="text-sm text-muted mt-2">You don’t need to know your 1-rep max. Your first session of each lift is a light calibration session.</p>
    </div>
  );
}

/** 3. Which days? The picked days are the training days; sessions are spread over them. */
export function DaysStep({ d, setDraft, errors }: StepProps) {
  const a = d.a;
  const days = trainingDaysOf(a);
  const beginner = a.experience === 'new' || a.experience === 'returning';
  const n = days.length;
  return (
    <div className="flex flex-col gap-4">
      <Field label="Training days" error={errors.availableWeekdays} hint={n ? `${n} day${n === 1 ? '' : 's'} a week.` : 'Tap the days you can train.'}>
        <ChipGroup label="Training days" values={days} onChange={(v) => setDraft((x) => ({ ...x, a: withTrainingDays(x.a, v) }))} options={WEEKDAY_OPTIONS} />
      </Field>
      {beginner && n >= 5 && a.goal !== 'endurance' && (
        <Notice tone="warn">For newer lifters, 3–4 days usually gives great progress with easier recovery. You can keep {n}: the plan explains the trade-offs.</Notice>
      )}
      {a.goal === 'endurance' && n > 2 && <Hint>With an endurance goal, up to 2 of these are strength days; the others become endurance sessions.</Hint>}
      {n === 7 && <Hint>Training every day: one of them becomes an easier day for recovery.</Hint>}
      <Hint>Most people do well with 3–4 days. You can move a session to another day any time.</Hint>
    </div>
  );
}

/** 4. Session length: the generator fits each workout into this time (fewer sets/accessories when short, more when long). */
export function DurationStep({ d, set }: StepProps) {
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Workout duration" className="flex flex-col gap-2">
        {DURATION_OPTIONS.map((o) => (
          <OptionCard key={o.value} selected={d.a.sessionMinutes === o.value} onClick={() => set({ sessionMinutes: o.value })} title={o.title} body={o.body} />
        ))}
      </div>
      <p className="text-sm text-muted mt-2">Including warm-up and rests. Each workout is built to fit this time.</p>
    </div>
  );
}

/** 5. Where do you train? Sets the equipment from a preset; it can be fine-tuned. */
export function LocationStep({ d, set }: StepProps) {
  const a = d.a;
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Training location" className="flex flex-col gap-2">
        {LOCATION_OPTIONS.map((o) => (
          <OptionCard key={o.value} selected={a.location === o.value} onClick={() => set({ location: o.value, equipment: [...LOCATION_PRESETS[o.value]] })} title={o.title} body={o.body} />
        ))}
      </div>
      <details className="rounded-2xl border border-line bg-surface px-4">
        <summary className="cursor-pointer min-h-11 flex items-center text-sm font-medium">Adjust equipment (optional)</summary>
        <div className="pb-4 flex flex-col gap-3">
          <p className="text-xs text-muted">Bodyweight exercises are always included. We only pick exercises you can do with what’s selected.</p>
          <ChipGroup label="Equipment" values={a.equipment} onChange={(v: Equipment[]) => set({ equipment: v })} options={ALL_GYM.map((e) => ({ value: e, label: EQUIPMENT_LABELS[e] }))} />
        </div>
      </details>
    </div>
  );
}

/** 6. Anything to be careful with? Optional chips. */
export function LimitsStep({ d, set }: StepProps) {
  const a = d.a;
  return (
    <div className="flex flex-col gap-4">
      <Field label="Areas to go easy on (optional)" hint="Skip this if nothing bothers you.">
        <ChipGroup
          label="Limitation areas"
          values={a.limitations}
          onChange={(v: LimitationArea[]) => set({ limitations: v })}
          options={(Object.keys(LIMITATION_LABELS) as LimitationArea[]).map((k) => ({ value: k, label: LIMITATION_LABELS[k] }))}
        />
      </Field>
      <p className="text-xs text-muted">
        Not a diagnosis or medical advice: we’ll just avoid exercises that commonly load these areas and suggest alternatives. If something hurts, stop, and if pain persists, see a qualified professional.
      </p>
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
          : `Structures that fit ${lifting} lifting day${lifting === 1 ? '' : 's'}${a.goal === 'endurance' ? ' alongside your endurance sessions' : ''}. Experience changes exercise choice, sets and effort, not which splits you can pick.`}
      </p>
    </div>
  );
}

export function ManualStep({ d, setDraft, errors }: StepProps) {
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
    </div>
  );
}
