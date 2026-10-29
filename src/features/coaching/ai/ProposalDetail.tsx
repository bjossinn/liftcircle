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
import { useExercises } from '@/data/catalog';
import { describeChanges, validateProposedProgram } from '@/domain/program/proposals';
import { currentVersion } from '@/domain/program/program';
import { SessionCard, WeekStrip } from '@/features/program/parts';
import { todayISO } from '@/lib/dates';
import type { Program } from '@/domain/types';
import { AI_DRAFT_KEY, liveActive, PROPOSAL_VIEW_LABEL, proposalShareText, proposalView, STALE_MESSAGE } from './model';
import { applyAiProposal, respondOrQueue, switchToSelfManaged } from './apply';
import { AiBadge, ShareWithCoachDialog } from './parts';

export function ProposalDetail({
  proposal: p, programs, coach, onChanged,
}: {
  proposal: ProgramProposal;
  programs: Program[];
  coach: CoachingRelationship | null;
  onChanged: (p: ProgramProposal) => void;
}) {
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
  const coachName = active?.managedBy?.coachName || coach?.coach.displayName || 'your coach';
  const base = p.baseProgramId ? live.find((x) => x.id === p.baseProgramId) : undefined;
  const baseVersion = base ? (base.versions.find((v) => v.version === p.baseVersion) ?? currentVersion(base)) : null;
  const nameOf = (id: string) => byId.get(id)?.name ?? 'Unknown exercise';
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
      toast.show(res.recorded ? 'Your plan was updated' : 'Your plan was updated on this device. The AI coach will be told when you’re back online.', { tone: res.recorded ? 'success' : 'warn' });
      onChanged({ ...p, status: 'accepted', appliedProgramId: res.program.id, appliedVersion: res.program.currentVersion, respondedAt: new Date().toISOString() });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t apply this suggestion.');
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
      toast.show('Your plan is now self-managed. Ask the AI coach for an updated suggestion.', { tone: 'success' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t switch your plan.');
    } finally {
      setBusy(null);
    }
  }

  async function decline() {
    setBusy('decline');
    try {
      const recorded = await respondOrQueue(db, (id, accept) => aiApi.respondProposal(id, accept), { id: p.id, accept: false });
      toast.show(recorded ? 'Suggestion declined' : 'Declined on this device; it will sync when you’re back online.', { tone: recorded ? 'success' : 'warn' });
      onChanged({ ...p, status: 'declined', respondedAt: new Date().toISOString() });
    } finally {
      setBusy(null);
    }
  }

  async function askForUpdate() {
    const text = `My plan has changed. Please write an updated version of your suggestion “${p.program.name}” for my current plan.`;
    await kvSet(AI_DRAFT_KEY, text, db).catch(() => undefined);
    nav('/coaching/ai');
  }

  const label = PROPOSAL_VIEW_LABEL[view];

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <AiBadge>AI suggestion</AiBadge>
          <Badge tone={label.tone}>{label.label}</Badge>
        </div>
        <h2 className="text-xl font-bold mt-2">{p.program.name}</h2>
        <p className="text-xs text-muted mt-1">
          Suggested {new Date(p.createdAt).toLocaleDateString()}
          {base ? ` · revises “${base.name}” (version ${p.baseVersion})` : ' · a new plan'}
        </p>
        {p.message && (
          <div className="mt-3">
            <h3 className="text-sm font-semibold">Why the AI suggests this</h3>
            <p className="text-sm text-muted mt-1 whitespace-pre-wrap break-words">{p.message}</p>
          </div>
        )}
        <p className="text-[11px] text-faint mt-3">Written by an AI. It’s a suggestion — check it fits you before applying.</p>
      </Card>

      {/* state-specific actions */}
      {view === 'accepted' && (
        <Notice tone="accent" className="flex items-start gap-2">
          <Check className="size-4 mt-0.5 text-accent shrink-0" aria-hidden />
          <div className="flex-1">
            Applied{p.respondedAt ? ` on ${new Date(p.respondedAt).toLocaleDateString()}` : ''}
            {p.appliedVersion ? ` as version ${p.appliedVersion}` : ''}.
            <Button size="sm" variant="ghost" className="ml-1" onClick={() => nav('/train/program')}>
              View plan
            </Button>
          </div>
        </Notice>
      )}
      {view === 'declined' && <Notice>You declined this suggestion. Your plan wasn’t changed.</Notice>}
      {view === 'closed' && <Notice>This suggestion was replaced by a newer one.</Notice>}
      {errors.length > 0 && (view === 'pending' || view === 'invalid') && (
        <Notice tone="danger">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="size-4" aria-hidden /> This suggestion can’t be applied
          </div>
          <p className="text-sm text-muted mt-1">It didn’t pass the app’s checks, so it’s shown for reference only:</p>
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
            <p className="flex-1">{base ? STALE_MESSAGE : 'The plan this suggestion was written for is no longer on this device; ask the AI for an updated one.'}</p>
          </div>
          <div className="mt-2 flex gap-2 flex-wrap">
            <Button size="sm" variant="primary" icon={<RefreshCw className="size-4" />} onClick={() => void askForUpdate()}>
              Ask for an updated one
            </Button>
            <Button size="sm" variant="ghost" loading={busy === 'decline'} onClick={() => void decline()}>
              Dismiss
            </Button>
          </div>
        </Notice>
      )}

      {needsCoach && (
        <Notice tone="info">
          <div className="flex items-center gap-2 font-semibold">
            <UserRound className="size-4" aria-hidden /> Your plan is managed by your coach
          </div>
          <p className="text-sm text-muted mt-1">
            {coachName === 'your coach' ? 'Your coach' : coachName} manages your active plan, so the AI can’t change it. Share this suggestion so they can review it, or switch
            to a self-managed plan.
          </p>
          <div className="mt-3 flex gap-2 flex-wrap">
            {coach && (
              <Button size="sm" variant="primary" icon={<MessageSquareShare className="size-4" />} onClick={() => setSharing(true)}>
                Share with my coach
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setConfirm('switch')}>
              Switch to a self-managed plan
            </Button>
            <Button size="sm" variant="ghost" loading={busy === 'decline'} onClick={() => void decline()}>
              Decline
            </Button>
          </div>
          {!coach && <p className="text-xs text-muted mt-2">To discuss it with your coach, open your coaching messages.</p>}
        </Notice>
      )}
      {reviewOnly && (
        <Notice tone="info">
          <p>This suggestion was written for your coach to review. Your plan isn’t coach-managed any more, so ask the AI coach for a version you can apply.</p>
          <Button size="sm" variant="primary" className="mt-2" icon={<RefreshCw className="size-4" />} onClick={() => void askForUpdate()}>
            Ask for an updated one
          </Button>
        </Notice>
      )}

      {pending && !needsCoach && !reviewOnly && (
        <div className="flex gap-2">
          <Button variant="primary" className="flex-1" onClick={() => setConfirm('apply')}>
            Apply suggestion
          </Button>
          <Button variant="ghost" loading={busy === 'decline'} onClick={() => void decline()}>
            Decline
          </Button>
        </div>
      )}
      {error && !confirm && (
        <Notice tone="danger">
          <span role="alert">{error}</span>
        </Notice>
      )}

      {/* preview */}
      <SectionTitle>{base ? `Changes compared with version ${p.baseVersion}` : 'What this plan contains'}</SectionTitle>
      <Card className="p-4">
        <ul className="list-disc pl-5 space-y-1 text-sm">
          {changes.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        {p.changeSummary.length > 0 && (
          <>
            <h3 className="text-sm font-semibold mt-3">The AI’s summary</h3>
            <ul className="list-disc pl-5 space-y-1 text-sm text-muted mt-1">
              {p.changeSummary.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </>
        )}
        {p.program.progressionNotes && (
          <>
            <h3 className="text-sm font-semibold mt-3">Progression</h3>
            <p className="text-sm text-muted mt-1 whitespace-pre-wrap">{p.program.progressionNotes}</p>
          </>
        )}
      </Card>

      <SectionTitle>Week</SectionTitle>
      <WeekStrip version={p.program} weekStart={account.settings.weekStart} />
      <SectionTitle>Sessions</SectionTitle>
      <div className="space-y-3">
        {p.program.templates.map((t) => (
          <SessionCard key={t.id} template={t} byId={byId} catalog={catalog} unit={unit} days={daysFor(t.id)} defaultOpen={false} />
        ))}
      </div>

      <ConfirmDialog
        open={confirm === 'apply'}
        title="Apply this AI suggestion?"
        confirmLabel="Apply"
        busy={busy === 'apply'}
        onCancel={() => {
          setConfirm(null);
          setError(null);
        }}
        onConfirm={() => void apply(false)}
        body={
          <>
            {base
              ? `This saves a new version of “${base.name}” (version ${base.currentVersion + 1}) and makes it your active plan.`
              : `This creates “${p.program.name}” and makes it your active plan${active ? ` instead of “${active.name}”` : ''}.`}{' '}
            Completed workouts don’t change, and earlier versions stay available on the Program page.
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
        title="Switch to a self-managed plan?"
        confirmLabel={p.target === 'apply' ? 'Switch and apply' : 'Switch'}
        danger
        busy={busy === 'switch'}
        onCancel={() => {
          setConfirm(null);
          setError(null);
        }}
        onConfirm={() => void (p.target === 'apply' ? apply(true) : switchOnly())}
        body={
          <>
            {coachName === 'your coach' ? 'Your coach' : coachName}’s plan stops being your active coach-managed plan.{' '}
            {p.target === 'apply'
              ? 'This AI suggestion is applied instead, and you manage the plan yourself from now on.'
              : 'Your current plan is kept as a self-managed copy (saved as a new version) that you manage yourself.'}{' '}
            Your coaching relationship and messages continue, and completed workouts don’t change. Your coach may notice the plan is no longer theirs.
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
        <ShareWithCoachDialog open what="a summary of this suggestion" text={proposalShareText(p, changes)} relationship={coach} onClose={() => setSharing(false)} />
      )}
    </div>
  );
}
