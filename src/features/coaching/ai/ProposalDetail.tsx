/** One AI plan suggestion: read-only preview, exact changes, and deliberate apply / decline / coach flows. */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, Check, MessageSquareShare, RefreshCw, ShieldAlert, UserRound } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, Notice, SectionTitle } from '@/components/ui';
import { useToast } from '@/components/toast';
import { aiApi } from '@/backend/ai';
import type { CoachingRelationship, ProgramProposal } from '@/backend/coachingContract';
import { kvSet } from '@/db/repo';
import { useApp } from '@/state/app';
import { trackAiAction } from '@/analytics/analytics';
import { useExercises } from '@/data/catalog';
import { describeChanges, validateProposedProgram } from '@/domain/program/proposals';
import { currentVersion } from '@/domain/program/program';
import { SessionCard, WeekStrip } from '@/features/program/parts';
import { todayISO } from '@/lib/dates';
import type { Program } from '@/domain/types';
import { dateTimeText, useT } from '@/i18n';
import { AI_DRAFT_KEY, liveActive, PROPOSAL_VIEW_LABEL, proposalShareText, proposalView } from './model';
import { applyAiProposal, respondOrQueue, switchToSelfManaged } from './apply';
import { AiBadge, ShareWithCoachDialog } from './parts';
import { exerciseDisplayName } from '@/data/catalogText';

