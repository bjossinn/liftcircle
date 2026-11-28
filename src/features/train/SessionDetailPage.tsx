import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, Layers, Plus, Repeat, Share2, Trash2, X } from 'lucide-react';
import { useApp } from '@/state/app';
import { deleteRecord, newRecord, saveRecord } from '@/db/repo';
import { Button, Card, ConfirmDialog, EmptyState, IconButton, Input, NumberInput, Page, SectionTitle, Sheet, Spinner, Stat, Textarea, Toggle } from '@/components/ui';
import { useExercises } from '@/data/catalog';
import { ExercisePicker } from '@/components/ExercisePicker';
import type { Exercise, LoggedSet, Prescription, SavedTemplate, WorkoutSession } from '@/domain/types';
import * as ops from '@/domain/sessionOps';
import { displayWeight, toKg } from '@/domain/units';
import { sessionDurationSec, summarizeSession } from '@/domain/stats';
import { usesLoad, validateLoggedSet } from '@/domain/setValidation';
import { DraftNumberField, type CommitResult } from './DraftNumberField';
import { draftKey } from './setDraft';
import { useToast } from '@/components/toast';
import { uuid } from '@/lib/id';
import { estimateSessionMinutes } from '@/domain/program/generator';
import { socialApi } from '@/backend/social';
import { useStarters } from './hooks';
import { t as tGlobal, useT } from '@/i18n';
import { exerciseDisplayName } from '@/data/catalogText';

