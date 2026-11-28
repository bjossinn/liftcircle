/**
 * Coach-side building blocks: coach eligibility gate, client cards with permission-aware panels.
 */
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { CalendarRange, ClipboardCheck, EyeOff, MessageCircle, ShieldAlert } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, ProgressBar, Spinner } from '@/components/ui';
import { coachingApi } from '@/backend/coaching';
import type { ClientOverview, CoachProfile, CoachingRelationship } from '@/backend/coachingContract';
import { Avatar } from '@/features/social/common';
import { useLoad } from './common';
import { t as tNow, useT } from '@/i18n';

export type CoachState = 'loading' | 'error' | 'none' | 'applicant' | 'suspended' | 'approved';

export function coachStateOf(profile: CoachProfile | null | undefined): CoachState {
  if (profile === undefined) return 'loading';
  if (profile === null) return 'none';
  if (profile.suspended) return 'suspended';
  return profile.status === 'approved' ? 'approved' : 'applicant';
}

export function useCoachStatus(enabled: boolean) {
  const prof = useLoad(() => coachingApi.getMyCoachProfile(), [], enabled, tNow('coaching.editor.couldnt_load_your_coach_profile'));
  const state: CoachState = prof.error && prof.data === undefined ? 'error' : coachStateOf(prof.data);
  return { state, profile: prof.data ?? null, error: prof.error, reload: prof.reload };
}

/** Explanation for anyone who can't use the coach tools right now. Renders nothing when approved. */
export function CoachGate({ state, profile, error, reload }: { state: CoachState; profile: CoachProfile | null; error: string | null; reload: () => Promise<void> }): ReactNode {
  const nav = useNavigate();
  const { t } = useT();
  if (state === 'approved') return null;
  if (state === 'loading') return <Spinner label={t('coaching.editor.checking_your_coach_status')} />;
  if (state === 'error') return <ErrorState title={t('coaching.editor.couldnt_check_your_coach_status')} message={error ?? undefined} onRetry={reload} />;
  if (state === 'suspended')
    return (
      <EmptyState
        icon={<ShieldAlert className="size-6" aria-hidden />}
        title={t('coaching.apply.your_coach_account_is_suspended')}
        body={
          <>
            {t('coaching.editor.while_suspended_you_cant_see_clients')}
            {profile?.suspendedReason ? ` ${t('coaching.editor.reason_x', { reason: profile.suspendedReason })}` : ''} {t('coaching.editor.contact_support_if_you_think_this')}
          </>
        }
      />
    );
  if (state === 'none')
    return (
      <EmptyState
        title={t('coaching.editor.coach_tools_are_for_approved_coaches')}
        body={t('coaching.editor.apply_to_become_a_coach_once')}
        action={
          <Button variant="primary" onClick={() => nav('/coaching/apply')}>
            {t('coaching.editor.apply_to_be_listed')}
          </Button>
        }
      />
    );
  return (
    <EmptyState
      title={t('coaching.editor.not_approved_yet')}
      body={
        <>
          {profile ? t(`coaching.editor.app_status.${profile.status}`) : ''}
          {profile?.latestFeedback ? ` ${t('coaching.editor.feedback_x', { feedback: profile.latestFeedback })}` : ''} {t('coaching.editor.you_can_prepare_your_profile_but')}
        </>
      }
      action={
        <Button variant="primary" onClick={() => nav('/coaching/apply')}>
          {t('coaching.hub.view_application')}
        </Button>
      }
    />
  );
}

/* ================================================================ client card */
export function TrainingSummary({ training, who }: { training: ClientOverview['training'] | undefined; who: string }) {
  const { t, tp } = useT();
  if (training === undefined) return <p className="text-xs text-muted">{t('coaching.editor.loading_activity')}</p>;
  if (training === null)
    return (
      <p className="text-xs text-muted inline-flex items-center gap-1">
        <EyeOff className="size-4" aria-hidden /> {t('coaching.editor.training_not_shared_by', { name: who })}
      </p>
    );
  const { plannedLast28: planned, completedLast28: done } = training;
  const summary = planned != null && planned > 0 ? t('coaching.editor.x_of_x_planned_sessions_in', { done, planned }) : tp('coaching.editor.workouts_last_28', done);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted">
        {training.activeProgram
          ? t('coaching.editor.training_summary_plan', { summary, program: training.activeProgram.name, version: training.activeProgram.currentVersion })
          : t('coaching.editor.training_summary_no_plan', { summary })}
      </p>
      {planned != null && planned > 0 && <ProgressBar value={Math.min(done, planned)} max={planned} label={t('coaching.editor.adherence_for_x', { name: who })} tone={done / planned < 0.6 ? 'warn' : 'accent'} />}
    </div>
  );
}

export function ClientCard({ rel, overview, overviewError }: { rel: CoachingRelationship; overview: ClientOverview | undefined; overviewError?: string | null }) {
  const nav = useNavigate();
  const { t, tp } = useT();
  const who = rel.client.displayName || t('coaching.client.your_client');
  const openCheckins = overview?.checkins?.filter((c) => !c.coachResponse).length ?? 0;
  return (
    <Card as="li" className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Avatar profile={{ displayName: who, username: '', avatarUrl: rel.client.avatarUrl }} size={40} />
        <div className="min-w-0 flex-1">
          <Link to={`/coaching/client/${rel.id}`} className="font-semibold truncate block hover:underline">
            {who}
          </Link>
          <div className="mt-1">{overviewError ? <p className="text-xs text-danger">{t('coaching.editor.couldnt_load_activity')}</p> : <TrainingSummary training={overview ? overview.training : undefined} who={who} />}</div>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {rel.unread > 0 && <Badge tone="accent">{t('coaching.editor.unread_count', { count: rel.unread })}</Badge>}
            {openCheckins > 0 && <Badge tone="warn">{tp('coaching.editor.checkins_to_answer', openCheckins)}</Badge>}
          </div>
        </div>
      </div>
      <div className="flex gap-1 mt-2 -ml-2 flex-wrap">
        <Button size="sm" variant="ghost" icon={<MessageCircle className="size-4" />} onClick={() => nav(`/coaching/messages/${rel.id}`)}>
          {t('coaching.messages.message')}
        </Button>
        <Button size="sm" variant="ghost" icon={<CalendarRange className="size-4" />} onClick={() => nav(`/coaching/client/${rel.id}/program`)}>
          {t('train.program')}
        </Button>
        <Button size="sm" variant="ghost" icon={<ClipboardCheck className="size-4" />} onClick={() => nav(`/coaching/client/${rel.id}`)}>
          {t('today.nutritionDetails')}
        </Button>
      </div>
    </Card>
  );
}
