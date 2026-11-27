/**
 * Add/edit a goal (extracted from GoalsSection so "Add a record" works before any goal exists). Validation, goal
 * types, default titles and the delete confirmation are unchanged.
 */
import { useMemo, useState } from 'react';
import { Button, ConfirmDialog, Input, NumberInput, Select, Sheet } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { deleteRecord, newRecord, saveRecord, StorageWriteError } from '@/db/repo';
import { exercisesWithHistory } from '@/domain/stats';
import { fromKg, round, toKg } from '@/domain/units';
import type { Exercise, ID, UserGoal, WeightUnit, WorkoutSession } from '@/domain/types';
import { exerciseName } from '@/data/catalog';
import { t, useT, type Language, type MessageKey } from '@/i18n';
import { useReturnFocus } from './shared';

export type GoalKind = UserGoal['kind'];
/**
 * Goal kinds. `defaultTitle` is a message key: the default title is stored as goal content in the language in use
 * when the goal was saved (the user can edit it), so it is localized when filled in, never rewritten afterwards.
 */
export const GOAL_KINDS: { value: GoalKind; label: MessageKey; unit: (w: string) => string; defaultTitle: MessageKey | null }[] = [
  { value: 'sessions_per_week', label: 'progress.goalWeeklyWorkouts', unit: () => t('progress.goalWorkoutsUnit'), defaultTitle: 'progress.goalConsistency' },
  { value: 'exercise_load', label: 'progress.goalExerciseLoad', unit: (w) => w, defaultTitle: 'progress.goalLiftTarget' },
  { value: 'bodyweight', label: 'progress.bodyweight', unit: (w) => w, defaultTitle: 'progress.goalBodyweight' },
  { value: 'protein_days', label: 'progress.goalProteinDays', unit: () => t('progress.goalDaysUnit'), defaultTitle: 'progress.goalProteinDefault' },
  { value: 'cardio_minutes', label: 'progress.goalActivityMinutes', unit: () => t('progress.minutesUnit'), defaultTitle: 'progress.goalMoveMore' },
  { value: 'custom', label: 'progress.goalCustom', unit: () => '', defaultTitle: null },
];
export const goalKindInfo = (k: GoalKind) => GOAL_KINDS.find((x) => x.value === k)!;
const LANGS: Language[] = ['en', 'is'];
/** The default title for a kind in the current language ('' for custom). */
export const defaultGoalTitle = (k: GoalKind) => {
  const key = goalKindInfo(k).defaultTitle;
  return key ? t(key) : '';
};
/**
 * The kind whose default title this is, in any language (stored titles may predate a language switch), else null.
 * Exact match only, so user-authored titles are never mistaken for defaults.
 */
export const defaultTitleKind = (title: string): GoalKind | null => {
  for (const x of GOAL_KINDS) if (x.defaultTitle && LANGS.some((l) => t(x.defaultTitle!, undefined, l) === title)) return x.value;
  return null;
};
/** Display text for a stored title: an untouched default shows in the current language; anything else as stored. */
export const goalTitleText = (title: string) => {
  const k = defaultTitleKind(title);
  return k ? defaultGoalTitle(k) : title;
};
const usesWeight = (k: GoalKind) => k === 'exercise_load' || k === 'bodyweight';

export interface GoalEditorProps {
  /** The goal to edit, 'new' to add, null when closed. */
  edit: UserGoal | 'new' | null;
  sessions: WorkoutSession[];
  exercises: Exercise[];
  byId: Map<ID, Exercise>;
  unit: WeightUnit;
  today: string;
  onClose: () => void;
}

/** Mounted per opening (keyed by the caller's target) so its draft starts from the goal. */
export function GoalEditor(props: GoalEditorProps) {
  if (props.edit == null) return null;
  return <GoalEditorBody key={props.edit === 'new' ? 'new' : props.edit.id} {...props} edit={props.edit} />;
}