export default function SessionDetailPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { t, tp } = useT();
  const { db, account, auth } = useApp();
  const unit = account.settings.units.weight;
  const { byId, list } = useExercises();
  const session = useLiveQuery(async () => (await db.sessions.get(id)) ?? null, [db, id]);
  const { repeat } = useStarters();
  const [picker, setPicker] = useState(false);
  const [del, setDel] = useState(false);
  const [delPosts, setDelPosts] = useState(true);
  const [tplOpen, setTplOpen] = useState(params.get('saveTemplate') === '1');
  const summary = useMemo(() => (session ? summarizeSession(session, byId) : null), [session, byId]);

  if (session === undefined) return <Spinner />;
  if (!session || session.deletedAt) return <EmptyState title={t('workout.notFound')} body={t('coaching.admin.it_may_have_been_deleted')} action={<Button onClick={() => nav('/train/history')}>{t('train.historyTitle')}</Button>} />;
  if (session.status === 'active') return <Navigate to={`/train/session/${session.id}`} replace />;

  const save = async (fn: (s: WorkoutSession) => WorkoutSession): Promise<boolean> => {
    const cur = await db.sessions.get(session.id);
    if (!cur) return false;
    try {
      await saveRecord('sessions', fn(cur), db);
      return true;
    } catch (e) {
      toast.show((e as Error).message || t('workout.saveFailed'), { tone: 'error' });
      return false;
    }
  };
  /**
   * Historical correction, validated with the shared rules: a counted (completed) set can't be edited into
   * invalid work (the field shows why and nothing is saved). A set that isn't counted yet becomes counted
   * as soon as its values are valid.
   */
  const editSet = (seId: string, st: LoggedSet, patch: Partial<LoggedSet>): CommitResult => {
    const ex = byId.get(session.exercises.find((e) => e.id === seId)?.exerciseId ?? '');
    const next = { ...st, ...patch };
    if (st.completed) {
      const v = validateLoggedSet(next, ex, { mode: 'record' });
      if (!v.ok) return v.errors[0];
      return save((s) => ops.updateSet(s, seId, st.id, patch));
    }
    const nowValid = validateLoggedSet(next, ex, { mode: 'record', asCompleted: true }).ok;
    return save((s) => ops.updateSet(s, seId, st.id, nowValid ? { ...patch, completed: true, completedAt: s.endedAt ?? Date.now() } : patch));
  };
  const durationMin = Math.round(sessionDurationSec(session) / 60);
  const posts = session.sharedPostIds ?? [];

  return (
    <Page
      title={session.name}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)} iconSize="lg">
          <ChevronLeft />
        </IconButton>
      }
    >
      <Card className="p-4 space-y-3">
        <Input label={t('workout.custom.name')} defaultValue={session.name} maxLength={80} onBlur={(e) => e.target.value.trim() && e.target.value !== session.name && void save((s) => ({ ...s, name: e.target.value.trim() }))} />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label={t('progress.date')}
            type="date"
            defaultValue={session.date}
            max={formatISO(new Date())}
            onBlur={(e) => /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && e.target.value !== session.date && void save((s) => ({ ...s, date: e.target.value }))}
          />
          <NumberInput
            label={t('workout.historyDetail.duration_min')}
            value={durationMin}
            decimals={false}
            min={1}
            max={600}
            onChange={(v) => v && void save((s) => ({ ...s, endedAt: s.startedAt + s.pausedTotalMs + v * 60000 }))}
          />
        </div>
        {summary && (
          <div className="grid grid-cols-3 gap-3 pt-1">
            <Stat label={t('program.workingSets')} value={summary.workingSets} />
            <Stat label={t('workout.historyDetail.warm_up_sets')} value={summary.warmupSets} />
            <Stat label={t('summary.exercises')} value={summary.exercisesDone} />
          </div>
        )}
        <p className="text-xs text-faint">{t('workout.historyDetail.edits_here_update_your_progress_charts')}</p>
      </Card>

      <SectionTitle>{t('summary.exercises')}</SectionTitle>
      <div className="space-y-3">
        {session.exercises.map((se) => {
          const ex = byId.get(se.exerciseId);
          const exName = ex ? exerciseDisplayName(ex) : t('workout.unknownExercise');
          return (
            <Card key={se.id} className="p-3">
              <div className="flex items-center gap-2 px-1">
                <h3 className="font-semibold flex-1 min-w-0 truncate">{exName}</h3>
                <IconButton size="sm" label={t('program.remove', { exercise: exName })} onClick={() => void save((s) => ops.removeExercise(s, se.id))}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
              {se.discomfort && se.sets.length === 0 && <p className="text-xs text-muted px-1 mt-1">{t('workout.historyDetail.stopped_with_discomfort_no_sets_completed')}</p>}
              <div className="mt-1 space-y-1">
                {se.sets.map((st, i) => (
                  <EditSetRow
                    key={st.id}
                    set={st}
                    label={st.type === 'warmup' ? t('workout.warmupMarker') : String(i + 1 - se.sets.slice(0, i).filter((x) => x.type === 'warmup').length)}
                    ex={ex}
                    unit={unit}
                    sessionId={session.id}
                    onChange={(patch) => editSet(se.id, st, patch)}
                    onDelete={() => void save((s) => ops.removeSet(s, se.id, st.id))}
                  />
                ))}
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="size-4" />}
                onClick={() =>
                  void save((s) => {
                    const added = ops.addSet(s, se.id, ex?.tracking === 'duration' || ex?.tracking === 'distance_time' ? 'timed' : 'normal');
                    const e2 = added.exercises.find((e) => e.id === se.id)!;
                    const last = e2.sets[e2.sets.length - 1];
                    // Counted only when the copied values are valid; otherwise it waits for real values.
                    if (!validateLoggedSet(last, ex, { mode: 'record', asCompleted: true }).ok) return added;
                    return ops.updateSet(added, se.id, last.id, { completed: true, completedAt: s.endedAt ?? Date.now() });
                  })
                }
              >
                {t('workout.addSet')}
              </Button>
            </Card>
          );
        })}
        <Button block icon={<Plus className="size-4" />} onClick={() => setPicker(true)}>
          {t('workout.addExercise')}
        </Button>
      </div>

      <SectionTitle>{t('workout.custom.notes')}</SectionTitle>
      <Textarea aria-label={t('workout.notes')} defaultValue={session.notes ?? ''} onBlur={(e) => e.target.value !== (session.notes ?? '') && void save((s) => ({ ...s, notes: e.target.value.trim() || undefined }))} />

      <div className="grid grid-cols-2 gap-2 mt-6">
        <Button icon={<Repeat className="size-4" />} onClick={() => void repeat(session)}>
          {t('workout.historyDetail.repeat')}
        </Button>
        <Button icon={<Layers className="size-4" />} onClick={() => setTplOpen(true)}>
          {t('summary.saveTemplate')}
        </Button>
        {!db.isGuest && (
          <Button icon={<Share2 className="size-4" />} onClick={() => nav(`/feed/new?session=${session.id}`)}>
            {t('workout.share.share')}
          </Button>
        )}
        <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setDel(true)}>
          {t('common.delete')}
        </Button>
      </div>

      <ExercisePicker
        open={picker}
        onClose={() => setPicker(false)}
        onPick={(ex) => {
          setPicker(false);
          // New sets start empty and become counted once their values are valid (never as 0-rep "work").
          void save((s) => ops.addExercise(s, ex, 1));
        }}
      />
      <ConfirmDialog
        open={del}
        danger
        title={t('workout.historyDetail.delete_this_workout')}
        body={t('workout.historyDetail.this_removes_the_workout_and_its')}
        confirmLabel={t('workout.historyDetail.delete_workout')}
        cancelLabel={t('workout.historyDetail.keep_workout')}
        onCancel={() => setDel(false)}
        onConfirm={async () => {
          if (posts.length && delPosts && auth.status === 'signed_in') {
            const results = await Promise.allSettled(posts.map((p) => socialApi.deletePost(p)));
            if (results.some((r) => r.status === 'rejected')) toast.show(t('workout.historyDetail.the_workout_was_deleted_but_its'), { tone: 'warn' });
          }
          await deleteRecord('sessions', session.id, db);
          setDel(false);
          toast.show(t('workout.historyDetail.workout_deleted'));
          nav('/train/history', { replace: true });
        }}
      >
        {posts.length > 0 && (
          <div className="mt-3">
            <Toggle label={tp('workout.historyDetail.alsoDeletePosts', posts.length)} description={t('workout.historyDetail.shared_posts_are_separate_snapshots_keep')} checked={delPosts} onChange={setDelPosts} />
          </div>
        )}
      </ConfirmDialog>
      <SaveTemplateSheet open={tplOpen} onClose={() => setTplOpen(false)} session={session} byId={byId} catalog={list} />
    </Page>
  );
}

function formatISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function EditSetRow({ set, label, ex, unit, sessionId, onChange, onDelete }: { set: LoggedSet; label: string; ex?: Exercise; unit: 'kg' | 'lb'; sessionId: string; onChange: (p: Partial<LoggedSet>) => CommitResult; onDelete: () => void }) {
  const { t: tr } = useT();
  const t = ex?.tracking;
  const showLoad = usesLoad(ex);
  const key = (f: string) => draftKey(`hist-${sessionId}`, set.id, f);
  const issue = validateLoggedSet(set, ex, { mode: 'record', asCompleted: true }).errors[0] ?? null;
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className={`w-8 text-center text-sm font-semibold ${set.type === 'warmup' ? 'text-warn' : 'text-muted'}`}>{label}</span>
        {showLoad && (
          <DraftNumberField
            className="flex-1"
            ariaLabel={tr('workout.historyDetail.set_x_load_x', { set: label, unit })}
            value={set.weightKg == null ? null : displayWeight(set.weightKg, unit, set.entered)}
            draftKey={key('weight')}
            placeholder={unit}
            onCommit={(v) => onChange(v == null ? { weightKg: null, entered: undefined } : { weightKg: toKg(v, unit), entered: { value: v, unit } })}
          />
        )}
        {t === 'distance_time' && <DraftNumberField className="flex-1" ariaLabel={tr('workout.historyDetail.set_x_distance_m', { set: label })} placeholder="m" value={set.distanceM ?? null} draftKey={key('distance')} onCommit={(v) => onChange({ distanceM: v })} />}
        {t === 'duration' || t === 'distance_time' ? (
          <DraftNumberField className="flex-1" ariaLabel={tr('workout.historyDetail.set_x_seconds', { set: label })} placeholder="s" decimals={false} value={set.durationSec ?? null} draftKey={key('duration')} onCommit={(v) => onChange({ durationSec: v })} />
        ) : (
          <DraftNumberField className="flex-1" ariaLabel={tr('workout.historyDetail.set_x_reps', { set: label })} placeholder={tr('workout.historyDetail.reps')} decimals={false} value={set.reps ?? null} draftKey={key('reps')} onCommit={(v) => onChange({ reps: v })} />
        )}
        <IconButton size="sm" label={tr('workout.historyDetail.delete_set_x', { set: label })} onClick={onDelete}>
          <X className="size-4" />
        </IconButton>
      </div>
      {issue && <p className="pl-10 text-xs text-warn">{tr('workout.historyDetail.not_counted', { reason: issue.charAt(0).toLowerCase() + issue.slice(1) })}</p>}
    </div>
  );
}

function SaveTemplateSheet({ open, onClose, session, byId, catalog }: { open: boolean; onClose: () => void; session: WorkoutSession; byId: Map<string, Exercise>; catalog: Exercise[] }) {
  const { db, account } = useApp();
  const toast = useToast();
  const { t } = useT();
  const [name, setName] = useState(session.name);
  useEffect(() => {
    if (open) setName(session.name);
  }, [open, session.name]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('summary.saveTemplate')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              // Exercises stopped with discomfort before any set (sets: []) aren't part of what was done.
              const exercises: Prescription[] = session.exercises.filter((se) => se.sets.length > 0).map((se) => {
                const work = se.sets.filter((s) => s.type !== 'warmup');
                const reps = work.map((s) => s.reps ?? 0).filter((r) => r > 0);
                const ex = byId.get(se.exerciseId);
                return {
                  id: uuid(),
                  exerciseId: se.exerciseId,
                  sets: Math.max(1, work.length),
                  repMin: reps.length ? Math.min(...reps) : 8,
                  repMax: reps.length ? Math.max(...reps) : 12,
                  targetRir: se.prescription?.targetRir ?? 2,
                  restSec: se.prescription?.restSec ?? account.settings.rest.defaultSec,
                  durationSec: ex?.tracking === 'duration' ? Math.max(...work.map((s) => s.durationSec ?? 30)) : undefined,
                  warmup: se.sets.some((s) => s.type === 'warmup') ? tGlobal('program.template.warmupLighterSets', undefined, 'en') : '',
                  priority: 2,
                  alternatives: ex?.substitutions ?? [],
                };
              });
              const template = { id: uuid(), name: name.trim() || session.name, focus: session.name, kind: 'lifting' as const, exercises, estimatedMinutes: 0 };
              template.estimatedMinutes = estimateSessionMinutes(template, catalog);
              await saveRecord('templates', newRecord<Omit<SavedTemplate, keyof import('@/domain/types').SyncFields>>({ template }) as SavedTemplate, db);
              toast.show(t('activities.form.template_saved'), { tone: 'success' });
              onClose();
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Input label={t('activities.form.template_name')} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      <p className="text-xs text-muted mt-2">{t('workout.historyDetail.uses_this_workouts_exercises_set_counts')}</p>
    </Sheet>
  );
}