export function ProposalDetail({
  proposal: p, programs, coach, onChanged,
}: {
  proposal: ProgramProposal;
  programs: Program[];
  coach: CoachingRelationship | null;
  onChanged: (p: ProgramProposal) => void;
}) {
  const { t } = useT();
  const nav = useNavigate();
  const toast = useToast();
  const { db, account } = useApp();
  const { list: catalog, byId } = useExercises();
  const unit = account.settings.units.weight;
  const [confirm, setConfirm] = useState<null | 'apply' | 'switch'>(null);
  const [busy, setBusy] = useState<null | 'apply' | 'decline' | 'switch'>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  const live = useMemo(() => programs.filter((x) => !x.deletedAt), [programs]);
  const view = proposalView(p, live);
  const active = liveActive(live);
  const coachManaged = active?.managedBy?.kind === 'coach';
  // A named coach is inserted unchanged; without a name the generic sentence variants are used.
  const coachName = active?.managedBy?.coachName || coach?.coach.displayName || null;
  const base = p.baseProgramId ? live.find((x) => x.id === p.baseProgramId) : undefined;
  const baseVersion = base ? (base.versions.find((v) => v.version === p.baseVersion) ?? currentVersion(base)) : null;
  const nameOf = (id: string) => (byId.get(id) ? exerciseDisplayName(byId.get(id)) : t('aiCard.proposal.unknownExercise'));
  const changes = describeChanges(baseVersion, p.program, nameOf);
  const errors = useMemo(() => {
    const server = p.validationErrors ?? [];
    if (view !== 'pending' && view !== 'invalid') return server;
    return [...new Set([...server, ...validateProposedProgram(p.program, byId)])];
  }, [p, view, byId]);
  const pending = view === 'pending' && errors.length === 0;
  // A coach-managed active plan can only change through the coach, or after an explicit switch.
  const needsCoach = pending && coachManaged;
  // Written for coach review, but the plan is no longer coach-managed: it can't be applied as-is.
  const reviewOnly = pending && !coachManaged && p.target === 'for_coach_review';
  const daysFor = (tid: string) => p.program.schedule.filter((s) => s.templateId === tid).map((s) => s.weekday);

  async function apply(switchFromCoach: boolean) {
    setBusy(switchFromCoach ? 'switch' : 'apply');
    setError(null);
    try {
      const res = await applyAiProposal({
        proposal: p, programs: live, db, today: todayISO(account.settings.timeZone), catalog: byId, switchFromCoach,
        respond: (id, accept, applied) => aiApi.respondProposal(id, accept, applied),
      });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setConfirm(null);
      void trackAiAction(db, 'program_proposal', 'applied');
      toast.show(res.recorded ? t('aiCard.proposal.updated') : t('aiCard.proposal.updatedOffline'), { tone: res.recorded ? 'success' : 'warn' });
      onChanged({ ...p, status: 'accepted', appliedProgramId: res.program.id, appliedVersion: res.program.currentVersion, respondedAt: new Date().toISOString() });
    } catch {
      // Raw storage/network errors aren't user-facing text; show the localized fallback.
      setError(t('aiCard.proposal.applyError'));
    } finally {
      setBusy(null);
    }
  }

  async function switchOnly() {
    setBusy('switch');
    setError(null);
    try {
      // The plan gets a new self-managed version, so this suggestion becomes out of date (stale) by design.
      await switchToSelfManaged(live, db);
      setConfirm(null);
      toast.show(t('aiCard.proposal.selfManaged'), { tone: 'success' });
    } catch {
      setError(t('aiCard.proposal.switchError'));
    } finally {
      setBusy(null);
    }
  }

  async function decline() {
    setBusy('decline');
    try {
      const recorded = await respondOrQueue(db, (id, accept) => aiApi.respondProposal(id, accept), { id: p.id, accept: false });
      void trackAiAction(db, 'program_proposal', 'dismissed');
      toast.show(recorded ? t('aiCard.proposal.declined') : t('aiCard.proposal.declinedOffline'), { tone: recorded ? 'success' : 'warn' });
      onChanged({ ...p, status: 'declined', respondedAt: new Date().toISOString() });
    } finally {
      setBusy(null);
    }
  }

  async function askForUpdate() {
    const text = t('aiCard.proposal.updateRequest', { programName: p.program.name });
    await kvSet(AI_DRAFT_KEY, text, db).catch(() => undefined);
    nav('/coach');
  }

  const label = { tone: PROPOSAL_VIEW_LABEL[view].tone, label: t(`ai.proposal.status.${view}`) };
  const dateOf = (iso: string) => dateTimeText(Date.parse(iso), account.settings.timeZone, { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <AiBadge>{t('ai.proposals.singular')}</AiBadge>
          <Badge tone={label.tone}>{label.label}</Badge>
        </div>
        <h2 className="text-xl font-bold mt-2">{p.program.name}</h2>
        <p className="text-xs text-muted mt-1">
          {t('aiCard.proposal.suggestedDate', { date: dateOf(p.createdAt) })}
          {' · '}
          {base ? t('aiCard.proposal.revises', { name: base.name, version: p.baseVersion ?? '' }) : t('aiCard.proposal.newPlan')}
        </p>
        {p.message && (
          <div className="mt-3">
            <h3 className="text-sm font-semibold">{t('aiCard.proposal.why')}</h3>
            <p className="text-sm text-muted mt-1 whitespace-pre-wrap break-words">{p.message}</p>
          </div>
        )}
        <p className="text-[11px] text-faint mt-3">{t('aiCard.proposal.disclaimer')}</p>
      </Card>

      {/* state-specific actions */}
      {view === 'accepted' && (
        <Notice tone="accent" className="flex items-start gap-2">
          <Check className="size-4 mt-0.5 text-accent shrink-0" aria-hidden />
          <div className="flex-1">
            {p.respondedAt
              ? p.appliedVersion
                ? t('aiCard.proposal.appliedDateVersion', { date: dateOf(p.respondedAt), version: p.appliedVersion })
                : t('aiCard.proposal.appliedDate', { date: dateOf(p.respondedAt) })
              : p.appliedVersion
                ? t('aiCard.proposal.appliedVersion', { version: p.appliedVersion })
                : t('ai.proposal.status.accepted')}
            <Button size="sm" variant="ghost" className="ml-1" onClick={() => nav('/train/program')}>
              {t('aiCard.proposal.viewPlan')}
            </Button>
          </div>
        </Notice>
      )}
      {view === 'declined' && <Notice>{t('aiCard.proposal.declinedNotice')}</Notice>}
      {view === 'closed' && <Notice>{t('aiCard.proposal.replacedNotice')}</Notice>}
      {errors.length > 0 && (view === 'pending' || view === 'invalid') && (
        <Notice tone="danger">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="size-4" aria-hidden /> {t('aiCard.proposal.invalidTitle')}
          </div>
          <p className="text-sm text-muted mt-1">{t('aiCard.proposal.invalidBody')}</p>
          <ul className="list-disc pl-5 mt-1 space-y-0.5 text-sm">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      )}
      {view === 'stale' && (
        <Notice tone="warn">
          <div className="flex items-start gap-2">
            <AlertTriangle className="size-4 mt-0.5 shrink-0" aria-hidden />
            <p className="flex-1">{base ? t('ai.proposal.stale') : t('aiCard.proposal.planGone')}</p>
          </div>
          <div className="mt-2 flex gap-2 flex-wrap">
            <Button size="sm" variant="primary" icon={<RefreshCw className="size-4" />} onClick={() => void askForUpdate()}>
              {t('aiCard.proposal.askUpdate')}
            </Button>
            <Button size="sm" variant="ghost" loading={busy === 'decline'} onClick={() => void decline()}>
              {t('aiCard.proposal.dismiss')}
            </Button>
          </div>
        </Notice>
      )}

      {needsCoach && (
        <Notice tone="info">
          <div className="flex items-center gap-2 font-semibold">
            <UserRound className="size-4" aria-hidden /> {t('aiCard.proposal.coachManaged')}
          </div>
          <p className="text-sm text-muted mt-1">
            {coachName ? t('aiCard.proposal.coachManagedBody', { coachName }) : t('aiCard.proposal.coachManagedBodyGeneric')}
          </p>
          <div className="mt-3 flex gap-2 flex-wrap">
            {coach && (
              <Button size="sm" variant="primary" icon={<MessageSquareShare className="size-4" />} onClick={() => setSharing(true)}>
                {t('ai.share.button')}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setConfirm('switch')}>
              {t('aiCard.proposal.switchSelf')}
            </Button>
            <Button size="sm" variant="ghost" loading={busy === 'decline'} onClick={() => void decline()}>
              {t('aiCard.proposal.decline')}
            </Button>
          </div>
          {!coach && <p className="text-xs text-muted mt-2">{t('aiCard.proposal.discuss')}</p>}
        </Notice>
      )}
      {reviewOnly && (
        <Notice tone="info">
          <p>{t('aiCard.proposal.reviewOnly')}</p>
          <Button size="sm" variant="primary" className="mt-2" icon={<RefreshCw className="size-4" />} onClick={() => void askForUpdate()}>
            {t('aiCard.proposal.askUpdate')}
          </Button>
        </Notice>
      )}

      {pending && !needsCoach && !reviewOnly && (
        <div className="flex gap-2">
          <Button variant="primary" className="flex-1" onClick={() => setConfirm('apply')}>
            {t('aiCard.proposal.apply')}
          </Button>
          <Button variant="ghost" loading={busy === 'decline'} onClick={() => void decline()}>
            {t('aiCard.proposal.decline')}
          </Button>
        </div>
      )}
      {error && !confirm && (
        <Notice tone="danger">
          <span role="alert">{error}</span>
        </Notice>
      )}

      {/* preview */}
      <SectionTitle>{base ? t('aiCard.proposal.changesVersion', { version: p.baseVersion ?? '' }) : t('aiCard.proposal.contains')}</SectionTitle>
      <Card className="p-4">
        <ul className="list-disc pl-5 space-y-1 text-sm">
          {changes.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        {p.changeSummary.length > 0 && (
          <>
            <h3 className="text-sm font-semibold mt-3">{t('aiCard.proposal.summary')}</h3>
            <ul className="list-disc pl-5 space-y-1 text-sm text-muted mt-1">
              {p.changeSummary.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </>
        )}
        {p.program.progressionNotes && (
          <>
            <h3 className="text-sm font-semibold mt-3">{t('aiCard.proposal.progression')}</h3>
            <p className="text-sm text-muted mt-1 whitespace-pre-wrap">{p.program.progressionNotes}</p>
          </>
        )}
      </Card>

      <SectionTitle>{t('aiCard.proposal.week')}</SectionTitle>
      <WeekStrip version={p.program} weekStart={account.settings.weekStart} />
      <SectionTitle>{t('aiCard.proposal.sessions')}</SectionTitle>
      <div className="space-y-3">
        {p.program.templates.map((tpl) => (
          <SessionCard key={tpl.id} template={tpl} byId={byId} catalog={catalog} unit={unit} days={daysFor(tpl.id)} defaultOpen={false} />
        ))}
      </div>

      <ConfirmDialog
        open={confirm === 'apply'}
        title={t('aiCard.proposal.applyConfirm')}
        confirmLabel={t('aiCard.proposal.applyConfirmButton')}
        busy={busy === 'apply'}
        onCancel={() => {
          setConfirm(null);
          setError(null);
        }}
        onConfirm={() => void apply(false)}
        body={
          <>
            {base
              ? t('aiCard.proposal.saveVersion', { name: base.name, version: base.currentVersion + 1 })
              : active
                ? t('aiCard.proposal.replacePlan', { name: p.program.name, oldName: active.name })
                : t('aiCard.proposal.createPlan', { name: p.program.name })}{' '}
            {t('aiCard.proposal.historyKept')}
          </>
        }
      >
        {error && confirm === 'apply' && (
          <Notice tone="danger" className="mt-3">
            {error}
          </Notice>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === 'switch'}
        title={t('aiCard.proposal.switchConfirm')}
        confirmLabel={p.target === 'apply' ? t('aiCard.proposal.switchApply') : t('aiCard.proposal.switch')}
        danger
        busy={busy === 'switch'}
        onCancel={() => {
          setConfirm(null);
          setError(null);
        }}
        onConfirm={() => void (p.target === 'apply' ? apply(true) : switchOnly())}
        body={
          <>
            {coachName ? t('aiCard.proposal.coachPlanStops', { coachName }) : t('aiCard.proposal.coachPlanStopsGeneric')}{' '}
            {p.target === 'apply' ? t('aiCard.proposal.switchApplies') : t('aiCard.proposal.switchKeeps')}{' '}
            {t('aiCard.proposal.switchRelationship')}
          </>
        }
      >
        {error && confirm === 'switch' && (
          <Notice tone="danger" className="mt-3">
            {error}
          </Notice>
        )}
      </ConfirmDialog>

      {sharing && coach && (
        <ShareWithCoachDialog open what={t('aiCard.proposal.shareWhat')} text={proposalShareText(p, changes)} relationship={coach} onClose={() => setSharing(false)} />
      )}
    </div>
  );
}
