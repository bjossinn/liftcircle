import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronLeft, Flag, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, Page, Segmented, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { socialApi } from '@/backend/social';
import type { ModerationReport } from '@/backend/contract';
import { friendlyError } from '@/social/pendingPosts';
import { AccessNotice, Time, useSocialAccess } from './common';
import { useT, type MessageKey } from '@/i18n';

type Status = ModerationReport['status'];
const REASON_LABELS: Record<string, MessageKey> = {
  spam: 'social.spam',
  harassment: 'social.reason.harassment',
  inappropriate: 'social.reason.inappropriate',
  other: 'social.reason.other',
};

function targetLabel(r: ModerationReport): MessageKey {
  if (r.commentId) return 'social.comment_2';
  if (r.postId) return 'social.post';
  if (r.userId) return 'nav.profile';
  return 'social.content';
}

export default function ModerationPage() {
  const nav = useNavigate();
  const { t } = useT();
  const { access } = useSocialAccess();
  return (
    <Page
      title={t('social.moderation')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? <AccessNotice access={access} what="moderation" /> : <ModerationGate />}
    </Page>
  );
}

function ModerationGate() {
  const { t } = useT();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(async () => {
    setError(null);
    try {
      setAllowed(await socialApi.amModerator());
    } catch (e) {
      setError(friendlyError(e, t('social.error.check_access')));
    }
  }, [t]);
  useEffect(() => {
    void check();
  }, [check]);
  if (error) return <ErrorState message={error} onRetry={check} />;
  if (allowed === null) return <Spinner />;
  if (!allowed) return <EmptyState icon={<ShieldCheck className="size-6" aria-hidden />} title={t('social.moderators_only')} body={t('social.this_area_is_only_available_to')} />;
  return <ReportQueue />;
}

function ReportQueue() {
  const toast = useToast();
  const { t } = useT();
  const [status, setStatus] = useState<Status>('open');
  const [reports, setReports] = useState<ModerationReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ModerationReport | null>(null);

  const load = useCallback(async () => {
    setReports(null);
    setError(null);
    try {
      setReports(await socialApi.listReports(status));
    } catch (e) {
      setError(friendlyError(e, t('coaching.admin.couldnt_load_reports')));
    }
  }, [status, t]);
  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (r: ModerationReport, action: 'dismiss' | 'remove_content') => {
    setBusy(r.id);
    try {
      await socialApi.resolveReport(r.id, action);
      setReports((cur) => cur?.filter((x) => x.id !== r.id) ?? cur);
      setConfirmRemove(null);
      toast.show(action === 'dismiss' ? t('social.report_dismissed') : t('social.content_removed'), { tone: 'success' });
    } catch (e) {
      toast.show(friendlyError(e, t('social.error.resolve_report')), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Segmented
        label={t('coaching.admin.report_status')}
        value={status}
        onChange={setStatus}
        options={[
          { value: 'open', label: t('social.status.open') },
          { value: 'actioned', label: t('social.removed') },
          { value: 'dismissed', label: t('coaching.admin.dismissed') },
        ]}
      />
      {error ? (
        <ErrorState title={t('coaching.admin.couldnt_load_reports')} message={error} onRetry={load} />
      ) : !reports ? (
        <Spinner label={t('coaching.admin.loading_reports')} />
      ) : reports.length === 0 ? (
        <EmptyState
          icon={<Flag className="size-6" aria-hidden />}
          title={status === 'open' ? t('social.no_open_reports') : t('coaching.admin.nothing_here')}
          body={status === 'open' ? t('social.new_reports_will_appear_here') : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-3 mt-4">
          {reports.map((r) => {
            const preview = r.content?.caption ?? r.content?.body;
            return (
              <li key={r.id}>
                <Card className="p-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge tone="warn">{REASON_LABELS[r.reason] ? t(REASON_LABELS[r.reason]) : r.reason}</Badge>
                    <Badge>{t(targetLabel(r))}</Badge>
                    <Time iso={r.createdAt} className="text-xs text-muted ml-auto" />
                  </div>
                  {preview ? (
                    <blockquote className="mt-3 border-l-2 border-line pl-3 text-[15px] whitespace-pre-wrap break-words">{preview}</blockquote>
                  ) : (
                    <p className="mt-3 text-sm text-muted">{r.userId && !r.postId && !r.commentId ? t('social.a_reported_profile') : t('social.no_text_preview_content_may_be')}</p>
                  )}
                  {r.details && (
                    <p className="mt-2 text-sm">
                      <span className="text-muted">{t('coaching.admin.reporters_note')} </span>
                      {r.details}
                    </p>
                  )}
                  {r.postId && (
                    <Link to={`/feed/post/${r.postId}`} className="inline-flex items-center min-h-11 text-sm text-accent font-medium">
                      {t('social.open_post_2')}
                    </Link>
                  )}
                  {r.status === 'open' && (
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" loading={busy === r.id} onClick={() => void resolve(r, 'dismiss')}>
                        {t('common.dismiss')}
                      </Button>
                      <Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => setConfirmRemove(r)}>
                        {t('social.remove_content')}
                      </Button>
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={!!confirmRemove}
        title={t('social.remove_this_content')}
        body={t('social.the_reported_content_is_removed_for')}
        confirmLabel={t('common.remove')}
        danger
        busy={!!confirmRemove && busy === confirmRemove.id}
        onConfirm={() => confirmRemove && void resolve(confirmRemove, 'remove_content')}
        onCancel={() => setConfirmRemove(null)}
      />
    </>
  );
}
