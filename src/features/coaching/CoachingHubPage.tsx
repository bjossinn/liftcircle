import { Link } from 'react-router';
import { Bot, ChevronRight, ClipboardList, GraduationCap, Search, ShieldCheck, UserRound } from 'lucide-react';
import { coachingApi } from '@/backend/coaching';
import { aiApi } from '@/backend/ai';
import type { AiAvailability, CoachingRelationship, CoachProfile } from '@/backend/coachingContract';
import { Badge, Card, ErrorState, Notice, Page, SectionTitle, Spinner } from '@/components/ui';
import { TopActions } from '@/app/TopActions';
import { STATUS_LABELS, STATUS_TONE, dateText } from '@/domain/coaching/display';
import { CoachPhoto, CoachingAccessNotice, GuestCoachingIntro, useCoachingAccess, useLoad, type Loaded } from './directory/common';

const linkBtn = 'inline-flex items-center justify-center gap-2 min-h-11 px-4 rounded-xl text-[15px] transition-colors';
const primaryLink = `${linkBtn} bg-accent text-accent-ink hover:bg-accent-strong font-semibold`;
const secondaryLink = `${linkBtn} bg-surface-2 text-ink hover:bg-surface-3 border border-line`;

export default function CoachingHubPage() {
  const { access } = useCoachingAccess();
  return (
    <Page title="Coaching" actions={<TopActions />}>
      {access === 'guest' ? <GuestCoachingIntro /> : access !== 'ok' ? <CoachingAccessNotice access={access} /> : <HubContent />}
    </Page>
  );
}

