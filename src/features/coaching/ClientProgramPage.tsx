/**
 * /coaching/client/:relationshipId/program — the coach builds or revises a ProposedProgram with the
 * existing program editor, validates it against the bundled exercise catalog (what every client has),
 * shows the changes against the client's current plan, saves a draft (idempotent id) and sends it.
 * Nothing changes for the client until they accept; their logged workouts never change.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { FilePlus2, Layers, Save, Send, Sparkles, Undo2, Wand2 } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Input, ListRow, Notice, Page, SectionTitle, Segmented, Sheet, Spinner, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { useExercises } from '@/data/catalog';
import { EXERCISES } from '@/data/exercises';
import { coachingApi } from '@/backend/coaching';
import type { ClientOverview, CoachingRelationship, ProgramProposal } from '@/backend/coachingContract';
import type { SavedTemplate } from '@/domain/types';
import { alive } from '@/db/repo';
import { describeChanges, validateProposedProgram } from '@/domain/program/proposals';
import { generateProgram, suggestProgramName } from '@/domain/program/generator';
import { todayISO } from '@/lib/dates';
import { uuid } from '@/lib/id';
import { coachingError } from '@/coaching/errors';
import {
  asVersion, blankProposed, intakeToAnswers, loadEditorDraft, proposedFromTemplates, proposedFromVersion, saveEditorDraft, type EditorDraft,
} from '@/coaching/programDraft';
import { BackButton, CoachingAccessNotice, ProposalStatusBadge, fmtDateTime, useCoachingAccess, useLoad } from './tools/common';
import { CoachGate, useCoachStatus } from './tools/coach';
import { ProgramEditor } from './tools/ProgramEditor';

const BUNDLED_IDS = new Set(EXERCISES.map((e) => e.id));

export default function ClientProgramPage() {
  const { relationshipId = '' } = useParams();
  const nav = useNavigate();
  const { access } = useCoachingAccess();
  const ok = access === 'ok';
  const coach = useCoachStatus(ok);
  const approved = coach.state === 'approved';
  const relQ = useLoad(async () => (await coachingApi.myRelationships()).find((r) => r.id === relationshipId && r.viewerIsCoach) ?? null, [relationshipId], ok && approved);
  const rel = relQ.data;
  const active = rel?.status === 'active';
  const overview = useLoad(() => coachingApi.clientOverview(relationshipId), [relationshipId], !!active);
  const proposals = useLoad(() => coachingApi.listProposals({ relationshipId }), [relationshipId], !!active);

  return (
    <Page title="Client program" back={<BackButton to={`/coaching/client/${relationshipId}`} />}>
      {!ok ? (
        <CoachingAccessNotice access={access} what="The program builder" />
      ) : !approved ? (
        <CoachGate state={coach.state} profile={coach.profile} error={coach.error} reload={coach.reload} />
      ) : relQ.error && rel === undefined ? (
        <ErrorState title="Couldn’t load this client" message={relQ.error} onRetry={relQ.reload} />
      ) : rel === undefined ? (
        <Spinner label="Loading" />
      ) : rel === null || !active ? (
        <EmptyState title="Coaching isn’t active" body="You can build programs only for clients you’re actively coaching." action={<Button onClick={() => nav('/coaching/dashboard')}>Dashboard</Button>} />
      ) : (overview.error && !overview.data) || (proposals.error && !proposals.data) ? (
        <ErrorState title="Couldn’t load the client’s program" message={overview.error ?? proposals.error ?? undefined} onRetry={() => Promise.all([overview.reload(), proposals.reload()]).then(() => {})} />
      ) : !overview.data || !proposals.data ? (
        <Spinner label="Loading the client’s plan" />
      ) : (
        <Builder rel={rel} overview={overview.data} proposals={proposals.data} reloadProposals={proposals.reload} />
      )}
    </Page>
  );
}

/* ================================================================ builder */
interface Base {
  programId: string;
  version: number;
  name: string;
  /** Content of `version` when known exactly (from the accepted proposal that produced it). */
  content: ProgramProposal['program'] | null;
  /** Content of an EARLIER version written by you (client changed the plan since). */
  approxContent: ProgramProposal['program'] | null;
  fromOverview: boolean;
}

