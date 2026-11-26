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
import { t, useT, type Language, type MessageKey } from '@/i18n';

type Kind = UserGoal['kind'];
/**
 * Goal kinds. `defaultTitle` is a message key: the default title is stored as goal content in the language in use
 * when the goal was saved (the user can edit it), so it is localized when filled in, never rewritten afterwards.
 */
const KINDS: { value: Kind; label: MessageKey; unit: (w: string) => string; defaultTitle: MessageKey | null }[] = [
  { value: 'sessions_per_week', label: 'progress.goalWeeklyWorkouts', unit: () => t('progress.goalWorkoutsUnit'), defaultTitle: 'progress.goalConsistency' },
  { value: 'exercise_load', label: 'progress.goalExerciseLoad', unit: (w) => w, defaultTitle: 'progress.goalLiftTarget' },
  { value: 'bodyweight', label: 'progress.bodyweight', unit: (w) => w, defaultTitle: 'progress.goalBodyweight' },
  { value: 'protein_days', label: 'progress.goalProteinDays', unit: () => t('progress.goalDaysUnit'), defaultTitle: 'progress.goalProteinDefault' },
  // i18n: no approved Icelandic copy for the bare "min" unit
  { value: 'cardio_minutes', label: 'progress.goalActivityMinutes', unit: () => 'min', defaultTitle: 'progress.goalMoveMore' },
  { value: 'custom', label: 'progress.goalCustom', unit: () => '', defaultTitle: null },
];
const kindInfo = (k: Kind) => KINDS.find((x) => x.value === k)!;
const LANGS: Language[] = ['en', 'is'];
/** The default title for a kind in the current language ('' for custom). */
const defaultTitle = (k: Kind) => {
  const key = kindInfo(k).defaultTitle;
  return key ? t(key) : '';
};
/**
 * The kind whose default title this is, in any language (stored titles may predate a language switch), else null.
 * Exact match only, so user-authored titles are never mistaken for defaults.
 */
const defaultTitleKind = (title: string): Kind | null => {
  for (const x of KINDS) if (x.defaultTitle && LANGS.some((l) => t(x.defaultTitle!, undefined, l) === title)) return x.value;
  return null;
};
/** Display text for a stored title: an untouched default shows in the current language; anything else as stored. */
const titleText = (title: string) => {
  const k = defaultTitleKind(title);
  return k ? defaultTitle(k) : title;
};
const usesWeight = (k: Kind) => k === 'exercise_load' || k === 'bodyweight';

