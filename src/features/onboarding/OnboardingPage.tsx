/**
 * /onboarding — short multi-step setup wizard. Progress is saved to kv('onboarding-draft') after every
 * change so a reload resumes. Ends with a suggested, editable program (or a manual program) and
 * optional nutrition targets.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, RotateCcw, X } from 'lucide-react';
import { Button, ConfirmDialog, IconButton, Notice, ProgressBar, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { useExercises } from '@/data/catalog';
import { alive, kvGet, kvSet, newRecord, saveRecord } from '@/db/repo';
import { computeNutritionTargets, type TargetInput } from '@/domain/nutrition/targets';
import { createProgram } from '@/domain/program/program';
import { emptyTemplate, generateProgram, suggestProgramName } from '@/domain/program/generator';
import { splitKeyOfVersion } from '@/domain/program/splits';
import { SPLITS } from '@/domain/program/templates';
import { fromKg, round } from '@/domain/units';
import { formatDate, todayISO } from '@/lib/dates';
import type { AccountState, NutritionTargets, OnboardingAnswers, ProgramVersion, SplitKey } from '@/domain/types';
import { DRAFT_KEY, isUnder18, migrateDraft, newDraft, STEP_TITLES, stepsFor, validateStep, type Draft, type StepKey } from './draft';
import {
  AboutStep, BodyStep, EquipmentStep, ExercisesStep, ExperienceStep, GoalStep, LifestyleStep, LimitsStep, ManualStep, NutritionStep, ScheduleStep, WelcomeStep,
  type StepProps,
} from './steps';
import { ResultStep, ReviewStep } from './result';

const STEP_COMPONENTS: Partial<Record<StepKey, (p: StepProps) => JSX.Element>> = {
  welcome: WelcomeStep,
  about: AboutStep,
  body: BodyStep,
  goal: GoalStep,
  experience: ExperienceStep,
  schedule: ScheduleStep,
  equipment: EquipmentStep,
  exercises: ExercisesStep,
  limits: LimitsStep,
  lifestyle: LifestyleStep,
  nutrition: NutritionStep,
  manual: ManualStep,
};

function isDraft(v: unknown): v is Draft {
  return !!v && typeof v === 'object' && (v as Draft).v === 1 && typeof (v as Draft).step === 'string' && !!(v as Draft).a;
}

function nutritionInput(a: OnboardingAnswers, d: Draft): TargetInput {
  const ref: 'goal' | 'current' = a.targetWeightKg != null && (d.nutri.refSource === 'goal' || a.weightKg == null) ? 'goal' : 'current';
  return {
    age: a.age,
    weightKg: a.weightKg,
    heightCm: a.heightCm,
    sexParam: a.nutritionMode === 'full' ? a.sexParam : undefined,
    activityLevel: a.activityLevel,
    goal: a.goal,
    mode: isUnder18(a) ? 'protein_only' : (a.nutritionMode ?? 'protein_only'),
    proteinPerKg: d.nutri.proteinPerKg,
    referenceWeightKg: ref === 'goal' ? a.targetWeightKg : undefined,
    referenceWeightSource: ref,
    mealsPerDay: a.diet.mealsPerDay,
    individualizedNutrition: a.individualizedNutrition,
    weightUnit: a.units.weight,
  };
}

function manualTargets(d: Draft, base: NutritionTargets | null, reason: NutritionTargets['autoDisabledReason']): NutritionTargets {
  const n = d.nutri;
  const t: NutritionTargets = {
    mode: 'manual',
    proteinPerKg: n.proteinPerKg,
    mealsPerDay: d.a.diet.mealsPerDay,
    autoDisabledReason: reason ?? null,
    updatedAt: Date.now(),
  };
  if (n.manualProtein != null) t.proteinG = n.manualProtein;
  if (n.manualCalories != null) t.calories = n.manualCalories;
  if (n.manualCarbs != null) t.carbsG = n.manualCarbs;
  if (n.manualFat != null) t.fatG = n.manualFat;
  if (base?.referenceWeightKg != null) t.referenceWeightKg = base.referenceWeightKg;
  return t;
}

function profileFrom(a: OnboardingAnswers, prev: AccountState['profile']): AccountState['profile'] {
  const full = a.wantsNutrition && a.nutritionMode === 'full' && !isUnder18(a);
  return {
    ...prev,
    displayName: a.displayName.trim(),
    age: a.age,
    ageRecordedAt: a.age != null ? Date.now() : undefined,
    heightCm: a.heightCm,
    sexParam: full ? a.sexParam : undefined,
    goal: a.goal,
    secondaryGoal: a.secondaryGoal,
    targetWeightKg: a.targetWeightKg,
    experience: a.experience,
    activityLevel: a.activityLevel,
    limitations: a.limitations,
    injuryNotes: a.limitationNotes,
    diet: a.diet,
    individualizedNutrition: !!a.individualizedNutrition,
    onboardedAt: Date.now(),
  };
}

export default function OnboardingPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { db, account, accountReady, updateAccount } = useApp();
  const coachPlan = useLiveQuery(async () => alive(await db.programs.toArray()).find((p) => p.active && p.managedBy?.kind === 'coach'), [db]);
  const { list: catalog, byId } = useExercises();
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const finished = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const today = todayISO(account.settings.timeZone);

  // Load (resume) the draft once the account row is ready.
  useEffect(() => {
    if (!accountReady || draft) return;
    let cancelled = false;
    kvGet<unknown>(DRAFT_KEY, db)
      .catch(() => undefined)
      .then((saved) => {
        if (cancelled) return;
        if (isDraft(saved)) {
          setDraftState(migrateDraft(saved));
          if (saved.step !== 'welcome') toast.show('Picked up where you left off', { action: { label: 'Start over', onClick: () => setConfirmRestart(true) } });
        } else setDraftState(newDraft(account));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountReady, db]);

  // Persist after every change (debounced).
  useEffect(() => {
    if (!draft || finished.current) return;
    const t = setTimeout(() => {
      if (!finished.current) void kvSet(DRAFT_KEY, draft, db).catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [draft, db]);

  const setDraft = useCallback((fn: (d: Draft) => Draft) => setDraftState((d) => (d ? fn(d) : d)), []);
  const set = useCallback((patch: Partial<OnboardingAnswers>) => setDraft((d) => ({ ...d, a: { ...d.a, ...patch } })), [setDraft]);

  const answersKey = draft ? JSON.stringify(draft.a) : '';
  const suggestion: ProgramVersion | null = useMemo(() => {
    if (!draft || draft.mode !== 'plan' || draft.step !== 'result') return null;
    if (draft.version && draft.versionKey === answersKey) return draft.version;
    return generateProgram(draft.a, catalog, { startDate: today, variant: draft.variant });
  }, [draft, answersKey, catalog, today]);

  const nutrition = useMemo(() => {
    if (!draft || !draft.a.wantsNutrition || draft.mode !== 'plan') return null;
    return computeNutritionTargets(nutritionInput(draft.a, draft));
  }, [draft]);

  if (!draft) {
    return (
      <div className="mx-auto max-w-2xl px-4">
        <Spinner label="Loading setup" />
      </div>
    );
  }

  const steps = stepsFor(draft);
  const idx = Math.max(0, steps.indexOf(draft.step));
  const step = steps[idx] ?? 'welcome';

  const goTo = (s: StepKey, fromReview = false) => {
    setErrors({});
    setDraft((d) => ({ ...d, step: s, fromReview }));
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0 });
      headingRef.current?.focus();
    });
  };
  const validate = () => {
    const e = validateStep(step, draft);
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const next = () => {
    if (!validate()) return;
    if (draft.fromReview && step !== 'review') return goTo('review');
    if (idx < steps.length - 1) goTo(steps[idx + 1]);
  };
  const back = () => {
    if (idx === 0) return nav(-1);
    goTo(steps[idx - 1]);
  };
  const skipBody = () => {
    set({ age: undefined, weightKg: undefined, heightCm: undefined });
    setErrors({});
    goTo(draft.fromReview ? 'review' : steps[idx + 1]);
  };

  async function deactivateOthers() {
    const progs = alive(await db.programs.toArray()).filter((p) => p.active);
    for (const p of progs) await saveRecord('programs', { ...p, active: false }, db);
  }
  async function finish(to: string) {
    finished.current = true;
    await db.kv.delete(DRAFT_KEY).catch(() => undefined);
    nav(to, { replace: true });
  }

  async function accept() {
    if (!suggestion || !draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Record the split actually accepted (explicit choice, mapped choice or recommended default).
      const acceptedSplit = splitKeyOfVersion(suggestion) ?? draft.a.splitPreference;
      const a: OnboardingAnswers = { ...draft.a, displayName: draft.a.displayName.trim(), ...(acceptedSplit ? { splitPreference: acceptedSplit } : {}) };
      const program = createProgram(a, suggestion, today, suggestProgramName(a, suggestion), 'generated');
      await deactivateOthers();
      await saveRecord('programs', program, db);
      if (a.weightKg != null) {
        const unit = a.units.weight;
        await saveRecord('measurements', newRecord({ kind: 'bodyweight' as const, date: today, value: a.weightKg, entered: { value: round(fromKg(a.weightKg, unit), 1), unit } }), db);
      }
      let targets: NutritionTargets | null = null;
      if (a.wantsNutrition) {
        const reason = nutrition?.targets.autoDisabledReason ?? null;
        targets = draft.nutri.manual || reason ? manualTargets(draft, nutrition?.targets ?? null, reason) : (nutrition?.targets ?? null);
      }
      await updateAccount((acc) => ({
        ...acc,
        profile: profileFrom(a, acc.profile),
        settings: { ...acc.settings, units: a.units, nutritionEnabled: a.wantsNutrition },
        nutrition: targets ?? acc.nutrition,
      }));
      toast.show('Your program is ready', { tone: 'success' });
      await finish('/');
    } catch (e) {
      finished.current = false;
      setSaveError(e instanceof Error ? e.message : 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function createManual() {
    if (!draft || !validate()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const a = { ...draft.a, displayName: draft.a.displayName.trim() };
      const letters = Array.from({ length: draft.manual.sessions }, (_, i) => String.fromCharCode(65 + i));
      const templates = letters.map((l) => emptyTemplate(`custom:${l.toLowerCase()}`, `Session ${l}`));
      const days = [...draft.manual.days].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
      const version: ProgramVersion = {
        version: 1,
        createdAt: Date.now(),
        reason: 'Created manually',
        templates,
        schedule: days.map((weekday, i) => ({ weekday, templateId: templates[i % templates.length].id })),
        weeks: 8,
        reviewWeek: 8,
        rationale: ['You chose to set up your own program. Add exercises to each session — every change is saved as a version you can restore.'],
        warnings: [],
      };
      await deactivateOthers();
      await saveRecord('programs', createProgram(null, version, today, 'My program', 'manual'), db);
      await updateAccount((acc) => ({
        ...acc,
        profile: { ...acc.profile, displayName: a.displayName, onboardedAt: Date.now() },
        settings: { ...acc.settings, units: a.units, nutritionEnabled: a.wantsNutrition },
        nutrition: a.wantsNutrition ? manualTargets(draft, null, null) : acc.nutrition,
      }));
      toast.show('Program created — add your exercises', { tone: 'success' });
      await finish('/train/program');
    } catch (e) {
      finished.current = false;
      setSaveError(e instanceof Error ? e.message : 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const Comp = STEP_COMPONENTS[step];
  const stepProps: StepProps = { d: draft, set, setDraft, errors, byId };
  const isResult = step === 'result';
  const isManual = step === 'manual';
  const primaryLabel = step === 'welcome' ? 'Get started' : step === 'review' ? 'Build my plan' : draft.fromReview ? 'Back to review' : 'Continue';
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <div className="mx-auto w-full max-w-2xl min-h-dvh flex flex-col">
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 min-h-11">
          <IconButton label={idx === 0 ? 'Close setup' : 'Back'} onClick={back}>
            {idx === 0 ? <X className="size-5" /> : <ChevronLeft className="size-5" />}
          </IconButton>
          <span className="flex-1 text-sm text-muted" aria-live="polite">
            Step {idx + 1} of {steps.length}
          </span>
          {idx > 0 && (
            <IconButton label="Start over" onClick={() => setConfirmRestart(true)}>
              <RotateCcw className="size-4" />
            </IconButton>
          )}
        </div>
        <ProgressBar value={idx + 1} max={steps.length} label="Setup progress" />
      </header>

      <div className="flex-1 px-4 pb-32">
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold tracking-tight mt-4 mb-4 focus:outline-none">
          {step === 'welcome' ? 'Let’s set up LiftCircle' : STEP_TITLES[step]}
        </h1>
        {hasErrors && (
          <Notice tone="danger" className="mb-4">
            Please fix the highlighted {Object.keys(errors).length === 1 ? 'field' : 'fields'}.
          </Notice>
        )}
        {Comp && <Comp {...stepProps} />}
        {step === 'review' && <ReviewStep d={draft} byId={byId} onEdit={(s) => goTo(s, true)} />}
        {isResult && suggestion && (
          <ResultStep
            d={draft}
            version={suggestion}
            catalog={catalog}
            byId={byId}
            nutrition={nutrition}
            today={formatDate(today)}
            setDraft={setDraft}
            onVersion={(v) => setDraft((d) => ({ ...d, version: v, versionKey: JSON.stringify(d.a) }))}
            onShuffle={() => {
              const prev = { variant: draft.variant, version: draft.version, versionKey: draft.versionKey, regen: draft.regen };
              setDraft((d) => ({ ...d, variant: d.variant + 1, version: null, versionKey: null, regen: {} }));
              toast.show('Exercises shuffled — same split', { action: { label: 'Undo', onClick: () => setDraft((d) => ({ ...d, ...prev })) } });
            }}
            onSplit={(key: SplitKey) => {
              const prev = { splitPreference: draft.a.splitPreference, variant: draft.variant, version: draft.version, versionKey: draft.versionKey, regen: draft.regen };
              setDraft((d) => ({ ...d, a: { ...d.a, splitPreference: key }, variant: 0, version: null, versionKey: null, regen: {} }));
              toast.show(`Split changed to ${SPLITS[key].label}`, {
                action: {
                  label: 'Undo',
                  onClick: () =>
                    setDraft((d) => {
                      const a = { ...d.a, splitPreference: prev.splitPreference };
                      if (prev.splitPreference === undefined) delete a.splitPreference;
                      return { ...d, a, variant: prev.variant, version: prev.version, versionKey: prev.versionKey, regen: prev.regen };
                    }),
                },
              });
            }}
          />
        )}
        {(isResult || isManual) && coachPlan && (
          <Notice tone="warn" className="mt-4">
            Your current plan, “{coachPlan.name}”, is managed by {coachPlan.managedBy?.coachName ?? 'your coach'}. Starting this program makes it your
            active plan instead. The coach’s plan and your workouts are kept, and your coaching relationship isn’t changed.
          </Notice>
        )}
        {saveError && (
          <Notice tone="danger" className="mt-4">
            {saveError}
          </Notice>
        )}
      </div>

      <footer className="fixed bottom-0 inset-x-0 z-20 bg-surface/95 backdrop-blur border-t border-line pb-safe">
        <div className="mx-auto max-w-2xl px-4 py-3 flex gap-2">
          {step === 'body' && (
            <Button variant="ghost" onClick={skipBody}>
              Skip
            </Button>
          )}
          {isResult ? (
            <>
              <Button variant="ghost" onClick={() => goTo('review')}>
                Edit answers
              </Button>
              <Button variant="primary" size="lg" className="flex-1" loading={saving} onClick={accept}>
                Accept & start
              </Button>
            </>
          ) : isManual ? (
            <Button variant="primary" size="lg" className="flex-1" loading={saving} onClick={createManual}>
              Create my program
            </Button>
          ) : (
            <Button variant="primary" size="lg" className="flex-1" onClick={next}>
              {primaryLabel}
            </Button>
          )}
        </div>
      </footer>

      <ConfirmDialog
        open={confirmRestart}
        title="Start over?"
        body="Your answers so far will be cleared."
        confirmLabel="Start over"
        danger
        onCancel={() => setConfirmRestart(false)}
        onConfirm={() => {
          setConfirmRestart(false);
          setErrors({});
          setDraftState(newDraft(account));
        }}
      />
    </div>
  );
}
