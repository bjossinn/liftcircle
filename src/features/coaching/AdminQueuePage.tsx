import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Flag, Inbox } from 'lucide-react';
import { coachingApi } from '@/backend/coaching';
import { Badge, Card, EmptyState, ErrorState, IconButton, Page, Spinner } from '@/components/ui';
import { QUEUE_TABS, isQueueTab } from '@/domain/coaching/admin';
import { STATUS_LABELS, STATUS_TONE, dateText, locationText } from '@/domain/coaching/display';
import { CoachPhoto, CoachingAccessNotice, useCoachingAccess, useLoad } from './directory/common';
import { AdminGate, ScrollTabs } from './admin/common';
import { useT } from '@/i18n';

export default function AdminQueuePage() {
  const nav = useNavigate();
  const { access } = useCoachingAccess();
  const { t } = useT();
  return (
    <Page
      title={t('coaching.admin.coach_applications')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? (
        <CoachingAccessNotice access={access} />
      ) : (
        <AdminGate>
          <Queue />
        </AdminGate>
      )}
    </Page>
  );
}

function Queue() {
  const { t, tp, language } = useT();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab = isQueueTab(raw) ? raw : 'submitted';
  const list = useLoad(() => coachingApi.adminListApplications(tab), [tab], { fallback: t('coaching.admin.couldnt_load_applications_retry') });
  const label = QUEUE_TABS.find((t) => t.value === tab)!.label;

  return (
    <>
      <Link to="/coaching/admin/reports" className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 min-h-12 font-medium hover:bg-surface-2">
        <Flag className="size-5 text-accent" aria-hidden />
        <span className="flex-1">{t('coaching.admin.coaching_reports')}</span>
        <ChevronRight className="size-5 text-muted" aria-hidden />
      </Link>
      <ScrollTabs label={t('coaching.admin.application_status')} panelId="admin-queue" tabs={QUEUE_TABS} value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} />
      <div id="admin-queue" role="tabpanel" aria-label={label} className="mt-3">
        {list.loading ? (
          <Spinner label={t('coaching.admin.loading_applications')} />
        ) : list.error ? (
          <ErrorState title={t('coaching.admin.couldnt_load_applications')} message={list.error} onRetry={list.reload} />
        ) : !list.data || list.data.length === 0 ? (
          <EmptyState icon={<Inbox className="size-6" aria-hidden />} title={t('coaching.admin.nothing_here')} body={t('coaching.admin.no_applications_in_x', { tab: label })} />
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {list.data.map((p) => {
                const pendingQ = p.qualifications.filter((q) => q.reviewStatus === 'pending').length;
                return (
                  <li key={p.userId}>
                    <Link to={`/coaching/admin/${encodeURIComponent(p.userId)}`} className="flex items-center gap-3 px-4 py-3 min-h-16 hover:bg-surface-2">
                      <CoachPhoto name={p.displayName || '?'} url={p.photoUrl} size={44} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium truncate">{p.displayName || t('coaching.admin.unnamed_applicant')}</span>
                        <span className="block text-xs text-muted truncate">
                          {[locationText(p), p.submittedAt ? t('coaching.admin.submitted_x_lower', { date: dateText(p.submittedAt, false, language) }) : null].filter(Boolean).join(' · ')}
                        </span>
                        <span className="flex flex-wrap gap-1 mt-1">
                          <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABELS[p.status]}</Badge>
                          {p.suspended && <Badge tone="danger">{t('coaching.admin.suspended')}</Badge>}
                          {pendingQ > 0 && <Badge tone="warn">{tp('coaching.admin.qualifications_to_review', pendingQ)}</Badge>}
                        </span>
                      </span>
                      <ChevronRight className="size-5 text-muted shrink-0" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
