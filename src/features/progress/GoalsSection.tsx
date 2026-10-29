import { useMemo, useState } from 'react';
import { CheckCircle2, Flag, Pencil, Plus, RotateCcw } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, Input, NumberInput, ProgressBar, Select, Sheet } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { deleteRecord, newRecord, saveRecord, StorageWriteError } from '@/db/repo';
import { exercisesWithHistory, goalProgress, type GoalContext } from '@/domain/stats';
import { fromKg, round, toKg } from '@/domain/units';
import type { UserGoal } from '@/domain/types';
import { formatDate } from '@/lib/dates';
import { exerciseName } from '@/data/catalog';
import type { ProgressData } from './shared';

type Kind = UserGoal['kind'];
const KINDS: { value: Kind; label: string; unit: (w: string) => string; defaultTitle: string }[] = [
  { value: 'sessions_per_week', label: 'Workouts per week', unit: () => 'workouts', defaultTitle: 'Train consistently' },
  { value: 'exercise_load', label: 'Exercise load', unit: (w) => w, defaultTitle: 'Lift target' },
  { value: 'bodyweight', label: 'Bodyweight', unit: (w) => w, defaultTitle: 'Bodyweight target' },
  { value: 'protein_days', label: 'Protein target days per week', unit: () => 'days', defaultTitle: 'Hit protein most days' },
  { value: 'cardio_minutes', label: 'Activity minutes per week', unit: () => 'min', defaultTitle: 'Move more' },
  { value: 'custom', label: 'Custom', unit: () => '', defaultTitle: '' },
];
const kindInfo = (k: Kind) => KINDS.find((x) => x.value === k)!;
const usesWeight = (k: Kind) => k === 'exercise_load' || k === 'bodyweight';

