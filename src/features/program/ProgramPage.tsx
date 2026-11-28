/**
 * /train/program — view and edit the active program. Every edit appends a ProgramVersion
 * (withNewVersion); completed workouts are separate records and never change.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { CalendarRange, ChevronLeft, History, Pencil, Plus, Sparkles, Wand2 } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, ListRow, Notice, Page, SectionTitle, Sheet, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { useExercises } from '@/data/catalog';
import { alive, newRecord, saveRecord } from '@/db/repo';
import { createProgram, currentVersion, blockWeek, restoreVersion, withNewVersion } from '@/domain/program/program';
import { takeOverPlan } from '@/domain/program/proposals';
import { PlanOwnerBadge } from './PlanOwner';
import { emptyTemplate, regenerateTemplates, WEEK_ORDER } from '@/domain/program/generator';
import { splitKeyOfVersion } from '@/domain/program/splits';
import { splitLabel } from '@/domain/program/templates';
import { programDisplayName } from '@/domain/program/localize';
import { formatDate, todayISO, weekdayShort } from '@/lib/dates';
import type { Program, ProgramVersion, SessionTemplate } from '@/domain/types';
import { displaySessionName, PlanLegend, RenameSheet, SessionCard, versionReasonText, WeekStrip, WhyItFits } from './parts';
import { dateTimeText, listText, t as translate, useT, type MessageKey, type Params } from '@/i18n';

/** Stored plan text (names, version reasons) is canonical English; parts.tsx localizes it for display. */
const enText = (key: MessageKey, params?: Params) => translate(key, params, 'en');

