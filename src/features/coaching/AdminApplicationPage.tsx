import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Award, ChevronLeft, ExternalLink, FileText, History } from 'lucide-react';
import { coachingApi } from '@/backend/coaching';
import type { CoachProfile, Qualification, ReviewAction, ReviewEvent } from '@/backend/coachingContract';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, Notice, Page, SectionTitle, Spinner, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { ACTION_COPY, REASON_MAX, availableActions, reasonProblem, reasonRequired } from '@/domain/coaching/admin';
import { EVENT_LABELS, STATUS_LABELS, STATUS_TONE, areaWithRadius, dateText, formatsText, locationText } from '@/domain/coaching/display';
import { coachGoalLabel, languageName, specialtyLabel } from '@/domain/coaching/options';
import { CoachPhoto, CoachingAccessNotice, FactRow, TagList, coachingError, useCoachingAccess, useLoad } from './directory/common';
import { AdminGate } from './admin/common';

export default function AdminApplicationPage() {
  const nav = useNavigate();
  const { coachId } = useParams();
  const { access } = useCoachingAccess();
  return (
    <Page
      title="Application"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? (
        <CoachingAccessNotice access={access} />
      ) : (
        <AdminGate>{coachId ? <Application coachId={coachId} /> : <EmptyState title="Application not found" />}</AdminGate>
      )}
    </Page>
  );
}

interface Pending {
  action: ReviewAction;
  qualification?: Qualification;
}

