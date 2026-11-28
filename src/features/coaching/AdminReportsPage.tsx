import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft, Flag } from 'lucide-react';
import { coachingReportsApi, type CoachingReport } from '@/backend/coaching';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, Notice, Page, Spinner } from '@/components/ui';
import { dateText } from '@/domain/coaching/display';
import { CoachingAccessNotice, coachingError, useCoachingAccess, useLoad } from './directory/common';
import { AdminGate, ScrollTabs } from './admin/common';
import { useT, type MessageKey } from '@/i18n';

type Tab = CoachingReport['status'];
const TAB_KEYS: { value: Tab; key: MessageKey }[] = [
  { value: 'open', key: 'coaching.admin.status_open' },
  { value: 'actioned', key: 'coaching.admin.actioned' },
  { value: 'dismissed', key: 'coaching.admin.dismissed' },
];
type Action = 'dismiss' | 'actioned' | 'remove_message';
const ACTION_COPY: Record<Action, { label: MessageKey; title: MessageKey; body: MessageKey; danger?: boolean }> = {
  dismiss: { label: 'common.dismiss', title: 'coaching.admin.dismiss_this_report', body: 'coaching.admin.nothing_changes_for_either_person_the' },
  actioned: {
    label: 'coaching.admin.mark_actioned',
    title: 'coaching.admin.mark_as_actioned',
    body: 'coaching.admin.use_this_after_you_have_taken',
  },
  remove_message: {
    label: 'coaching.admin.remove_message',
    title: 'coaching.admin.remove_the_reported_message',
    body: 'coaching.admin.the_message_is_deleted_for_both',
    danger: true,
  },
};

/** Coaching reports (messages and coach profiles) for app admins. Reviewers see only the reported message. */
export default function AdminReportsPage() {
  const nav = useNavigate();
  const { access } = useCoachingAccess();
  const { t } = useT();
  return (
    <Page
      title={t('coaching.admin.coaching_reports')}
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
          <Reports />
        </AdminGate>
      )}
    </Page>
  );
}

function Reports() {
  const { t, language } = useT();
  const tabs = TAB_KEYS.map((x) => ({ value: x.value, label: t(x.key) }));
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = TAB_KEYS.some((x) => x.value === raw) ? (raw as Tab) : 'open';
  const list = useLoad(() => coachingReportsApi.list(tab), [tab], { fallback: t('coaching.admin.couldnt_load_reports_retry') });
  const [pending, setPending] = useState<{ report: CoachingReport; action: Action } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await coachingReportsApi.resolve(pending.report.id, pending.action);
      setPending(null);
      list.reload();
    } catch (e) {
      setError(coachingError(e, t('coaching.admin.couldnt_update_the_report')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ScrollTabs label={t('coaching.admin.report_status')} panelId="admin-reports" tabs={tabs} value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} />
      <div id="admin-reports" role="tabpanel" className="mt-3 flex flex-col gap-3">
        {error && <Notice tone="danger">{error}</Notice>}
        {list.loading && !list.data ? (
          <Spinner label={t('coaching.admin.loading_reports')} />
        ) : list.error ? (
          <ErrorState title={t('coaching.admin.couldnt_load_reports')} message={list.error} onRetry={list.reload} />
        ) : !list.data || list.data.length === 0 ? (
          <EmptyState icon={<Flag className="size-6" aria-hidden />} title={t('coaching.admin.no_reports')} body={t('coaching.admin.nothing_has_been_reported_here')} />
        ) : (
          list.data.map((r) => (
            <Card key={r.id} className="p-4 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={r.status === 'open' ? 'warn' : 'neutral'}>{r.reason}</Badge>
                <span className="text-xs text-muted">{t('coaching.admin.reported_x', { date: dateText(r.createdAt, false, language) })}</span>
              </div>
              {r.messageId ? (
                r.messageBody != null ? (
                  <blockquote className="rounded-xl bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap break-words">{r.messageBody}</blockquote>
                ) : (
                  <p className="text-sm text-muted">{t('coaching.admin.the_reported_message_has_already_been')}</p>
                )
              ) : (
                <p className="text-sm text-muted">{t('coaching.admin.report_about_a_person_or_profile')}</p>
              )}
              {r.details && <p className="text-sm">
                  {t('coaching.admin.reporters_note')} {r.details}
                </p>}
              {r.coachId && (
                <Link to={`/coaching/admin/${encodeURIComponent(r.coachId)}`} className="text-sm font-semibold text-accent min-h-11 inline-flex items-center">
                  {t('coaching.admin.open_the_coachs_application')}
                </Link>
              )}
              {r.status === 'open' && (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setPending({ report: r, action: 'dismiss' })}>{t('common.dismiss')}</Button>
                  <Button onClick={() => setPending({ report: r, action: 'actioned' })}>{t('coaching.admin.mark_actioned')}</Button>
                  {r.messageId && r.messageBody != null && (
                    <Button variant="danger" onClick={() => setPending({ report: r, action: 'remove_message' })}>
                      {t('coaching.admin.remove_message')}
                    </Button>
                  )}
                </div>
              )}
            </Card>
          ))
        )}
      </div>
      <ConfirmDialog
        open={!!pending}
        title={pending ? t(ACTION_COPY[pending.action].title) : ''}
        body={pending ? t(ACTION_COPY[pending.action].body) : undefined}
        confirmLabel={pending ? t(ACTION_COPY[pending.action].label) : t('common.confirm')}
        danger={pending ? ACTION_COPY[pending.action].danger : false}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
