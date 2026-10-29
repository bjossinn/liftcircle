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

export type CoachState = 'loading' | 'error' | 'none' | 'applicant' | 'suspended' | 'approved';

export function coachStateOf(profile: CoachProfile | null | undefined): CoachState {
  if (profile === undefined) return 'loading';
  if (profile === null) return 'none';
  if (profile.suspended) return 'suspended';
  return profile.status === 'approved' ? 'approved' : 'applicant';
}

export function useCoachStatus(enabled: boolean) {
  const prof = useLoad(() => coachingApi.getMyCoachProfile(), [], enabled, 'Couldn’t load your coach profile.');
  const state: CoachState = prof.error && prof.data === undefined ? 'error' : coachStateOf(prof.data);
  return { state, profile: prof.data ?? null, error: prof.error, reload: prof.reload };
}

const APP_STATUS: Record<CoachProfile['status'], string> = {
  draft: 'Your application is a draft — finish and submit it for review.',
  submitted: 'Your application is with our reviewers.',
  changes_requested: 'Reviewers asked for changes to your application.',
  approved: 'Approved',
  rejected: 'Your application wasn’t approved.',
};

/** Explanation for anyone who can't use the coach tools right now. Renders nothing when approved. */
export function CoachGate({ state, profile, error, reload }: { state: CoachState; profile: CoachProfile | null; error: string | null; reload: () => Promise<void> }): ReactNode {
  const nav = useNavigate();
  if (state === 'approved') return null;
  if (state === 'loading') return <Spinner label="Checking your coach status" />;
  if (state === 'error') return <ErrorState title="Couldn’t check your coach status" message={error ?? undefined} onRetry={reload} />;
  if (state === 'suspended')
    return (
      <EmptyState
        icon={<ShieldAlert className="size-6" aria-hidden />}
        title="Your coach account is suspended"
        body={
          <>
            While suspended you can’t see clients, their records or messages, and your listing is hidden. Your clients keep their workouts and accepted plans.
            {profile?.suspendedReason ? ` Reason: “${profile.suspendedReason}”.` : ''} Contact support if you think this is a mistake.
          </>
        }
      />
    );
  if (state === 'none')
    return (
      <EmptyState
        title="Coach tools are for approved coaches"
        body="Apply to become a coach. Once LiftCircle approves your application you can accept clients, build programs and message them."
        action={
          <Button variant="primary" onClick={() => nav('/coaching/apply')}>
            Become a coach
          </Button>
        }
      />
    );
  return (
    <EmptyState
      title="Not approved yet"
      body={
        <>
          {profile ? APP_STATUS[profile.status] : ''}
          {profile?.latestFeedback ? ` Feedback: “${profile.latestFeedback}”.` : ''} You can prepare your profile, but you can’t access clients until you’re approved.
        </>
      }
      action={
        <Button variant="primary" onClick={() => nav('/coaching/apply')}>
          View application
        </Button>
      }
    />
  );
}

/* ================================================================ client card */
export function TrainingSummary({ training, who }: { training: ClientOverview['training'] | undefined; who: string }) {
  if (training === undefined) return <p className="text-xs text-muted">Loading activity…</p>;
  if (training === null)
    return (
      <p className="text-xs text-muted inline-flex items-center gap-1">
        <EyeOff className="size-3.5" aria-hidden /> Training not shared by {who}
      </p>
    );
  const { plannedLast28: planned, completedLast28: done } = training;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted">
        {planned != null && planned > 0 ? `${done} of ${planned} planned sessions in the last 28 days` : `${done} workout${done === 1 ? '' : 's'} in the last 28 days`}
        {training.activeProgram ? ` · ${training.activeProgram.name} v${training.activeProgram.currentVersion}` : ' · no active plan'}
      </p>
      {planned != null && planned > 0 && <ProgressBar value={Math.min(done, planned)} max={planned} label={`Adherence for ${who}`} tone={done / planned < 0.6 ? 'warn' : 'accent'} />}
    </div>
  );
}

export function ClientCard({ rel, overview, overviewError }: { rel: CoachingRelationship; overview: ClientOverview | undefined; overviewError?: string | null }) {
  const nav = useNavigate();
  const who = rel.client.displayName || 'your client';
  const openCheckins = overview?.checkins?.filter((c) => !c.coachResponse).length ?? 0;
  return (
    <Card as="li" className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Avatar profile={{ displayName: who, username: '', avatarUrl: rel.client.avatarUrl }} size={40} />
        <div className="min-w-0 flex-1">
          <Link to={`/coaching/client/${rel.id}`} className="font-semibold truncate block hover:underline">
            {who}
          </Link>
          <div className="mt-1">{overviewError ? <p className="text-xs text-danger">Couldn’t load activity.</p> : <TrainingSummary training={overview ? overview.training : undefined} who={who} />}</div>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {rel.unread > 0 && <Badge tone="accent">{rel.unread} unread</Badge>}
            {openCheckins > 0 && <Badge tone="warn">{openCheckins} check-in{openCheckins === 1 ? '' : 's'} to answer</Badge>}
          </div>
        </div>
      </div>
      <div className="flex gap-1 mt-2 -ml-2 flex-wrap">
        <Button size="sm" variant="ghost" icon={<MessageCircle className="size-4" />} onClick={() => nav(`/coaching/messages/${rel.id}`)}>
          Message
        </Button>
        <Button size="sm" variant="ghost" icon={<CalendarRange className="size-4" />} onClick={() => nav(`/coaching/client/${rel.id}/program`)}>
          Program
        </Button>
        <Button size="sm" variant="ghost" icon={<ClipboardCheck className="size-4" />} onClick={() => nav(`/coaching/client/${rel.id}`)}>
          Details
        </Button>
      </div>
    </Card>
  );
}
