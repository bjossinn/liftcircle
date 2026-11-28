/**
 * /coaching/my — the client's side of coaching: current coach, open requests, sharing permissions,
 * program proposals, check-ins, workout feedback, ending or switching coaches.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { CalendarRange, ClipboardCheck, HeartHandshake, MessageCircle, Repeat, Search, Sparkles, UserX } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, ListRow, Notice, Page, SectionTitle, Spinner, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { coachingApi } from '@/backend/coaching';
import type { CheckIn, CoachFeedback, CoachingRelationship } from '@/backend/coachingContract';
import { alive, saveRecord } from '@/db/repo';
import { takeOverPlan } from '@/domain/program/proposals';
import { formatDate } from '@/lib/dates';
import { coachingError } from '@/coaching/errors';
import { RELATIONSHIP_STATUS_LABEL, closedExplanation, sortClientRelationships } from '@/coaching/relationship';
import { Avatar } from '@/features/social/common';
import { useT } from '@/i18n';
import { isFeatureEnabled } from '@/config/featureFlags';
import { BackButton, CheckInAnswers, CoachingAccessNotice, ProposalStatusBadge, ScopeEditor, fmtDateTime, useCoachingAccess, useLoad, useScrollToHash } from './tools/common';

export default function MyCoachPage() {
  const nav = useNavigate();
  const { t } = useT();
  const { access } = useCoachingAccess();
  const ok = access === 'ok';
  const rels = useLoad(async () => sortClientRelationships((await coachingApi.myRelationships()).filter((r) => !r.viewerIsCoach)), [], ok);

  const active = rels.data?.find((r) => r.status === 'active') ?? null;
  const requested = rels.data?.filter((r) => r.status === 'requested') ?? [];
  const closed = rels.data?.filter((r) => r.status === 'ended' || r.status === 'declined' || r.status === 'cancelled') ?? [];
  useScrollToHash(!!rels.data);
  const marketplace = isFeatureEnabled('coachMarketplace');

  return (
    <Page title={t('coaching.hub.my_coach')} back={<BackButton to="/coaching" />}>
      <TakeOverNotice activeRelationshipIds={active ? [active.id] : []} ready={!!rels.data} />
      {!ok ? (
        <CoachingAccessNotice access={access} what={t('coaching.myCoach.what_coaching_details')} />
      ) : rels.error && !rels.data ? (
        <ErrorState title={t('coaching.hub.couldnt_load_your_coaching')} message={rels.error} onRetry={rels.reload} />
      ) : !rels.data ? (
        <Spinner label={t('coaching.hub.loading_your_coaching')} />
      ) : rels.data.length === 0 ? (
        <EmptyState
          icon={<HeartHandshake className="size-6" aria-hidden />}
          title={t('coaching.myCoach.no_coach_yet')}
          body={
            marketplace
              ? t('coaching.myCoach.find_an_approved_coach_near_you')
              : t('coaching.myCoach.the_training_assistant_can_answer_questions')
          }
          action={
            <div className="flex flex-col gap-2 w-full max-w-xs">
              {marketplace && (
                <Button variant="primary" icon={<Search className="size-4" />} onClick={() => nav('/coaching/find')}>
                  {t('coaching.hub.look_for_a_coach')}
                </Button>
              )}
              <Button variant={marketplace ? undefined : 'primary'} icon={<Sparkles className="size-4" />} onClick={() => nav('/coach')}>
                {t('coaching.myCoach.try_the_training_assistant')}
              </Button>
            </div>
          }
        />
      ) : (
        <>
          {active && <ActiveCoach rel={active} onChanged={rels.reload} />}
          {requested.map((r) => (
            <PendingRequest key={r.id} rel={r} onChanged={rels.reload} />
          ))}
          {!active && requested.length === 0 && (
            <Card className="px-4 py-4 mt-2">
              <p className="text-sm">{t('coaching.myCoach.you_dont_have_an_active_coach')}</p>
              {marketplace ? (
                <Button className="mt-3" variant="primary" icon={<Search className="size-4" />} onClick={() => nav('/coaching/find')}>
                  {t('coaching.hub.look_for_a_coach')}
                </Button>
              ) : (
                <Button className="mt-3" icon={<Sparkles className="size-4" />} onClick={() => nav('/coach')}>
                  {t('coaching.myCoach.try_the_training_assistant')}
                </Button>
              )}
            </Card>
          )}
          {closed.length > 0 && (
            <>
              <SectionTitle>{t('coaching.hub.past_coaching')}</SectionTitle>
              <ul className="flex flex-col gap-2">
                {closed.slice(0, 5).map((r) => (
                  <Card as="li" key={r.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar profile={{ displayName: r.coach.displayName, username: '', avatarUrl: r.coach.photoUrl }} size={36} />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{r.coach.displayName}</p>
                        <p className="text-xs text-muted">
                          {RELATIONSHIP_STATUS_LABEL[r.status]} · {fmtDateTime(r.endedAt ?? r.respondedAt ?? r.requestedAt)}
                        </p>
                      </div>
                      {r.status === 'ended' && (
                        <Button size="sm" variant="ghost" icon={<MessageCircle className="size-4" />} onClick={() => nav(`/coaching/messages/${r.id}`)}>
                          {t('train.historyTitle')}
                        </Button>
                      )}
                    </div>
                    <p className="text-sm text-muted mt-2">{closedExplanation(r)}</p>
                  </Card>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Page>
  );
}

/* ================================================================ active coach */
function ActiveCoach({ rel, onChanged }: { rel: CoachingRelationship; onChanged: () => Promise<void> }) {
  const nav = useNavigate();
  const toast = useToast();
  const { t, tp } = useT();
  const { db, account } = useApp();
  const unit = account.settings.units.weight;
  const name = rel.coach.displayName || t('coaching.hub.your_coach');
  const proposals = useLoad(() => coachingApi.listProposals({ relationshipId: rel.id }), [rel.id]);
  const checkins = useLoad(() => coachingApi.listCheckIns(rel.id), [rel.id]);
  const feedback = useLoad(() => coachingApi.listFeedback(rel.id), [rel.id]);
  const sessions = useLiveQuery(() => db.sessions.toArray(), [db]);
  const sessionById = useMemo(() => new Map(alive(sessions ?? []).map((s) => [s.id, s])), [sessions]);

  const [ending, setEnding] = useState(false);
  const [endReason, setEndReason] = useState('');
  const [busy, setBusy] = useState(false);

  const pending = (proposals.data ?? []).filter((p) => p.status === 'sent');
  const past = (proposals.data ?? []).filter((p) => p.status !== 'sent' && p.status !== 'draft').sort((a, b) => (b.respondedAt ?? b.sentAt ?? '').localeCompare(a.respondedAt ?? a.sentAt ?? ''));

  const end = async () => {
    setBusy(true);
    try {
      await coachingApi.endCoaching(rel.id, endReason.trim() || undefined);
      setEnding(false);
      toast.show(t('coaching.myCoach.coaching_with_x_has_ended', { name }), { tone: 'success' });
      await onChanged();
    } catch (e) {
      toast.show(coachingError(e, t('coaching.myCoach.couldnt_end_coaching')), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {rel.coach.suspended && (
        <Notice tone="warn" className="mb-3">
          {t('coaching.messages.your_coachs_account_is_currently_suspended')}
        </Notice>
      )}
      <Card className="px-4 py-4">
        <div className="flex items-center gap-3">
          <Avatar profile={{ displayName: name, username: '', avatarUrl: rel.coach.photoUrl }} size={52} />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight truncate">{name}</h2>
            <p className="text-sm text-muted">{rel.respondedAt ? t('coaching.myCoach.your_coach_since', { date: fmtDateTime(rel.respondedAt) }) : t('coaching.hub.your_coach')}</p>
            <div className="mt-1.5 flex gap-1.5 flex-wrap">
              <Badge tone="accent">{t('coaching.myCoach.active')}</Badge>
              {rel.coach.approved && !rel.coach.suspended && <Badge>{t('coaching.hub.listed_coach')}</Badge>}
            </div>
          </div>
        </div>
        <div className="mt-3 flex gap-2 flex-wrap">
          <Button variant="primary" icon={<MessageCircle className="size-4" />} onClick={() => nav(`/coaching/messages/${rel.id}`)}>
            {rel.unread > 0 ? tp('coaching.myCoach.messages_x_new', rel.unread) : t('coaching.messages.messages')}
          </Button>
          <Button icon={<ClipboardCheck className="size-4" />} onClick={() => nav(`/coaching/checkin/${rel.id}`)}>
            {t('coaching.myCoach.new_check_in')}
          </Button>
        </div>
        {rel.coach.approved && <p className="text-xs text-muted mt-3">{t('coaching.myCoach.listed_coach_means_hard_earned_reviewed')}</p>}
      </Card>

      <SectionTitle id="sharing">{t('coaching.myCoach.what_you_share_with_x', { name })}</SectionTitle>
      <ScopeEditor
        scopes={rel.scopes}
        onSave={async (s) => {
          await coachingApi.setScopes(rel.id, s);
          await onChanged();
        }}
      />

      <SectionTitle>{t('coaching.client.program_proposals')}</SectionTitle>
      {proposals.error && !proposals.data ? (
        <ErrorState title={t('coaching.client.couldnt_load_proposals')} message={proposals.error} onRetry={proposals.reload} />
      ) : !proposals.data ? (
        <Spinner label={t('coaching.client.loading_proposals')} />
      ) : pending.length === 0 && past.length === 0 ? (
        <Card className="px-4 py-3 text-sm text-muted">{t('coaching.myCoach.no_programs_from_x_yet', { name })}</Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {pending.map((p) => (
              <li key={p.id}>
                <ListRow
                  left={<CalendarRange className="size-5 text-accent" aria-hidden />}
                  title={p.program.name}
                  subtitle={t('coaching.myCoach.revision_x_sent_x_waiting_for', { revision: p.revision, date: fmtDateTime(p.sentAt) })}
                  right={<Badge tone="accent">{t('nutrition.home.review')}</Badge>}
                  onClick={() => nav(`/coaching/proposal/${p.id}`)}
                />
              </li>
            ))}
            {past.slice(0, 6).map((p) => (
              <li key={p.id}>
                <ListRow title={p.program.name} subtitle={t('coaching.myCoach.revision_x_x', { revision: p.revision, date: fmtDateTime(p.respondedAt ?? p.sentAt) })} right={<ProposalStatusBadge status={p.status} />} onClick={() => nav(`/coaching/proposal/${p.id}`)} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <SectionTitle
        action={
          <Button size="sm" variant="ghost" onClick={() => nav(`/coaching/checkin/${rel.id}`)}>
            {t('coaching.myCoach.new_check_in')}
          </Button>
        }
      >
        {t('coaching.shareScope.check_ins')}
      </SectionTitle>
      <CheckInList data={checkins.data} error={checkins.error} reload={checkins.reload} unit={unit} coachName={name} shared={rel.scopes.checkins} />

      <SectionTitle>{t('coaching.myCoach.feedback_on_your_workouts')}</SectionTitle>
      <FeedbackList data={feedback.data} error={feedback.error} reload={feedback.reload} sessionName={(id) => {
        const s = id ? sessionById.get(id) : undefined;
        return s ? `${s.name} · ${formatDate(s.date)}` : id ? t('coaching.myCoach.a_workout') : t('coaching.myCoach.general');
      }} />

      <SectionTitle>{t('coaching.myCoach.change_coaching')}</SectionTitle>
      <Card className="px-4 py-3 flex flex-col gap-3">
        {isFeatureEnabled('coachMarketplace') && (
          <div>
            <p className="text-sm">
              <span className="font-medium">{t('coaching.myCoach.switch_coach')}</span> {t('coaching.myCoach.switch_coach_body', { name })}
            </p>
            <Button className="mt-2" icon={<Repeat className="size-4" />} onClick={() => nav('/coaching/find')}>
              {t('coaching.myCoach.find_another_coach')}
            </Button>
          </div>
        )}
        <div className={isFeatureEnabled('coachMarketplace') ? 'border-t border-line pt-3' : undefined}>
          <Button variant="danger" icon={<UserX className="size-4" />} onClick={() => setEnding(true)}>
            {t('coaching.client.end_coaching')}
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={ending}
        title={t('coaching.myCoach.end_coaching_with_x', { name })}
        danger
        confirmLabel={t('coaching.client.end_coaching')}
        busy={busy}
        onCancel={() => setEnding(false)}
        onConfirm={end}
        body={
          <ul className="list-disc pl-4 flex flex-col gap-1.5">
            <li>{t('coaching.myCoach.your_workouts_and_every_program_you')}</li>
            <li>{t('coaching.myCoach.your_current_plan_stays_active_you')}</li>
            <li>{t('coaching.myCoach.x_immediately_loses_access', { name })}</li>
            <li>{t('coaching.myCoach.your_conversation_stays_readable_but_no')}</li>
          </ul>
        }
      >
        <Textarea className="mt-3" label={t('coaching.myCoach.reason_optional_shared_with_your_coach')} maxLength={500} value={endReason} onChange={(e) => setEndReason(e.target.value)} />
      </ConfirmDialog>
    </>
  );
}

function CheckInList({ data, error, reload, unit, coachName, shared }: { data?: CheckIn[]; error: string | null; reload: () => Promise<void>; unit: 'kg' | 'lb'; coachName: string; shared: boolean }) {
  const { t } = useT();
  return (
    <>
      {!shared && (
        <Notice tone="warn" className="mb-2">
          {t('coaching.myCoach.check_in_sharing_off_x', { name: coachName })}
        </Notice>
      )}
      {error && !data ? (
        <ErrorState title={t('coaching.myCoach.couldnt_load_check_ins')} message={error} onRetry={reload} />
      ) : !data ? (
        <Spinner label={t('coaching.myCoach.loading_check_ins')} />
      ) : data.length === 0 ? (
        <Card className="px-4 py-3 text-sm text-muted">{t('coaching.myCoach.no_check_ins_yet_a_quick')}</Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...data]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 8)
            .map((c) => (
              <Card as="li" key={c.id} className="px-4 py-3">
                <p className="text-xs text-muted mb-2">{fmtDateTime(c.createdAt)}</p>
                <CheckInAnswers c={c} unit={unit} />
                {c.coachResponse ? (
                  <div className="mt-3 rounded-xl bg-accent-soft px-3 py-2 text-sm">
                    <p className="text-xs font-medium text-accent mb-0.5">{t('coaching.myCoach.x_replied', { name: coachName })}</p>
                    <p className="whitespace-pre-wrap break-words">{c.coachResponse}</p>
                  </div>
                ) : (
                  <p className="text-xs text-faint mt-2">{t('coaching.myCoach.no_reply_yet')}</p>
                )}
              </Card>
            ))}
        </ul>
      )}
    </>
  );
}

function FeedbackList({ data, error, reload, sessionName }: { data?: CoachFeedback[]; error: string | null; reload: () => Promise<void>; sessionName: (id?: string | null) => string }) {
  const { t } = useT();
  if (error && !data) return <ErrorState title={t('coaching.myCoach.couldnt_load_feedback')} message={error} onRetry={reload} />;
  if (!data) return <Spinner label={t('coaching.myCoach.loading_feedback')} />;
  if (!data.length) return <Card className="px-4 py-3 text-sm text-muted">{t('coaching.myCoach.no_feedback_yet_your_coach_can')}</Card>;
  return (
    <ul className="flex flex-col gap-2">
      {[...data]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10)
        .map((f) => (
          <Card as="li" key={f.id} className="px-4 py-3">
            <p className="text-xs text-muted">
              {f.sessionId ? (
                <Link className="underline" to={`/train/history/${f.sessionId}`}>
                  {sessionName(f.sessionId)}
                </Link>
              ) : (
                sessionName(null)
              )}{' '}
              · {fmtDateTime(f.createdAt)}
            </p>
            <p className="text-sm mt-1 whitespace-pre-wrap break-words">{f.body}</p>
          </Card>
        ))}
    </ul>
  );
}

/* ================================================================ pending request */
function PendingRequest({ rel, onChanged }: { rel: CoachingRelationship; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const { t } = useT();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = rel.coach.displayName || t('coaching.relationship.the_coach');
  const cancel = async () => {
    setBusy(true);
    try {
      await coachingApi.cancelRequest(rel.id);
      setConfirm(false);
      toast.show(t('coaching.myCoach.request_cancelled'), { tone: 'success' });
      await onChanged();
    } catch (e) {
      toast.show(coachingError(e, t('coaching.myCoach.couldnt_cancel_request')), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="px-4 py-4 mt-3">
      <div className="flex items-center gap-3">
        <Avatar profile={{ displayName: name, username: '', avatarUrl: rel.coach.photoUrl }} size={44} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold truncate">{name}</p>
          <p className="text-xs text-muted">{t('coaching.myCoach.requested_on', { date: fmtDateTime(rel.requestedAt) })}</p>
        </div>
        <Badge tone="info">{t('coaching.myCoach.waiting')}</Badge>
      </div>
      <p className="text-sm text-muted mt-3">
        {t('coaching.myCoach.waiting_for_x_to_respond', { name })}
      </p>
      {rel.coach.suspended && <Notice tone="warn" className="mt-2">{t('coaching.myCoach.this_coachs_account_is_currently_suspended')}</Notice>}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium min-h-11 flex items-center">{t('coaching.myCoach.what_youll_share_once_accepted')}</summary>
        <div className="mt-2">
          <ScopeEditor
            scopes={rel.scopes}
            onSave={async (s) => {
              await coachingApi.setScopes(rel.id, s);
              await onChanged();
            }}
          />
        </div>
      </details>
      <Button className="mt-3" variant="ghost" onClick={() => setConfirm(true)}>
        {t('coaching.myCoach.cancel_request')}
      </Button>
      <ConfirmDialog
        open={confirm}
        title={t('coaching.myCoach.cancel_this_request')}
        body={t('coaching.myCoach.x_wont_be_able_to_accept', { name })}
        confirmLabel={t('coaching.myCoach.cancel_request')}
        danger
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={cancel}
      />
    </Card>
  );
}

/* ================================================================ take over */
/** After coaching ends, a coach-managed plan stays active; offer the explicit switch to self-managed. */
function TakeOverNotice({ activeRelationshipIds, ready }: { activeRelationshipIds: string[]; ready: boolean }) {
  const { db } = useApp();
  const toast = useToast();
  const { t } = useT();
  const nav = useNavigate();
  const programs = useLiveQuery(() => db.programs.toArray(), [db]);
  const [busy, setBusy] = useState(false);
  const plan = alive(programs ?? []).find((p) => p.active && p.managedBy?.kind === 'coach');
  if (!ready || !plan || (plan.managedBy?.relationshipId && activeRelationshipIds.includes(plan.managedBy.relationshipId))) return null;
  const take = async () => {
    setBusy(true);
    try {
      await saveRecord('programs', takeOverPlan(plan), db);
      toast.show(t('coaching.myCoach.the_plan_is_now_yours_to'), { tone: 'success', action: { label: t('aiCard.recipe.open'), onClick: () => nav('/train/program') } });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : t('coaching.myCoach.couldnt_update_the_plan'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice tone="accent" className="mb-3">
      <p>
        {plan.managedBy?.coachName
          ? t('coaching.myCoach.plan_written_by_x_coaching_ended', { plan: plan.name, coach: plan.managedBy.coachName })
          : t('coaching.myCoach.plan_written_by_your_coach_coaching_ended', { plan: plan.name })}
      </p>
      <Button size="sm" variant="primary" className="mt-2" loading={busy} onClick={take}>
        {t('coaching.myCoach.take_over_the_plan')}
      </Button>
    </Notice>
  );
}
