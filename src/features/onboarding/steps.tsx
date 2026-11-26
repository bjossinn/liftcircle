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
import { weekdayShort } from '@/lib/dates';
import { localizeGeneratedText } from '@/domain/program/localize';
import { t, tKey, useT, type MessageKey } from '@/i18n';
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

/** Weekday chips in week order, labelled in the current language. */
const weekdayOptions = () => WEEK_ORDER.map((w) => ({ value: w, label: weekdayShort(w) }));
/** Shared equipment / limitation labels (`workout.meta.*`), falling back to the catalog English. */
export const equipmentLabel = (e: Equipment) => tKey(`workout.meta.equipment.${e}`, EQUIPMENT_LABELS[e]);
export const limitationLabel = (l: LimitationArea) => tKey(`workout.meta.limitation.${l}`, LIMITATION_LABELS[l]);

/** An option whose title/body are read in the current language each time (values stay stable enums). */
function option<V>(value: V, titleKey: MessageKey, bodyKey: MessageKey): { value: V; readonly title: string; readonly body: string } {
  return {
    value,
    get title() {
      return t(titleKey);
    },
    get body() {
      return t(bodyKey);
    },
  };
}

export const GOAL_OPTIONS: { value: Goal; readonly title: string; readonly body: string }[] = [
  option('build_muscle', 'onboarding.goal.buildMuscle', 'onboarding.goal.buildMuscle.help'),
  option('strength', 'onboarding.goal.strength', 'onboarding.goal.strength.help'),
  option('lose_fat', 'onboarding.goal.loseFat', 'onboarding.goal.loseFat.help'),
  option('general_fitness', 'onboarding.goal.fitness', 'onboarding.goal.fitness.help'),
  option('endurance', 'onboarding.goal.endurance', 'onboarding.goal.endurance.help'),
];
export const EXPERIENCE_OPTIONS: { value: Experience; readonly title: string; readonly body: string }[] = [
  option('new', 'onboarding.experience.new', 'onboarding.experience.new.help'),
  option('returning', 'onboarding.experience.returning', 'onboarding.experience.returning.help'),
  option('intermediate', 'onboarding.experience.intermediate', 'onboarding.experience.intermediate.help'),
  option('advanced', 'onboarding.experience.advanced', 'onboarding.experience.advanced.help'),
];
const ACTIVITY_VALUES: ActivityType[] = ['walk', 'run', 'cycle', 'hike', 'swim', 'row', 'sport', 'class', 'yoga', 'mobility', 'stretch'];
export const ACTIVITY_OPTIONS: { value: ActivityType; readonly label: string }[] = ACTIVITY_VALUES.map((value) => ({
  value,
  get label() {
    return t(`onboarding.activity.${value}` as MessageKey);
  },
}));
const ENDURANCE_CHOICES: ActivityType[] = ['run', 'cycle', 'swim', 'row', 'hike', 'walk'];
const LOCATION_LABEL_KEYS: Record<OnboardingAnswers['location'], MessageKey> = {
  full_gym: 'onboarding.location.fullGymLabel',
  home_gym: 'onboarding.location.homeGymLabel',
  minimal: 'onboarding.location.minimalLabel',
};
export const LOCATION_LABELS: Record<OnboardingAnswers['location'], string> = {
  get full_gym() {
    return t(LOCATION_LABEL_KEYS.full_gym);
  },
  get home_gym() {
    return t(LOCATION_LABEL_KEYS.home_gym);
  },
  get minimal() {
    return t(LOCATION_LABEL_KEYS.minimal);
  },
};

export const DURATION_OPTIONS: { value: number; readonly title: string; readonly body: string }[] = [
  option(30, 'onboarding.duration.30', 'onboarding.duration.30.help'),
  option(45, 'onboarding.duration.45', 'onboarding.duration.45.help'),
  option(60, 'onboarding.duration.60', 'onboarding.duration.60.help'),
  option(75, 'onboarding.duration.75', 'onboarding.duration.75.help'),
  option(90, 'onboarding.duration.90', 'onboarding.duration.90.help'),
];
export const LOCATION_OPTIONS: { value: OnboardingAnswers['location']; readonly title: string; readonly body: string }[] = [
  option('full_gym', 'onboarding.location.gym', 'onboarding.location.gym.help'),
  option('home_gym', 'onboarding.location.home', 'onboarding.location.home.help'),
  option('minimal', 'onboarding.location.minimal', 'onboarding.location.minimal.help'),
];

