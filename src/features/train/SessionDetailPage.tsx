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

export default function SessionDetailPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
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
  if (!session || session.deletedAt) return <EmptyState title="Workout not found" body="It may have been deleted." action={<Button onClick={() => nav('/train/history')}>History</Button>} />;
  if (session.status === 'active') return <Navigate to={`/train/session/${session.id}`} replace />;

  const save = async (fn: (s: WorkoutSession) => WorkoutSession): Promise<boolean> => {
    const cur = await db.sessions.get(session.id);
    if (!cur) return false;
    try {
      await saveRecord('sessions', fn(cur), db);
      return true;
    } catch (e) {
      toast.show((e as Error).message || 'Couldn’t save that change on this device.', { tone: 'error' });
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
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <Card className="p-4 space-y-3">
        <Input label="Name" defaultValue={session.name} maxLength={80} onBlur={(e) => e.target.value.trim() && e.target.value !== session.name && void save((s) => ({ ...s, name: e.target.value.trim() }))} />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Date"
            type="date"
            defaultValue={session.date}
            max={formatISO(new Date())}
            onBlur={(e) => /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && e.target.value !== session.date && void save((s) => ({ ...s, date: e.target.value }))}
          />
          <NumberInput
            label="Duration (min)"
            value={durationMin}
            decimals={false}
            min={1}
            max={600}
            onChange={(v) => v && void save((s) => ({ ...s, endedAt: s.startedAt + s.pausedTotalMs + v * 60000 }))}
          />
        </div>
        {summary && (
          <div className="grid grid-cols-3 gap-3 pt-1">
            <Stat label="Working sets" value={summary.workingSets} />
            <Stat label="Warm-up sets" value={summary.warmupSets} />
            <Stat label="Exercises" value={summary.exercisesDone} />
          </div>
        )}
        <p className="text-xs text-faint">Edits here update your progress charts and records. Your program templates aren’t changed.</p>
      </Card>

      <SectionTitle>Exercises</SectionTitle>
      <div className="space-y-3">
        {session.exercises.map((se) => {
          const ex = byId.get(se.exerciseId);
          return (
            <Card key={se.id} className="p-3">
              <div className="flex items-center gap-2 px-1">
                <h3 className="font-semibold flex-1 min-w-0 truncate">{ex?.name ?? 'Unknown exercise'}</h3>
                <IconButton size="sm" label={`Remove ${ex?.name ?? 'exercise'}`} onClick={() => void save((s) => ops.removeExercise(s, se.id))}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
              <div className="mt-1 space-y-1">
                {se.sets.map((st, i) => (
                  <EditSetRow
                    key={st.id}
                    set={st}
                    label={st.type === 'warmup' ? 'W' : String(i + 1 - se.sets.slice(0, i).filter((x) => x.type === 'warmup').length)}
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
                Add set
              </Button>
            </Card>
          );
        })}
        <Button block icon={<Plus className="size-4" />} onClick={() => setPicker(true)}>
          Add exercise
        </Button>
      </div>

      <SectionTitle>Notes</SectionTitle>
      <Textarea aria-label="Workout notes" defaultValue={session.notes ?? ''} onBlur={(e) => e.target.value !== (session.notes ?? '') && void save((s) => ({ ...s, notes: e.target.value.trim() || undefined }))} />

      <div className="grid grid-cols-2 gap-2 mt-6">
        <Button icon={<Repeat className="size-4" />} onClick={() => void repeat(session)}>
          Repeat
        </Button>
        <Button icon={<Layers className="size-4" />} onClick={() => setTplOpen(true)}>
          Save as template
        </Button>
        {!db.isGuest && (
          <Button icon={<Share2 className="size-4" />} onClick={() => nav(`/feed/new?session=${session.id}`)}>
            Share
          </Button>
        )}
        <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setDel(true)}>
          Delete
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
        title="Delete this workout?"
        body="It will be removed from your history, charts and records on all your devices."
        confirmLabel="Delete"
        onCancel={() => setDel(false)}
        onConfirm={async () => {
          if (posts.length && delPosts && auth.status === 'signed_in') {
            const results = await Promise.allSettled(posts.map((p) => socialApi.deletePost(p)));
            if (results.some((r) => r.status === 'rejected')) toast.show('The workout was deleted, but its shared post couldn’t be removed right now. You can delete it from the feed.', { tone: 'warn' });
          }
          await deleteRecord('sessions', session.id, db);
          setDel(false);
          toast.show('Workout deleted');
          nav('/train/history', { replace: true });
        }}
      >
        {posts.length > 0 && (
          <div className="mt-3">
            <Toggle label={`Also delete the shared post${posts.length > 1 ? 's' : ''}`} description="Shared posts are separate snapshots. Keep them if you like." checked={delPosts} onChange={setDelPosts} />
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
            ariaLabel={`Set ${label} load (${unit})`}
            value={set.weightKg == null ? null : displayWeight(set.weightKg, unit, set.entered)}
            draftKey={key('weight')}
            placeholder={unit}
            onCommit={(v) => onChange(v == null ? { weightKg: null, entered: undefined } : { weightKg: toKg(v, unit), entered: { value: v, unit } })}
          />
        )}
        {t === 'distance_time' && <DraftNumberField className="flex-1" ariaLabel={`Set ${label} distance (m)`} placeholder="m" value={set.distanceM ?? null} draftKey={key('distance')} onCommit={(v) => onChange({ distanceM: v })} />}
        {t === 'duration' || t === 'distance_time' ? (
          <DraftNumberField className="flex-1" ariaLabel={`Set ${label} seconds`} placeholder="s" decimals={false} value={set.durationSec ?? null} draftKey={key('duration')} onCommit={(v) => onChange({ durationSec: v })} />
        ) : (
          <DraftNumberField className="flex-1" ariaLabel={`Set ${label} reps`} placeholder="reps" decimals={false} value={set.reps ?? null} draftKey={key('reps')} onCommit={(v) => onChange({ reps: v })} />
        )}
        <IconButton size="sm" label={`Delete set ${label}`} onClick={onDelete}>
          <X className="size-4" />
        </IconButton>
      </div>
      {issue && <p className="pl-10 text-xs text-warn">Not counted — {issue.charAt(0).toLowerCase() + issue.slice(1)}</p>}
    </div>
  );
}

function SaveTemplateSheet({ open, onClose, session, byId, catalog }: { open: boolean; onClose: () => void; session: WorkoutSession; byId: Map<string, Exercise>; catalog: Exercise[] }) {
  const { db, account } = useApp();
  const toast = useToast();
  const [name, setName] = useState(session.name);
  useEffect(() => {
    if (open) setName(session.name);
  }, [open, session.name]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Save as template"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              const exercises: Prescription[] = session.exercises.map((se) => {
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
                  warmup: se.sets.some((s) => s.type === 'warmup') ? 'Warm up with 1–2 lighter sets.' : '',
                  priority: 2,
                  alternatives: ex?.substitutions ?? [],
                };
              });
              const template = { id: uuid(), name: name.trim() || session.name, focus: session.name, kind: 'lifting' as const, exercises, estimatedMinutes: 0 };
              template.estimatedMinutes = estimateSessionMinutes(template, catalog);
              await saveRecord('templates', newRecord<Omit<SavedTemplate, keyof import('@/domain/types').SyncFields>>({ template }) as SavedTemplate, db);
              toast.show('Template saved', { tone: 'success' });
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Input label="Template name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      <p className="text-xs text-muted mt-2">Uses this workout’s exercises, set counts and rep range. Find it under Train → Templates.</p>
    </Sheet>
  );
}