export function GoalsSection({ d, proteinTargetG }: { d: ProgressData; proteinTargetG?: number }) {
  const { db } = useApp();
  const toast = useToast();
  const { t } = useT();
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
      setTitle(defaultTitle('sessions_per_week'));
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
    // Old English defaults and current localized defaults both count as "untouched".
    const wasDefault = !title.trim() || defaultTitleKind(title) != null;
    setKind(k);
    if (wasDefault) setTitle(defaultTitle(k));
    setTarget(k === 'sessions_per_week' ? 3 : k === 'protein_days' ? 5 : k === 'cardio_minutes' ? 150 : null);
    setErrors({});
  };

  const save = async () => {
    const errs: Record<string, string> = {};
    const name = title.trim() || (kind === 'exercise_load' && exerciseId ? t('progress.goalExerciseDefault', { exercise: exerciseName(exerciseId, d.byId) }) : defaultTitle(kind));
    if (!name) errs.title = t('validation.goalName');
    if (kind !== 'custom') {
      if (target == null || target <= 0) errs.target = t('validation.positiveTarget');
      else if (kind === 'protein_days' && target > 7) errs.target = t('validation.week7Days');
      else if (kind === 'sessions_per_week' && target > 14) errs.target = t('validation.atMost14');
      else if (kind === 'cardio_minutes' && target > 3000) errs.target = t('validation.atMost3000Minutes');
    }
    if (kind === 'exercise_load' && !exerciseId) errs.exercise = t('validation.chooseExercise');
    if (Object.keys(errs).length) return setErrors(errs);
    const tgt = kind === 'custom' ? 1 : usesWeight(kind) ? toKg(target!, unit) : Math.round(target!);
    const fields = { title: name, kind, target: tgt, exerciseId: kind === 'exercise_load' ? exerciseId : undefined, deadline: deadline || undefined };
    try {
      if (edit === 'new') await saveRecord('goals', newRecord<Omit<UserGoal, 'id' | 'createdAt' | 'updatedAt'>>(fields), db);
      else if (edit) await saveRecord('goals', { ...edit, ...fields }, db);
      setEdit(null);
      toast.show(t('progress.goalSaved'), { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('progress.goalSaveFailed'), { tone: 'error' });
    }
  };

  const setAchieved = async (g: UserGoal, achieved: boolean) => {
    try {
      await saveRecord('goals', { ...g, achievedAt: achieved ? Date.now() : undefined }, db);
      toast.show(achieved ? t('progress.goalAchievedToast') : t('progress.goalReopened'), { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('progress.goalUpdateFailed'), { tone: 'error' });
    }
  };

  const remove = async () => {
    if (!edit || edit === 'new') return;
    try {
      await deleteRecord('goals', edit.id, db);
      toast.show(t('progress.goalDeleted'));
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('progress.goalDeleteFailed'), { tone: 'error' });
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
            title={t('progress.goalsEmpty')}
            body={t('progress.goalsEmptyHelp')}
            action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => open('new')}>{t('progress.addGoal')}</Button>}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {goals.map((g) => {
            const p = goalProgress(g, ctx);
            const shown = titleText(g.title);
            return (
              <Card key={g.id} as="article" className="p-4 flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate">{shown}</h3>
                    <p className="text-xs text-muted">
                      {t(kindInfo(g.kind).label)}
                      {g.kind === 'exercise_load' && g.exerciseId ? ` · ${exerciseName(g.exerciseId, d.byId)}` : ''}
                      {g.deadline ? ` · ${t('progress.goalDeadline', { date: formatDate(g.deadline, { day: 'numeric', month: 'short', year: 'numeric' }) })}` : ''}
                    </p>
                  </div>
                  {g.achievedAt && <Badge tone="accent"><CheckCircle2 className="size-3" aria-hidden /> {t('progress.achieved')}</Badge>}
                  <IconButton label={t('progress.editNamedGoal', { name: shown })} size="sm" onClick={() => open(g)}>
                    <Pencil className="size-4" />
                  </IconButton>
                </div>
                {p.fraction != null && <ProgressBar value={Math.round(p.fraction * 100)} max={100} label={t('progress.namedGoalProgress', { name: shown })} />}
                <p className="text-sm text-muted">{p.text}</p>
                {g.achievedAt ? (
                  <Button size="sm" variant="ghost" className="self-start" icon={<RotateCcw className="size-4" />} onClick={() => setAchieved(g, false)}>{t('progress.reopenGoal')}</Button>
                ) : (
                  <Button size="sm" variant={p.reached ? 'primary' : 'outline'} className="self-start" icon={<CheckCircle2 className="size-4" />} onClick={() => setAchieved(g, true)}>
                    {p.reached ? t('progress.reachedMarkAchieved') : t('progress.markAchieved')}
                  </Button>
                )}
              </Card>
            );
          })}
          <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => open('new')} className="self-start">{t('progress.addGoal')}</Button>
        </div>
      )}

      <Sheet
        open={edit != null}
        onClose={() => setEdit(null)}
        title={edit === 'new' ? t('progress.newGoal') : t('progress.editGoal')}
        footer={
          <>
            {edit && edit !== 'new' && <Button variant="danger" className="mr-auto" onClick={() => setConfirmDel(true)}>{t('common.delete')}</Button>}
            <Button variant="ghost" onClick={() => setEdit(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={save}>{t('progress.saveGoal')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Select label={t('progress.goalType')} value={kind} onChange={(e) => changeKind(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{t(k.label)}</option>
            ))}
          </Select>
          {kind === 'exercise_load' && (
            <Select label={t('progress.exercise')} value={exerciseId} onChange={(e) => { setExerciseId(e.target.value); setErrors((x) => ({ ...x, exercise: '' })); }} error={errors.exercise || null}>
              <option value="">{t('progress.chooseExercise')}</option>
              {exerciseOptions.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </Select>
          )}
          <Input label={t('progress.goalName')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} error={errors.title || null} placeholder={kind === 'custom' ? t('progress.goalNameExample') : undefined} />
          {kind !== 'custom' && (
            <NumberInput
              label={kind === 'exercise_load' && selectedEx?.tracking === 'assisted' ? t('progress.goalAssistanceTarget', { unit }) : t('progress.goalTarget', { unit: kindInfo(kind).unit(unit) })}
              hint={
                kind === 'exercise_load'
                  ? t('progress.goalLiftHelp')
                  : kind === 'bodyweight'
                    ? t('progress.goalBodyweightHelp')
                    : kind === 'protein_days'
                      ? t('progress.goalProteinHelp')
                      : t('progress.goalWeeklyHelp')
              }
              value={target}
              onChange={(v) => { setTarget(v); setErrors((x) => ({ ...x, target: '' })); }}
              decimals={usesWeight(kind)}
              min={0}
              suffix={kindInfo(kind).unit(unit)}
              error={errors.target || null}
            />
          )}
          <Input label={t('progress.goalDate')} hint={t('common.optional')} type="date" value={deadline} min={d.today} onChange={(e) => setDeadline(e.target.value)} />
        </div>
      </Sheet>
      <ConfirmDialog open={confirmDel} title={t('progress.deleteGoal')} confirmLabel={t('common.delete')} danger onConfirm={remove} onCancel={() => setConfirmDel(false)} />
    </>
  );
}
