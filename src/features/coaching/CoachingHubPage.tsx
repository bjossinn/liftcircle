import { Link } from 'react-router';
import { Bot, ChevronRight, ClipboardList, GraduationCap, History, Search, ShieldCheck } from 'lucide-react';
import { isFeatureEnabled } from '@/config/featureFlags';
import { coachingApi } from '@/backend/coaching';
import { aiApi } from '@/backend/ai';
import type { AiAvailability, CoachingRelationship, CoachProfile } from '@/backend/coachingContract';
import { Badge, Card, ErrorState, Notice, Page, SectionTitle, Spinner } from '@/components/ui';
import { TopActions } from '@/app/TopActions';
import { STATUS_LABELS, STATUS_TONE, dateText } from '@/domain/coaching/display';
import { CoachPhoto, CoachingAccessNotice, GuestCoachingIntro, useCoachingAccess, useLoad, type Loaded } from './directory/common';
import { CoachSwitcher, useHumanCoaching } from './coachChannels';
import { useT, type MessageKey } from '@/i18n';

const linkBtn = 'inline-flex items-center justify-center gap-2 min-h-11 px-4 rounded-xl text-[15px] transition-colors';
const primaryLink = `${linkBtn} ember-fill font-semibold`;
const secondaryLink = `${linkBtn} bg-surface-2 text-ink hover:bg-surface-3 border border-line`;

/**
 * /coaching — human coaching (My coach, past coaching, the coach workspace, applications, admin). Part of the Coach tab:
 * the switcher at the top goes back to the training assistant (/coach), the tab's main screen.
 */
export default function CoachingHubPage() {
  const { access } = useCoachingAccess();
  const human = useHumanCoaching();
  const { t } = useT();
  return (
    <Page title={t('ai.channels.human')} actions={<TopActions />}>
      <div className="mb-3">
        <CoachSwitcher current="human" unread={human.unread} onRetry={human.uncertain ? human.retry : undefined} />
      </div>
      {access === 'guest' ? <GuestCoachingIntro /> : access !== 'ok' ? <CoachingAccessNotice access={access} /> : <HubContent />}
    </Page>
  );
}