/* --------------------------------------------------------------- steps */
export function WelcomeStep({ d, setDraft }: StepProps) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-4">
      <BrandMoment />
      <p className="text-[15px] font-medium">{t('onboarding.welcome.lead')}</p>
      <p className="text-muted -mt-2">{t('onboarding.welcome.description')}</p>
      <OptionCard
        selected={d.mode === 'plan'}
        onClick={() => setDraft((x) => ({ ...x, mode: 'plan' }))}
        title={t('onboarding.welcome.suggest')}
        body={t('onboarding.welcome.suggest.help')}
      />
      <OptionCard
        selected={d.mode === 'manual'}
        onClick={() => setDraft((x) => ({ ...x, mode: 'manual' }))}
        title={t('onboarding.welcome.manual')}
        body={t('onboarding.welcome.manual.help')}
      />
    </div>
  );
}

/** 1. Goal (five options; an endurance goal also asks which activity). */
export function GoalStep({ d, set }: StepProps) {
  const { t } = useT();
  const a = d.a;
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label={t('onboarding.goal.group')} className="flex flex-col gap-2">
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
        <Select label={t('onboarding.goal.mainActivity')} value={a.endurance?.activity ?? 'run'} onChange={(e) => set({ endurance: { ...(a.endurance ?? {}), activity: e.target.value as ActivityType } })}>
          {ENDURANCE_CHOICES.map((act) => (
            <option key={act} value={act}>
              {ACTIVITY_OPTIONS.find((o) => o.value === act)?.label}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

/** 2. Experience (four options). */
export function ExperienceStep({ d, set }: StepProps) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={t('onboarding.experience.group')} className="flex flex-col gap-2">
        {EXPERIENCE_OPTIONS.map((o) => (
          <OptionCard key={o.value} selected={d.a.experience === o.value} onClick={() => set({ experience: o.value })} title={o.title} body={o.body} />
        ))}
      </div>
      <p className="text-sm text-muted mt-2">{t('onboarding.experience.calibration')}</p>
    </div>
  );
}

/** 3. Which days? The picked days are the training days; sessions are spread over them. */
export function DaysStep({ d, setDraft, errors }: StepProps) {
  const { t, tp } = useT();
  const a = d.a;
  const days = trainingDaysOf(a);
  const beginner = a.experience === 'new' || a.experience === 'returning';
  const n = days.length;
  return (
    <div className="flex flex-col gap-4">
      <Field label={t('onboarding.days.label')} error={errors.availableWeekdays} hint={n ? tp('onboarding.days.count', n) : t('onboarding.days.choose')}>
        <ChipGroup label={t('onboarding.days.label')} values={days} onChange={(v) => setDraft((x) => ({ ...x, a: withTrainingDays(x.a, v) }))} options={weekdayOptions()} />
      </Field>
      {beginner && n >= 5 && a.goal !== 'endurance' && (
        <Notice tone="warn">{t('onboarding.days.beginnerWarning', { count: n })}</Notice>
      )}
      {a.goal === 'endurance' && n > 2 && <Hint>{t('onboarding.days.endurance')}</Hint>}
      {n === 7 && <Hint>{t('onboarding.days.everyDay')}</Hint>}
      <Hint>{t('onboarding.days.hint')}</Hint>
    </div>
  );
}

/** 4. Session length: the generator fits each workout into this time (fewer sets/accessories when short, more when long). */
export function DurationStep({ d, set }: StepProps) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={t('onboarding.duration.group')} className="flex flex-col gap-2">
        {DURATION_OPTIONS.map((o) => (
          <OptionCard key={o.value} selected={d.a.sessionMinutes === o.value} onClick={() => set({ sessionMinutes: o.value })} title={o.title} body={o.body} />
        ))}
      </div>
      <p className="text-sm text-muted mt-2">{t('onboarding.duration.hint')}</p>
    </div>
  );
}