function HubContent() {
  const rels = useLoad(() => coachingApi.myRelationships(), [], { fallback: 'Couldn’t load your coaching.' });
  const profile = useLoad(() => coachingApi.getMyCoachProfile(), [], { fallback: 'Couldn’t load your coach profile.' });
  const roles = useLoad(() => coachingApi.myRoles(), []);
  return (
    <>
      <MyCoachSection rels={rels} />
      <AiSection />
      <ForCoachesSection profile={profile} rels={rels.data} />
      {roles.data?.admin && (
        <>
          <SectionTitle>Admin</SectionTitle>
          <Card>
            <Link to="/coaching/admin" className="flex items-center gap-3 px-4 py-3 min-h-14 hover:bg-surface-2 rounded-2xl">
              <ShieldCheck className="size-5 text-accent" aria-hidden />
              <span className="flex-1">
                <span className="block font-medium">Coach applications</span>
                <span className="block text-xs text-muted">Review applications, qualifications and suspensions</span>
              </span>
              <ChevronRight className="size-5 text-muted" aria-hidden />
            </Link>
          </Card>
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- my coach */
function MyCoachSection({ rels }: { rels: Loaded<CoachingRelationship[]> }) {
  const mine = (rels.data ?? []).filter((r) => !r.viewerIsCoach);
  const active = mine.find((r) => r.status === 'active');
  const pending = mine.filter((r) => r.status === 'requested');
  return (
    <section aria-labelledby="hub-my-coach">
      <SectionTitle id="hub-my-coach">My coach</SectionTitle>
      {rels.loading && !rels.data ? (
        <Card className="p-2">
          <Spinner label="Loading your coaching" />
        </Card>
      ) : rels.error && !rels.data ? (
        <Card className="pb-4 flex flex-col items-center">
          <ErrorState title="Couldn’t load your coaching" message={rels.error} onRetry={rels.reload} />
          <Link to="/coaching/find" className="text-sm text-accent font-medium min-h-11 inline-flex items-center">
            Look for a coach
          </Link>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {active && <RelationshipCard rel={active} />}
          {pending.map((r) => (
            <RelationshipCard key={r.id} rel={r} />
          ))}
          {!active && (
            <Card className="p-4 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <span className="size-10 rounded-xl bg-accent-soft text-accent flex items-center justify-center shrink-0">
                  <GraduationCap className="size-5" aria-hidden />
                </span>
                <div>
                  <p className="font-semibold">{pending.length ? 'Waiting for a reply' : 'Work with a coach'}</p>
                  <p className="text-sm text-muted">
                    {pending.length
                      ? 'You’ll get a notification when the coach answers. You can look at other coaches meanwhile.'
                      : 'Find an approved coach near you or online. You choose exactly what they can see.'}
                  </p>
                </div>
              </div>
              <Link to="/coaching/find" className={pending.length ? secondaryLink : primaryLink}>
                <Search className="size-4" aria-hidden />
                Look for a coach
              </Link>
            </Card>
          )}
          {active && (
            <Link to="/coaching/find" className="text-sm text-accent font-medium min-h-11 inline-flex items-center px-1">
              Look for a different coach
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

function RelationshipCard({ rel }: { rel: CoachingRelationship }) {
  const pending = rel.status === 'requested';
  return (
    <Card>
      <Link to="/coaching/my" className="flex items-center gap-3 p-4 hover:bg-surface-2 rounded-2xl">
        <CoachPhoto name={rel.coach.displayName} url={rel.coach.photoUrl} size={48} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold truncate">{rel.coach.displayName}</span>
          <span className="flex flex-wrap items-center gap-1.5 mt-1">
            {pending ? <Badge tone="warn">Request pending</Badge> : rel.coach.suspended ? <Badge tone="danger">Coaching paused</Badge> : <Badge tone="accent">Your coach</Badge>}
            {pending && <span className="text-xs text-muted">sent {dateText(rel.requestedAt)}</span>}
            {!pending && rel.unread > 0 && <Badge tone="info">{rel.unread} unread</Badge>}
          </span>
        </span>
        <ChevronRight className="size-5 text-muted" aria-hidden />
      </Link>
    </Card>
  );
}

/* ---------------------------------------------------------------- AI coach */
function aiUnavailableText(a: Extract<AiAvailability, { available: false }>['reason']): string {
  switch (a) {
    case 'not_configured':
    case 'backend_missing':
      return 'The AI coach isn’t switched on in this version of LiftCircle yet.';
    case 'provider_down':
      return 'The AI coach is temporarily unavailable. Please try again later.';
    case 'offline':
      return 'The AI coach needs a connection.';
    case 'disabled':
      return 'The AI coach is turned off.';
  }
}

function AiSection() {
  const status = useLoad(async () => {
    const st = await aiApi.status();
    const settings = await aiApi.getSettings().catch(() => null);
    return { st, settings };
  }, []);
  const enabled = !!status.data?.settings?.enabled;
  const paused = !!status.data?.settings?.paused;
  const st = status.data?.st;
  return (
    <section aria-labelledby="hub-ai">
      <SectionTitle id="hub-ai">AI coach</SectionTitle>
      <Card className="p-4 flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <span className="size-10 rounded-xl bg-surface-3 text-info flex items-center justify-center shrink-0">
            <Bot className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="font-semibold">{enabled ? (paused ? 'AI coach is paused' : 'Your AI coach') : 'Start with an AI coach'}</p>
            <p className="text-sm text-muted">
              Get suggestions and answers based on the records you choose to share. AI messages are always labelled, and nothing changes in your plan unless you accept it.
            </p>
          </div>
        </div>
        {status.loading ? (
          <Spinner label="Checking the AI coach" />
        ) : status.error || !st ? (
          <Notice>
            The AI coach isn’t available right now.{' '}
            <button type="button" className="text-accent font-medium min-h-11 px-1" onClick={status.reload}>
              Check again
            </button>
          </Notice>
        ) : st.available ? (
          <Link to={enabled ? '/coaching/ai' : '/coaching/ai/setup'} className={enabled ? secondaryLink : primaryLink}>
            <Bot className="size-4" aria-hidden />
            {enabled ? 'Open AI coach' : 'Start with an AI coach'}
          </Link>
        ) : (
          <>
            <Notice>{aiUnavailableText(st.reason)}</Notice>
            {enabled && (
              <Link to="/coaching/ai/settings" className={secondaryLink}>
                AI coach settings
              </Link>
            )}
          </>
        )}
      </Card>
    </section>
  );
}

/* ---------------------------------------------------------------- coaches */
function ForCoachesSection({ profile, rels }: { profile: Loaded<CoachProfile | null>; rels: CoachingRelationship[] | undefined }) {
  const p = profile.data;
  const asCoach = (rels ?? []).filter((r) => r.viewerIsCoach);
  const requests = asCoach.filter((r) => r.status === 'requested').length;
  const clients = asCoach.filter((r) => r.status === 'active').length;
  return (
    <section aria-labelledby="hub-coaches">
      <SectionTitle id="hub-coaches">For coaches</SectionTitle>
      <Card className="p-4 flex flex-col gap-3">
        {profile.loading && profile.data === undefined ? (
          <Spinner label="Loading your coach profile" />
        ) : profile.error && profile.data === undefined ? (
          <ErrorState title="Couldn’t load your coach profile" message={profile.error} onRetry={profile.reload} />
        ) : !p ? (
          <>
            <div className="flex items-start gap-3">
              <span className="size-10 rounded-xl bg-surface-3 text-accent flex items-center justify-center shrink-0">
                <UserRound className="size-5" aria-hidden />
              </span>
              <div>
                <p className="font-semibold">Coach on LiftCircle</p>
                <p className="text-sm text-muted">Apply with your profile and experience. After review, approved coaches can list themselves and take on clients — using this same account.</p>
              </div>
            </div>
            <Link to="/coaching/apply" className={secondaryLink}>
              Become a coach
            </Link>
          </>
        ) : p.status === 'approved' ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">{p.displayName}</p>
              {p.suspended ? <Badge tone="danger">Suspended</Badge> : <Badge tone="accent">Approved coach</Badge>}
            </div>
            {p.suspended ? (
              <Notice tone="danger">Your coach account is suspended{p.suspendedReason ? `: ${p.suspendedReason}` : '.'} Your listing is hidden and coaching tools are unavailable.</Notice>
            ) : (
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-muted">Directory listing</dt>
                  <dd className="font-medium">{p.listed ? 'Listed' : 'Hidden'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">New clients</dt>
                  <dd className="font-medium">{p.acceptingClients ? 'Accepting' : 'Not accepting'}</dd>
                </div>
                {rels && (
                  <>
                    <div>
                      <dt className="text-xs text-muted">Active clients</dt>
                      <dd className="font-medium tabular">{clients}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Pending requests</dt>
                      <dd className="font-medium tabular">{requests}</dd>
                    </div>
                  </>
                )}
              </dl>
            )}
            <div className="flex flex-wrap gap-2">
              {!p.suspended && (
                <Link to="/coaching/dashboard" className={`${primaryLink} flex-1`}>
                  <ClipboardList className="size-4" aria-hidden />
                  Coach dashboard
                </Link>
              )}
              <Link to="/coaching/apply" className={`${secondaryLink} flex-1`}>
                Edit coach profile
              </Link>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">Your coach application</p>
              <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABELS[p.status]}</Badge>
            </div>
            <p className="text-sm text-muted">
              {p.status === 'draft'
                ? 'Finish your profile and submit it for review when you’re ready.'
                : p.status === 'submitted'
                  ? 'Thanks — your application is with our reviewers. You’ll get a notification when it’s reviewed.'
                  : p.status === 'changes_requested'
                    ? 'Reviewers asked for a few changes. Update your application and resubmit.'
                    : 'Your application wasn’t approved. You can read the reason, update it and apply again.'}
            </p>
            <Link to="/coaching/apply" className={p.status === 'submitted' ? secondaryLink : primaryLink}>
              {p.status === 'submitted' ? 'View application' : 'Continue application'}
            </Link>
          </>
        )}
      </Card>
      {p && p.status !== 'approved' && (
        <p className="text-xs text-muted px-1 mt-2">Applicants can prepare a profile, but don’t appear in search or work with clients until approved.</p>
      )}
    </section>
  );
}