function HubContent() {
  const { t } = useT();
  const rels = useLoad(() => coachingApi.myRelationships(), [], { fallback: t('coaching.hub.couldnt_load_your_coaching') });
  const profile = useLoad(() => coachingApi.getMyCoachProfile(), [], { fallback: t('coaching.hub.couldnt_load_your_coach_profile') });
  const roles = useLoad(() => coachingApi.myRoles(), []);
  // Marketplace off: AI-first. The training assistant leads, and "My coach" only appears for someone who has (or had)
  // a human coach or a pending request, without any "Look for a coach" links.
  const marketplace = isFeatureEnabled('coachMarketplace');
  return (
    <>
      {marketplace ? (
        <>
          <MyCoachSection rels={rels} marketplace />
          <AiSection />
        </>
      ) : (
        <>
          <AiSection />
          <MyCoachSection rels={rels} marketplace={false} />
        </>
      )}
      <ForCoachesSection profile={profile} rels={rels.data} />
      {roles.data?.admin && (
        <>
          <SectionTitle>{t('coaching.hub.admin')}</SectionTitle>
          <Card>
            <Link to="/coaching/admin" className="flex items-center gap-3 px-4 py-3 min-h-14 hover:bg-surface-2 rounded-2xl">
              <ShieldCheck className="size-5 text-accent" aria-hidden />
              <span className="flex-1">
                <span className="block font-medium">{t('coaching.admin.coach_applications')}</span>
                <span className="block text-xs text-muted">{t('coaching.hub.review_applications_qualifications_and_suspensions')}</span>
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
function MyCoachSection({ rels, marketplace }: { rels: Loaded<CoachingRelationship[]>; marketplace: boolean }) {
  const { t } = useT();
  const mine = (rels.data ?? []).filter((r) => !r.viewerIsCoach);
  const active = mine.find((r) => r.status === 'active');
  const pending = mine.filter((r) => r.status === 'requested');
  if (!marketplace) {
    // Nothing to show a lifter who never had a coach (no empty marketplace card); keep loading/errors quiet until we know.
    if (rels.loading && !rels.data) return null;
    if (rels.error && !rels.data)
      return (
        <section aria-labelledby="hub-my-coach">
          <SectionTitle id="hub-my-coach">{t('coaching.hub.my_coach')}</SectionTitle>
          <Card className="pb-4 flex flex-col items-center">
            <ErrorState title={t('coaching.hub.couldnt_load_your_coaching')} message={rels.error} onRetry={rels.reload} />
          </Card>
        </section>
      );
    if (mine.length === 0) return null;
  }
  return (
    <section aria-labelledby="hub-my-coach">
      <SectionTitle id="hub-my-coach">{t('coaching.hub.my_coach')}</SectionTitle>
      {rels.loading && !rels.data ? (
        <Card className="p-2">
          <Spinner label={t('coaching.hub.loading_your_coaching')} />
        </Card>
      ) : rels.error && !rels.data ? (
        <Card className="pb-4 flex flex-col items-center">
          <ErrorState title={t('coaching.hub.couldnt_load_your_coaching')} message={rels.error} onRetry={rels.reload} />
          {marketplace && (
            <Link to="/coaching/find" className="text-sm text-accent font-medium min-h-11 inline-flex items-center">
              {t('coaching.hub.look_for_a_coach')}
            </Link>
          )}
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {active && <RelationshipCard rel={active} />}
          {pending.map((r) => (
            <RelationshipCard key={r.id} rel={r} />
          ))}
          {!active && !marketplace && pending.length === 0 && (
            // Only past coaching: a quiet link to its history (data is kept), no prompt to find someone new.
            <Card>
              <Link to="/coaching/my" className="flex items-center gap-3 p-4 hover:bg-surface-2 rounded-2xl">
                <History className="size-5 text-muted" aria-hidden />
                <span className="flex-1">
                  <span className="block font-medium">{t('coaching.hub.past_coaching')}</span>
                  <span className="block text-xs text-muted">{t('coaching.hub.your_earlier_coaches_feedback_and_check')}</span>
                </span>
                <ChevronRight className="size-5 text-muted" aria-hidden />
              </Link>
            </Card>
          )}
          {!active && marketplace && (
            <Card className="p-4 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <span className="size-10 rounded-xl bg-accent-soft text-accent flex items-center justify-center shrink-0">
                  <GraduationCap className="size-5" aria-hidden />
                </span>
                <div>
                  <p className="font-semibold">{pending.length ? t('coaching.hub.waiting_for_a_reply') : t('coaching.hub.work_with_a_coach')}</p>
                  <p className="text-sm text-muted">
                    {pending.length
                      ? t('coaching.hub.youll_get_a_notification_when_the')
                      : t('coaching.hub.find_an_approved_coach_near_you')}
                  </p>
                </div>
              </div>
              <Link to="/coaching/find" className={pending.length ? secondaryLink : primaryLink}>
                <Search className="size-4" aria-hidden />
                {t('coaching.hub.look_for_a_coach')}
              </Link>
            </Card>
          )}
          {active && marketplace && (
            <Link to="/coaching/find" className="text-sm text-accent font-medium min-h-11 inline-flex items-center px-1">
              {t('coaching.hub.look_for_a_different_coach')}
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

function RelationshipCard({ rel }: { rel: CoachingRelationship }) {
  const { t, tp } = useT();
  const pending = rel.status === 'requested';
  return (
    <Card>
      <Link to="/coaching/my" className="flex items-center gap-3 p-4 hover:bg-surface-2 rounded-2xl">
        <CoachPhoto name={rel.coach.displayName} url={rel.coach.photoUrl} size={48} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold truncate">{rel.coach.displayName}</span>
          <span className="flex flex-wrap items-center gap-1.5 mt-1">
            {pending ? (
              <Badge tone="warn">{t('coaching.hub.request_pending')}</Badge>
            ) : rel.coach.suspended ? (
              <Badge tone="danger">{t('coaching.hub.coaching_paused')}</Badge>
            ) : (
              <Badge tone="accent">{t('coaching.hub.your_coach')}</Badge>
            )}
            {pending && <span className="text-xs text-muted">{t('coaching.hub.sent_on', { date: dateText(rel.requestedAt) })}</span>}
            {!pending && rel.unread > 0 && <Badge tone="info">{tp('coaching.hub.unreadCount', rel.unread)}</Badge>}
          </span>
        </span>
        <ChevronRight className="size-5 text-muted" aria-hidden />
      </Link>
    </Card>
  );
}

/* ---------------------------------------------------------------- training assistant */
function aiUnavailableKey(a: Extract<AiAvailability, { available: false }>['reason']): MessageKey {
  switch (a) {
    case 'not_configured':
    case 'backend_missing':
      return 'coaching.hub.ai_not_switched_on';
    case 'provider_down':
      return 'coaching.hub.ai_temporarily_unavailable';
    case 'offline':
      return 'coaching.hub.ai_needs_connection';
    case 'disabled':
      return 'ai.error.disabled';
  }
}

function AiSection() {
  const { t } = useT();
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
      <SectionTitle id="hub-ai">{t('ai.title')}</SectionTitle>
      <Card className="p-4 flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <span className="size-10 rounded-xl bg-surface-3 text-info flex items-center justify-center shrink-0">
            <Bot className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="font-semibold">{enabled ? (paused ? t('coaching.hub.the_training_assistant_is_paused') : t('aiConsent.title')) : t('coaching.hub.start_with_the_training_assistant')}</p>
            <p className="text-sm text-muted">{t('coaching.hub.get_suggestions_and_answers_based_on')}</p>
          </div>
        </div>
        {status.loading ? (
          <Spinner label={t('coaching.hub.checking_the_training_assistant')} />
        ) : status.error || !st ? (
          <Notice>
            {t('coaching.hub.the_training_assistant_isnt_available_right')}{' '}
            <button type="button" className="text-accent font-medium min-h-11 px-1" onClick={status.reload}>
              {t('ai.chat.checkAgain')}
            </button>
          </Notice>
        ) : st.available ? (
          <Link to={enabled ? '/coach' : '/coaching/ai/setup'} className={enabled ? secondaryLink : primaryLink}>
            <Bot className="size-4" aria-hidden />
            {enabled ? t('ai.proposals.openAssistant') : t('coaching.hub.start_with_the_training_assistant')}
          </Link>
        ) : (
          <>
            <Notice>{t(aiUnavailableKey(st.reason))}</Notice>
            {enabled && (
              <Link to="/coaching/ai/settings" className={secondaryLink}>
                {t('coaching.hub.training_assistant_settings')}
              </Link>
            )}
          </>
        )}
      </Card>
    </section>
  );
}

/* ---------------------------------------------------------------- coaches */
/**
 * Only for people who already coach or have applied: a regular lifter isn't pitched coach onboarding here (no
 * "Coach on Hard Earned / Apply to be listed" card). /coaching/apply and every coach route still work as before.
 * While the profile loads nothing shows. If it fails to load we can't tell a lifter from an applicant or a coach
 * without clients, so everyone gets a neutral "couldn't load" notice with Retry (no coach wording, no apply link);
 * someone known to coach (relationships as the coach) gets the full "For coaches" error card instead.
 */
function ForCoachesSection({ profile, rels }: { profile: Loaded<CoachProfile | null>; rels: CoachingRelationship[] | undefined }) {
  const { t } = useT();
  const p = profile.data;
  const asCoach = (rels ?? []).filter((r) => r.viewerIsCoach);
  const requests = asCoach.filter((r) => r.status === 'requested').length;
  const clients = asCoach.filter((r) => r.status === 'active').length;
  const loadFailed = !!profile.error && p === undefined;
  if (!p && loadFailed && asCoach.length === 0)
    return (
      <Notice className="mt-4">
        {t('coaching.hub.some_of_your_coaching_details_couldnt')}{' '}
        <button type="button" className="text-accent font-medium min-h-11 px-1" onClick={profile.reload}>
          {t('workout.retry')}
        </button>
      </Notice>
    );
  if (!p && !loadFailed) return null;
  return (
    <section aria-labelledby="hub-coaches">
      <SectionTitle id="hub-coaches">{t('coaching.hub.for_coaches')}</SectionTitle>
      <Card className="p-4 flex flex-col gap-3">
        {!p ? (
          <ErrorState title={t('coaching.hub.couldnt_load_your_coach_profile')} message={profile.error ?? undefined} onRetry={profile.reload} />
        ) : p.status === 'approved' ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">{p.displayName}</p>
              {p.suspended ? <Badge tone="danger">{t('coaching.admin.suspended')}</Badge> : <Badge tone="accent">{t('coaching.hub.listed_coach')}</Badge>}
            </div>
            {p.suspended ? (
              <Notice tone="danger">
                {p.suspendedReason ? t('coaching.hub.suspended_with_reason', { reason: p.suspendedReason }) : t('coaching.hub.suspended_no_reason')}
              </Notice>
            ) : (
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-muted">{t('coaching.hub.directory_listing')}</dt>
                  <dd className="font-medium">{p.listed ? t('coaching.hub.listed') : t('coaching.hub.hidden')}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">{t('coaching.hub.new_clients')}</dt>
                  <dd className="font-medium">{p.acceptingClients ? t('coaching.hub.accepting') : t('coaching.admin.not_accepting')}</dd>
                </div>
                {rels && (
                  <>
                    <div>
                      <dt className="text-xs text-muted">{t('coaching.hub.active_clients')}</dt>
                      <dd className="font-medium tabular">{clients}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">{t('coaching.hub.pending_requests')}</dt>
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
                  {t('coaching.dashboard.your_coaching_workspace')}
                </Link>
              )}
              <Link to="/coaching/apply" className={`${secondaryLink} flex-1`}>
                {t('coaching.hub.edit_coach_profile')}
              </Link>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">{t('coaching.hub.your_coach_application')}</p>
              <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABELS[p.status]}</Badge>
            </div>
            <p className="text-sm text-muted">
              {p.status === 'draft'
                ? t('coaching.hub.finish_your_profile_and_submit_it')
                : p.status === 'submitted'
                  ? t('coaching.hub.application_received_youll_see_its_status')
                  : p.status === 'changes_requested'
                    ? t('coaching.hub.reviewers_asked_for_a_few_changes')
                    : t('coaching.hub.your_application_wasnt_approved_you_can')}
            </p>
            <Link to="/coaching/apply" className={p.status === 'submitted' ? secondaryLink : primaryLink}>
              {p.status === 'submitted' ? t('coaching.hub.view_application') : t('coaching.hub.continue_application')}
            </Link>
          </>
        )}
      </Card>
      {p && p.status !== 'approved' && (
        <p className="text-xs text-muted px-1 mt-2">{t('coaching.hub.applicants_can_prepare_a_profile_but')}</p>
      )}
    </section>
  );
}
