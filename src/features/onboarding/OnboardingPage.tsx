/**
 * /onboarding — six quick questions (goal, experience, which days, session length, where you train, anything to be
 * careful with; about a minute), then a suggested, editable program. Units come from the device locale; body details
 * and nutrition are set up later from Profile, Progress, Nutrition or Settings. Progress is saved to
 * kv('onboarding-draft') after every change so a reload resumes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, RotateCcw, X } from 'lucide-react';
import { Button, ConfirmDialog, IconButton, Notice, ProgressBar, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { useExercises } from '@/data/catalog';
import { alive, kvGet, kvSet, saveRecord } from '@/db/repo';
import { createProgram } from '@/domain/program/program';
import { emptyTemplate, generateProgram, suggestProgramName } from '@/domain/program/generator';
import { splitKeyOfVersion } from '@/domain/program/splits';
import { SPLITS } from '@/domain/program/templates';
import { formatDate, todayISO } from '@/lib/dates';
import type { AccountState, OnboardingAnswers, ProgramVersion, SplitKey } from '@/domain/types';
import { DRAFT_KEY, migrateDraft, newDraft, QUESTION_STEPS, questionNumber, STEP_TITLES, stepsFor, validateStep, type Draft, type StepKey } from './draft';
import { DaysStep, DurationStep, ExperienceStep, GoalStep, LimitsStep, LocationStep, ManualStep, WelcomeStep, type StepProps } from './steps';
import { ResultStep } from './result';
import { startFirstWorkout } from './firstWorkout';
import { trackOnboardingCompleted } from '@/analytics/analytics';

const STEP_COMPONENTS: Partial<Record<StepKey, (p: StepProps) => JSX.Element>> = {
  welcome: WelcomeStep,
  goal: GoalStep,
  experience: ExperienceStep,
  days: DaysStep,
  duration: DurationStep,
  location: LocationStep,
  limits: LimitsStep,
  manual: ManualStep,
};

function isDraft(v: unknown): v is Draft {
  return !!v && typeof v === 'object' && (v as Draft).v === 1 && typeof (v as Draft).step === 'string' && !!(v as Draft).a;
}

/**
 * The profile after setup: only what the six questions ask (goal, experience, areas to be careful with) changes.
 * Everything else an existing account already has (name, body details, diet, nutrition choices) is kept as it is.
 */