/** 5. Where do you train? Sets the equipment from a preset; it can be fine-tuned. */
export function LocationStep({ d, set }: StepProps) {
  const { t } = useT();
  const a = d.a;
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label={t('onboarding.location.group')} className="flex flex-col gap-2">
        {LOCATION_OPTIONS.map((o) => (
          <OptionCard key={o.value} selected={a.location === o.value} onClick={() => set({ location: o.value, equipment: [...LOCATION_PRESETS[o.value]] })} title={o.title} body={o.body} />
        ))}
      </div>
      <details className="rounded-2xl border border-line bg-surface px-4">
        <summary className="cursor-pointer min-h-11 flex items-center text-sm font-medium">{t('onboarding.location.adjust')}</summary>
        <div className="pb-4 flex flex-col gap-3">
          <p className="text-xs text-muted">{t('onboarding.location.equipment.help')}</p>
          <ChipGroup label={t('onboarding.location.equipment')} values={a.equipment} onChange={(v: Equipment[]) => set({ equipment: v })} options={ALL_GYM.map((e) => ({ value: e, label: equipmentLabel(e) }))} />
        </div>
      </details>
    </div>
  );
}

/** 6. Anything to be careful with? Optional chips. */
export function LimitsStep({ d, set }: StepProps) {
  const { t } = useT();
  const a = d.a;
  return (
    <div className="flex flex-col gap-4">
      <Field label={t('onboarding.limits.label')} hint={t('onboarding.limits.hint')}>
        <ChipGroup
          label={t('onboarding.limits.group')}
          values={a.limitations}
          onChange={(v: LimitationArea[]) => set({ limitations: v })}
          options={(Object.keys(LIMITATION_LABELS) as LimitationArea[]).map((k) => ({ value: k, label: limitationLabel(k) }))}
        />
      </Field>
      <p className="text-xs text-muted">{t('onboarding.limits.safety')}</p>
    </div>
  );
}

/**
 * Radio-style split selector for the current lifting-day count. The selection is stored as
 * `splitPreference`; when the day count changes the resolver keeps the intent and says so.
 */
export function SplitPicker({ a, onSelect, showTitle = true }: { a: OnboardingAnswers; onSelect: (key: SplitKey) => void; showTitle?: boolean }) {
  const { t, tp } = useT();
  const titleId = useId();
  const lifting = effectiveLiftingDays(a);
  const res = resolveSplit(a, lifting);
  const requested = Math.min(Math.round(a.liftingDaysPerWeek || 0), availableDayCount(a));
  if (lifting === 0) return <p className="text-sm text-muted">{t('onboarding.split.noLifting')}</p>;
  return (
    <div className="flex flex-col gap-2">
      {showTitle && (
        <span id={titleId} className="text-sm font-medium">
          {t('onboarding.split.title')}
        </span>
      )}
      {a.goal === 'endurance' && requested > lifting && (
        <p className="text-xs text-muted">{t('onboarding.split.endurance')}</p>
      )}
      {res.adjustment && (
        <Notice tone="warn" className="py-2.5">
          <span role="status">{localizeGeneratedText(res.adjustment.message)}</span>
        </Notice>
      )}
      <div role="radiogroup" aria-labelledby={showTitle ? titleId : undefined} aria-label={showTitle ? undefined : t('onboarding.split.title')} className="flex flex-col gap-2">
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
                    <Badge tone="accent">{t('onboarding.split.recommended')}</Badge>
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
          ? tp('onboarding.split.only', lifting)
          : tp(a.goal === 'endurance' ? 'onboarding.split.optionsEndurance' : 'onboarding.split.options', lifting)}
      </p>
    </div>
  );
}

export function ManualStep({ d, setDraft, errors }: StepProps) {
  const { t } = useT();
  const m = d.manual;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted">{t('onboarding.manual.description')}</p>
      <Field label={t('onboarding.manual.sessions')} error={errors.sessions}>
        <Segmented label={t('onboarding.manual.sessionCount')} value={m.sessions} onChange={(v) => setDraft((x) => ({ ...x, manual: { ...x.manual, sessions: v } }))} options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))} />
      </Field>
      <Field label={t('onboarding.manual.days')} hint={t('onboarding.manual.days.help')}>
        <ChipGroup label={t('onboarding.days.label')} values={m.days} onChange={(v) => setDraft((x) => ({ ...x, manual: { ...x.manual, days: v } }))} options={weekdayOptions()} />
      </Field>
    </div>
  );
}
