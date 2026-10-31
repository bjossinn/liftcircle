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
import { SPLITS } from '@/domain/program/templates';
import { formatDate, todayISO, WEEKDAY_SHORT } from '@/lib/dates';
import type { Program, ProgramVersion, SessionTemplate } from '@/domain/types';
import { PlanLegend, RenameSheet, SessionCard, WeekStrip, WhyItFits } from './parts';

export default function ProgramPage() {
  const nav = useNavigate();
  const { db, account } = useApp();
  const toast = useToast();
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
    <IconButton label="Back" onClick={() => nav(-1)}>
      <ChevronLeft />
    </IconButton>
  );

  if (programs === undefined) {
    return (
      <Page title="Program" back={back}>
        <Spinner label="Loading program" />
      </Page>
    );
  }

  async function save(p: Program, message?: string) {
    setError(null);
    try {
      await saveRecord('programs', p, db);
      if (message) toast.show(message, { tone: 'success' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your program.');
    }
  }

  async function createManual() {
    setBusy(true);
    try {
      const v: ProgramVersion = {
        version: 1,
        createdAt: Date.now(),
        reason: 'Created manually',
        templates: [emptyTemplate('custom:a', 'Session A')],
        schedule: [],
        weeks: 8,
        reviewWeek: 8,
        rationale: ['You built this program yourself. Add sessions, exercises and days. Every change is saved as a new version you can restore.'],
        warnings: [],
      };
      for (const p of alive(programs ?? []).filter((x) => x.active)) await saveRecord('programs', { ...p, active: false }, db);
      await saveRecord('programs', createProgram(null, v, today, 'My program', 'manual'), db);
      toast.show('Program created: add exercises to your first session.', { tone: 'success' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the program.');
    } finally {
      setBusy(false);
    }
  }

  if (!active) {
    return (
      <Page title="Program" back={back}>
        {error && <ErrorState message={error} onRetry={() => setError(null)} />}
        <EmptyState
          icon={<CalendarRange className="size-6" />}
          title="No active program"
          body="Answer a few questions and we’ll suggest a starting plan you can edit, or build your own routine from scratch."
          action={
            <div className="flex flex-col gap-2 w-full max-w-xs">
              <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => nav('/onboarding')}>
                Suggest a program
              </Button>
              <Button icon={<Plus className="size-4" />} loading={busy} onClick={createManual}>
                Create my own
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

  const updateTemplate = (t: SessionTemplate, reason: string) => commit({ templates: v.templates.map((x) => (x.id === t.id ? t : x)) }, reason);
  const setDays = (t: SessionTemplate, days: number[]) => {
    const schedule = [...v.schedule.filter((s) => s.templateId !== t.id), ...days.map((weekday) => ({ weekday, templateId: t.id }))].sort(
      (a, b) => WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday),
    );
    void commit({ schedule }, `Changed days for ${t.name}`, 'Schedule updated');
  };
  const doubleBooked = WEEK_ORDER.filter((d) => v.schedule.filter((s) => s.weekday === d).length > 1);

  const regenerate = (t: SessionTemplate) => {
    if (!answers) return;
    const n = (regenCount[t.id] ?? 0) + 1;
    setRegenCount({ ...regenCount, [t.id]: n });
    const next = regenerateTemplates(v, [t.id], answers, catalog, n);
    void commit({ templates: next.templates }, next.reason, `Shuffled exercises in ${t.name}. Same split; older versions stay in history`);
  };
  const duplicate = async (t: SessionTemplate) => {
    try {
      await saveRecord('templates', newRecord({ template: { ...t, id: `lib:${Date.now().toString(36)}` } }), db);
      toast.show(`${t.name} saved to your templates`, { tone: 'success', action: { label: 'View', onClick: () => nav('/train/templates') } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the template.');
    }
  };
  const remove = (t: SessionTemplate) =>
    commit({ templates: v.templates.filter((x) => x.id !== t.id), schedule: v.schedule.filter((s) => s.templateId !== t.id) }, `Deleted ${t.name}`, `${t.name} deleted`);
  const addSession = () => {
    const letter = String.fromCharCode(65 + (v.templates.filter((t) => t.kind === 'lifting').length % 26));
    const t = emptyTemplate(`custom:${Date.now().toString(36)}`, `Session ${letter}`);
    void commit({ templates: [...v.templates, t] }, `Added ${t.name}`, `${t.name} added`);
  };

  const versions = [...program.versions].sort((a, b) => b.version - a.version);
  const splitKey = splitKeyOfVersion(v);

  return (
    <Page
      title="Program"
      back={back}
      actions={
        <IconButton label="Version history" onClick={() => setHistoryOpen(true)}>
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
              ? 'You can still adjust it. Every change is a new version; your coach sees that the plan changed and any update they were preparing will need revising before you can accept it.'
              : 'You can adjust it like any plan. AI suggestions written for an older version of this plan can no longer be applied.'}
          </p>
          <Button size="sm" className="mt-2" onClick={() => setTakeOverOpen(true)}>
            Make it self-managed
          </Button>
        </Notice>
      )}
      <ConfirmDialog
        open={takeOverOpen}
        title="Manage this plan yourself?"
        body={
          program.managedBy?.kind === 'coach'
            ? 'The plan stays exactly as it is, but it’s no longer marked as your coach’s plan. Your coaching relationship and messages aren’t affected, and your workouts don’t change.'
            : 'The plan stays exactly as it is, but it’s no longer marked as AI-suggested. Your workouts don’t change.'
        }
        confirmLabel="Make self-managed"
        onConfirm={() => {
          setTakeOverOpen(false);
          void save(takeOverPlan(program), 'You now manage this plan yourself');
        }}
        onCancel={() => setTakeOverOpen(false)}
      />
      <Card className="px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight">{program.name}</h2>
            <p className="text-sm text-muted mt-1">
              Week {Math.min(week, v.weeks)} of {v.weeks} · review in week {v.reviewWeek} · started {formatDate(program.startDate)}
            </p>
            {splitKey && (
              <p className="text-sm mt-1">
                <span className="text-muted">Split: </span>
                {SPLITS[splitKey].label}
              </p>
            )}
            <div className="flex gap-1.5 mt-2 flex-wrap">
              <Badge tone={program.source === 'generated' ? 'accent' : 'neutral'}>{program.source === 'generated' ? 'Suggested plan' : 'Your own plan'}</Badge>
              <Badge>Version {v.version}</Badge>
            </div>
          </div>
          <IconButton label="Rename program" onClick={() => setRenaming(true)}>
            <Pencil className="size-4" />
          </IconButton>
        </div>
        {week >= v.reviewWeek && (
          <Notice tone="accent" className="mt-3">
            It’s review time. How did the block go? Keep what worked, adjust days or swap exercises,{' '}
            <button type="button" className="underline font-medium" onClick={() => nav('/onboarding')}>
              or get a fresh suggestion
            </button>
            .
          </Notice>
        )}
      </Card>

      <SectionTitle>This week</SectionTitle>
      <WeekStrip version={v} weekStart={account.settings.weekStart} />
      {doubleBooked.length > 0 && (
        <Notice tone="warn" className="mt-2">
          {doubleBooked.map((d) => WEEKDAY_SHORT[d]).join(', ')} {doubleBooked.length === 1 ? 'has' : 'have'} more than one session. That’s fine for an easy walk plus lifting, but avoid two hard sessions on one day.
        </Notice>
      )}

      <SectionTitle
        action={
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={addSession}>
            Add session
          </Button>
        }
      >
        Sessions
      </SectionTitle>
      <PlanLegend />
      <div className="flex flex-col gap-3">
        {v.templates.map((t) => (
          <SessionCard
            key={t.id}
            template={t}
            byId={byId}
            catalog={catalog}
            unit={unit}
            editable
            experience={answers?.experience}
            goal={answers?.goal}
            days={v.schedule.filter((s) => s.templateId === t.id).map((s) => s.weekday)}
            defaultOpen={v.templates.length <= 3}
            onChange={(next, reason) => void updateTemplate(next, reason)}
            onDaysChange={(d) => setDays(t, d)}
            onRegenerate={answers && t.exercises.length > 0 ? () => regenerate(t) : undefined}
            onDuplicate={t.exercises.length ? () => void duplicate(t) : undefined}
            onDelete={() => void remove(t)}
          />
        ))}
        {v.templates.length === 0 && (
          <EmptyState title="No sessions yet" body="Add a session and choose its exercises. A custom split from scratch." action={<Button onClick={addSession}>Add session</Button>} />
        )}
      </div>

      <WhyItFits version={v} defaultOpen={false} />

      <div className="mt-6 flex flex-col gap-2">
        <Button variant="outline" icon={<Wand2 className="size-4" />} onClick={() => nav('/onboarding')}>
          Change split or get a new suggested program
        </Button>
        <p className="text-xs text-muted px-1">Runs setup again. Your current plan and workouts are kept; nothing changes until you accept a new plan.</p>
      </div>

      <RenameSheet
        open={renaming}
        value={program.name}
        title="Rename program"
        onClose={() => setRenaming(false)}
        onSave={(name) => {
          setRenaming(false);
          void save({ ...program, name }, 'Program renamed');
        }}
      />

      <Sheet open={historyOpen} onClose={() => setHistoryOpen(false)} title="Version history">
        <p className="text-sm text-muted mb-3">Every change is saved as a version. Restoring creates a new version, and completed workouts are never changed.</p>
        <ul className="-mx-4 divide-y divide-line">
          {versions.map((ver) => (
            <li key={ver.version}>
              <ListRow
                title={`Version ${ver.version}${ver.version === program.currentVersion ? ' (current)' : ''}`}
                subtitle={`${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ver.createdAt))} · ${ver.reason}`}
                right={
                  ver.version !== program.currentVersion ? (
                    <Button size="sm" onClick={() => setRestoreTarget(ver)}>
                      Restore
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
        title={restoreTarget ? `Restore version ${restoreTarget.version}?` : 'Restore'}
        body="This saves a copy of that version as the newest one. Your current version stays in history."
        confirmLabel="Restore"
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => {
          if (!restoreTarget) return;
          const n = restoreTarget.version;
          setRestoreTarget(null);
          setHistoryOpen(false);
          void save(restoreVersion(program, n), `Restored version ${n}`);
        }}
      />
    </Page>
  );
}
