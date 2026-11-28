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
import { useT, type MessageKey } from '@/i18n';

const EXPERIENCE_KEYS: Record<Experience, MessageKey> = {
  new: 'coaching.request.experience.new',
  returning: 'onboarding.experience.returning',
  intermediate: 'onboarding.experience.intermediate',
  advanced: 'onboarding.experience.advanced',
};

const SCOPE_INFO: Record<ScopeKey, { label: MessageKey; body: MessageKey }> = {
  training: { label: 'ai.scope.training', body: 'coaching.request.your_workouts_how_often_you_train' },
  measurements: { label: 'ai.scope.measurements', body: 'coaching.request.bodyweight_and_body_measurements_you_log' },
  nutrition: { label: 'today.nutrition', body: 'coaching.request.your_food_log_totals_and_nutrition' },
  checkins: { label: 'coaching.shareScope.check_ins', body: 'coaching.request.check_ins_you_send_this_coach' },
};

const NEED_TEXT: Record<ScopeNeed, MessageKey> = {
  recommended: 'coaching.request.need.recommended',
  often_useful: 'coaching.request.need.often_useful',
  optional: 'common.optional',
};

export default function RequestCoachingPage() {
  const nav = useNavigate();
  const { coachId } = useParams();
  const { access, meId } = useCoachingAccess();
  const { t } = useT();
  return (
    <Page
      title={t('coaching.profile.request_coaching')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? <CoachingAccessNotice access={access} /> : coachId ? <RequestLoader coachId={coachId} meId={meId} /> : <EmptyState title={t('coaching.profile.coach_not_found')} />}
    </Page>
  );
}

