import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Activity, BookOpen, CalendarDays, ChevronRight, ClipboardList, History, Layers, Play, Plus, Repeat, Timer } from 'lucide-react';
import { useApp } from '@/state/app';
import { alive } from '@/db/repo';
import { Button, Card, ListRow, Page, SectionTitle, Sheet, Spinner } from '@/components/ui';
import { exercisesDone } from '@/domain/stats';
import { TopActions } from '@/app/TopActions';
import { useActiveProgram, useAllSessions, useStarters } from './hooks';
import { currentVersion } from '@/domain/program/program';
import { PlanOwnerBadge } from '@/features/program/PlanOwner';
import { displaySessionName, SessionMarkTile } from '@/features/program/parts';
import { nextPlannedSession } from '@/domain/program/schedule';
import { formatDate, formatMinutes, todayISO, weekdayShort } from '@/lib/dates';
import { useT } from '@/i18n';

export default function TrainPage() {
  const { db, account } = useApp();
  const nav = useNavigate();
  const program = useActiveProgram();
  const sessions = useAllSessions();
  const saved = useLiveQuery(async () => alive(await db.templates.toArray()), [db]);
  const { startTemplate, repeat, empty } = useStarters();
  const [repeatOpen, setRepeatOpen] = useState(false);
  const { t: tr, tp } = useT();
  const today = todayISO(account.settings.timeZone);
  const next = useMemo(() => (program && sessions ? nextPlannedSession(program, today, sessions) : null), [program, sessions, today]);

  if (program === undefined || sessions === undefined || saved === undefined) return <Spinner />;
  const active = sessions.find((s) => s.status === 'active');
  const recent = sessions.filter((s) => s.status === 'completed').slice(0, 15);
  const version = program ? currentVersion(program) : null;
  const daysFor = (tid: string) => version?.schedule.filter((s) => s.templateId === tid).map((s) => weekdayShort(s.weekday)) ?? [];

  return (
    <Page title={tr('nav.train')} actions={<TopActions />}>
      {active ? (
        <Card className="p-4 flex items-center gap-3 border-accent/40">
          <Play className="size-5 text-accent" aria-hidden />
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{displaySessionName({ id: active.templateId ?? '', name: active.name, nameEdited: active.nameEdited })}</div>
            <div className="text-xs text-muted">{tr('train.inProgress')}</div>
          </div>
          <Button variant="primary" onClick={() => nav(`/train/session/${active.id}`)}>
            {tr('today.continue')}
          </Button>
        </Card>
      ) : (
        <Card className="p-4 space-y-2">
          {next && (
            <Button variant="primary" size="lg" block icon={<Play className="size-5" />} onClick={() => void startTemplate(next.template, { program: program!, plannedDate: next.date })}>
              {tr(next.date === today ? 'train.startToday' : 'train.startNext', { name: displaySessionName(next.template) })}
            </Button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button icon={<Plus className="size-4" />} onClick={() => void empty()}>
              {tr('train.empty')}
            </Button>
            <Button icon={<Repeat className="size-4" />} onClick={() => setRepeatOpen(true)} disabled={recent.length === 0}>
              {tr('train.repeat')}
            </Button>
            <Button icon={<Activity className="size-4" />} onClick={() => nav('/train/activity/new')}>
              {tr('today.logActivity')}
            </Button>
            <Button icon={<Timer className="size-4" />} onClick={() => nav('/train/intervals')}>
              {tr('today.intervalTimer')}
            </Button>
          </div>
        </Card>
      )}

      <SectionTitle action={<Link to="/train/program" className="text-sm text-accent min-h-11 min-w-11 px-2 -mr-2 inline-flex items-center justify-center">{program ? tr('common.edit') : tr('train.setup')}</Link>}>
        {program ? program.name : tr('train.program')}
      </SectionTitle>
      {program?.managedBy && program.managedBy.kind !== 'self' && <PlanOwnerBadge program={program} className="mb-2 -mt-1" />}
      {program && version ? (
        <Card className="divide-y divide-line overflow-hidden">
          {version.templates.map((t) => (
            <ListRow
              key={t.id}
              left={<SessionMarkTile template={t} />}
              title={displaySessionName(t)}
              subtitle={tr('train.templateMeta', { days: daysFor(t.id).join(', ') || tr('train.unscheduled'), minutes: t.estimatedMinutes, count: t.exercises.length })}
              right={
                <Button size="sm" disabled={!!active} onClick={() => void startTemplate(t, { program })} aria-label={tr('train.startNamed', { name: displaySessionName(t) })}>
                  {tr('common.start')}
                </Button>
              }
            />
          ))}
        </Card>
      ) : (
        <Card className="p-4 text-sm">
          <p className="text-muted">{tr('train.noProgram')}</p>
          <div className="flex gap-2 mt-3">
            <Button variant="primary" onClick={() => nav('/onboarding')}>
              {tr('train.suggest')}
            </Button>
            <Button onClick={() => nav('/train/program')}>{tr('train.own')}</Button>
          </div>
        </Card>
      )}

      {saved.length > 0 && (
        <>
          <SectionTitle action={<Link to="/train/templates" className="text-sm text-accent min-h-11 inline-flex items-center">{tr('train.manage')}</Link>}>{tr('train.templates')}</SectionTitle>
          <Card className="divide-y divide-line overflow-hidden">
            {saved.slice(0, 5).map((s) => (
              <ListRow
                key={s.id}
                left={<Layers className="size-5 text-muted" />}
                title={displaySessionName(s.template)}
                subtitle={tr('train.savedMeta', { count: s.template.exercises.length, minutes: s.template.estimatedMinutes })}
                right={
                  <Button size="sm" disabled={!!active} onClick={() => void startTemplate(s.template)}>
                    {tr('common.start')}
                  </Button>
                }
              />
            ))}
          </Card>
        </>
      )}

      <SectionTitle>{tr('common.more')}</SectionTitle>
      <Card className="divide-y divide-line overflow-hidden">
        <ListRow left={<History className="size-5 text-muted" />} title={tr('train.history')} subtitle={recent.length ? tr('train.last', { date: formatDate(recent[0].date) }) : tr('train.noWorkouts')} right={<ChevronRight className="size-4" />} onClick={() => nav('/train/history')} />
        <ListRow left={<BookOpen className="size-5 text-muted" />} title={tr('train.library')} subtitle={tr('train.libraryHint')} right={<ChevronRight className="size-4" />} onClick={() => nav('/train/exercises')} />
        <ListRow left={<ClipboardList className="size-5 text-muted" />} title={tr('train.templateTitle')} subtitle={tr('train.templateHint')} right={<ChevronRight className="size-4" />} onClick={() => nav('/train/templates')} />
        <ListRow left={<CalendarDays className="size-5 text-muted" />} title={tr('train.programSchedule')} subtitle={program && version ? tp('train.blockMeta', version.weeks, { weeks: version.weeks, reviewWeek: version.reviewWeek }) : tr('train.notSetup')} right={<ChevronRight className="size-4" />} onClick={() => nav('/train/program')} />
      </Card>

      <Sheet open={repeatOpen} onClose={() => setRepeatOpen(false)} title={tr('train.repeatPast')}>
        <div className="divide-y divide-line -mx-5">
          {recent.map((s) => (
            <ListRow
              key={s.id}
              title={s.name}
              subtitle={tr('train.pastMeta', { date: formatDate(s.date), count: exercisesDone(s), duration: formatMinutes(((s.endedAt ?? s.startedAt) - s.startedAt - s.pausedTotalMs) / 1000) })}
              onClick={() => {
                setRepeatOpen(false);
                void repeat(s);
              }}
              right={<ChevronRight className="size-4" />}
            />
          ))}
        </div>
      </Sheet>
    </Page>
  );
}
