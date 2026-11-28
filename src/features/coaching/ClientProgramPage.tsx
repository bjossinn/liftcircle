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
import { listText, useT } from '@/i18n';
import { programDisplayName } from '@/domain/program/localize';
import { uuid } from '@/lib/id';
import { coachingError } from '@/coaching/errors';
import {
  asVersion, blankProposed, intakeToAnswers, loadEditorDraft, proposedFromTemplates, proposedFromVersion, saveEditorDraft, type EditorDraft,
} from '@/coaching/programDraft';
import { BackButton, CoachingAccessNotice, ProposalStatusBadge, fmtDateTime, slot, useCoachingAccess, useLoad, withSlots } from './tools/common';
import { CoachGate, useCoachStatus } from './tools/coach';
import { ProgramEditor } from './tools/ProgramEditor';
import { exerciseDisplayName } from '@/data/catalogText';
import { displaySessionName } from '@/features/program/parts';

const BUNDLED_IDS = new Set(EXERCISES.map((e) => e.id));

export default function ClientProgramPage() {
  const { relationshipId = '' } = useParams();
  const nav = useNavigate();
  const { t } = useT();
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
    <Page title={t('coaching.client.client_program')} back={<BackButton to={`/coaching/client/${relationshipId}`} />}>
      {!ok ? (
        <CoachingAccessNotice access={access} what={t('coaching.client.what_program_builder')} />
      ) : !approved ? (
        <CoachGate state={coach.state} profile={coach.profile} error={coach.error} reload={coach.reload} />
      ) : relQ.error && rel === undefined ? (
        <ErrorState title={t('coaching.client.couldnt_load_this_client')} message={relQ.error} onRetry={relQ.reload} />
      ) : rel === undefined ? (
        <Spinner label={t('common.loading')} />
      ) : rel === null || !active ? (
        <EmptyState
          title={t('coaching.client.coaching_isnt_active')}
          body={t('coaching.client.you_can_build_programs_only_for')}
          action={<Button onClick={() => nav('/coaching/dashboard')}>{t('coaching.client.dashboard')}</Button>}
        />
      ) : (overview.error && !overview.data) || (proposals.error && !proposals.data) ? (
        <ErrorState title={t('coaching.client.couldnt_load_the_clients_program')} message={overview.error ?? proposals.error ?? undefined} onRetry={() => Promise.all([overview.reload(), proposals.reload()]).then(() => {})} />
      ) : !overview.data || !proposals.data ? (
        <Spinner label={t('coaching.client.loading_the_clients_plan')} />
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
  const { t, tp, language } = useT();
  const { db, account } = useApp();
  const { list: catalog, byId } = useExercises();
  const unit = account.settings.units.weight;
  const today = todayISO(account.settings.timeZone);
  const who = rel.client.displayName || t('coaching.client.your_client');
  // Default program name: a prefill in the coach's language; the coach can rename it before sending.
  const defaultName = t('coaching.client.default_plan_name', { name: who });
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
            toast.show(t('coaching.client.added_x_to_your_draft', { name: tpl.template.name }), { tone: 'success' });
          } else start(proposedFromTemplates([tpl.template], defaultName), false);
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
    if (program.reviewWeek < 1 || program.reviewWeek > program.weeks) e.push(t('coaching.client.review_week_within_block'));
    return e;
  }, [program, t]);
  // Exercises (or substitutes) missing from the shared catalog: the coach's own custom exercises.
  const unknownCustom = !!program?.templates.some((tpl) => tpl.exercises.some((rx) => !BUNDLED_IDS.has(rx.exerciseId) || (rx.alternatives ?? []).some((a) => !BUNDLED_IDS.has(a))));
  const nameOf = (id: string) => exerciseDisplayName(id, byId);
  const useBase = !!draft?.revise && !!base;
  const changes = useMemo(() => {
    if (!program) return [];
    if (!useBase) return describeChanges(null, program, nameOf);
    const known = base!.content ?? base!.approxContent;
    if (!known) return [t('coaching.client.replaces_sessions_of_x', { name: programDisplayName(base!.name), version: base!.version }), ...describeChanges(null, program, nameOf)];
    return describeChanges(asVersion(known, base!.version), program, nameOf);
  }, [program, useBase, base, byId, t]); // eslint-disable-line react-hooks/exhaustive-deps

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
      toast.show(t('coaching.client.draft_saved_the_client_cant_see'), { tone: 'success' });
      await reloadProposals();
    } catch (e) {
      toast.show(coachingError(e, t('coaching.client.couldnt_save_draft')), { tone: 'error' });
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
      toast.show(t('coaching.client.sent_to_x_nothing_changes_until', { name: who }), { tone: 'success' });
      await reloadProposals();
    } catch (e) {
      toast.show(coachingError(e, t('coaching.client.couldnt_send')), { tone: 'error' });
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
      toast.show(t('coaching.client.proposal_withdrawn'), { tone: 'success' });
      await reloadProposals();
    } catch (e) {
      toast.show(coachingError(e, t('coaching.client.couldnt_withdraw')), { tone: 'error' });
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

  if (draft === undefined) return <Spinner label={t('common.loading')} />;

  return (
    <>
      <Card className="px-4 py-3">
        <p className="text-sm">
          {withSlots(t('coaching.client.building_for', { name: slot('name') }), { name: <span className="font-semibold">{who}</span> })}
        </p>
        <p className="text-xs text-muted mt-1">
          {overview.training === null
            ? t('coaching.client.x_doesnt_share_training_so_you', { name: who })
            : overview.training.activeProgram
              ? t(overview.training.activeProgram.managedBy === 'coach' ? 'coaching.client.current_plan_coach_managed' : 'coaching.client.current_plan_x_version_xx', {
                  name: programDisplayName(overview.training.activeProgram.name),
                  version: overview.training.activeProgram.currentVersion,
                })
              : t('coaching.client.x_has_no_active_plan', { name: who })}
        </p>
      </Card>

      {draft === null ? (
        <>
          <SectionTitle>{t('coaching.client.start_from')}</SectionTitle>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {base && (
                <li>
                  <ListRow
                    left={<Layers className="size-5 text-accent" aria-hidden />}
                    title={t('coaching.client.revise_x', { name: programDisplayName(base.name) })}
                    subtitle={
                      baseContent
                        ? base.content
                          ? t('coaching.client.start_from_version_x', { version: base.version })
                          : t('coaching.client.start_from_the_version_you_wrote', { name: who, version: base.version })
                        : t('coaching.client.their_plans_content_isnt_available_to')
                    }
                    onClick={baseContent ? () => start(proposedFromVersion(baseContent, base.name), true) : undefined}
                  />
                </li>
              )}
              <li>
                <ListRow left={<Wand2 className="size-5 text-accent" aria-hidden />} title={t('coaching.client.generate_from_intake')} subtitle={t('coaching.client.uses_xs_shared_goals_days_equipment', { name: who })} onClick={fromGenerator} />
              </li>
              <li>
                <ListRow left={<FilePlus2 className="size-5 text-accent" aria-hidden />} title={t('coaching.client.your_templates')} subtitle={tp('coaching.client.session_templates_in_library', myTemplates.length)} onClick={myTemplates.length ? () => setPickTemplates(true) : undefined} />
              </li>
              <li>
                <ListRow left={<Sparkles className="size-5 text-accent" aria-hidden />} title={t('coaching.client.blank_plan')} subtitle={t('coaching.client.add_sessions_and_exercises_yourself')} onClick={() => start(blankProposed(defaultName), !!base)} />
              </li>
              {serverDrafts.map((p) => (
                <li key={p.id}>
                  <ListRow
                    left={<Save className="size-5 text-muted" aria-hidden />}
                    title={t('coaching.client.continue_draft_x', { name: programDisplayName(p.program.name) })}
                    subtitle={t('coaching.client.saved_x', { date: fmtDateTime(p.createdAt) })}
                    onClick={() => {
                      setDraftState({ proposalId: p.id, program: proposedFromVersion(p.program, p.program.name), revise: !!p.baseProgramId && !!base, message: p.message ?? '', effectiveDate: p.effectiveDate ?? null, savedAt: Date.now() });
                      setServerStatus('draft');
                    }}
                  />
                </li>
              ))}
            </ul>
          </Card>
          {assumed.length > 0 && <p className="text-xs text-muted mt-2 px-1">{t('coaching.client.the_generator_assumes', { assumptions: listText(assumed, language) })}</p>}
        </>
      ) : (
        <>
          {restored && (
            <Notice className="mt-3">
              {t('coaching.client.restored_your_unsaved_draft_from_this')}{' '}
              <button type="button" className="underline font-medium" onClick={() => setDiscardOpen(true)}>
                {t('coaching.client.discard_it')}
              </button>
            </Notice>
          )}
          <div className="flex items-center gap-2 mt-3">
            <Badge>{serverStatus === 'draft' ? t('coaching.apply.draft_saved') : t('coaching.client.not_saved_to_the_server_yet')}</Badge>
            <span className="text-xs text-faint">{t('coaching.client.autosaved_on_this_device')}</span>
          </div>

          {base && (
            <div className="mt-3">
              <span className="text-sm font-medium block mb-1.5">{t('coaching.client.send_as')}</span>
              <Segmented
                label={t('coaching.client.send_as')}
                value={draft.revise ? 'revise' : 'new'}
                onChange={(v) => setDraft({ ...draft, revise: v === 'revise' })}
                options={[
                  { value: 'revise', label: t('coaching.client.update_x', { name: programDisplayName(base.name) }) },
                  { value: 'new', label: t('coaching.client.a_new_plan') },
                ]}
              />
              <p className="text-xs text-muted mt-1">
                {draft.revise
                  ? t('coaching.client.adds_a_new_version_to_their', { version: base.version, name: who })
                  : t('coaching.client.becomes_their_single_active_plan_if')}
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
              pickerOnlyNote={t('coaching.client.picker_only_note')}
              unit={unit}
              weekStart={account.settings.weekStart}
              experience={answers.experience}
              goal={answers.goal}
            />
          </div>

          <SectionTitle>{t('coaching.client.for_x', { name: who })}</SectionTitle>
          <Card className="px-4 py-3 flex flex-col gap-3">
            <Textarea label={t('coaching.client.message_with_the_proposal_optional')} maxLength={2000} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />
            <Input
              type="date"
              label={draft.revise && base ? t('coaching.client.suggested_start_optional') : t('coaching.client.start_date_optional')}
              min={today}
              value={draft.effectiveDate ?? ''}
              onChange={(e) => setDraft({ ...draft, effectiveDate: e.target.value || null })}
              hint={draft.revise && base ? t('coaching.client.updates_apply_to_their_next_sessions') : t('coaching.client.leave_empty_to_start_when_they')}
            />
          </Card>

          <SectionTitle>{useBase ? t('coaching.client.changes_vs_version', { version: base!.version }) : t('coaching.client.changes')}</SectionTitle>
          <Card className="px-4 py-3">
            {useBase && !base!.content && base!.approxContent && (
              <p className="text-xs text-warn mb-2">{t('coaching.client.compared_with_the_version_you_wrote', { name: who })}</p>
            )}
            <ul className="list-disc pl-4 text-sm flex flex-col gap-1">
              {changes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            <p className="text-xs text-muted mt-2">{t('coaching.client.the_client_sees_this_list_completed')}</p>
          </Card>

          {errors.length > 0 && (
            <Notice tone="danger" className="mt-3">
              <p className="font-medium mb-1">{t('coaching.client.fix_before_sending')}</p>
              <ul className="list-disc pl-4 flex flex-col gap-0.5" role="alert">
                {errors.slice(0, 8).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
              {unknownCustom && <p className="mt-2 text-xs">{t('coaching.client.custom_exercises_from_your_own_library')}</p>}
            </Notice>
          )}

          <div className="mt-5 flex flex-col gap-2">
            <div className="flex gap-2">
              <Button className="flex-1" icon={<Save className="size-4" />} loading={busy === 'save'} disabled={!!busy || !draft.program.name.trim()} onClick={saveDraft}>
                {t('coaching.apply.save_draft')}
              </Button>
              <Button className="flex-[2]" variant="primary" icon={<Send className="size-4" />} loading={busy === 'send'} disabled={!!busy || errors.length > 0} onClick={send}>
                {t('coaching.client.send_to_x', { name: who })}
              </Button>
            </div>
            <Button variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setDiscardOpen(true)} disabled={!!busy}>
              {t('onboarding.restart')}
            </Button>
          </div>
        </>
      )}

      <SectionTitle>{t('coaching.client.proposal_history')}</SectionTitle>
      {history.length === 0 ? (
        <Card className="px-4 py-3 text-sm text-muted">{t('coaching.client.nothing_sent_yet')}</Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {history.map((p) => (
              <li key={p.id} className="flex items-center">
                <div className="flex-1 min-w-0">
                  <ListRow
                    title={programDisplayName(p.program.name)}
                    subtitle={t('coaching.client.revision_x_x_x', {
                      revision: p.revision,
                      kind: p.baseProgramId ? t('coaching.client.update_to_vx', { version: p.baseVersion ?? '' }) : t('coaching.client.new_plan_lower'),
                      date: fmtDateTime(p.respondedAt ?? p.sentAt ?? p.createdAt),
                    })}
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
                    {t('coaching.client.withdraw')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="px-4 py-2 text-xs text-muted">{t('coaching.client.tap_a_proposal_to_start_a')}</p>
        </Card>
      )}

      <TemplatePicker
        open={pickTemplates}
        templates={myTemplates}
        onClose={() => setPickTemplates(false)}
        onPick={(ts) => {
          setPickTemplates(false);
          start(proposedFromTemplates(ts.map((x) => x.template), defaultName), !!base);
        }}
      />
      <ConfirmDialog
        open={discardOpen}
        title={t('onboarding.restartTitle')}
        body={t('coaching.client.this_clears_the_editor_and_the')}
        confirmLabel={t('onboarding.restart')}
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
        title={t('coaching.client.withdraw_this_proposal')}
        body={t('coaching.client.x_wont_be_able_to_accept', { name: who })}
        confirmLabel={t('coaching.client.withdraw')}
        busy={busy === 'withdraw'}
        onCancel={() => setWithdrawing(null)}
        onConfirm={withdraw}
      />
      <div className="sr-only" aria-live="polite">
        {busy === 'send' ? t('coaching.client.sending_proposal') : ''}
      </div>
      <Button variant="ghost" className="mt-4" onClick={() => nav(`/coaching/client/${rel.id}`)}>
        {t('coaching.client.back_to_x', { name: who })}
      </Button>
    </>
  );
}

function TemplatePicker({ open, templates, onClose, onPick }: { open: boolean; templates: SavedTemplate[]; onClose: () => void; onPick: (t: SavedTemplate[]) => void }) {
  const { t, tp } = useT();
  const [sel, setSel] = useState<string[]>([]);
  const close = () => {
    setSel([]);
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={close}
      title={t('coaching.client.choose_sessions')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!sel.length}
            onClick={() => {
              const picked = sel.map((id) => templates.find((x) => x.id === id)!).filter(Boolean);
              setSel([]);
              onPick(picked);
            }}
          >
            {sel.length ? tp('coaching.client.use_sessions', sel.length) : t('coaching.client.use_sessions_none')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted mb-2">{t('coaching.client.each_session_is_copied_into_the')}</p>
      <ul className="flex flex-col gap-1" role="group" aria-label={t('train.templateTitle')}>
        {templates.map((st) => {
          const on = sel.includes(st.id);
          return (
            <li key={st.id}>
              <label className="flex items-center gap-3 min-h-12 px-2 rounded-xl hover:bg-surface-2 cursor-pointer">
                <input type="checkbox" className="size-5 accent-[var(--color-accent)]" checked={on} onChange={() => setSel(on ? sel.filter((x) => x !== st.id) : [...sel, st.id])} />
                <span className="min-w-0">
                  <span className="block font-medium truncate">{displaySessionName(st.template)}</span>
                  <span className="block text-xs text-muted">
                    {tp('coaching.client.exercises_count', st.template.exercises.length)} · ~{t('coaching.client.x_min', { minutes: st.template.estimatedMinutes })}
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