function GoalEditorBody({ edit, sessions, exercises, byId, unit, today, onClose }: GoalEditorProps & { edit: UserGoal | 'new' }) {
  const { db } = useApp();
  const toast = useToast();
  const { t } = useT();
  useReturnFocus();
  const isNew = edit === 'new';
  const [kind, setKind] = useState<GoalKind>(isNew ? 'sessions_per_week' : edit.kind);
  const [title, setTitle] = useState(isNew ? defaultGoalTitle('sessions_per_week') : edit.title);
  const [target, setTarget] = useState<number | null>(isNew ? 3 : edit.kind === 'custom' ? null : usesWeight(edit.kind) ? round(fromKg(edit.target, unit), 1) : edit.target);
  const [exerciseId, setExerciseId] = useState(isNew ? '' : edit.exerciseId ?? '');
  const [deadline, setDeadline] = useState(isNew ? '' : edit.deadline ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDel, setConfirmDel] = useState(false);

  const historyIds = useMemo(() => exercisesWithHistory(sessions), [sessions]);
  const exerciseOptions = useMemo(() => {
    const hist = new Set(historyIds);
    const loadable = exercises.filter((e) => e.tracking === 'weight_reps' || e.tracking === 'bodyweight_plus' || e.tracking === 'assisted');
    return [...loadable.filter((e) => hist.has(e.id)), ...loadable.filter((e) => !hist.has(e.id)).sort((a, b) => a.name.localeCompare(b.name))];
  }, [exercises, historyIds]);

  const changeKind = (k: GoalKind) => {
    // Old English defaults and current localized defaults both count as "untouched".
    const wasDefault = !title.trim() || defaultTitleKind(title) != null;
    setKind(k);
    if (wasDefault) setTitle(defaultGoalTitle(k));
    setTarget(k === 'sessions_per_week' ? 3 : k === 'protein_days' ? 5 : k === 'cardio_minutes' ? 150 : null);
    setErrors({});
  };

  const save = async () => {
    const errs: Record<string, string> = {};
    const name = title.trim() || (kind === 'exercise_load' && exerciseId ? t('progress.goalExerciseDefault', { exercise: exerciseName(exerciseId, byId) }) : defaultGoalTitle(kind));
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
      if (isNew) await saveRecord('goals', newRecord<Omit<UserGoal, 'id' | 'createdAt' | 'updatedAt'>>(fields), db);
      else await saveRecord('goals', { ...edit, ...fields }, db);
      onClose();
      toast.show(t('progress.goalSaved'), { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('progress.goalSaveFailed'), { tone: 'error' });
    }
  };

  const remove = async () => {
    if (isNew) return;
    try {
      await deleteRecord('goals', edit.id, db);
      toast.show(t('progress.goalDeleted'));
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('progress.goalDeleteFailed'), { tone: 'error' });
    }
    setConfirmDel(false);
    onClose();
  };

  const selectedEx = exerciseId ? byId.get(exerciseId) : undefined;

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={isNew ? t('progress.newGoal') : t('progress.editGoal')}
        footer={
          <>
            {!isNew && <Button variant="danger" className="mr-auto" onClick={() => setConfirmDel(true)}>{t('common.delete')}</Button>}
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={save}>{t('progress.saveGoal')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Select label={t('progress.goalType')} value={kind} onChange={(e) => changeKind(e.target.value as GoalKind)}>
            {GOAL_KINDS.map((k) => (
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
              label={kind === 'exercise_load' && selectedEx?.tracking === 'assisted' ? t('progress.goalAssistanceTarget', { unit }) : t('progress.goalTarget', { unit: goalKindInfo(kind).unit(unit) })}
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
              suffix={goalKindInfo(kind).unit(unit)}
              error={errors.target || null}
            />
          )}
          <Input label={t('progress.goalDate')} hint={t('common.optional')} type="date" value={deadline} min={today} onChange={(e) => setDeadline(e.target.value)} />
        </div>
      </Sheet>
      <ConfirmDialog open={confirmDel} title={t('progress.deleteGoal')} confirmLabel={t('common.delete')} danger onConfirm={remove} onCancel={() => setConfirmDel(false)} />
    </>
  );
}