function Application({ coachId }: { coachId: string }) {
  const toast = useToast();
  const app = useLoad(() => coachingApi.adminGetApplication(coachId), [coachId], { fallback: 'Couldn’t load this application.' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (app.loading && app.data === undefined) return <Spinner label="Loading application" />;
  if (app.error) return <ErrorState title="Couldn’t load this application" message={app.error} onRetry={app.reload} />;
  if (!app.data) return <EmptyState title="Application not found" body="It may have been deleted." />;
  const { profile: p, events } = app.data;
  const actions = availableActions(p);

  const open = (action: ReviewAction, qualification?: Qualification) => {
    setPending({ action, qualification });
    setReason('');
    setReasonTouched(false);
    setActionError(null);
  };
  const close = () => {
    if (!busy) setPending(null);
  };
  const confirm = async () => {
    if (!pending) return;
    setReasonTouched(true);
    if (reasonProblem(pending.action, reason)) return;
    setBusy(true);
    setActionError(null);
    try {
      await coachingApi.adminReview(coachId, pending.action, reason.trim() || undefined, pending.qualification?.id);
      toast.show(`${EVENT_LABELS[pending.action]}${pending.qualification ? `: ${pending.qualification.title}` : ''}`, { tone: 'success' });
      setPending(null);
      app.reload();
    } catch (e) {
      // The server checks the current status; a stale view gets a readable error and a refresh.
      setActionError(coachingError(e, 'That action couldn’t be completed. The application may have changed — refresh and try again.'));
    } finally {
      setBusy(false);
    }
  };

  const copy = pending ? ACTION_COPY[pending.action] : null;
  const rProblem = pending && reasonTouched ? reasonProblem(pending.action, reason) : null;

  return (
    <>
      <Header p={p} />

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-4">
          {actions.map((a) => (
            <Button key={a} variant={a === 'approve' || a === 'reinstate' ? 'primary' : ACTION_COPY[a].danger ? 'danger' : 'secondary'} onClick={() => open(a)} className="flex-1 min-w-32">
              {ACTION_COPY[a].label}
            </Button>
          ))}
        </div>
      )}
      {p.status === 'changes_requested' && <p className="text-xs text-muted mt-2 px-1">Waiting for the applicant to update and resubmit.</p>}
      {p.status === 'draft' && <p className="text-xs text-muted mt-2 px-1">Not submitted yet — nothing to review.</p>}
      {p.status === 'rejected' && !p.suspended && <p className="text-xs text-muted mt-2 px-1">The applicant can edit and resubmit.</p>}
      {p.latestFeedback && (
        <Notice className="mt-3">
          <span className="font-medium">Latest feedback to applicant: </span>
          <span className="whitespace-pre-line">{p.latestFeedback}</span>
        </Notice>
      )}

      <ProfileDetails p={p} />
      <Qualifications p={p} onAction={open} />
      <Events events={events} />

      <ConfirmDialog
        open={!!pending && !!copy}
        title={copy?.title ?? ''}
        body={copy?.body}
        confirmLabel={copy?.confirm}
        danger={copy?.danger}
        busy={busy}
        onCancel={close}
        onConfirm={() => void confirm()}
      >
        {pending && copy && (
          <div className="mt-4 flex flex-col gap-2">
            {pending.qualification && <p className="text-sm font-medium">{pending.qualification.title}</p>}
            <Textarea
              label={copy.reasonLabel ?? (reasonRequired(pending.action) ? 'Reason' : 'Note (optional)')}
              value={reason}
              maxLength={REASON_MAX}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setReasonTouched(true)}
              error={rProblem}
              required={reasonRequired(pending.action)}
            />
            {actionError && (
              <p role="alert" className="text-sm text-danger">
                {actionError}
              </p>
            )}
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}

function Header({ p }: { p: CoachProfile }) {
  return (
    <div className="flex items-start gap-4 pt-2">
      <CoachPhoto name={p.displayName || '?'} url={p.photoUrl} size={80} />
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        <h2 className="text-xl font-bold break-words">{p.displayName || 'Unnamed applicant'}</h2>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABELS[p.status]}</Badge>
          {p.suspended && <Badge tone="danger">Suspended</Badge>}
          <Badge>{p.listed ? 'Listing on' : 'Listing off'}</Badge>
          <Badge>{p.acceptingClients ? 'Accepting clients' : 'Not accepting'}</Badge>
        </div>
        <p className="text-xs text-muted">
          {[p.submittedAt ? `Submitted ${dateText(p.submittedAt, true)}` : null, p.reviewedAt ? `last reviewed ${dateText(p.reviewedAt, true)}` : null].filter(Boolean).join(' · ') || 'Not submitted'}
        </p>
        {p.suspended && p.suspendedReason && <p className="text-sm text-danger">Suspended: {p.suspendedReason}</p>}
      </div>
    </div>
  );
}

function ProfileDetails({ p }: { p: CoachProfile }) {
  return (
    <>
      <SectionTitle>Profile</SectionTitle>
      <Card className="px-4 py-2">
        <dl className="divide-y divide-line">
          <FactRow label="Bio">{p.bio ? <span className="whitespace-pre-line break-words">{p.bio}</span> : <span className="text-faint">Not provided</span>}</FactRow>
          <FactRow label="Experience">
            {p.experienceYears != null && <span className="block font-medium">{p.experienceYears} years</span>}
            {p.experience ? <span className="whitespace-pre-line break-words">{p.experience}</span> : p.experienceYears == null && <span className="text-faint">Not provided</span>}
          </FactRow>
          <FactRow label="Specialties">{p.specialties.length ? <TagList label="Specialties" items={p.specialties.map(specialtyLabel)} /> : <span className="text-faint">None</span>}</FactRow>
          <FactRow label="Goals">{p.goals.length ? <TagList label="Goals" items={p.goals.map(coachGoalLabel)} /> : <span className="text-faint">None</span>}</FactRow>
          <FactRow label="Languages">{p.languages.length ? p.languages.map(languageName).join(', ') : <span className="text-faint">None</span>}</FactRow>
          <FactRow label="Business location">{locationText(p) || <span className="text-faint">Not provided</span>}</FactRow>
          <FactRow label="Formats">{formatsText(p.formats)}</FactRow>
          <FactRow label="Service areas">
            {p.serviceAreas.length ? (
              <ul className="flex flex-col gap-0.5">
                {p.serviceAreas.map((a) => (
                  <li key={a.id}>
                    {areaWithRadius(a)}
                    {a.lat != null && a.lng != null && <span className="text-xs text-muted"> · map position from {a.label || 'geocoder'}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-faint">None</span>
            )}
          </FactRow>
        </dl>
      </Card>
    </>
  );
}

const Q_TONE = { pending: 'warn', approved: 'accent', rejected: 'danger' } as const;
const Q_LABEL = { pending: 'Pending review', approved: 'Reviewed', rejected: 'Rejected' } as const;

function Qualifications({ p, onAction }: { p: CoachProfile; onAction: (a: ReviewAction, q: Qualification) => void }) {
  return (
    <>
      <SectionTitle>Qualifications</SectionTitle>
      {p.qualifications.length === 0 ? (
        <p className="text-sm text-muted px-1">No qualifications listed.</p>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {p.qualifications.map((q) => (
              <li key={q.id} className="px-4 py-3 flex flex-col gap-2">
                <div className="flex items-start gap-3">
                  <Award className="size-5 text-muted shrink-0 mt-0.5" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">{q.title}</p>
                    <p className="text-xs text-muted">{[q.issuer, q.year].filter(Boolean).join(' · ') || 'No issuer or year given'}</p>
                    {q.reviewNote && <p className="text-xs text-muted mt-0.5">Note: {q.reviewNote}</p>}
                  </div>
                  <Badge tone={Q_TONE[q.reviewStatus]}>{Q_LABEL[q.reviewStatus]}</Badge>
                </div>
                {q.documentPath ? <DocumentLink path={q.documentPath} name={q.documentName} /> : <p className="text-xs text-faint pl-8">No document attached</p>}
                {q.reviewStatus === 'pending' && (
                  <div className="flex gap-2 pl-8">
                    <Button size="sm" variant="primary" onClick={() => onAction('approve_qualification', q)}>
                      Mark reviewed
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => onAction('reject_qualification', q)}>
                      Reject
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/** Fetches a short-lived signed URL on demand; never cached or prefetched. */
function DocumentLink({ path, name }: { path: string; name?: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const get = async () => {
    setBusy(true);
    setError(null);
    try {
      setUrl(await coachingApi.documentUrl(path));
    } catch (e) {
      setError(coachingError(e, 'Couldn’t open the document.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pl-8 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <FileText className="size-4 text-muted shrink-0" aria-hidden />
        <span className="text-sm truncate flex-1 min-w-0">{name || 'Document'}</span>
        {!url && (
          <Button size="sm" variant="outline" loading={busy} onClick={() => void get()}>
            Get secure link
          </Button>
        )}
      </div>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-accent font-medium min-h-11">
          <ExternalLink className="size-4" aria-hidden />
          Open document (link expires shortly)
        </a>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function Events({ events }: { events: ReviewEvent[] }) {
  const sorted = [...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return (
    <>
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <History className="size-4" aria-hidden /> Review history
        </span>
      </SectionTitle>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted px-1">No review events yet.</p>
      ) : (
        <Card className="overflow-hidden">
          <ol className="divide-y divide-line">
            {sorted.map((e) => (
              <li key={e.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{EVENT_LABELS[e.action] ?? e.action}</span>
                  <time dateTime={e.createdAt} className="text-xs text-muted">
                    {dateText(e.createdAt, true)}
                  </time>
                </div>
                <p className="text-xs text-muted mt-0.5">
                  by {e.actorName || (e.actorId === e.coachId ? 'the applicant' : 'an admin')}
                  {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus ? ` · ${e.fromStatus.replace(/_/g, ' ')} → ${e.toStatus.replace(/_/g, ' ')}` : ''}
                </p>
                {e.reason && <p className="text-sm mt-1 whitespace-pre-line break-words">{e.reason}</p>}
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}
