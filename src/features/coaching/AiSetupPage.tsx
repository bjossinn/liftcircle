/**
 * /coaching/ai/setup — short AI coach enrollment:
 *  1. what it does / doesn't do  2. review & correct details the app already has (only ask what's missing)
 *  3. choose data categories      4. explicit consent → aiApi.saveSettings({ enabled, scopes, acceptConsent }).
 * Profile corrections are written to the account (same fields onboarding uses). Training-setup corrections
 * (days, session length, equipment) are not program edits, so they're stored in the user-visible AI coach notes.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, CheckCircle2, ChevronLeft, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { Badge, Button, Card, ChipGroup, IconButton, Notice, Page, ProgressBar, Segmented, Select, Spinner, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { aiApi } from '@/backend/ai';
import type { AiScopes } from '@/backend/coachingContract';
import type { CoachStyle } from '@/domain/types';
import { useApp } from '@/state/app';
import { useExercises } from '@/data/catalog';
import { EQUIPMENT_LABELS, LIMITATION_LABELS } from '@/data/exerciseMeta';
import { trainingSetupLine, upsertSetupLine, type SetupDetails as Details } from './ai/setup';
import { ALLERGEN_LABELS, DIET_TAG_LABELS } from '@/features/onboarding/draft';
import { EXPERIENCE_OPTIONS, GOAL_OPTIONS } from '@/features/onboarding/steps';
import { currentVersion } from '@/domain/program/program';
import type { Allergen, DietTag, Equipment, Experience, Goal, LimitationArea } from '@/domain/types';
import { AI_NOTES_MAX, classifyAiError, consentOutdated, DEFAULT_SCOPES, isHardUnavailable, liveActive, providerLabel, SCOPE_INFO, settingsActive } from './ai/model';
import { useAiBoot } from './ai/useAi';
import { AiGuest, AiUnavailable, BackButton, CoachStylePicker, DataExplainer, ScopeToggles } from './ai/parts';

const STEPS = ['About', 'Your details', 'Data', 'Agree'] as const;
type StepIdx = 0 | 1 | 2 | 3;


const keys = <T extends string>(o: Record<T, string>) => Object.keys(o) as T[];
const sameSet = <T,>(a: T[] = [], b: T[] = []) => a.length === b.length && a.every((x) => b.includes(x));

export default function AiSetupPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { db, account, accountReady, updateAccount } = useApp();
  const { boot, reload, setSettings } = useAiBoot();
  const { byId } = useExercises();
  const programs = useLiveQuery(() => db.programs.toArray(), [db]);
  const active = useMemo(() => liveActive(programs ?? []), [programs]);

  const [step, setStep] = useState<StepIdx>(0);
  const [details, setDetails] = useState<Details | null>(null);
  const [original, setOriginal] = useState<Details | null>(null);
  const [notes, setNotes] = useState('');
  const [scopes, setScopes] = useState<AiScopes>(DEFAULT_SCOPES);
  const [coachStyle, setCoachStyle] = useState<CoachStyle>(account.settings.coachStyle ?? 'balanced');
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill once account + programs + settings are known.
  useEffect(() => {
    if (details || !accountReady || programs === undefined || boot.phase !== 'ready') return;
    const p = account.profile;
    const inputs = active?.inputs;
    const scheduleDays = active ? currentVersion(active).schedule.length : 0;
    const d: Details = {
      goal: p.goal ?? inputs?.goal,
      experience: p.experience ?? inputs?.experience,
      limitations: p.limitations ?? [],
      dietTags: p.diet?.tags ?? [],
      allergens: p.diet?.allergens ?? [],
      days: inputs?.liftingDaysPerWeek ?? (scheduleDays || undefined),
      sessionMinutes: inputs?.sessionMinutes,
      equipment: inputs?.equipment,
    };
    setDetails(d);
    setOriginal(d);
    if (boot.settings) {
      setScopes(boot.settings.scopes);
      setNotes(boot.settings.profileNotes ?? '');
      setCoachStyle(boot.settings.coachStyle);
    }
  }, [details, accountReady, programs, boot, account.profile, active]);

  const back = <BackButton />;
  const stepBack =
    step > 0 ? (
      <IconButton label="Previous step" onClick={() => setStep((s) => (s - 1) as StepIdx)}>
        <ChevronLeft />
      </IconButton>
    ) : (
      back
    );

  if (boot.phase === 'loading')
    return (
      <Page title="Set up AI coach" back={back}>
        <Spinner label="Loading" />
      </Page>
    );
  if (boot.phase === 'guest')
    return (
      <Page title="Set up AI coach" back={back}>
        <AiGuest />
      </Page>
    );
  if (isHardUnavailable(boot.availability) || (!boot.availability.available && boot.availability.reason === 'offline'))
    return (
      <Page title="Set up AI coach" back={back}>
        <AiUnavailable reason={(boot.availability as { reason: 'offline' | 'not_configured' | 'backend_missing' }).reason} onRetry={() => void reload()} />
      </Page>
    );
  if (!details || !original)
    return (
      <Page title="Set up AI coach" back={back}>
        <Spinner label="Loading your details" />
      </Page>
    );

  const set = (patch: Partial<Details>) => setDetails((d) => ({ ...(d as Details), ...patch }));
  const setupChanged = original.days !== details.days || original.sessionMinutes !== details.sessionMinutes || !sameSet(original.equipment, details.equipment) || (details.equipment && !original.equipment);
  const setupLine = setupChanged ? trainingSetupLine(details) : null;
  const finalNotes = setupLine ? upsertSetupLine(notes, setupLine) : notes.slice(0, AI_NOTES_MAX);
  const profileChanged =
    original.goal !== details.goal || original.experience !== details.experience || !sameSet(original.limitations, details.limitations) ||
    !sameSet(original.dietTags, details.dietTags) || !sameSet(original.allergens, details.allergens);
  const alreadyOn = boot.settings && settingsActive(boot.settings, boot.availability);
  const reconsent = consentOutdated(boot.settings, boot.availability);
  const provider = providerLabel(boot.availability);
  const providerId = boot.availability.available ? boot.availability.provider : undefined;
  const providerDown = !boot.availability.available && boot.availability.reason === 'provider_down';

  async function enable() {
    if (!consent || !details) return;
    setSaving(true);
    setError(null);
    try {
      if (profileChanged) {
        await updateAccount((a) => ({
          ...a,
          profile: {
            ...a.profile,
            goal: details.goal,
            experience: details.experience,
            limitations: details.limitations,
            diet: { ...a.profile.diet, tags: details.dietTags, allergens: details.allergens },
          },
        }));
      }
      const saved = await aiApi.saveSettings({ enabled: true, paused: false, scopes, profileNotes: finalNotes, coachStyle, acceptConsent: true, provider: providerId });
      setSettings(saved);
      toast.show('Your AI coach is on', { tone: 'success' });
      nav('/coaching/ai', { replace: true });
    } catch (e) {
      setError(classifyAiError(e).message);
    } finally {
      setSaving(false);
    }
  }

  const next = () => setStep((s) => Math.min(3, s + 1) as StepIdx);

  return (
    <Page title="Set up AI coach" back={stepBack}>
      <div className="mb-4">
        <p className="text-xs text-muted mb-1.5">
          Step {step + 1} of {STEPS.length} · {STEPS[step]}
        </p>
        <ProgressBar value={step + 1} max={STEPS.length} label="Setup progress" />
      </div>
      {providerDown && (
        <Notice tone="warn" className="mb-3">
          The AI service isn’t responding right now. You can still finish setup; chatting will work once it’s back.
        </Notice>
      )}

      {step === 0 && (
        <section aria-labelledby="ai-about" className="space-y-4">
          {reconsent && (
            <Notice tone="warn">
              The AI coach now uses {provider} instead of the provider you agreed to before. Nothing has been sent to {provider} yet — review what would be
              sent and agree again to keep using it.
            </Notice>
          )}
          {alreadyOn && (
            <Notice tone="accent" className="flex items-center gap-3">
              <span className="flex-1">Your AI coach is already on. You can review your choices here.</span>
              <Button size="sm" variant="primary" onClick={() => nav('/coaching/ai')}>
                Open chat
              </Button>
            </Notice>
          )}
          <div className="flex items-center gap-3">
            <div className="size-12 rounded-2xl bg-accent-soft text-accent flex items-center justify-center">
              <Sparkles className="size-6" aria-hidden />
            </div>
            <h2 id="ai-about" className="text-lg font-semibold">
              An AI coach for everyday questions
            </h2>
          </div>
          <Card className="p-4">
            <h3 className="font-semibold mb-2">What it does</h3>
            <ul className="space-y-2 text-sm">
              {[
                'Answers questions about your training, using the data you choose to share',
                'Helps with missed sessions, schedule changes, exercise swaps and progression',
                'Reviews your recent progress when you ask for a check-in review',
                'Suggests meal ideas that fit your protein target (if you share nutrition)',
                'Drafts plan changes for you to review — nothing changes unless you apply it',
              ].map((t) => (
                <Li key={t} ok>
                  {t}
                </Li>
              ))}
            </ul>
          </Card>
          <Card className="p-4">
            <h3 className="font-semibold mb-2">What it doesn’t do</h3>
            <ul className="space-y-2 text-sm">
              {[
                'Give medical advice or diagnose pain, injuries or conditions — see a health professional for those',
                'Change your plan on its own, or replace a plan your human coach manages',
                'Read your conversations with a human coach. Human coaches are separate people you find under “Look for a coach”',
              ].map((t) => (
                <Li key={t}>{t}</Li>
              ))}
            </ul>
          </Card>
          <p className="text-xs text-muted">Replies are written by an AI and can be wrong. Treat them as suggestions and use your judgement.</p>
          <Button variant="primary" size="lg" block onClick={next}>
            Get started
          </Button>
        </section>
      )}

      {step === 1 && (
        <section aria-labelledby="ai-details" className="space-y-3">
          <div>
            <h2 id="ai-details" className="text-lg font-semibold">
              Check your details
            </h2>
            <p className="text-sm text-muted mt-1">We filled these in from your profile and plan. Correct anything that’s out of date and add what’s missing.</p>
          </div>
          <Card className="divide-y divide-line">
            <DetailRow label="Goal" value={details.goal ? GOAL_OPTIONS.find((g) => g.value === details.goal)?.title : undefined} missing={!details.goal}>
              <Select label="Goal" value={details.goal ?? ''} onChange={(e) => set({ goal: (e.target.value || undefined) as Goal | undefined })}>
                <option value="">Choose…</option>
                {GOAL_OPTIONS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.title}
                  </option>
                ))}
              </Select>
            </DetailRow>
            <DetailRow label="Experience" value={details.experience ? EXPERIENCE_OPTIONS.find((g) => g.value === details.experience)?.title : undefined} missing={!details.experience}>
              <Select label="Experience" value={details.experience ?? ''} onChange={(e) => set({ experience: (e.target.value || undefined) as Experience | undefined })}>
                <option value="">Choose…</option>
                {EXPERIENCE_OPTIONS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.title}
                  </option>
                ))}
              </Select>
            </DetailRow>
            <DetailRow label="Training days per week" value={details.days != null ? String(details.days) : undefined} missing={details.days == null}>
              <Segmented label="Training days per week" value={details.days ?? 0} onChange={(v) => set({ days: v || undefined })} options={[1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) }))} />
            </DetailRow>
            <DetailRow label="Session length" value={details.sessionMinutes != null ? `${details.sessionMinutes} min` : undefined} missing={details.sessionMinutes == null}>
              <Segmented label="Session length in minutes" value={details.sessionMinutes ?? 0} onChange={(v) => set({ sessionMinutes: v || undefined })} options={[30, 45, 60, 75, 90].map((n) => ({ value: n, label: String(n) }))} />
            </DetailRow>
            <DetailRow
              label="Equipment"
              value={details.equipment ? (details.equipment.length ? details.equipment.map((e) => EQUIPMENT_LABELS[e]).join(', ') : 'Bodyweight only') : undefined}
              missing={!details.equipment}
            >
              <ChipGroup label="Equipment" values={details.equipment ?? []} onChange={(v: Equipment[]) => set({ equipment: v })} options={keys(EQUIPMENT_LABELS).map((e) => ({ value: e, label: EQUIPMENT_LABELS[e] }))} />
            </DetailRow>
            {(active?.inputs?.excludedExerciseIds?.length ?? 0) > 0 && (
              <div className="px-4 py-3">
                <div className="text-sm font-medium">Excluded exercises</div>
                <p className="text-sm text-muted mt-0.5">{active!.inputs!.excludedExerciseIds.map((id) => byId.get(id)?.name ?? id).join(', ')}</p>
                <p className="text-xs text-faint mt-1">From your plan setup. Mention any changes in the notes below.</p>
              </div>
            )}
            <DetailRow label="Areas to go easy on" value={details.limitations.length ? details.limitations.map((l) => LIMITATION_LABELS[l]).join(', ') : 'None'}>
              <ChipGroup label="Areas to go easy on" values={details.limitations} onChange={(v: LimitationArea[]) => set({ limitations: v })} options={keys(LIMITATION_LABELS).map((k) => ({ value: k, label: LIMITATION_LABELS[k] }))} />
              <p className="text-xs text-muted mt-2">Only the body-area names are used — never a diagnosis.</p>
            </DetailRow>
            <DetailRow label="Diet" value={details.dietTags.length ? details.dietTags.map((t) => DIET_TAG_LABELS[t]).join(', ') : 'No preferences'}>
              <ChipGroup label="Diet preferences" values={details.dietTags} onChange={(v: DietTag[]) => set({ dietTags: v })} options={keys(DIET_TAG_LABELS).map((k) => ({ value: k, label: DIET_TAG_LABELS[k] }))} />
            </DetailRow>
            <DetailRow label="Allergies" value={details.allergens.length ? details.allergens.map((t) => ALLERGEN_LABELS[t]).join(', ') : 'None'}>
              <ChipGroup label="Allergies" values={details.allergens} onChange={(v: Allergen[]) => set({ allergens: v })} options={keys(ALLERGEN_LABELS).map((k) => ({ value: k, label: ALLERGEN_LABELS[k] }))} />
            </DetailRow>
          </Card>
          {setupLine && (
            <Notice>
              Your plan itself isn’t changed. This line will be saved in your AI coach notes: <span className="text-ink">“{setupLine}”</span>
            </Notice>
          )}
          {profileChanged && <p className="text-xs text-muted px-1">Goal, experience, areas and diet changes are saved to your profile and used across the app.</p>}
          <Textarea
            label="Notes for your AI coach (optional)"
            hint="Anything else it should know, e.g. “I train before work” or “I prefer dumbbells”. You can view, edit or clear these at any time."
            value={notes}
            maxLength={AI_NOTES_MAX}
            onChange={(e) => setNotes(e.target.value)}
          />
          <Button variant="primary" size="lg" block onClick={next}>
            Continue
          </Button>
        </section>
      )}

      {step === 2 && (
        <section aria-labelledby="ai-data" className="space-y-3">
          <div>
            <h2 id="ai-data" className="text-lg font-semibold">
              Choose what the AI coach may use
            </h2>
            <p className="text-sm text-muted mt-1">It only uses the categories you switch on. You can change this later in settings.</p>
          </div>
          <Card className="px-4 py-1">
            <ScopeToggles value={scopes} onChange={setScopes} />
          </Card>
          <Card className="p-4">
            <h3 className="font-semibold mb-2">Coach style</h3>
            <CoachStylePicker value={coachStyle} onChange={setCoachStyle} />
          </Card>
          <Card className="p-4">
            <DataExplainer provider={provider} />
          </Card>
          <Button variant="primary" size="lg" block onClick={next}>
            Continue
          </Button>
        </section>
      )}

      {step === 3 && (
        <section aria-labelledby="ai-consent" className="space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-accent" aria-hidden />
            <h2 id="ai-consent" className="text-lg font-semibold">
              Review and agree
            </h2>
          </div>
          <Card className="p-4">
            <h3 className="text-sm font-semibold mb-2">You’re sharing</h3>
            <ul className="space-y-1.5 text-sm">
              {SCOPE_INFO.map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  {scopes[s.key] ? <Check className="size-4 text-accent" aria-hidden /> : <XCircle className="size-4 text-faint" aria-hidden />}
                  <span className={scopes[s.key] ? '' : 'text-muted'}>{s.title}</span>
                  <span className="sr-only">{scopes[s.key] ? 'shared' : 'not shared'}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted mt-3">Plus your messages and AI coach notes. They’re sent from the server to {provider === 'the AI provider' ? provider : `${provider}, the AI provider,`} only when you ask something.</p>
          </Card>
          <label className="flex items-start gap-3 rounded-2xl border border-line bg-surface px-4 py-3 min-h-14 cursor-pointer">
            <input type="checkbox" className="mt-1 size-5 accent-accent shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span className="text-sm">
              I understand the AI coach gives general fitness guidance, not medical advice, and I agree that the data I selected is sent from the server to{' '}
              {provider} to generate replies.
            </span>
          </label>
          {error && (
            <Notice tone="danger">
              <span role="alert">{error}</span>
            </Notice>
          )}
          <Button variant="primary" size="lg" block disabled={!consent} loading={saving} onClick={() => void enable()} icon={<CheckCircle2 className="size-5" />}>
            Turn on AI coach
          </Button>
          <p className="text-xs text-muted text-center">You can pause or turn it off at any time.</p>
        </section>
      )}
    </Page>
  );
}

function Li({ children, ok }: { children: ReactNode; ok?: boolean }) {
  return (
    <li className="flex gap-2 items-start">
      {ok ? <Check className="size-4 mt-0.5 text-accent shrink-0" aria-hidden /> : <XCircle className="size-4 mt-0.5 text-muted shrink-0" aria-hidden />}
      <span>{children}</span>
    </li>
  );
}

function DetailRow({ label, value, missing, children }: { label: string; value?: string; missing?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!!missing);
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 min-h-11">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium flex items-center gap-2">
            {label}
            {missing && <Badge tone="warn">Missing</Badge>}
          </div>
          {!open && <div className="text-sm text-muted truncate">{value ?? 'Not set'}</div>}
        </div>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Done' : missing ? 'Add' : 'Change'}
        </Button>
      </div>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
