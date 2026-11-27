import { useState } from 'react';
import { CheckCircle2, Pencil, Plus, RotateCcw } from 'lucide-react';
import { Badge, Button, Card, IconButton, ProgressBar } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { saveRecord, StorageWriteError } from '@/db/repo';
import { goalProgress, type GoalContext } from '@/domain/stats';
import type { UserGoal } from '@/domain/types';
import { formatDate } from '@/lib/dates';
import type { ProgressData } from './shared';
import { exerciseLabel } from './shared';
import { GoalEditor, goalKindInfo, goalTitleText } from './GoalEditor';
import { useT } from '@/i18n';

/**
 * Goals: every alive goal (achieved and custom ones included, and goals whose supporting data is missing), with the
 * existing goal semantics. Independent of the range selector; protein goals stay visible with nutrition disabled.
 */
export function GoalsSection({ d, proteinTargetG }: { d: ProgressData; proteinTargetG?: number }) {
  const { db } = useApp();
  const toast = useToast();
  const { t, language } = useT();
  const unit = d.settings.units.weight;
  const [edit, setEdit] = useState<UserGoal | 'new' | null>(null);

  const ctx: GoalContext = {
    sessions: d.sessions, activities: d.activities, measurements: d.measurements, foodLogs: d.foodLogs, proteinTargetG,
    byId: d.byId, today: d.today, weekStart: d.settings.weekStart, unit,
  };
  const goals = [...d.goals].sort((a, b) => (a.achievedAt ? 1 : 0) - (b.achievedAt ? 1 : 0) || b.createdAt - a.createdAt);

  const setAchieved = async (g: UserGoal, achieved: boolean) => {
    try {
      await saveRecord('goals', { ...g, achievedAt: achieved ? Date.now() : undefined }, db);
      toast.show(achieved ? t('progress.goalAchievedToast') : t('progress.goalReopened'), { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('progress.goalUpdateFailed'), { tone: 'error' });
    }
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        {goals.map((g) => {
          const p = goalProgress(g, ctx, language);
          const shown = goalTitleText(g.title);
          return (
            <Card key={g.id} as="article" className="p-4 flex flex-col gap-2">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold truncate">{shown}</h3>
                  <p className="text-xs text-muted">
                    {t(goalKindInfo(g.kind).label)}
                    {g.kind === 'exercise_load' && g.exerciseId ? ` · ${exerciseLabel(g.exerciseId, d.byId)}` : ''}
                    {g.deadline ? ` · ${t('progress.goalDeadline', { date: formatDate(g.deadline, { day: 'numeric', month: 'short', year: 'numeric' }) })}` : ''}
                  </p>
                </div>
                {g.achievedAt && <Badge tone="accent"><CheckCircle2 className="size-3" aria-hidden /> {t('progress.achieved')}</Badge>}
                <IconButton label={t('progress.editNamedGoal', { name: shown })} size="sm" onClick={() => setEdit(g)}>
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
        <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => setEdit('new')} className="self-start">{t('progress.addGoal')}</Button>
      </div>
      <GoalEditor edit={edit} sessions={d.sessions} exercises={d.exercises} byId={d.byId} unit={unit} today={d.today} onClose={() => setEdit(null)} />
    </>
  );
}