export function profileFrom(a: OnboardingAnswers, prev: AccountState['profile']): AccountState['profile'] {
  return { ...prev, goal: a.goal, experience: a.experience, limitations: a.limitations, onboardedAt: Date.now() };
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
  /** Set while "Accept & start" / "Save plan, start later" runs, so a double tap can't save the plan twice. */
  const accepting = useRef(false);
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

  const goTo = (s: StepKey) => {
    setErrors({});
    setDraft((d) => ({ ...d, step: s }));
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
    if (idx < steps.length - 1) goTo(steps[idx + 1]);
  };
  const back = () => {
    if (idx === 0) return nav(-1);
    goTo(steps[idx - 1]);
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

  /**
   * Save the suggested plan. With `start` (the primary "Accept & start"), also start the plan's first workout and open
   * the logger. If a workout is already in progress, or the plan has no lifting workout to start, the plan is still
   * saved and the user lands on Today instead.
   */
  async function accept({ start }: { start: boolean }) {
    if (!suggestion || !draft || accepting.current) return;
    accepting.current = true;
    setSaving(true);
    setSaveError(null);
    let program: ReturnType<typeof createProgram>;
    let settings: AccountState['settings'];
    let experience: OnboardingAnswers['experience'];
    try {
      // Record the split actually accepted (explicit choice, mapped choice or recommended default).
      const acceptedSplit = splitKeyOfVersion(suggestion) ?? draft.a.splitPreference;
      const a: OnboardingAnswers = { ...draft.a, displayName: draft.a.displayName.trim(), ...(acceptedSplit ? { splitPreference: acceptedSplit } : {}) };
      program = createProgram(a, suggestion, today, suggestProgramName(a, suggestion), 'generated');
      await deactivateOthers();
      await saveRecord('programs', program, db);
      // Units: the locale default (or the units already in use). Nutrition settings and targets are left as they are.
      await updateAccount((acc) => ({ ...acc, profile: profileFrom(a, acc.profile), settings: { ...acc.settings, units: a.units } }));
      settings = { ...account.settings, units: a.units };
      experience = a.experience;
    } catch (e) {
      finished.current = false;
      accepting.current = false;
      setSaveError(e instanceof Error ? e.message : 'Could not save. Please try again.');
      setSaving(false);
      return;
    }
    // The plan is saved from here on: never stay on this screen (a retry would save it again).
    void trackOnboardingCompleted(db, 'suggested');
    if (!start) {
      toast.show('Plan saved. Start your first workout whenever you’re ready.', { tone: 'success' });
      return finish('/');
    }
    try {
      const r = await startFirstWorkout(program, today, { db, settings, catalog, experience });
      if (r.kind === 'started') return await finish(`/train/session/${r.session.id}`);
      toast.show(r.kind === 'already_active' ? 'Plan saved. You already have a workout in progress: finish that one first.' : 'You’re ready to log your first workout.', {
        tone: 'success',
      });
    } catch {
      toast.show('Plan saved, but the workout couldn’t start. Start it from Today.', { tone: 'error' });
    }
    await finish('/');
  }

  async function createManual() {
    if (!draft || !validate()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const a = draft.a;
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
        rationale: ['You chose to set up your own program. Add exercises to each session. Every change is saved as a version you can restore.'],
        warnings: [],
      };
      await deactivateOthers();
      await saveRecord('programs', createProgram(null, version, today, 'My program', 'manual'), db);
      await updateAccount((acc) => ({ ...acc, profile: { ...acc.profile, onboardedAt: Date.now() }, settings: { ...acc.settings, units: a.units } }));
      void trackOnboardingCompleted(db, 'manual');
      toast.show('Program created: add your exercises', { tone: 'success' });
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
  const qn = questionNumber(step);
  const primaryLabel = step === 'welcome' ? 'Get started' : step === QUESTION_STEPS[QUESTION_STEPS.length - 1] ? 'Build my plan' : 'Continue';
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <div className="mx-auto w-full max-w-2xl min-h-dvh flex flex-col">
      <header className="sticky top-0 z-10 bg-bg/95 backdrop-blur px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 min-h-11">
          <IconButton label={idx === 0 ? 'Close setup' : 'Back'} onClick={back}>
            {idx === 0 ? <X className="size-5" /> : <ChevronLeft className="size-5" />}
          </IconButton>
          <span className="flex-1 text-sm text-muted" aria-live="polite">
            {qn ? `Question ${qn} of ${QUESTION_STEPS.length}` : step === 'welcome' ? 'About a minute' : step === 'result' ? 'Your suggested plan' : 'Set up your own program'}
          </span>
          {idx > 0 && (
            <IconButton label="Start over" onClick={() => setConfirmRestart(true)}>
              <RotateCcw className="size-4" />
            </IconButton>
          )}
        </div>
        <ProgressBar value={idx + 1} max={steps.length} label="Setup progress" />
      </header>

      <div className={`flex-1 px-4 ${isResult ? 'pb-44' : 'pb-32'}`}>
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold tracking-tight mt-4 mb-4 focus:outline-none">
          {step === 'welcome' ? 'Welcome to Hard Earned' : STEP_TITLES[step]}
        </h1>
        {hasErrors && (
          <Notice tone="danger" className="mb-4">
            Please fix the highlighted {Object.keys(errors).length === 1 ? 'field' : 'fields'}.
          </Notice>
        )}
        {Comp && <Comp {...stepProps} />}
        {isResult && suggestion && (
          <ResultStep
            d={draft}
            version={suggestion}
            catalog={catalog}
            byId={byId}
            today={formatDate(today)}
            setDraft={setDraft}
            onVersion={(v) => setDraft((d) => ({ ...d, version: v, versionKey: JSON.stringify(d.a) }))}
            onShuffle={() => {
              const prev = { variant: draft.variant, version: draft.version, versionKey: draft.versionKey, regen: draft.regen };
              setDraft((d) => ({ ...d, variant: d.variant + 1, version: null, versionKey: null, regen: {} }));
              toast.show('Exercises shuffled: same split', { action: { label: 'Undo', onClick: () => setDraft((d) => ({ ...d, ...prev })) } });
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
          {isResult ? (
            <>
              <Button variant="ghost" onClick={() => goTo(QUESTION_STEPS[0])}>
                Edit answers
              </Button>
              <Button variant="primary" size="lg" className="flex-1" loading={saving} onClick={() => void accept({ start: true })}>
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
        {isResult && (
          <div className="mx-auto max-w-2xl px-4 -mt-2 pb-2 flex justify-center">
            <button
              type="button"
              className="min-h-11 px-3 text-sm font-medium text-muted hover:text-ink"
              disabled={saving}
              onClick={() => void accept({ start: false })}
            >
              Save plan, start later
            </button>
          </div>
        )}
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
