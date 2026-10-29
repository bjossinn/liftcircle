import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, Info, ShieldCheck, Undo2, X } from 'lucide-react';
import { coachingApi } from '@/backend/coaching';
import type { CoachDetail, CoachFormat, SharingScopes } from '@/backend/coachingContract';
import { Button, Card, ChipGroup, EmptyState, ErrorState, IconButton, Notice, NumberInput, Page, SectionTitle, Segmented, Select, Spinner, Textarea, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { alive } from '@/db/repo';
import { uuid } from '@/lib/id';
import type { Equipment, Experience, Goal, LimitationArea } from '@/domain/types';
import { GOAL_LABELS } from '@/domain/nutrition/targets';
import { EQUIPMENT_LABELS, LIMITATION_LABELS } from '@/data/exerciseMeta';
import { INTRO_MAX, NOTES_MAX, buildIntake, defaultScopes, hasValue, introProblem, prefillIntake, scopeNeeds, type IntakeDraft, type IntakeKey, type ScopeKey, type ScopeNeed } from '@/domain/coaching/intake';
import { REQUEST_BLOCK_TEXT, activeCoach, requestBlock } from '@/domain/coaching/eligibility';
import { FORMAT_LABELS } from '@/domain/coaching/options';
import { CoachPhoto, CoachingAccessNotice, coachingError, useCoachingAccess, useLoad } from './directory/common';

const EXPERIENCE_LABELS: Record<Experience, string> = {
  new: 'New to training',
  returning: 'Returning after a break',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

const SCOPE_INFO: Record<ScopeKey, { label: string; body: string }> = {
  training: { label: 'Training', body: 'Your workouts, how often you train, your current program and goals. Coaches use this to plan and adjust your program.' },
  measurements: { label: 'Measurements', body: 'Bodyweight and body measurements you log.' },
  nutrition: { label: 'Nutrition', body: 'Your food log totals and nutrition targets.' },
  checkins: { label: 'Check-ins', body: 'Check-ins you send this coach, including any photos you choose to attach to them.' },
};

const NEED_TEXT: Record<ScopeNeed, string> = {
  recommended: 'Recommended for program coaching',
  often_useful: 'Often useful for this coach’s services',
  optional: 'Optional',
};

export default function RequestCoachingPage() {
  const nav = useNavigate();
  const { coachId } = useParams();
  const { access, meId } = useCoachingAccess();
  return (
    <Page
      title="Request coaching"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? <CoachingAccessNotice access={access} /> : coachId ? <RequestLoader coachId={coachId} meId={meId} /> : <EmptyState title="Coach not found" />}
    </Page>
  );
}

function RequestLoader({ coachId, meId }: { coachId: string; meId: string | undefined }) {
  const { db } = useApp();
  const coach = useLoad(() => coachingApi.getCoach(coachId), [coachId], { fallback: 'Couldn’t load this coach.' });
  const rels = useLoad(() => coachingApi.myRelationships(), []);
  const programs = useLiveQuery(() => db.programs.toArray(), [db]);
  if ((coach.loading && coach.data === undefined) || programs === undefined || (rels.loading && rels.data === undefined)) return <Spinner label="Loading" />;
  if (coach.error) return <ErrorState title="Couldn’t load this coach" message={coach.error} onRetry={coach.reload} />;
  if (!coach.data) return <EmptyState title="This coach isn’t listed" body="The profile may have been unpublished." />;
  const active = alive(programs).filter((p) => p.active).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  const block = requestBlock({ coachId, acceptingClients: coach.data.acceptingClients, meId, relationships: rels.data });
  if (block) {
    return (
      <EmptyState
        title="You can’t send this request"
        body={REQUEST_BLOCK_TEXT[block]}
        action={
          <Link to="/coaching/my" className="inline-flex min-h-11 items-center px-4 rounded-xl border border-line hover:bg-surface-2">
            Go to My coach
          </Link>
        }
      />
    );
  }
  const current = activeCoach(rels.data);
  return <RequestForm coach={coach.data} inputs={active?.inputs} currentCoachName={current && current.coachId !== coachId ? current.coach.displayName : null} />;
}

function RequestForm({ coach, inputs, currentCoachName }: { coach: CoachDetail; inputs: Parameters<typeof prefillIntake>[1]; currentCoachName: string | null }) {
  const nav = useNavigate();
  const toast = useToast();
  const { account } = useApp();
  const initial = useMemo(() => prefillIntake(account.profile, inputs, coach.formats), [account.profile, inputs, coach.formats]);
  const [draft, setDraft] = useState<IntakeDraft>(initial);
  const [intro, setIntro] = useState('');
  const [introTouched, setIntroTouched] = useState(false);
  const [scopes, setScopes] = useState<SharingScopes>(defaultScopes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per attempt so a double tap or a retry after a network error can't create two requests.
  const requestId = useRef(uuid());
  const needs = scopeNeeds(coach);
  const introErr = introTouched ? introProblem(intro) : null;

  const set = <K extends keyof IntakeDraft>(k: K, v: IntakeDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const keep = (k: IntakeKey, on: boolean) => setDraft((d) => ({ ...d, kept: { ...d.kept, [k]: on } }));

  const submit = async () => {
    setIntroTouched(true);
    if (introProblem(intro) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await coachingApi.requestCoaching({ id: requestId.current, coachId: coach.userId, intake: buildIntake(draft), introMessage: intro.trim(), scopes });
      toast.show(`Request sent to ${coach.displayName}`, { tone: 'success' });
      nav('/coaching/my', { replace: true });
    } catch (e) {
      setError(coachingError(e, 'Your request couldn’t be sent. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const goalOptions = (Object.keys(GOAL_LABELS) as Goal[]).map((g) => ({ value: g, label: GOAL_LABELS[g] }));
  const sent = buildIntake(draft);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col"
    >
      <Card className="p-4 flex items-center gap-3">
        <CoachPhoto name={coach.displayName} url={coach.photoUrl} size={48} />
        <div className="min-w-0">
          <p className="font-semibold truncate">{coach.displayName}</p>
          <p className="text-xs text-muted">The coach sees only this request until they accept.</p>
        </div>
      </Card>

      {currentCoachName && (
        <Notice tone="warn" className="mt-3">
          You’re currently coached by <strong>{currentCoachName}</strong>. You can have one coach at a time: if {coach.displayName} accepts, your coaching with {currentCoachName} ends automatically. Until then nothing changes. Your workouts and accepted programs stay yours either way.
        </Notice>
      )}

      <SectionTitle>Introduce yourself</SectionTitle>
      <Textarea
        label="Message to the coach"
        value={intro}
        maxLength={INTRO_MAX}
        onChange={(e) => setIntro(e.target.value)}
        onBlur={() => setIntroTouched(true)}
        error={introErr}
        hint={`What you’d like help with, and anything the coach should know. ${intro.length}/${INTRO_MAX}`}
        className="min-h-32"
        required
      />

      <SectionTitle>About your training</SectionTitle>
      <p className="text-sm text-muted px-1 mb-2">Filled in from your profile and program. Edit anything, or remove what you’d rather not share — only what’s kept is sent.</p>
      <Card className="divide-y divide-line">
        <IntakeRow label="Main goal" k="goal" draft={draft} keep={keep} summary={draft.goal ? GOAL_LABELS[draft.goal] : null}>
          <Select aria-label="Main goal" value={draft.goal ?? ''} onChange={(e) => set('goal', (e.target.value || undefined) as Goal | undefined)}>
            <option value="">Choose…</option>
            {goalOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </IntakeRow>
        <IntakeRow label="Second goal" k="secondaryGoal" draft={draft} keep={keep} summary={draft.secondaryGoal ? GOAL_LABELS[draft.secondaryGoal] : null}>
          <Select aria-label="Second goal" value={draft.secondaryGoal ?? ''} onChange={(e) => set('secondaryGoal', (e.target.value || undefined) as Goal | undefined)}>
            <option value="">None</option>
            {goalOptions
              .filter((o) => o.value !== draft.goal)
              .map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
          </Select>
        </IntakeRow>
        <IntakeRow label="Experience" k="experience" draft={draft} keep={keep} summary={draft.experience ? EXPERIENCE_LABELS[draft.experience] : null}>
          <Select aria-label="Experience" value={draft.experience ?? ''} onChange={(e) => set('experience', (e.target.value || undefined) as Experience | undefined)}>
            <option value="">Choose…</option>
            {(Object.keys(EXPERIENCE_LABELS) as Experience[]).map((x) => (
              <option key={x} value={x}>
                {EXPERIENCE_LABELS[x]}
              </option>
            ))}
          </Select>
        </IntakeRow>
        <IntakeRow label="Training days per week" k="daysPerWeek" draft={draft} keep={keep} summary={draft.daysPerWeek != null ? `${draft.daysPerWeek} days` : null}>
          <NumberInput ariaLabel="Training days per week" value={draft.daysPerWeek ?? null} decimals={false} min={1} max={7} onChange={(v) => set('daysPerWeek', v ?? undefined)} suffix="days" />
        </IntakeRow>
        <IntakeRow label="Session length" k="sessionMinutes" draft={draft} keep={keep} summary={draft.sessionMinutes != null ? `${draft.sessionMinutes} min` : null}>
          <NumberInput ariaLabel="Session length in minutes" value={draft.sessionMinutes ?? null} decimals={false} min={10} max={240} onChange={(v) => set('sessionMinutes', v ?? undefined)} suffix="min" />
        </IntakeRow>
        <IntakeRow label="Equipment" k="equipment" draft={draft} keep={keep} summary={draft.equipment?.length ? draft.equipment.map((q) => EQUIPMENT_LABELS[q]).join(', ') : null}>
          <ChipGroup<Equipment>
            label="Equipment you have"
            values={draft.equipment ?? []}
            onChange={(v) => set('equipment', v)}
            options={(Object.keys(EQUIPMENT_LABELS) as Equipment[]).map((q) => ({ value: q, label: EQUIPMENT_LABELS[q] }))}
          />
        </IntakeRow>
        <IntakeRow
          label="Areas to be careful with"
          k="limitations"
          draft={draft}
          keep={keep}
          summary={draft.limitations?.length ? draft.limitations.map((l) => LIMITATION_LABELS[l]).join(', ') : null}
          help="Body areas only — no medical details are shared. Tell the coach more in your message if you want to."
        >
          <ChipGroup<LimitationArea>
            label="Areas to be careful with"
            values={draft.limitations ?? []}
            onChange={(v) => set('limitations', v)}
            options={(Object.keys(LIMITATION_LABELS) as LimitationArea[]).map((l) => ({ value: l, label: LIMITATION_LABELS[l] }))}
          />
        </IntakeRow>
        {coach.formats.length > 0 && (
          <IntakeRow label="Preferred format" k="preferredFormat" draft={draft} keep={keep} summary={draft.preferredFormat ? FORMAT_LABELS[draft.preferredFormat] : null}>
            <Segmented<CoachFormat | ''>
              label="Preferred format"
              value={draft.preferredFormat ?? ''}
              onChange={(v) => set('preferredFormat', v || undefined)}
              options={[{ value: '' as const, label: 'No preference' }, ...coach.formats.map((f) => ({ value: f, label: FORMAT_LABELS[f] }))]}
            />
          </IntakeRow>
        )}
        <IntakeRow label="Anything else" k="notes" draft={draft} keep={keep} summary={draft.notes?.trim() ? draft.notes.trim() : null} alwaysEditable>
          <Textarea aria-label="Anything else for the coach" value={draft.notes ?? ''} maxLength={NOTES_MAX} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value, kept: { ...d.kept, notes: e.target.value.trim().length > 0 } }))} placeholder="Schedule constraints, preferences…" className="min-h-20" />
        </IntakeRow>
      </Card>
      {Object.keys(sent).length === 0 && <p className="text-xs text-muted px-1 mt-2">No training details will be sent — just your message.</p>}

      <SectionTitle>What this coach can see once they accept</SectionTitle>
      <Card className="px-4 py-1 divide-y divide-line">
        {(Object.keys(SCOPE_INFO) as ScopeKey[]).map((k) => (
          <Toggle
            key={k}
            label={SCOPE_INFO[k].label}
            checked={scopes[k]}
            onChange={(v) => setScopes((s) => ({ ...s, [k]: v }))}
            description={
              <>
                {SCOPE_INFO[k].body} <span className={needs[k] === 'optional' ? 'text-faint' : 'text-accent'}>{NEED_TEXT[needs[k]]}.</span>
              </>
            }
          />
        ))}
      </Card>
      {!scopes.training && <p className="text-xs text-warn px-1 mt-2">Without training access the coach can’t see your workouts, so they can’t review your progress or adjust your program.</p>}
      <Notice className="mt-3">
        <span className="inline-flex items-start gap-2">
          <ShieldCheck className="size-4 text-accent shrink-0 mt-0.5" aria-hidden />
          <span>
            Nothing is shared until the coach accepts, and you can change these choices or end coaching anytime from My coach. Being friends with someone never gives them coaching access.
          </span>
        </span>
      </Notice>

      {error && (
        <p role="alert" className="text-sm text-danger mt-4">
          {error}
        </p>
      )}
      <div className="flex gap-2 mt-6">
        <Button variant="ghost" icon={<X className="size-4" />} onClick={() => nav(-1)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" block loading={busy}>
          Send request
        </Button>
      </div>
    </form>
  );
}

function IntakeRow({
  label, k, draft, keep, summary, children, help, alwaysEditable,
}: {
  label: string;
  k: IntakeKey;
  draft: IntakeDraft;
  keep: (k: IntakeKey, on: boolean) => void;
  summary: string | null;
  children: ReactNode;
  help?: string;
  alwaysEditable?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const kept = draft.kept[k];
  const empty = !hasValue(draft, k);
  if (alwaysEditable) {
    return (
      <div className="px-4 py-3 flex flex-col gap-2">
        <span className="text-sm font-medium">{label} <span className="text-muted font-normal">(optional)</span></span>
        {children}
      </div>
    );
  }
  return (
    <div className="px-4 py-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className={kept && !empty ? 'text-sm text-ink break-words' : 'text-sm text-faint'}>{!kept ? (empty ? 'Not added' : 'Not shared') : empty ? 'Not set' : summary}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {kept ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
                {editing ? 'Done' : empty ? 'Add' : 'Edit'}
              </Button>
              <IconButton label={`Don’t share ${label.toLowerCase()}`} size="sm" onClick={() => { keep(k, false); setEditing(false); }}>
                <X className="size-4" />
              </IconButton>
            </>
          ) : (
            <Button size="sm" variant="ghost" icon={empty ? undefined : <Undo2 className="size-4" />} aria-label={`${empty ? 'Add' : 'Include'} ${label.toLowerCase()}`} onClick={() => { keep(k, true); if (empty) setEditing(true); }}>
              {empty ? 'Add' : 'Include'}
            </Button>
          )}
        </div>
      </div>
      {kept && editing && (
        <div className="flex flex-col gap-2">
          {children}
          {help && (
            <p className="text-xs text-muted inline-flex items-start gap-1.5">
              <Info className="size-3.5 shrink-0 mt-0.5" aria-hidden />
              {help}
            </p>
          )}
        </div>
      )}
      {kept && !editing && help && !empty && <p className="text-xs text-muted">{help}</p>}
    </div>
  );
}