export default function ProgramPage() {
  const nav = useNavigate();
  const { db, account } = useApp();
  const toast = useToast();
  const { t, tp, language } = useT();
  const { list: catalog, byId } = useExercises();
  const programs = useLiveQuery(() => db.programs.toArray(), [db]);
  const [regenCount, setRegenCount] = useState<Record<string, number>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [takeOverOpen, setTakeOverOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ProgramVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = useMemo(() => (programs ? alive(programs).filter((p) => p.active).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null : undefined), [programs]);
  const unit = account.settings.units.weight;
  const today = todayISO(account.settings.timeZone);

  const back = (
    <IconButton label={t('common.back')} onClick={() => nav(-1)}>
      <ChevronLeft />
    </IconButton>
  );

  if (programs === undefined) {
    return (
      <Page title={t('train.program')} back={back}>
        <Spinner label={t('program.loading_program')} />
      </Page>
    );
  }

  async function save(p: Program, message?: string) {
    setError(null);
    try {
      await saveRecord('programs', p, db);
      if (message) toast.show(message, { tone: 'success' });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('program.saveFailed'));
    }
  }

  async function createManual() {
    setBusy(true);
    try {
      const v: ProgramVersion = {
        version: 1,
        createdAt: Date.now(),
        reason: enText('onboarding.manualReason'),
        templates: [emptyTemplate('custom:a', enText('onboarding.manualSessionName', { letter: 'A' }))],
        schedule: [],
        weeks: 8,
        reviewWeek: 8,
        rationale: [enText('program.manualBuiltRationale')],
        warnings: [],
      };
      for (const p of alive(programs ?? []).filter((x) => x.active)) await saveRecord('programs', { ...p, active: false }, db);
      await saveRecord('programs', createProgram(null, v, today, enText('onboarding.myProgram'), 'manual'), db);
      toast.show(t('program.program_created_add_exercises_to_your'), { tone: 'success' });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('program.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (!active) {
    return (
      <Page title={t('train.program')} back={back}>
        {error && <ErrorState message={error} onRetry={() => setError(null)} />}
        <EmptyState
          icon={<CalendarRange className="size-6" />}
          title={t('program.no_active_program')}
          body={t('program.answer_a_few_questions_and_well')}
          action={
            <div className="flex flex-col gap-2 w-full max-w-xs">
              <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => nav('/onboarding')}>
                {t('train.suggest')}
              </Button>
              <Button icon={<Plus className="size-4" />} loading={busy} onClick={createManual}>
                {t('program.create_my_own')}
              </Button>
            </div>
          }
        />
      </Page>
    );
  }

  const program = active;
  const v = currentVersion(program);
  const week = blockWeek(program, today);
  const answers = program.inputs;
  const versionData = (patch: Partial<ProgramVersion>, reason: string) => {
    const { version: _a, createdAt: _b, ...rest } = v;
    void _a;
    void _b;
    return { ...rest, ...patch, reason };
  };
  const commit = (patch: Partial<ProgramVersion>, reason: string, message?: string) => save(withNewVersion(program, versionData(patch, reason)), message);

  const updateTemplate = (next: SessionTemplate, reason: string) => commit({ templates: v.templates.map((x) => (x.id === next.id ? next : x)) }, reason);
  const setDays = (tpl: SessionTemplate, days: number[]) => {
    const schedule = [...v.schedule.filter((s) => s.templateId !== tpl.id), ...days.map((weekday) => ({ weekday, templateId: tpl.id }))].sort(
      (a, b) => WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday),
    );
    void commit({ schedule }, enText('program.changedDays', { sessionName: tpl.name }), t('program.scheduleUpdated'));
  };
  const doubleBooked = WEEK_ORDER.filter((d) => v.schedule.filter((s) => s.weekday === d).length > 1);

  const regenerate = (tpl: SessionTemplate) => {
    if (!answers) return;
    const n = (regenCount[tpl.id] ?? 0) + 1;
    setRegenCount({ ...regenCount, [tpl.id]: n });
    const next = regenerateTemplates(v, [tpl.id], answers, catalog, n);
    void commit({ templates: next.templates }, next.reason, t('program.shuffledToast', { sessionName: displaySessionName(tpl) }));
  };
  const duplicate = async (tpl: SessionTemplate) => {
    try {
      await saveRecord('templates', newRecord({ template: { ...tpl, id: `lib:${Date.now().toString(36)}` } }), db);
      toast.show(t('program.x_saved_to_your_templates', { sessionName: displaySessionName(tpl) }), { tone: 'success', action: { label: t('program.view'), onClick: () => nav('/train/templates') } });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('program.templateSaveFailed'));
    }
  };
  const remove = (tpl: SessionTemplate) =>
    commit(
      { templates: v.templates.filter((x) => x.id !== tpl.id), schedule: v.schedule.filter((s) => s.templateId !== tpl.id) },
      enText('program.deletedSession', { sessionName: tpl.name }),
      t('program.sessionDeletedToast', { sessionName: displaySessionName(tpl) }),
    );
  const addSession = () => {
    const letter = String.fromCharCode(65 + (v.templates.filter((x) => x.kind === 'lifting').length % 26));
    const tpl = emptyTemplate(`custom:${Date.now().toString(36)}`, enText('onboarding.manualSessionName', { letter }));
    void commit({ templates: [...v.templates, tpl] }, enText('program.addedSession', { sessionName: tpl.name }), t('program.sessionAddedToast', { sessionName: displaySessionName(tpl) }));
  };

  const versions = [...program.versions].sort((a, b) => b.version - a.version);
  const splitKey = splitKeyOfVersion(v);

  return (
    <Page
      title={t('train.program')}
      back={back}
      actions={
        <IconButton label={t('program.version_history')} onClick={() => setHistoryOpen(true)}>
          <History className="size-5" />
        </IconButton>
      }
    >
      {error && (
        <Notice tone="danger" className="mb-3">
          {error}
        </Notice>
      )}
      {program.managedBy && program.managedBy.kind !== 'self' && (
        <Notice tone={program.managedBy.kind === 'coach' ? 'accent' : 'info'} className="mb-3">
          <PlanOwnerBadge program={program} className="mb-1.5" />
          <p>
            {program.managedBy.kind === 'coach'
              ? t('program.you_can_still_adjust_it_every')
              : t('program.you_can_adjust_it_like_any')}
          </p>
          <Button size="sm" className="mt-2" onClick={() => setTakeOverOpen(true)}>
            {t('program.make_it_self_managed')}
          </Button>
        </Notice>
      )}
      <ConfirmDialog
        open={takeOverOpen}
        title={t('program.manage_this_plan_yourself')}
        body={
          program.managedBy?.kind === 'coach'
            ? t('program.the_plan_stays_exactly_as_it_2')
            : t('program.the_plan_stays_exactly_as_it')
        }
        confirmLabel={t('program.make_self_managed')}
        onConfirm={() => {
          setTakeOverOpen(false);
          void save(takeOverPlan(program), t('program.tookOverToast'));
        }}
        onCancel={() => setTakeOverOpen(false)}
      />
      <Card className="px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight">{programDisplayName(program.name)}</h2>
            <p className="text-sm text-muted mt-1">
              {t('program.weekLine', { week: Math.min(week, v.weeks), weeks: v.weeks, reviewWeek: v.reviewWeek, date: formatDate(program.startDate) })}
            </p>
            {splitKey && (
              <p className="text-sm mt-1">
                <span className="text-muted">{t('onboarding.result.splitLabel')} </span>
                {splitLabel(splitKey)}
              </p>
            )}
            <div className="flex gap-1.5 mt-2 flex-wrap">
              <Badge tone={program.source === 'generated' ? 'accent' : 'neutral'}>{program.source === 'generated' ? t('program.suggested_plan') : t('program.your_own_plan')}</Badge>
              <Badge>{t('program.version_xx', { version: v.version })}</Badge>
            </div>
          </div>
          <IconButton label={t('program.rename_program')} onClick={() => setRenaming(true)}>
            <Pencil className="size-4" />
          </IconButton>
        </div>
        {week >= v.reviewWeek && (
          <Notice tone="accent" className="mt-3">
            {t('program.its_review_time_how_did_the')}{' '}
            <button type="button" className="underline font-medium" onClick={() => nav('/onboarding')}>
              {t('program.or_get_a_fresh_suggestion')}
            </button>
            .
          </Notice>
        )}
      </Card>

      <SectionTitle>{t('today.thisWeek')}</SectionTitle>
      <WeekStrip version={v} weekStart={account.settings.weekStart} />
      {doubleBooked.length > 0 && (
        <Notice tone="warn" className="mt-2">
          {tp('program.doubleBooked', doubleBooked.length, { days: listText(doubleBooked.map((d) => weekdayShort(d, language)), language) })}
        </Notice>
      )}

      <SectionTitle
        action={
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={addSession}>
            {t('program.add_session')}
          </Button>
        }
      >
        {t('aiCard.proposal.sessions')}
      </SectionTitle>
      <PlanLegend />
      <div className="flex flex-col gap-3">
        {v.templates.map((tpl) => (
          <SessionCard
            key={tpl.id}
            template={tpl}
            byId={byId}
            catalog={catalog}
            unit={unit}
            editable
            experience={answers?.experience}
            goal={answers?.goal}
            days={v.schedule.filter((s) => s.templateId === tpl.id).map((s) => s.weekday)}
            defaultOpen={v.templates.length <= 3}
            onChange={(next, reason) => void updateTemplate(next, reason)}
            onDaysChange={(d) => setDays(tpl, d)}
            onRegenerate={answers && tpl.exercises.length > 0 ? () => regenerate(tpl) : undefined}
            onDuplicate={tpl.exercises.length ? () => void duplicate(tpl) : undefined}
            onDelete={() => void remove(tpl)}
          />
        ))}
        {v.templates.length === 0 && (
          <EmptyState title={t('program.no_sessions_yet')} body={t('program.add_a_session_and_choose_its')} action={<Button onClick={addSession}>{t('program.add_session')}</Button>} />
        )}
      </div>

      <WhyItFits version={v} defaultOpen={false} experience={account.profile.experience} />

      <div className="mt-6 flex flex-col gap-2">
        <Button variant="outline" icon={<Wand2 className="size-4" />} onClick={() => nav('/onboarding')}>
          {t('program.change_split_or_get_a_new')}
        </Button>
        <p className="text-xs text-muted px-1">{t('program.runs_setup_again_your_current_plan')}</p>
      </div>

      <RenameSheet
        open={renaming}
        value={programDisplayName(program.name)}
        title={t('program.rename_program')}
        onClose={() => setRenaming(false)}
        onSave={(name) => {
          setRenaming(false);
          void save({ ...program, name }, t('program.renamedToast'));
        }}
      />

      <Sheet open={historyOpen} onClose={() => setHistoryOpen(false)} title={t('program.version_history')}>
        <p className="text-sm text-muted mb-3">{t('program.every_change_is_saved_as_a')}</p>
        <ul className="-mx-4 divide-y divide-line">
          {versions.map((ver) => (
            <li key={ver.version}>
              <ListRow
                title={ver.version === program.currentVersion ? t('program.versionCurrent', { version: ver.version }) : t('program.version_xx', { version: ver.version })}
                subtitle={`${dateTimeText(ver.createdAt, account.settings.timeZone, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${versionReasonText(ver.reason, ver.templates)}`}
                right={
                  ver.version !== program.currentVersion ? (
                    <Button size="sm" onClick={() => setRestoreTarget(ver)}>
                      {t('program.restore')}
                    </Button>
                  ) : undefined
                }
              />
            </li>
          ))}
        </ul>
      </Sheet>
      <ConfirmDialog
        open={!!restoreTarget}
        title={restoreTarget ? t('program.restore_version_x', { version: restoreTarget.version }) : t('program.restore')}
        body={t('program.this_saves_a_copy_of_that')}
        confirmLabel={t('program.restore')}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => {
          if (!restoreTarget) return;
          const n = restoreTarget.version;
          setRestoreTarget(null);
          setHistoryOpen(false);
          void save(restoreVersion(program, n), t('program.restoredVersion', { version: n }));
        }}
      />
    </Page>
  );
}
