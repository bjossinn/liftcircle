/**
 * /coaching/proposal/:id — the client previews a program proposal (coach or AI) and accepts or declines.
 * Accepting applies it locally with the shared applyProposal rules (new version / single active plan /
 * stale protection), persists via saveRecord (→ Train, Today, logger, sync), then tells the server.
 * Completed workouts are separate records and never change.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Bot, Check, MessageCircle, RefreshCw, UserRound, X } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Notice, Page, SectionTitle, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { useExercises } from '@/data/catalog';
import { coachingApi } from '@/backend/coaching';
import type { ProgramProposal } from '@/backend/coachingContract';
import { alive } from '@/db/repo';
import { describeChanges } from '@/domain/program/proposals';
import { formatDate, todayISO } from '@/lib/dates';
import { coachingError } from '@/coaching/errors';
import { acceptProposalLocally, findAppliedProgram, setPendingNotify, type AcceptLocalResult } from '@/coaching/acceptProposal';
import { BackButton, CoachingAccessNotice, ProposalStatusBadge, fmtDateTime, useCoachingAccess, useLoad } from './tools/common';
import { ProgramPreview } from './tools/ProgramPreview';
import { exerciseDisplayName } from '@/data/catalogText';
import { programDisplayName } from '@/domain/program/localize';
import { t as tNow, useT } from '@/i18n';

export default function ProposalPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { t } = useT();
  const { db, account } = useApp();
  const { access, meId } = useCoachingAccess();
  const ok = access === 'ok';
  const { list: catalog, byId } = useExercises();
  const unit = account.settings.units.weight;
  const today = todayISO(account.settings.timeZone);

  const proposal = useLoad(() => coachingApi.getProposal(id), [id], ok, tNow('coaching.proposal.couldnt_load_this_proposal'));
  const rels = useLoad(() => coachingApi.myRelationships(), [], ok);
  const programs = useLiveQuery(() => db.programs.toArray(), [db]);
  const notifyRow = useLiveQuery(() => db.kv.get(`coach-proposal-notify:${id}`), [db, id]);
  const pendingNotify = (notifyRow?.value as { programId: string; version: number } | undefined) ?? null;

  const [busy, setBusy] = useState<'accept' | 'decline' | 'notify' | null>(null);
  const [applyError, setApplyError] = useState<Extract<AcceptLocalResult, { ok: false }> | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);

  const p = proposal.data;
  const rel = p?.relationshipId ? rels.data?.find((r) => r.id === p.relationshipId) : undefined;
  const coachName = rel?.coach.displayName || t('coaching.proposal.your_coach');
  const live = useMemo(() => alive(programs ?? []), [programs]);
  const applied = p ? findAppliedProgram(live, p.id) : undefined;
  const base = p?.baseProgramId ? live.find((x) => x.id === p.baseProgramId) : undefined;
  const baseVersion = base && p?.baseVersion != null ? base.versions.find((v) => v.version === p.baseVersion) : undefined;
  const stale = !!base && p?.baseVersion != null && base.currentVersion !== p.baseVersion && !applied;
  const nameOf = (x: string) => exerciseDisplayName(x, byId);
  const changes = useMemo(() => (p ? describeChanges(baseVersion ?? null, p.program, nameOf) : []), [p, baseVersion, byId]); // eslint-disable-line react-hooks/exhaustive-deps

  const askRevision = () => {
    if (!p?.relationshipId) return;
    // A message the client sends to their coach: prefilled in the client's UI language (they can edit it before sending).
    const draft = t('coaching.proposal.revision_request_draft', { name: p.program.name, revision: p.revision });
    nav(`/coaching/messages/${p.relationshipId}?draft=${encodeURIComponent(draft)}`);
  };

  const notify = async (prop: ProgramProposal, appliedTo: { programId: string; version: number }) => {
    setBusy('notify');
    try {
      await coachingApi.respondProposal(prop.id, true, appliedTo);
      await setPendingNotify(db, prop.id, null);
      await proposal.reload();
      toast.show(prop.authorKind === 'coach' ? t('coaching.proposal.x_has_been_told_you_accepted', { name: coachName }) : t('coaching.proposal.saved'), { tone: 'success' });
    } catch (e) {
      toast.show(t('coaching.proposal.your_plan_is_updated_on_this_2', { error: coachingError(e) }), { tone: 'warn', duration: 7000 });
    } finally {
      setBusy(null);
    }
  };

  const accept = async () => {
    if (!p) return;
    setBusy('accept');
    setApplyError(null);
    try {
      const r = await acceptProposalLocally(db, p, { today, catalog: byId, coachName: p.authorKind === 'coach' ? rel?.coach.displayName : undefined });
      if (!r.ok) {
        setApplyError(r);
        setBusy(null);
        return;
      }
      const appliedTo = { programId: r.program.id, version: r.program.currentVersion };
      await setPendingNotify(db, p.id, appliedTo);
      if (!r.alreadyApplied) toast.show(r.createdNew ? t('coaching.proposal.new_plan_is_now_active_in') : t('coaching.proposal.your_plan_was_updated_the_change'), { tone: 'success' });
      await notify(p, appliedTo);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : t('coaching.proposal.couldnt_save_the_plan_on_this'), { tone: 'error' });
      setBusy(null);
    }
  };

  const decline = async () => {
    if (!p) return;
    setBusy('decline');
    try {
      await coachingApi.respondProposal(p.id, false);
      setDeclineOpen(false);
      await proposal.reload();
      toast.show(t('coaching.proposal.proposal_declined_your_current_plan_didnt'), { tone: 'success' });
    } catch (e) {
      toast.show(coachingError(e, t('coaching.proposal.couldnt_decline')), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  let body;
  if (!ok) body = <CoachingAccessNotice access={access} what={t('coaching.proposal.what_program_proposals')} />;
  else if (proposal.error && !p) body = <ErrorState title={t('coaching.proposal.couldnt_load_this_proposal')} message={proposal.error} onRetry={proposal.reload} />;
  else if (p === undefined || programs === undefined) body = <Spinner label={t('coaching.proposal.loading_proposal')} />;
  else if (p === null) body = <EmptyState title={t('coaching.proposal.this_proposal_isnt_available')} body={t('coaching.proposal.it_may_have_been_withdrawn_or')} action={<Button onClick={() => nav('/coaching/my')}>{t('coaching.hub.my_coach')}</Button>} />;
  else if (meId && p.clientId !== meId)
    body = (
      <EmptyState
        title={t('coaching.proposal.this_proposal_is_for_your_client')}
        body={t('coaching.proposal.only_the_client_can_accept_or')}
        action={p.relationshipId ? <Button onClick={() => nav(`/coaching/client/${p.relationshipId}/program`)}>{t('coaching.proposal.open_client_program')}</Button> : undefined}
      />
    );
  else {
    const isNew = !p.baseProgramId;
    body = (
      <>
        <Card className="px-4 py-4">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-surface-2 flex items-center justify-center text-accent shrink-0">{p.authorKind === 'ai' ? <Bot className="size-5" aria-hidden /> : <UserRound className="size-5" aria-hidden />}</div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold leading-tight">{programDisplayName(p.program.name)}</h2>
              <p className="text-sm text-muted mt-0.5">{p.authorKind === 'ai' ? t('ai.proposals.singular') : t('coaching.proposal.from_your_coach_x', { name: coachName })}</p>
              <div className="flex gap-1.5 flex-wrap mt-2">
                <ProposalStatusBadge status={p.status} />
                <Badge>{t('coaching.proposal.revision_x', { revision: p.revision })}</Badge>
                <Badge>{isNew ? t('coaching.proposal.new_plan') : t('coaching.proposal.update_to_x', { name: base ? programDisplayName(base.name) : t('coaching.proposal.your_plan_lower') })}</Badge>
              </div>
            </div>
          </div>
          {p.message && <p className="mt-3 rounded-xl bg-surface-2 px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words">{p.message}</p>}
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">{t('coaching.messages.sent')}</dt>
            <dd>{fmtDateTime(p.sentAt ?? p.createdAt)}</dd>
            <dt className="text-muted">{isNew ? t('coaching.proposal.starts') : t('coaching.proposal.applies')}</dt>
            <dd>
              {isNew
                ? p.effectiveDate
                  ? formatDate(p.effectiveDate)
                  : t('coaching.proposal.as_soon_as_you_accept')
                : p.effectiveDate
                  ? t('coaching.proposal.to_next_sessions_suggested', { date: formatDate(p.effectiveDate) })
                  : t('coaching.proposal.to_your_next_sessions_after_you')}
            </dd>
          </dl>
        </Card>

        <SectionTitle>{t('coaching.proposal.what_changes')}</SectionTitle>
        <Card className="px-4 py-3">
          {p.changeSummary.length > 0 && (
            <>
              <p className="text-xs font-medium text-muted mb-1">{p.authorKind === 'ai' ? t('coaching.proposal.summary') : t('coaching.proposal.xs_summary', { name: coachName })}</p>
              <ul className="list-disc pl-4 text-sm flex flex-col gap-1 mb-3">
                {p.changeSummary.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          )}
          <p className="text-xs font-medium text-muted mb-1">{baseVersion ? t('coaching.proposal.compared_with_your_plan_version_x', { version: baseVersion.version }) : t('coaching.proposal.overview')}</p>
          <ul className="list-disc pl-4 text-sm flex flex-col gap-1">
            {changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          {p.baseProgramId && !base && <p className="text-xs text-warn mt-2">{t('coaching.proposal.the_plan_this_update_was_written')}</p>}
          <p className="text-xs text-muted mt-3">{t('coaching.proposal.accepting_saves_a_new_version_of')}</p>
        </Card>

        <ProgramPreview program={p.program} byId={byId} catalog={catalog} unit={unit} weekStart={account.settings.weekStart} />

        {/* ------------------------------------------------------------- actions */}
        <div className="mt-6 flex flex-col gap-3">
          {p.status === 'sent' && p.target === 'for_coach_review' && <Notice>{t('aiCard.apply.reviewOnly')}</Notice>}
          {p.status === 'sent' && stale && (
            <Notice tone="warn">
              {t('coaching.proposal.stale_notice', { current: base!.currentVersion, base: p.baseVersion ?? 0 })}
              {p.relationshipId && (
                <Button size="sm" className="mt-2" icon={<MessageCircle className="size-4" />} onClick={askRevision}>
                  {t('coaching.proposal.ask_x_for_a_revision', { name: coachName })}
                </Button>
              )}
            </Notice>
          )}
          {applyError && (
            <Notice tone={applyError.reason === 'stale' ? 'warn' : 'danger'}>
              <p>{applyError.message}</p>
              {applyError.reason === 'stale' && p.relationshipId && (
                <Button size="sm" className="mt-2" icon={<MessageCircle className="size-4" />} onClick={askRevision}>
                  {t('coaching.proposal.ask_x_for_a_revision', { name: coachName })}
                </Button>
              )}
              {applyError.reason === 'coach_managed' && <p className="mt-1 text-xs">{t('coaching.proposal.you_can_take_over_your_current')}</p>}
            </Notice>
          )}
          {pendingNotify && (
            <Notice tone="warn">
              <p>
                {p.authorKind === 'coach' ? t('coaching.proposal.pending_notify_coach', { name: coachName }) : t('coaching.proposal.pending_notify_ai')}
              </p>
              <Button size="sm" className="mt-2" icon={<RefreshCw className="size-4" />} loading={busy === 'notify'} onClick={() => void notify(p, pendingNotify)}>
                {t('workout.retry')}
              </Button>
            </Notice>
          )}
          {p.status === 'sent' && p.target === 'apply' && !pendingNotify && (
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" icon={<X className="size-4" />} onClick={() => setDeclineOpen(true)} disabled={!!busy}>
                {t('aiCard.proposal.decline')}
              </Button>
              <Button variant="primary" className="flex-[2]" icon={<Check className="size-4" />} loading={busy === 'accept'} disabled={stale || !!busy} onClick={accept}>
                {t('coaching.proposal.accept_plan')}
              </Button>
            </div>
          )}
          {p.status === 'accepted' && (
            <Notice tone="accent">
              {p.respondedAt ? t('coaching.proposal.you_accepted_this_on', { date: fmtDateTime(p.respondedAt) }) : t('coaching.proposal.you_accepted_this')}{' '}
              <button type="button" className="underline font-medium" onClick={() => nav('/train/program')}>
                {t('coaching.proposal.open_your_plan')}
              </button>
            </Notice>
          )}
          {p.status === 'declined' && <Notice>{t('coaching.proposal.you_declined_this_proposal_your_plan')}</Notice>}
          {p.status === 'withdrawn' && <Notice>{t('coaching.proposal.x_withdrew_this_proposal', { name: coachName })}</Notice>}
          {p.status === 'superseded' && <Notice>{t('coaching.proposal.a_newer_revision_replaced_this_proposal')}</Notice>}
          {p.status === 'invalid' && <Notice tone="danger">{p.validationErrors?.[0] ? t('coaching.proposal.didnt_pass_validation_x', { error: p.validationErrors[0] }) : t('coaching.proposal.this_proposal_didnt_pass_validation')}</Notice>}
        </div>

        <ConfirmDialog
          open={declineOpen}
          title={t('coaching.proposal.decline_this_proposal')}
          body={p.authorKind === 'coach' ? t('coaching.proposal.decline_body_coach', { name: coachName }) : t('coaching.proposal.your_current_plan_stays_as_it')}
          confirmLabel={t('aiCard.proposal.decline')}
          busy={busy === 'decline'}
          onCancel={() => setDeclineOpen(false)}
          onConfirm={decline}
        />
      </>
    );
  }

  return (
    <Page title={t('coaching.proposal.program_proposal')} back={<BackButton />}>
      {body}
    </Page>
  );
}
