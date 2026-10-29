import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft, Flag } from 'lucide-react';
import { coachingReportsApi, type CoachingReport } from '@/backend/coaching';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, Notice, Page, Spinner } from '@/components/ui';
import { dateText } from '@/domain/coaching/display';
import { CoachingAccessNotice, coachingError, useCoachingAccess, useLoad } from './directory/common';
import { AdminGate, ScrollTabs } from './admin/common';

type Tab = CoachingReport['status'];
const TABS: { value: Tab; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'actioned', label: 'Actioned' },
  { value: 'dismissed', label: 'Dismissed' },
];
type Action = 'dismiss' | 'actioned' | 'remove_message';
const ACTION_COPY: Record<Action, { label: string; title: string; body: string; danger?: boolean }> = {
  dismiss: { label: 'Dismiss', title: 'Dismiss this report?', body: 'Nothing changes for either person. The report moves to “Dismissed”.' },
  actioned: {
    label: 'Mark actioned',
    title: 'Mark as actioned?',
    body: 'Use this after you have taken action elsewhere, for example suspending the coach from their application page.',
  },
  remove_message: {
    label: 'Remove message',
    title: 'Remove the reported message?',
    body: 'The message is deleted for both people in the conversation. Other reports of the same message are closed too. This can’t be undone.',
    danger: true,
  },
};

/** Coaching reports (messages and coach profiles) for app admins. Reviewers see only the reported message. */
export default function AdminReportsPage() {
  const nav = useNavigate();
  const { access } = useCoachingAccess();
  return (
    <Page
      title="Coaching reports"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
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
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : 'open';
  const list = useLoad(() => coachingReportsApi.list(tab), [tab], { fallback: 'Couldn’t load reports.' });
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
      setError(coachingError(e, 'Couldn’t update the report.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ScrollTabs label="Report status" panelId="admin-reports" tabs={TABS} value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} />
      <div id="admin-reports" role="tabpanel" className="mt-3 flex flex-col gap-3">
        {error && <Notice tone="danger">{error}</Notice>}
        {list.loading && !list.data ? (
          <Spinner label="Loading reports" />
        ) : list.error ? (
          <ErrorState title="Couldn’t load reports" message={list.error} onRetry={list.reload} />
        ) : !list.data || list.data.length === 0 ? (
          <EmptyState icon={<Flag className="size-6" aria-hidden />} title="No reports" body="Nothing has been reported here." />
        ) : (
          list.data.map((r) => (
            <Card key={r.id} className="p-4 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={r.status === 'open' ? 'warn' : 'neutral'}>{r.reason}</Badge>
                <span className="text-xs text-muted">Reported {dateText(r.createdAt)}</span>
              </div>
              {r.messageId ? (
                r.messageBody != null ? (
                  <blockquote className="rounded-xl bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap break-words">{r.messageBody}</blockquote>
                ) : (
                  <p className="text-sm text-muted">The reported message has already been removed.</p>
                )
              ) : (
                <p className="text-sm text-muted">Report about a person or profile, not a single message.</p>
              )}
              {r.details && <p className="text-sm">Reporter’s note: {r.details}</p>}
              {r.coachId && (
                <Link to={`/coaching/admin/${encodeURIComponent(r.coachId)}`} className="text-sm font-semibold text-accent min-h-11 inline-flex items-center">
                  Open the coach’s application
                </Link>
              )}
              {r.status === 'open' && (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setPending({ report: r, action: 'dismiss' })}>Dismiss</Button>
                  <Button onClick={() => setPending({ report: r, action: 'actioned' })}>Mark actioned</Button>
                  {r.messageId && r.messageBody != null && (
                    <Button variant="danger" onClick={() => setPending({ report: r, action: 'remove_message' })}>
                      Remove message
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
        title={pending ? ACTION_COPY[pending.action].title : ''}
        body={pending ? ACTION_COPY[pending.action].body : undefined}
        confirmLabel={pending ? ACTION_COPY[pending.action].label : 'Confirm'}
        danger={pending ? ACTION_COPY[pending.action].danger : false}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