function RequestLoader({ coachId, meId }: { coachId: string; meId: string | undefined }) {
  const { db } = useApp();
  const { t } = useT();
  const coach = useLoad(() => coachingApi.getCoach(coachId), [coachId], { fallback: t('coaching.profile.couldnt_load_this_coach') });
  const rels = useLoad(() => coachingApi.myRelationships(), []);
  const programs = useLiveQuery(() => db.programs.toArray(), [db]);
  if ((coach.loading && coach.data === undefined) || programs === undefined || (rels.loading && rels.data === undefined)) return <Spinner label={t('common.loading')} />;
  if (coach.error) return <ErrorState title={t('coaching.profile.couldnt_load_this_coach')} message={coach.error} onRetry={coach.reload} />;
  if (!coach.data) return <EmptyState title={t('coaching.profile.this_coach_isnt_listed')} body={t('coaching.request.the_profile_may_have_been_unpublished')} />;
  const active = alive(programs).filter((p) => p.active).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  const block = requestBlock({ coachId, acceptingClients: coach.data.acceptingClients, meId, relationships: rels.data });
  if (block) {
    return (
      <EmptyState
        title={t('coaching.request.you_cant_send_this_request')}
        body={REQUEST_BLOCK_TEXT[block]}
        action={
          <Link to="/coaching/my" className="inline-flex min-h-11 items-center px-4 rounded-xl border border-line hover:bg-surface-2">
            {t('coaching.profile.go_to_my_coach')}
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
  const { t, tp } = useT();
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
      toast.show(t('coaching.request.request_sent_to_x', { name: coach.displayName }), { tone: 'success' });
      nav('/coaching/my', { replace: true });
    } catch (e) {
      setError(coachingError(e, t('coaching.request.couldnt_send')));
    } finally {
      setBusy(false);
    }
  };

  const goalOptions = (Object.keys(GOAL_LABELS) as Goal[]).map((g) => ({ value: g, label: GOAL_LABELS[g] }));
  const sent = buildIntake(draft);
  const [coachedBefore, coachedAfter] = currentCoachName ? t('coaching.request.currently_coached_by_x', { name: '\u0000' }).split('\u0000') : ['', ''];

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
          <p className="text-xs text-muted">{t('coaching.request.the_coach_sees_only_this_request')}</p>
        </div>
      </Card>

      {currentCoachName && (
        <Notice tone="warn" className="mt-3">
          {coachedBefore}
          <strong>{currentCoachName}</strong>
          {coachedAfter} {t('coaching.request.one_coach_at_a_time', { coach: coach.displayName, current: currentCoachName })}
        </Notice>
      )}

      <SectionTitle>{t('coaching.request.introduce_yourself')}</SectionTitle>
      <Textarea
        label={t('coaching.request.message_to_the_coach')}
        value={intro}
        maxLength={INTRO_MAX}
        onChange={(e) => setIntro(e.target.value)}
        onBlur={() => setIntroTouched(true)}
        error={introErr}
        hint={t('coaching.request.what_youd_like_help_with_and', { count: intro.length, max: INTRO_MAX })}
        className="min-h-32"
        required
      />

      <SectionTitle>{t('coaching.request.about_your_training')}</SectionTitle>
      <p className="text-sm text-muted px-1 mb-2">{t('coaching.request.filled_in_from_your_profile_and')}</p>
      <Card className="divide-y divide-line">
        <IntakeRow label={t('onboarding.goal.group')} k="goal" draft={draft} keep={keep} summary={draft.goal ? GOAL_LABELS[draft.goal] : null}>
          <Select aria-label={t('onboarding.goal.group')} value={draft.goal ?? ''} onChange={(e) => set('goal', (e.target.value || undefined) as Goal | undefined)}>
            <option value="">{t('coaching.apply.choose')}</option>
            {goalOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </IntakeRow>
        <IntakeRow label={t('coaching.request.second_goal')} k="secondaryGoal" draft={draft} keep={keep} summary={draft.secondaryGoal ? GOAL_LABELS[draft.secondaryGoal] : null}>
          <Select aria-label={t('coaching.request.second_goal')} value={draft.secondaryGoal ?? ''} onChange={(e) => set('secondaryGoal', (e.target.value || undefined) as Goal | undefined)}>
            <option value="">{t('coaching.admin.none')}</option>
            {goalOptions
              .filter((o) => o.value !== draft.goal)
              .map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
          </Select>
        </IntakeRow>
        <IntakeRow label={t('onboarding.experience.group')} k="experience" draft={draft} keep={keep} summary={draft.experience ? t(EXPERIENCE_KEYS[draft.experience]) : null}>
          <Select aria-label={t('onboarding.experience.group')} value={draft.experience ?? ''} onChange={(e) => set('experience', (e.target.value || undefined) as Experience | undefined)}>
            <option value="">{t('coaching.apply.choose')}</option>
            {(Object.keys(EXPERIENCE_KEYS) as Experience[]).map((x) => (
              <option key={x} value={x}>
                {t(EXPERIENCE_KEYS[x])}
              </option>
            ))}
          </Select>
        </IntakeRow>
        <IntakeRow label={t('coaching.request.training_days_per_week')} k="daysPerWeek" draft={draft} keep={keep} summary={draft.daysPerWeek != null ? tp('coaching.request.days_count', draft.daysPerWeek) : null}>
          <NumberInput ariaLabel={t('coaching.request.training_days_per_week')} value={draft.daysPerWeek ?? null} decimals={false} min={1} max={7} onChange={(v) => set('daysPerWeek', v ?? undefined)} suffix={t('progress.goalDaysUnit')} />
        </IntakeRow>
        <IntakeRow label={t('coaching.request.session_length')} k="sessionMinutes" draft={draft} keep={keep} summary={draft.sessionMinutes != null ? t('coaching.request.minutes_value', { count: draft.sessionMinutes }) : null}>
          <NumberInput ariaLabel={t('coaching.request.session_length_in_minutes')} value={draft.sessionMinutes ?? null} decimals={false} min={10} max={240} onChange={(v) => set('sessionMinutes', v ?? undefined)} suffix={t('progress.minutesUnit')} />
        </IntakeRow>
        <IntakeRow label={t('workout.custom.equipment')} k="equipment" draft={draft} keep={keep} summary={draft.equipment?.length ? draft.equipment.map((q) => EQUIPMENT_LABELS[q]).join(', ') : null}>
          <ChipGroup<Equipment>
            label={t('coaching.request.equipment_you_have')}
            values={draft.equipment ?? []}
            onChange={(v) => set('equipment', v)}
            options={(Object.keys(EQUIPMENT_LABELS) as Equipment[]).map((q) => ({ value: q, label: EQUIPMENT_LABELS[q] }))}
          />
        </IntakeRow>
        <IntakeRow
          label={t('coaching.request.areas_to_be_careful_with')}
          k="limitations"
          draft={draft}
          keep={keep}
          summary={draft.limitations?.length ? draft.limitations.map((l) => LIMITATION_LABELS[l]).join(', ') : null}
          help={t('coaching.request.body_areas_only')}
        >
          <ChipGroup<LimitationArea>
            label={t('coaching.request.areas_to_be_careful_with')}
            values={draft.limitations ?? []}
            onChange={(v) => set('limitations', v)}
            options={(Object.keys(LIMITATION_LABELS) as LimitationArea[]).map((l) => ({ value: l, label: LIMITATION_LABELS[l] }))}
          />
        </IntakeRow>
        {coach.formats.length > 0 && (
          <IntakeRow label={t('coaching.request.preferred_format')} k="preferredFormat" draft={draft} keep={keep} summary={draft.preferredFormat ? FORMAT_LABELS[draft.preferredFormat] : null}>
            <Segmented<CoachFormat | ''>
              label={t('coaching.request.preferred_format')}
              value={draft.preferredFormat ?? ''}
              onChange={(v) => set('preferredFormat', v || undefined)}
              options={[{ value: '' as const, label: t('coaching.request.no_preference') }, ...coach.formats.map((f) => ({ value: f, label: FORMAT_LABELS[f] }))]}
            />
          </IntakeRow>
        )}
        <IntakeRow label={t('coaching.request.anything_else')} k="notes" draft={draft} keep={keep} summary={draft.notes?.trim() ? draft.notes.trim() : null} alwaysEditable>
          <Textarea aria-label={t('coaching.request.anything_else_for_the_coach')} value={draft.notes ?? ''} maxLength={NOTES_MAX} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value, kept: { ...d.kept, notes: e.target.value.trim().length > 0 } }))} placeholder={t('coaching.request.schedule_constraints_preferences')} className="min-h-20" />
        </IntakeRow>
      </Card>
      {Object.keys(sent).length === 0 && <p className="text-xs text-muted px-1 mt-2">{t('coaching.request.no_training_details_will_be_sent')}</p>}

      <SectionTitle>{t('coaching.request.what_this_coach_can_see_once')}</SectionTitle>
      <Card className="px-4 py-1 divide-y divide-line">
        {(Object.keys(SCOPE_INFO) as ScopeKey[]).map((k) => (
          <Toggle
            key={k}
            label={t(SCOPE_INFO[k].label)}
            checked={scopes[k]}
            onChange={(v) => setScopes((s) => ({ ...s, [k]: v }))}
            description={
              <>
                {t(SCOPE_INFO[k].body)} <span className={needs[k] === 'optional' ? 'text-faint' : 'text-accent'}>{t(NEED_TEXT[needs[k]])}.</span>
              </>
            }
          />
        ))}
      </Card>
      {!scopes.training && <p className="text-xs text-warn px-1 mt-2">{t('coaching.request.without_training_access_the_coach_cant')}</p>}
      <Notice className="mt-3">
        <span className="inline-flex items-start gap-2">
          <ShieldCheck className="size-4 text-accent shrink-0 mt-0.5" aria-hidden />
          <span>{t('coaching.request.nothing_is_shared_until_the_coach')}</span>
        </span>
      </Notice>

      {error && (
        <p role="alert" className="text-sm text-danger mt-4">
          {error}
        </p>
      )}
      <div className="flex gap-2 mt-6">
        <Button variant="ghost" icon={<X className="size-4" />} onClick={() => nav(-1)} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" block loading={busy}>
          {t('coaching.request.send_request')}
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
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const kept = draft.kept[k];
  const empty = !hasValue(draft, k);
  if (alwaysEditable) {
    return (
      <div className="px-4 py-3 flex flex-col gap-2">
        <span className="text-sm font-medium">{label} <span className="text-muted font-normal">{t('coaching.request.optional')}</span></span>
        {children}
      </div>
    );
  }
  return (
    <div className="px-4 py-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className={kept && !empty ? 'text-sm text-ink break-words' : 'text-sm text-faint'}>{!kept ? (empty ? t('coaching.request.not_added') : t('coaching.request.not_shared')) : empty ? t('activities.form.not_set') : summary}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {kept ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
                {editing ? t('workout.done') : empty ? t('foodLog.add') : t('common.edit')}
              </Button>
              <IconButton label={t('coaching.request.dont_share_x', { label: label.toLowerCase() })} size="sm" onClick={() => { keep(k, false); setEditing(false); }}>
                <X className="size-4" />
              </IconButton>
            </>
          ) : (
            <Button size="sm" variant="ghost" icon={empty ? undefined : <Undo2 className="size-4" />} aria-label={empty ? t('coaching.request.add_x', { label: label.toLowerCase() }) : t('coaching.request.include_x', { label: label.toLowerCase() })} onClick={() => { keep(k, true); if (empty) setEditing(true); }}>
              {empty ? t('foodLog.add') : t('coaching.request.include')}
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
