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
import { useT, type MessageKey } from '@/i18n';

export default function AdminApplicationPage() {
  const nav = useNavigate();
  const { coachId } = useParams();
  const { access } = useCoachingAccess();
  const { t } = useT();
  return (
    <Page
      title={t('coaching.admin.application')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? (
        <CoachingAccessNotice access={access} />
      ) : (
        <AdminGate>{coachId ? <Application coachId={coachId} /> : <EmptyState title={t('coaching.admin.application_not_found')} />}</AdminGate>
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
  const { t } = useT();
  const app = useLoad(() => coachingApi.adminGetApplication(coachId), [coachId], { fallback: t('coaching.admin.couldnt_load_this_application_retry') });
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (app.loading && app.data === undefined) return <Spinner label={t('coaching.admin.loading_application')} />;
  if (app.error) return <ErrorState title={t('coaching.admin.couldnt_load_this_application')} message={app.error} onRetry={app.reload} />;
  if (!app.data) return <EmptyState title={t('coaching.admin.application_not_found')} body={t('coaching.admin.it_may_have_been_deleted')} />;
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
      setActionError(coachingError(e, t('coaching.admin.action_failed_refresh')));
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
      {p.status === 'changes_requested' && <p className="text-xs text-muted mt-2 px-1">{t('coaching.admin.waiting_for_the_applicant_to_update')}</p>}
      {p.status === 'draft' && <p className="text-xs text-muted mt-2 px-1">{t('coaching.admin.not_submitted_yet_nothing_to_review')}</p>}
      {p.status === 'rejected' && !p.suspended && <p className="text-xs text-muted mt-2 px-1">{t('coaching.admin.the_applicant_can_edit_and_resubmit')}</p>}
      {p.latestFeedback && (
        <Notice className="mt-3">
          <span className="font-medium">{t('coaching.admin.latest_feedback_to_applicant')} </span>
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
              label={copy.reasonLabel ?? (reasonRequired(pending.action) ? t('coaching.editor.reason') : t('coaching.admin.note_optional'))}
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
  const { t, language } = useT();
  return (
    <div className="flex items-start gap-4 pt-2">
      <CoachPhoto name={p.displayName || '?'} url={p.photoUrl} size={80} />
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        <h2 className="text-xl font-bold break-words">{p.displayName || t('coaching.admin.unnamed_applicant')}</h2>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABELS[p.status]}</Badge>
          {p.suspended && <Badge tone="danger">{t('coaching.admin.suspended')}</Badge>}
          <Badge>{p.listed ? t('coaching.admin.listing_on') : t('coaching.admin.listing_off')}</Badge>
          <Badge>{p.acceptingClients ? t('coaching.admin.accepting_clients') : t('coaching.admin.not_accepting')}</Badge>
        </div>
        <p className="text-xs text-muted">
          {[
            p.submittedAt ? t('coaching.admin.submitted_x', { date: dateText(p.submittedAt, true, language) }) : null,
            p.reviewedAt ? t('coaching.admin.last_reviewed_x', { date: dateText(p.reviewedAt, true, language) }) : null,
          ]
            .filter(Boolean)
            .join(' · ') || t('coaching.admin.not_submitted')}
        </p>
        {p.suspended && p.suspendedReason && <p className="text-sm text-danger">{t('coaching.admin.suspended_2')} {p.suspendedReason}</p>}
      </div>
    </div>
  );
}

function ProfileDetails({ p }: { p: CoachProfile }) {
  const { t, tp, language } = useT();
  const none = <span className="text-faint">{t('coaching.admin.none')}</span>;
  const notProvided = <span className="text-faint">{t('coaching.admin.not_provided')}</span>;
  return (
    <>
      <SectionTitle>{t('nav.profile')}</SectionTitle>
      <Card className="px-4 py-2">
        <dl className="divide-y divide-line">
          <FactRow label={t('coaching.admin.bio')}>{p.bio ? <span className="whitespace-pre-line break-words">{p.bio}</span> : notProvided}</FactRow>
          <FactRow label={t('onboarding.experience.group')}>
            {p.experienceYears != null && <span className="block font-medium">{tp('coaching.admin.years_count', p.experienceYears)}</span>}
            {p.experience ? <span className="whitespace-pre-line break-words">{p.experience}</span> : p.experienceYears == null && notProvided}
          </FactRow>
          <FactRow label={t('coaching.directory.specialties')}>{p.specialties.length ? <TagList label={t('coaching.directory.specialties')} items={p.specialties.map(specialtyLabel)} /> : none}</FactRow>
          <FactRow label={t('progress.goals')}>{p.goals.length ? <TagList label={t('progress.goals')} items={p.goals.map(coachGoalLabel)} /> : none}</FactRow>
          <FactRow label={t('coaching.directory.languages')}>{p.languages.length ? p.languages.map((l) => languageName(l, language)).join(', ') : none}</FactRow>
          <FactRow label={t('coaching.admin.business_location')}>{locationText(p) || notProvided}</FactRow>
          <FactRow label={t('coaching.admin.formats')}>{formatsText(p.formats, language)}</FactRow>
          <FactRow label={t('coaching.admin.service_areas')}>
            {p.serviceAreas.length ? (
              <ul className="flex flex-col gap-0.5">
                {p.serviceAreas.map((a) => (
                  <li key={a.id}>
                    {areaWithRadius(a)}
                    {a.lat != null && a.lng != null && <span className="text-xs text-muted"> · {t('coaching.admin.map_position_from_x', { source: a.label || t('coaching.admin.geocoder') })}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              none
            )}
          </FactRow>
        </dl>
      </Card>
    </>
  );
}

const Q_TONE = { pending: 'warn', approved: 'accent', rejected: 'danger' } as const;
const Q_LABEL = { pending: 'coaching.admin.pending_review', approved: 'coaching.directory.reviewed', rejected: 'coaching.admin.rejected' } as const satisfies Record<Qualification['reviewStatus'], MessageKey>;

function Qualifications({ p, onAction }: { p: CoachProfile; onAction: (a: ReviewAction, q: Qualification) => void }) {
  const { t } = useT();
  return (
    <>
      <SectionTitle>{t('coaching.admin.qualifications')}</SectionTitle>
      {p.qualifications.length === 0 ? (
        <p className="text-sm text-muted px-1">{t('coaching.admin.no_qualifications_listed')}</p>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {p.qualifications.map((q) => (
              <li key={q.id} className="px-4 py-3 flex flex-col gap-2">
                <div className="flex items-start gap-3">
                  <Award className="size-5 text-muted shrink-0 mt-0.5" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">{q.title}</p>
                    <p className="text-xs text-muted">{[q.issuer, q.year].filter(Boolean).join(' · ') || t('coaching.admin.no_issuer_or_year_given')}</p>
                    {q.reviewNote && <p className="text-xs text-muted mt-0.5">{t('coaching.admin.note')} {q.reviewNote}</p>}
                  </div>
                  <Badge tone={Q_TONE[q.reviewStatus]}>{t(Q_LABEL[q.reviewStatus])}</Badge>
                </div>
                {q.documentPath ? <DocumentLink path={q.documentPath} name={q.documentName} /> : <p className="text-xs text-faint pl-8">{t('coaching.admin.no_document_attached')}</p>}
                {q.reviewStatus === 'pending' && (
                  <div className="flex gap-2 pl-8">
                    <Button size="sm" variant="primary" onClick={() => onAction('approve_qualification', q)}>
                      {t('coaching.admin.mark_reviewed')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => onAction('reject_qualification', q)}>
                      {t('coaching.admin.reject')}
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
  const { t } = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const get = async () => {
    setBusy(true);
    setError(null);
    try {
      setUrl(await coachingApi.documentUrl(path));
    } catch (e) {
      setError(coachingError(e, t('coaching.directory.couldnt_open_the_document')));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pl-8 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <FileText className="size-4 text-muted shrink-0" aria-hidden />
        <span className="text-sm truncate flex-1 min-w-0">{name || t('coaching.directory.document')}</span>
        {!url && (
          <Button size="sm" variant="outline" loading={busy} onClick={() => void get()}>
            {t('coaching.admin.get_secure_link')}
          </Button>
        )}
      </div>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-accent font-medium min-h-11">
          <ExternalLink className="size-4" aria-hidden />
          {t('coaching.admin.open_document_link_expires_shortly')}
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
  const { t, language } = useT();
  const statusText = (s: string) => (s in STATUS_LABELS ? STATUS_LABELS[s as keyof typeof STATUS_LABELS] : s.replace(/_/g, ' '));
  const sorted = [...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return (
    <>
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <History className="size-4" aria-hidden /> {t('coaching.apply.review_history')}
        </span>
      </SectionTitle>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted px-1">{t('coaching.admin.no_review_events_yet')}</p>
      ) : (
        <Card className="overflow-hidden">
          <ol className="divide-y divide-line">
            {sorted.map((e) => (
              <li key={e.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{EVENT_LABELS[e.action] ?? e.action}</span>
                  <time dateTime={e.createdAt} className="text-xs text-muted">
                    {dateText(e.createdAt, true, language)}
                  </time>
                </div>
                <p className="text-xs text-muted mt-0.5">
                  {t('coaching.admin.by_x', { name: e.actorName || (e.actorId === e.coachId ? t('coaching.admin.the_applicant') : t('coaching.admin.an_admin')) })}
                  {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus ? ` · ${statusText(e.fromStatus)} → ${statusText(e.toStatus)}` : ''}
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
