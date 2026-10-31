import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronLeft, Flag, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, Page, Segmented, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { socialApi } from '@/backend/social';
import type { ModerationReport } from '@/backend/contract';
import { friendlyError } from '@/social/pendingPosts';
import { AccessNotice, Time, useSocialAccess } from './common';

type Status = ModerationReport['status'];
const REASON_LABELS: Record<string, string> = { spam: 'Spam', harassment: 'Harassment', inappropriate: 'Inappropriate', other: 'Other' };

function targetLabel(r: ModerationReport) {
  if (r.commentId) return 'Comment';
  if (r.postId) return 'Post';
  if (r.userId) return 'Profile';
  return 'Content';
}

export default function ModerationPage() {
  const nav = useNavigate();
  const { access } = useSocialAccess();
  return (
    <Page
      title="Moderation"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? <AccessNotice access={access} what="Moderation" /> : <ModerationGate />}
    </Page>
  );
}

function ModerationGate() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(async () => {
    setError(null);
    try {
      setAllowed(await socialApi.amModerator());
    } catch (e) {
      setError(friendlyError(e, 'Couldn’t check your access.'));
    }
  }, []);
  useEffect(() => {
    void check();
  }, [check]);
  if (error) return <ErrorState message={error} onRetry={check} />;
  if (allowed === null) return <Spinner />;
  if (!allowed) return <EmptyState icon={<ShieldCheck className="size-6" aria-hidden />} title="Moderators only" body="This area is only available to Hard Earned moderators." />;
  return <ReportQueue />;
}

function ReportQueue() {
  const toast = useToast();
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
      setError(friendlyError(e, 'Couldn’t load reports.'));
    }
  }, [status]);
  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (r: ModerationReport, action: 'dismiss' | 'remove_content') => {
    setBusy(r.id);
    try {
      await socialApi.resolveReport(r.id, action);
      setReports((cur) => cur?.filter((x) => x.id !== r.id) ?? cur);
      setConfirmRemove(null);
      toast.show(action === 'dismiss' ? 'Report dismissed' : 'Content removed', { tone: 'success' });
    } catch (e) {
      toast.show(friendlyError(e, 'Couldn’t resolve the report.'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Segmented
        label="Report status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'open', label: 'Open' },
          { value: 'actioned', label: 'Removed' },
          { value: 'dismissed', label: 'Dismissed' },
        ]}
      />
      {error ? (
        <ErrorState title="Couldn’t load reports" message={error} onRetry={load} />
      ) : !reports ? (
        <Spinner label="Loading reports" />
      ) : reports.length === 0 ? (
        <EmptyState icon={<Flag className="size-6" aria-hidden />} title={status === 'open' ? 'No open reports' : 'Nothing here'} body={status === 'open' ? 'New reports will appear here.' : undefined} />
      ) : (
        <ul className="flex flex-col gap-3 mt-4">
          {reports.map((r) => {
            const preview = r.content?.caption ?? r.content?.body;
            return (
              <li key={r.id}>
                <Card className="p-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge tone="warn">{REASON_LABELS[r.reason] ?? r.reason}</Badge>
                    <Badge>{targetLabel(r)}</Badge>
                    <Time iso={r.createdAt} className="text-xs text-muted ml-auto" />
                  </div>
                  {preview ? (
                    <blockquote className="mt-3 border-l-2 border-line pl-3 text-[15px] whitespace-pre-wrap break-words">{preview}</blockquote>
                  ) : (
                    <p className="mt-3 text-sm text-muted">{r.userId && !r.postId && !r.commentId ? 'A reported profile.' : 'No text preview (content may be photos only, or already removed).'}</p>
                  )}
                  {r.details && (
                    <p className="mt-2 text-sm">
                      <span className="text-muted">Reporter’s note: </span>
                      {r.details}
                    </p>
                  )}
                  {r.postId && (
                    <Link to={`/feed/post/${r.postId}`} className="inline-flex items-center min-h-11 text-sm text-accent font-medium">
                      Open post
                    </Link>
                  )}
                  {r.status === 'open' && (
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" loading={busy === r.id} onClick={() => void resolve(r, 'dismiss')}>
                        Dismiss
                      </Button>
                      <Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => setConfirmRemove(r)}>
                        Remove content
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
        title="Remove this content?"
        body="The reported content is removed for everyone. This can’t be undone."
        confirmLabel="Remove"
        danger
        busy={!!confirmRemove && busy === confirmRemove.id}
        onConfirm={() => confirmRemove && void resolve(confirmRemove, 'remove_content')}
        onCancel={() => setConfirmRemove(null)}
      />
    </>
  );
}