function findBase(overview: ClientOverview, proposals: ProgramProposal[]): Base | null {
  const accepted = proposals.filter((p) => p.status === 'accepted' && p.appliedProgramId).sort((a, b) => (b.appliedVersion ?? 0) - (a.appliedVersion ?? 0));
  const ap = overview.training?.activeProgram;
  if (ap) {
    const mine = accepted.find((p) => p.appliedProgramId === ap.id);
    return {
      programId: ap.id,
      version: ap.currentVersion,
      name: ap.name,
      content: mine && mine.appliedVersion === ap.currentVersion ? mine.program : null,
      approxContent: mine && mine.appliedVersion !== ap.currentVersion ? mine.program : null,
      fromOverview: true,
    };
  }
  // Training not shared: revise the plan you last got accepted (the client's device rejects it if it changed since).
  const last = accepted[0];
  if (last && overview.training === null) return { programId: last.appliedProgramId!, version: last.appliedVersion ?? 1, name: last.program.name, content: last.program, approxContent: null, fromOverview: false };
  return null;
}

function Builder({ rel, overview, proposals, reloadProposals }: { rel: CoachingRelationship; overview: ClientOverview; proposals: ProgramProposal[]; reloadProposals: () => Promise<void> }) {
  const toast = useToast();
  const nav = useNavigate();
  const [search, setSearch] = useSearchParams();
  const { db, account } = useApp();
  const { list: catalog, byId } = useExercises();
  const unit = account.settings.units.weight;
  const today = todayISO(account.settings.timeZone);
  const who = rel.client.displayName || 'your client';
  const base = useMemo(() => findBase(overview, proposals), [overview, proposals]);
  const { answers, assumed } = useMemo(() => intakeToAnswers(rel.intake, account.settings.units), [rel.intake, account.settings.units]);
  const templatesRows = useLiveQuery(() => db.templates.toArray(), [db]);
  const myTemplates = useMemo(() => alive(templatesRows ?? []), [templatesRows]);

  const [draft, setDraftState] = useState<EditorDraft | null | undefined>(undefined);
  const [restored, setRestored] = useState(false);
  const [serverStatus, setServerStatus] = useState<ProgramProposal['status'] | null>(null);
  const [busy, setBusy] = useState<'save' | 'send' | 'withdraw' | null>(null);
  const [pickTemplates, setPickTemplates] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState<ProgramProposal | null>(null);

  const setDraft = (d: EditorDraft | null) => {
    setDraftState(d);
    void saveEditorDraft(db, rel.id, d ? { ...d, savedAt: Date.now() } : null);
  };
  const start = (program: EditorDraft['program'], revise: boolean, proposalId = uuid(), message = '', effectiveDate: string | null = null) => {
    setServerStatus(null);
    setDraft({ proposalId, program, revise: revise && !!base, message, effectiveDate, savedAt: Date.now() });
  };

  // Initial state: local autosave → ?proposal= → ?template= → chooser.
  const initDone = useRef(false);
  useEffect(() => {
    if (initDone.current || templatesRows === undefined) return;
    initDone.current = true;
    void (async () => {
      const local = await loadEditorDraft(db, rel.id);
      const pid = search.get('proposal');
      const tid = search.get('template');
      if (pid || tid) setSearch({}, { replace: true });
      if (pid) {
        const p = proposals.find((x) => x.id === pid);
        if (p) {
          const keepId = p.status === 'draft';
          setDraftState({ proposalId: keepId ? p.id : uuid(), program: proposedFromVersion(p.program, p.program.name), revise: !!p.baseProgramId && !!base, message: p.message ?? '', effectiveDate: p.effectiveDate ?? null, savedAt: Date.now() });
          setServerStatus(keepId ? 'draft' : null);
          return;
        }
      }
      if (tid) {
        const tpl = myTemplates.find((x) => x.id === tid);
        if (tpl) {
          if (local) {
            setDraft({ ...local, program: { ...local.program, templates: [...local.program.templates, ...proposedFromTemplates([tpl.template]).templates] } });
            toast.show(`Added “${tpl.template.name}” to your draft.`, { tone: 'success' });
          } else start(proposedFromTemplates([tpl.template], `${who}’s plan`), false);
          return;
        }
      }
      if (local) {
        setDraftState(local);
        setRestored(true);
        return;
      }
      setDraftState(null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templatesRows]);

  const program = draft?.program;
  const errors = useMemo(() => {
    if (!program) return [];
    const e = validateProposedProgram(program, BUNDLED_IDS);
    if (program.reviewWeek < 1 || program.reviewWeek > program.weeks) e.push('Review week must be within the block.');
    return e;
  }, [program]);
  const unknownCustom = errors.some((e) => e.startsWith('Unknown exercise') || e.startsWith('Unknown substitution'));
  const nameOf = (id: string) => byId.get(id)?.name ?? 'Unknown exercise';
  const useBase = !!draft?.revise && !!base;
  const changes = useMemo(() => {
    if (!program) return [];
    if (!useBase) return describeChanges(null, program, nameOf);
    const known = base!.content ?? base!.approxContent;
    if (!known) return [`Replaces the sessions of “${base!.name}” (version ${base!.version}) for future workouts.`, ...describeChanges(null, program, nameOf)];
    return describeChanges(asVersion(known, base!.version), program, nameOf);
  }, [program, useBase, base, byId]); // eslint-disable-line react-hooks/exhaustive-deps

  const payload = () => ({
    id: draft!.proposalId,
    relationshipId: rel.id,
    baseProgramId: useBase ? base!.programId : null,
    baseVersion: useBase ? base!.version : null,
    program: { ...draft!.program, name: draft!.program.name.trim() },
    changeSummary: changes.slice(0, 30),
    message: draft!.message.trim() || undefined,
    effectiveDate: draft!.effectiveDate || null,
  });

  const saveDraft = async () => {
    if (!draft) return;
    setBusy('save');
    try {
      const saved = await coachingApi.saveProposal(payload()); // idempotent on id
      setServerStatus(saved.status);
      toast.show('Draft saved: the client can’t see drafts.', { tone: 'success' });
      await reloadProposals();
    } catch (e) {
      toast.show(coachingError(e, 'Couldn’t save the draft. It’s still kept on this device.'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const send = async () => {
    if (!draft || errors.length) return;
    setBusy('send');
    try {
      await coachingApi.saveProposal(payload());
      await coachingApi.sendProposal(draft.proposalId);
      setDraft(null);
      setServerStatus(null);
      toast.show(`Sent to ${who}. Nothing changes until they accept.`, { tone: 'success' });
      await reloadProposals();
    } catch (e) {
      toast.show(coachingError(e, 'Couldn’t send. Your draft is kept on this device. Try again.'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const withdraw = async () => {
    if (!withdrawing) return;
    setBusy('withdraw');
    try {
      await coachingApi.withdrawProposal(withdrawing.id);
      setWithdrawing(null);
      toast.show('Proposal withdrawn', { tone: 'success' });
      await reloadProposals();
    } catch (e) {
      toast.show(coachingError(e, 'Couldn’t withdraw it.'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const fromGenerator = () => {
    const v = generateProgram(answers, EXERCISES, { startDate: today });
    start(proposedFromVersion(v, suggestProgramName(answers, v)), !!base);
  };
  const baseContent = base?.content ?? base?.approxContent ?? null;
  const serverDrafts = proposals.filter((p) => p.status === 'draft');
  const history = [...proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (draft === undefined) return <Spinner label="Loading" />;

  return (
    <>
      <Card className="px-4 py-3">
        <p className="text-sm">
          Building for <span className="font-semibold">{who}</span>
        </p>
        <p className="text-xs text-muted mt-1">
          {overview.training === null
            ? `${who} doesn’t share training, so you can’t see their current plan or workouts.`
            : overview.training.activeProgram
              ? `Current plan: ${overview.training.activeProgram.name} · version ${overview.training.activeProgram.currentVersion}${overview.training.activeProgram.managedBy === 'coach' ? ' · coach-managed' : ''}`
              : `${who} has no active plan.`}
        </p>
      </Card>

      {draft === null ? (
        <>
          <SectionTitle>Start from</SectionTitle>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {base && (
                <li>
                  <ListRow
                    left={<Layers className="size-5 text-accent" aria-hidden />}
                    title={`Revise “${base.name}”`}
                    subtitle={
                      baseContent
                        ? base.content
                          ? `Start from version ${base.version}`
                          : `Start from the version you wrote. ${who} has changed it since (now v${base.version})`
                        : 'Their plan’s content isn’t available to you. Start from a template or the generator and send it as an update'
                    }
                    onClick={baseContent ? () => start(proposedFromVersion(baseContent, base.name), true) : undefined}
                  />
                </li>
              )}
              <li>
                <ListRow left={<Wand2 className="size-5 text-accent" aria-hidden />} title="Generate from intake" subtitle={`Uses ${who}’s shared goals, days, equipment and limitations`} onClick={fromGenerator} />
              </li>
              <li>
                <ListRow left={<FilePlus2 className="size-5 text-accent" aria-hidden />} title="Your templates" subtitle={`${myTemplates.length} session template${myTemplates.length === 1 ? '' : 's'} in your library`} onClick={myTemplates.length ? () => setPickTemplates(true) : undefined} />
              </li>
              <li>
                <ListRow left={<Sparkles className="size-5 text-accent" aria-hidden />} title="Blank plan" subtitle="Add sessions and exercises yourself" onClick={() => start(blankProposed(`${who}’s plan`), !!base)} />
              </li>
              {serverDrafts.map((p) => (
                <li key={p.id}>
                  <ListRow
                    left={<Save className="size-5 text-muted" aria-hidden />}
                    title={`Continue draft: ${p.program.name}`}
                    subtitle={`Saved ${fmtDateTime(p.createdAt)}`}
                    onClick={() => {
                      setDraftState({ proposalId: p.id, program: proposedFromVersion(p.program, p.program.name), revise: !!p.baseProgramId && !!base, message: p.message ?? '', effectiveDate: p.effectiveDate ?? null, savedAt: Date.now() });
                      setServerStatus('draft');
                    }}
                  />
                </li>
              ))}
            </ul>
          </Card>
          {assumed.length > 0 && <p className="text-xs text-muted mt-2 px-1">The generator assumes {assumed.join(', ')} where the intake didn’t say.</p>}
        </>
      ) : (
        <>
          {restored && (
            <Notice className="mt-3">
              Restored your unsaved draft from this device.{' '}
              <button type="button" className="underline font-medium" onClick={() => setDiscardOpen(true)}>
                Discard it
              </button>
            </Notice>
          )}
          <div className="flex items-center gap-2 mt-3">
            <Badge>{serverStatus === 'draft' ? 'Draft saved' : 'Not saved to the server yet'}</Badge>
            <span className="text-xs text-faint">Autosaved on this device</span>
          </div>

          {base && (
            <div className="mt-3">
              <span className="text-sm font-medium block mb-1.5">Send as</span>
              <Segmented
                label="Send as"
                value={draft.revise ? 'revise' : 'new'}
                onChange={(v) => setDraft({ ...draft, revise: v === 'revise' })}
                options={[
                  { value: 'revise', label: `Update “${base.name}”` },
                  { value: 'new', label: 'A new plan' },
                ]}
              />
              <p className="text-xs text-muted mt-1">
                {draft.revise
                  ? `Adds a new version to their plan (based on version ${base.version}). If ${who} changes the plan before accepting, they’ll be asked to get a revision from you.`
                  : 'Becomes their single active plan if they accept; their current plan stays in their history.'}
              </p>
            </div>
          )}

          <div className="mt-4">
            <ProgramEditor
              program={draft.program}
              onChange={(p) => setDraft({ ...draft, program: p })}
              byId={byId}
              catalog={catalog}
              pickerOnlyIds={BUNDLED_IDS}
              pickerOnlyNote="Only exercises from the shared catalog can be sent. Your client’s app doesn’t have your custom exercises."
              unit={unit}
              weekStart={account.settings.weekStart}
              experience={answers.experience}
              goal={answers.goal}
            />
          </div>

          <SectionTitle>For {who}</SectionTitle>
          <Card className="px-4 py-3 flex flex-col gap-3">
            <Textarea label="Message with the proposal (optional)" maxLength={2000} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />
            <Input
              type="date"
              label={draft.revise && base ? 'Suggested start (optional)' : 'Start date (optional)'}
              min={today}
              value={draft.effectiveDate ?? ''}
              onChange={(e) => setDraft({ ...draft, effectiveDate: e.target.value || null })}
              hint={draft.revise && base ? 'Updates apply to their next sessions once accepted.' : 'Leave empty to start when they accept.'}
            />
          </Card>

          <SectionTitle>Changes {useBase ? `vs. version ${base!.version}` : ''}</SectionTitle>
          <Card className="px-4 py-3">
            {useBase && !base!.content && base!.approxContent && (
              <p className="text-xs text-warn mb-2">Compared with the version you wrote. {who} has changed their plan since, so the comparison may miss their own edits.</p>
            )}
            <ul className="list-disc pl-4 text-sm flex flex-col gap-1">
              {changes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            <p className="text-xs text-muted mt-2">The client sees this list. Completed workouts never change.</p>
          </Card>

          {errors.length > 0 && (
            <Notice tone="danger" className="mt-3">
              <p className="font-medium mb-1">Fix before sending:</p>
              <ul className="list-disc pl-4 flex flex-col gap-0.5" role="alert">
                {errors.slice(0, 8).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
              {unknownCustom && <p className="mt-2 text-xs">Custom exercises from your own library can’t be sent. Your client doesn’t have them. Pick a catalog exercise instead.</p>}
            </Notice>
          )}

          <div className="mt-5 flex flex-col gap-2">
            <div className="flex gap-2">
              <Button className="flex-1" icon={<Save className="size-4" />} loading={busy === 'save'} disabled={!!busy || !draft.program.name.trim()} onClick={saveDraft}>
                Save draft
              </Button>
              <Button className="flex-[2]" variant="primary" icon={<Send className="size-4" />} loading={busy === 'send'} disabled={!!busy || errors.length > 0} onClick={send}>
                Send to {who}
              </Button>
            </div>
            <Button variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setDiscardOpen(true)} disabled={!!busy}>
              Start over
            </Button>
          </div>
        </>
      )}

      <SectionTitle>Proposal history</SectionTitle>
      {history.length === 0 ? (
        <Card className="px-4 py-3 text-sm text-muted">Nothing sent yet.</Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {history.map((p) => (
              <li key={p.id} className="flex items-center">
                <div className="flex-1 min-w-0">
                  <ListRow
                    title={p.program.name}
                    subtitle={`Revision ${p.revision} · ${p.baseProgramId ? `update to v${p.baseVersion}` : 'new plan'} · ${fmtDateTime(p.respondedAt ?? p.sentAt ?? p.createdAt)}`}
                    right={<ProposalStatusBadge status={p.status} />}
                    onClick={() => {
                      const keep = p.status === 'draft';
                      setDraft({ proposalId: keep ? p.id : uuid(), program: proposedFromVersion(p.program, p.program.name), revise: !!p.baseProgramId && !!base, message: keep ? (p.message ?? '') : '', effectiveDate: p.effectiveDate ?? null, savedAt: Date.now() });
                      setServerStatus(keep ? 'draft' : null);
                      window.scrollTo?.({ top: 0, behavior: 'smooth' });
                    }}
                  />
                </div>
                {p.status === 'sent' && (
                  <Button size="sm" variant="ghost" className="mr-2" onClick={() => setWithdrawing(p)}>
                    Withdraw
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="px-4 py-2 text-xs text-muted">Tap a proposal to start a new revision from it (drafts reopen as they are).</p>
        </Card>
      )}

      <TemplatePicker
        open={pickTemplates}
        templates={myTemplates}
        onClose={() => setPickTemplates(false)}
        onPick={(ts) => {
          setPickTemplates(false);
          start(proposedFromTemplates(ts.map((t) => t.template), `${who}’s plan`), !!base);
        }}
      />
      <ConfirmDialog
        open={discardOpen}
        title="Start over?"
        body="This clears the editor and the copy saved on this device. Drafts already saved to the server stay in the history."
        confirmLabel="Start over"
        danger
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          setDiscardOpen(false);
          setRestored(false);
          setServerStatus(null);
          setDraft(null);
        }}
      />
      <ConfirmDialog
        open={!!withdrawing}
        title="Withdraw this proposal?"
        body={`${who} won’t be able to accept it any more. Their current plan doesn’t change.`}
        confirmLabel="Withdraw"
        busy={busy === 'withdraw'}
        onCancel={() => setWithdrawing(null)}
        onConfirm={withdraw}
      />
      <div className="sr-only" aria-live="polite">
        {busy === 'send' ? 'Sending proposal' : ''}
      </div>
      <Button variant="ghost" className="mt-4" onClick={() => nav(`/coaching/client/${rel.id}`)}>
        Back to {who}
      </Button>
    </>
  );
}

function TemplatePicker({ open, templates, onClose, onPick }: { open: boolean; templates: SavedTemplate[]; onClose: () => void; onPick: (t: SavedTemplate[]) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const close = () => {
    setSel([]);
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={close}
      title="Choose sessions"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!sel.length}
            onClick={() => {
              const picked = sel.map((id) => templates.find((t) => t.id === id)!).filter(Boolean);
              setSel([]);
              onPick(picked);
            }}
          >
            Use {sel.length || ''} session{sel.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted mb-2">Each session is copied into the client’s plan. Editing it there doesn’t change your template.</p>
      <ul className="flex flex-col gap-1" role="group" aria-label="Templates">
        {templates.map((t) => {
          const on = sel.includes(t.id);
          return (
            <li key={t.id}>
              <label className="flex items-center gap-3 min-h-12 px-2 rounded-xl hover:bg-surface-2 cursor-pointer">
                <input type="checkbox" className="size-5 accent-[var(--color-accent)]" checked={on} onChange={() => setSel(on ? sel.filter((x) => x !== t.id) : [...sel, t.id])} />
                <span className="min-w-0">
                  <span className="block font-medium truncate">{t.template.name}</span>
                  <span className="block text-xs text-muted">
                    {t.template.exercises.length} exercise{t.template.exercises.length === 1 ? '' : 's'} · ~{t.template.estimatedMinutes} min
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