export function GoalsSection({ d, proteinTargetG }: { d: ProgressData; proteinTargetG?: number }) {
  const { db } = useApp();
  const toast = useToast();
  const unit = d.settings.units.weight;
  const [edit, setEdit] = useState<UserGoal | 'new' | null>(null);
  const [kind, setKind] = useState<Kind>('sessions_per_week');
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState<number | null>(3);
  const [exerciseId, setExerciseId] = useState('');
  const [deadline, setDeadline] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDel, setConfirmDel] = useState(false);

  const ctx: GoalContext = {
    sessions: d.sessions, activities: d.activities, measurements: d.measurements, foodLogs: d.foodLogs, proteinTargetG,
    byId: d.byId, today: d.today, weekStart: d.settings.weekStart, unit,
  };
  const historyIds = useMemo(() => exercisesWithHistory(d.sessions), [d.sessions]);
  const exerciseOptions = useMemo(() => {
    const hist = new Set(historyIds);
    const loadable = d.exercises.filter((e) => e.tracking === 'weight_reps' || e.tracking === 'bodyweight_plus' || e.tracking === 'assisted');
    return [...loadable.filter((e) => hist.has(e.id)), ...loadable.filter((e) => !hist.has(e.id)).sort((a, b) => a.name.localeCompare(b.name))];
  }, [d.exercises, historyIds]);

  const goals = [...d.goals].sort((a, b) => (a.achievedAt ? 1 : 0) - (b.achievedAt ? 1 : 0) || b.createdAt - a.createdAt);

  const open = (g: UserGoal | 'new') => {
    setErrors({});
    if (g === 'new') {
      setKind('sessions_per_week');
      setTitle(kindInfo('sessions_per_week').defaultTitle);
      setTarget(3);
      setExerciseId('');
      setDeadline('');
    } else {
      setKind(g.kind);
      setTitle(g.title);
      setTarget(g.kind === 'custom' ? null : usesWeight(g.kind) ? round(fromKg(g.target, unit), 1) : g.target);
      setExerciseId(g.exerciseId ?? '');
      setDeadline(g.deadline ?? '');
    }
    setEdit(g);
  };

  const changeKind = (k: Kind) => {
    const wasDefault = !title.trim() || KINDS.some((x) => x.defaultTitle === title);
    setKind(k);
    if (wasDefault) setTitle(kindInfo(k).defaultTitle);
    setTarget(k === 'sessions_per_week' ? 3 : k === 'protein_days' ? 5 : k === 'cardio_minutes' ? 150 : null);
    setErrors({});
  };

  const save = async () => {
    const errs: Record<string, string> = {};
    const t = title.trim() || (kind === 'exercise_load' && exerciseId ? `${exerciseName(exerciseId, d.byId)} target` : kindInfo(kind).defaultTitle);
    if (!t) errs.title = 'Give your goal a name';
    if (kind !== 'custom') {
      if (target == null || target <= 0) errs.target = 'Enter a target above zero';
      else if (kind === 'protein_days' && target > 7) errs.target = 'A week has 7 days';
      else if (kind === 'sessions_per_week' && target > 14) errs.target = 'Enter 14 or fewer';
      else if (kind === 'cardio_minutes' && target > 3000) errs.target = 'Enter 3000 minutes or fewer';
    }
    if (kind === 'exercise_load' && !exerciseId) errs.exercise = 'Choose an exercise';
    if (Object.keys(errs).length) return setErrors(errs);
    const tgt = kind === 'custom' ? 1 : usesWeight(kind) ? toKg(target!, unit) : Math.round(target!);
    const fields = { title: t, kind, target: tgt, exerciseId: kind === 'exercise_load' ? exerciseId : undefined, deadline: deadline || undefined };
    try {
      if (edit === 'new') await saveRecord('goals', newRecord<Omit<UserGoal, 'id' | 'createdAt' | 'updatedAt'>>(fields), db);
      else if (edit) await saveRecord('goals', { ...edit, ...fields }, db);
      setEdit(null);
      toast.show('Goal saved', { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : 'Couldn’t save the goal', { tone: 'error' });
    }
  };

  const setAchieved = async (g: UserGoal, achieved: boolean) => {
    try {
      await saveRecord('goals', { ...g, achievedAt: achieved ? Date.now() : undefined }, db);
      toast.show(achieved ? 'Goal marked as achieved' : 'Goal reopened', { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : 'Couldn’t update the goal', { tone: 'error' });
    }
  };

  const remove = async () => {
    if (!edit || edit === 'new') return;
    try {
      await deleteRecord('goals', edit.id, db);
      toast.show('Goal deleted');
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : 'Couldn’t delete the goal', { tone: 'error' });
    }
    setConfirmDel(false);
    setEdit(null);
  };

  const selectedEx = exerciseId ? d.byId.get(exerciseId) : undefined;

  return (
    <>
      {goals.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Flag className="size-6" />}
            title="No goals yet"
            body="Set a goal like workouts per week, a lift target or weekly activity minutes. Progress is calculated from what you log."
            action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => open('new')}>Add a goal</Button>}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {goals.map((g) => {
            const p = goalProgress(g, ctx);
            return (
              <Card key={g.id} as="article" className="p-4 flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate">{g.title}</h3>
                    <p className="text-xs text-muted">
                      {kindInfo(g.kind).label}
                      {g.kind === 'exercise_load' && g.exerciseId ? ` · ${exerciseName(g.exerciseId, d.byId)}` : ''}
                      {g.deadline ? ` · by ${formatDate(g.deadline, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                    </p>
                  </div>
                  {g.achievedAt && <Badge tone="accent"><CheckCircle2 className="size-3" aria-hidden /> Achieved</Badge>}
                  <IconButton label={`Edit goal ${g.title}`} size="sm" onClick={() => open(g)}>
                    <Pencil className="size-4" />
                  </IconButton>
                </div>
                {p.fraction != null && <ProgressBar value={Math.round(p.fraction * 100)} max={100} label={`${g.title} progress`} />}
                <p className="text-sm text-muted">{p.text}</p>
                {g.achievedAt ? (
                  <Button size="sm" variant="ghost" className="self-start" icon={<RotateCcw className="size-4" />} onClick={() => setAchieved(g, false)}>Reopen</Button>
                ) : (
                  <Button size="sm" variant={p.reached ? 'primary' : 'outline'} className="self-start" icon={<CheckCircle2 className="size-4" />} onClick={() => setAchieved(g, true)}>
                    {p.reached ? 'Target reached — mark achieved' : 'Mark achieved'}
                  </Button>
                )}
              </Card>
            );
          })}
          <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => open('new')} className="self-start">Add a goal</Button>
        </div>
      )}

      <Sheet
        open={edit != null}
        onClose={() => setEdit(null)}
        title={edit === 'new' ? 'New goal' : 'Edit goal'}
        footer={
          <>
            {edit && edit !== 'new' && <Button variant="danger" className="mr-auto" onClick={() => setConfirmDel(true)}>Delete</Button>}
            <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" onClick={save}>Save goal</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Select label="Type" value={kind} onChange={(e) => changeKind(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </Select>
          {kind === 'exercise_load' && (
            <Select label="Exercise" value={exerciseId} onChange={(e) => { setExerciseId(e.target.value); setErrors((x) => ({ ...x, exercise: '' })); }} error={errors.exercise || null}>
              <option value="">Choose an exercise…</option>
              {exerciseOptions.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </Select>
          )}
          <Input label="Goal name" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} error={errors.title || null} placeholder={kind === 'custom' ? 'e.g. Run a 10 km race' : undefined} />
          {kind !== 'custom' && (
            <NumberInput
              label={kind === 'exercise_load' && selectedEx?.tracking === 'assisted' ? `Target assistance (${unit}) — lower is better` : `Target (${kindInfo(kind).unit(unit)})`}
              hint={
                kind === 'exercise_load'
                  ? 'Compared with your heaviest completed working set (warm-ups excluded).'
                  : kind === 'bodyweight'
                    ? 'Compared with your 7-day average.'
                    : kind === 'protein_days'
                      ? 'Days this week where logged protein reached your target.'
                      : 'Counted for the current week.'
              }
              value={target}
              onChange={(v) => { setTarget(v); setErrors((x) => ({ ...x, target: '' })); }}
              decimals={usesWeight(kind)}
              min={0}
              suffix={kindInfo(kind).unit(unit)}
              error={errors.target || null}
            />
          )}
          <Input label="Target date" hint="Optional" type="date" value={deadline} min={d.today} onChange={(e) => setDeadline(e.target.value)} />
        </div>
      </Sheet>
      <ConfirmDialog open={confirmDel} title="Delete this goal?" confirmLabel="Delete" danger onConfirm={remove} onCancel={() => setConfirmDel(false)} />
    </>
  );
}
