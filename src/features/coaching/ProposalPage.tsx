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

export default function ProposalPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { db, account } = useApp();
  const { access, meId } = useCoachingAccess();
  const ok = access === 'ok';
  const { list: catalog, byId } = useExercises();
  const unit = account.settings.units.weight;
  const today = todayISO(account.settings.timeZone);

  const proposal = useLoad(() => coachingApi.getProposal(id), [id], ok, 'Couldn’t load this proposal.');
  const rels = useLoad(() => coachingApi.myRelationships(), [], ok);
  const programs = useLiveQuery(() => db.programs.toArray(), [db]);
  const notifyRow = useLiveQuery(() => db.kv.get(`coach-proposal-notify:${id}`), [db, id]);
  const pendingNotify = (notifyRow?.value as { programId: string; version: number } | undefined) ?? null;

  const [busy, setBusy] = useState<'accept' | 'decline' | 'notify' | null>(null);
  const [applyError, setApplyError] = useState<Extract<AcceptLocalResult, { ok: false }> | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);

  const p = proposal.data;
  const rel = p?.relationshipId ? rels.data?.find((r) => r.id === p.relationshipId) : undefined;
  const coachName = rel?.coach.displayName || 'your coach';
  const live = useMemo(() => alive(programs ?? []), [programs]);
  const applied = p ? findAppliedProgram(live, p.id) : undefined;
  const base = p?.baseProgramId ? live.find((x) => x.id === p.baseProgramId) : undefined;
  const baseVersion = base && p?.baseVersion != null ? base.versions.find((v) => v.version === p.baseVersion) : undefined;
  const stale = !!base && p?.baseVersion != null && base.currentVersion !== p.baseVersion && !applied;
  const nameOf = (x: string) => byId.get(x)?.name ?? 'Unknown exercise';
  const changes = useMemo(() => (p ? describeChanges(baseVersion ?? null, p.program, nameOf) : []), [p, baseVersion, byId]); // eslint-disable-line react-hooks/exhaustive-deps

  const askRevision = () => {
    if (!p?.relationshipId) return;
    const draft = `Hi! My plan changed since you wrote “${p.program.name}” (revision ${p.revision}). Could you send me a revised version?`;
    nav(`/coaching/messages/${p.relationshipId}?draft=${encodeURIComponent(draft)}`);
  };

  const notify = async (prop: ProgramProposal, appliedTo: { programId: string; version: number }) => {
    setBusy('notify');
    try {
      await coachingApi.respondProposal(prop.id, true, appliedTo);
      await setPendingNotify(db, prop.id, null);
      await proposal.reload();
      toast.show(prop.authorKind === 'coach' ? `${coachName} has been told you accepted.` : 'Saved.', { tone: 'success' });
    } catch (e) {
      toast.show(`Your plan is updated on this device, but we couldn’t record your answer yet: ${coachingError(e)}`, { tone: 'warn', duration: 7000 });
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
      if (!r.alreadyApplied) toast.show(r.createdNew ? 'New plan is now active in Train.' : 'Your plan was updated — the change applies to your next sessions.', { tone: 'success' });
      await notify(p, appliedTo);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Couldn’t save the plan on this device.', { tone: 'error' });
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
      toast.show('Proposal declined. Your current plan didn’t change.', { tone: 'success' });
    } catch (e) {
      toast.show(coachingError(e, 'Couldn’t decline right now.'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  let body;
  if (!ok) body = <CoachingAccessNotice access={access} what="Program proposals" />;
  else if (proposal.error && !p) body = <ErrorState title="Couldn’t load this proposal" message={proposal.error} onRetry={proposal.reload} />;
  else if (p === undefined || programs === undefined) body = <Spinner label="Loading proposal" />;
  else if (p === null) body = <EmptyState title="This proposal isn’t available" body="It may have been withdrawn, or it isn’t addressed to you." action={<Button onClick={() => nav('/coaching/my')}>My coach</Button>} />;
  else if (meId && p.clientId !== meId)
    body = (
      <EmptyState
        title="This proposal is for your client"
        body="Only the client can accept or decline it. You can edit or withdraw it from the client’s program page."
        action={p.relationshipId ? <Button onClick={() => nav(`/coaching/client/${p.relationshipId}/program`)}>Open client program</Button> : undefined}
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
              <h2 className="text-lg font-semibold leading-tight">{p.program.name}</h2>
              <p className="text-sm text-muted mt-0.5">{p.authorKind === 'ai' ? 'AI suggestion' : `From your coach ${coachName}`}</p>
              <div className="flex gap-1.5 flex-wrap mt-2">
                <ProposalStatusBadge status={p.status} />
                <Badge>Revision {p.revision}</Badge>
                <Badge>{isNew ? 'New plan' : `Update to “${base?.name ?? 'your plan'}”`}</Badge>
              </div>
            </div>
          </div>
          {p.message && <p className="mt-3 rounded-xl bg-surface-2 px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words">{p.message}</p>}
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Sent</dt>
            <dd>{fmtDateTime(p.sentAt ?? p.createdAt)}</dd>
            <dt className="text-muted">{isNew ? 'Starts' : 'Applies'}</dt>
            <dd>
              {isNew
                ? p.effectiveDate
                  ? formatDate(p.effectiveDate)
                  : 'As soon as you accept'
                : `To your next sessions after you accept${p.effectiveDate ? ` (suggested from ${formatDate(p.effectiveDate)})` : ''}`}
            </dd>
          </dl>
        </Card>

        <SectionTitle>What changes</SectionTitle>
        <Card className="px-4 py-3">
          {p.changeSummary.length > 0 && (
            <>
              <p className="text-xs font-medium text-muted mb-1">{p.authorKind === 'ai' ? 'Summary' : `${coachName}’s summary`}</p>
              <ul className="list-disc pl-4 text-sm flex flex-col gap-1 mb-3">
                {p.changeSummary.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          )}
          <p className="text-xs font-medium text-muted mb-1">{baseVersion ? `Compared with your plan (version ${baseVersion.version})` : 'Overview'}</p>
          <ul className="list-disc pl-4 text-sm flex flex-col gap-1">
            {changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          {p.baseProgramId && !base && <p className="text-xs text-warn mt-2">The plan this update was written for isn’t on this device.</p>}
          <p className="text-xs text-muted mt-3">Accepting saves a new version of your plan. Workouts you’ve already completed are never changed.</p>
        </Card>

        <ProgramPreview program={p.program} byId={byId} catalog={catalog} unit={unit} weekStart={account.settings.weekStart} />

        {/* ------------------------------------------------------------- actions */}
        <div className="mt-6 flex flex-col gap-3">
          {p.status === 'sent' && p.target === 'for_coach_review' && <Notice>This is a suggestion to discuss with your coach, not a plan to apply.</Notice>}
          {p.status === 'sent' && stale && (
            <Notice tone="warn">
              Your plan changed after this was written (it’s now version {base!.currentVersion}, this update was made for version {p.baseVersion}). Accepting it would overwrite newer changes,
              so it can’t be applied.
              {p.relationshipId && (
                <Button size="sm" className="mt-2" icon={<MessageCircle className="size-4" />} onClick={askRevision}>
                  Ask {coachName} for a revision
                </Button>
              )}
            </Notice>
          )}
          {applyError && (
            <Notice tone={applyError.reason === 'stale' ? 'warn' : 'danger'}>
              <p>{applyError.message}</p>
              {applyError.reason === 'stale' && p.relationshipId && (
                <Button size="sm" className="mt-2" icon={<MessageCircle className="size-4" />} onClick={askRevision}>
                  Ask {coachName} for a revision
                </Button>
              )}
              {applyError.reason === 'coach_managed' && <p className="mt-1 text-xs">You can take over your current plan from My coach, then accept this.</p>}
            </Notice>
          )}
          {pendingNotify && (
            <Notice tone="warn">
              <p>
                Your plan is updated on this device{p.authorKind === 'coach' ? `, but ${coachName} hasn’t been told yet` : ', but your answer isn’t saved on the server yet'}. If this keeps
                failing, wait a moment for your plan to sync and try again.
              </p>
              <Button size="sm" className="mt-2" icon={<RefreshCw className="size-4" />} loading={busy === 'notify'} onClick={() => void notify(p, pendingNotify)}>
                Retry
              </Button>
            </Notice>
          )}
          {p.status === 'sent' && p.target === 'apply' && !pendingNotify && (
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" icon={<X className="size-4" />} onClick={() => setDeclineOpen(true)} disabled={!!busy}>
                Decline
              </Button>
              <Button variant="primary" className="flex-[2]" icon={<Check className="size-4" />} loading={busy === 'accept'} disabled={stale || !!busy} onClick={accept}>
                Accept plan
              </Button>
            </div>
          )}
          {p.status === 'accepted' && (
            <Notice tone="accent">
              You accepted this {p.respondedAt ? `on ${fmtDateTime(p.respondedAt)}` : ''}.{' '}
              <button type="button" className="underline font-medium" onClick={() => nav('/train/program')}>
                Open your plan
              </button>
            </Notice>
          )}
          {p.status === 'declined' && <Notice>You declined this proposal. Your plan didn’t change.</Notice>}
          {p.status === 'withdrawn' && <Notice>{coachName} withdrew this proposal.</Notice>}
          {p.status === 'superseded' && <Notice>A newer revision replaced this proposal. Check My coach for the latest one.</Notice>}
          {p.status === 'invalid' && <Notice tone="danger">This proposal didn’t pass validation{p.validationErrors?.[0] ? `: ${p.validationErrors[0]}` : '.'}</Notice>}
        </div>

        <ConfirmDialog
          open={declineOpen}
          title="Decline this proposal?"
          body={`Your current plan stays as it is. ${p.authorKind === 'coach' ? `${coachName} will see that you declined — you can message them about what you’d like changed.` : ''}`}
          confirmLabel="Decline"
          busy={busy === 'decline'}
          onCancel={() => setDeclineOpen(false)}
          onConfirm={decline}
        />
      </>
    );
  }

  return (
    <Page title="Program proposal" back={<BackButton />}>
      {body}
    </Page>
  );
}
