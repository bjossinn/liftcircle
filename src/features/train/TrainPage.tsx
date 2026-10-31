import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Activity, BookOpen, CalendarDays, ChevronRight, ClipboardList, Dumbbell, History, Layers, Play, Plus, Repeat, Timer } from 'lucide-react';
import { useApp } from '@/state/app';
import { alive } from '@/db/repo';
import { Button, Card, ListRow, Page, SectionTitle, Sheet, Spinner } from '@/components/ui';
import { TopActions } from '@/app/TopActions';
import { useActiveProgram, useAllSessions, useStarters } from './hooks';
import { currentVersion } from '@/domain/program/program';
import { PlanOwnerBadge } from '@/features/program/PlanOwner';
import { nextPlannedSession } from '@/domain/program/schedule';
import { formatDate, formatMinutes, todayISO, WEEKDAY_SHORT } from '@/lib/dates';

export default function TrainPage() {
  const { db, account } = useApp();
  const nav = useNavigate();
  const program = useActiveProgram();
  const sessions = useAllSessions();
  const saved = useLiveQuery(async () => alive(await db.templates.toArray()), [db]);
  const { startTemplate, repeat, empty } = useStarters();
  const [repeatOpen, setRepeatOpen] = useState(false);
  const today = todayISO(account.settings.timeZone);
  const next = useMemo(() => (program && sessions ? nextPlannedSession(program, today, sessions) : null), [program, sessions, today]);

  if (program === undefined || sessions === undefined || saved === undefined) return <Spinner />;
  const active = sessions.find((s) => s.status === 'active');
  const recent = sessions.filter((s) => s.status === 'completed').slice(0, 15);
  const version = program ? currentVersion(program) : null;
  const daysFor = (tid: string) => version?.schedule.filter((s) => s.templateId === tid).map((s) => WEEKDAY_SHORT[s.weekday]) ?? [];

  return (
    <Page title="Train" actions={<TopActions />}>
      {active ? (
        <Card className="p-4 flex items-center gap-3 border-accent/40">
          <Play className="size-5 text-accent" aria-hidden />
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{active.name}</div>
            <div className="text-xs text-muted">In progress</div>
          </div>
          <Button variant="primary" onClick={() => nav(`/train/session/${active.id}`)}>
            Continue workout
          </Button>
        </Card>
      ) : (
        <Card className="p-4 space-y-2">
          {next && (
            <Button variant="primary" size="lg" block icon={<Play className="size-5" />} onClick={() => void startTemplate(next.template, { program: program!, plannedDate: next.date })}>
              {next.date === today ? 'Start today’s session' : 'Start next session'} · {next.template.name}
            </Button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button icon={<Plus className="size-4" />} onClick={() => void empty()}>
              Empty workout
            </Button>
            <Button icon={<Repeat className="size-4" />} onClick={() => setRepeatOpen(true)} disabled={recent.length === 0}>
              Repeat a workout
            </Button>
            <Button icon={<Activity className="size-4" />} onClick={() => nav('/train/activity/new')}>
              Log activity
            </Button>
            <Button icon={<Timer className="size-4" />} onClick={() => nav('/train/intervals')}>
              Interval timer
            </Button>
          </div>
        </Card>
      )}

      <SectionTitle action={<Link to="/train/program" className="text-sm text-accent min-h-11 min-w-11 px-2 -mr-2 inline-flex items-center justify-center">{program ? 'Edit' : 'Set up'}</Link>}>
        {program ? program.name : 'Program'}
      </SectionTitle>
      {program?.managedBy && program.managedBy.kind !== 'self' && <PlanOwnerBadge program={program} className="mb-2 -mt-1" />}
      {program && version ? (
        <Card className="divide-y divide-line overflow-hidden">
          {version.templates.map((t) => (
            <ListRow
              key={t.id}
              left={<Dumbbell className="size-5 text-accent" />}
              title={t.name}
              subtitle={`${daysFor(t.id).join(', ') || 'Unscheduled'} · ~${t.estimatedMinutes} min${t.exercises.length ? ` · ${t.exercises.length} exercises` : ''}`}
              right={
                <Button size="sm" disabled={!!active} onClick={() => void startTemplate(t, { program })} aria-label={`Start ${t.name}`}>
                  Start
                </Button>
              }
            />
          ))}
        </Card>
      ) : (
        <Card className="p-4 text-sm">
          <p className="text-muted">No program yet. Get a suggested plan based on your days, equipment and goals, or build your own.</p>
          <div className="flex gap-2 mt-3">
            <Button variant="primary" onClick={() => nav('/onboarding')}>
              Suggest a program
            </Button>
            <Button onClick={() => nav('/train/program')}>Build my own</Button>
          </div>
        </Card>
      )}

      {saved.length > 0 && (
        <>
          <SectionTitle action={<Link to="/train/templates" className="text-sm text-accent min-h-11 inline-flex items-center">Manage</Link>}>Saved templates</SectionTitle>
          <Card className="divide-y divide-line overflow-hidden">
            {saved.slice(0, 5).map((s) => (
              <ListRow
                key={s.id}
                left={<Layers className="size-5 text-muted" />}
                title={s.template.name}
                subtitle={`${s.template.exercises.length} exercises · ~${s.template.estimatedMinutes} min`}
                right={
                  <Button size="sm" disabled={!!active} onClick={() => void startTemplate(s.template)}>
                    Start
                  </Button>
                }
              />
            ))}
          </Card>
        </>
      )}

      <SectionTitle>More</SectionTitle>
      <Card className="divide-y divide-line overflow-hidden">
        <ListRow left={<History className="size-5 text-muted" />} title="History & calendar" subtitle={`${recent.length ? `Last: ${formatDate(recent[0].date)}` : 'No workouts yet'}`} right={<ChevronRight className="size-4" />} onClick={() => nav('/train/history')} />
        <ListRow left={<BookOpen className="size-5 text-muted" />} title="Exercise library" subtitle="Instructions, cues and substitutions" right={<ChevronRight className="size-4" />} onClick={() => nav('/train/exercises')} />
        <ListRow left={<ClipboardList className="size-5 text-muted" />} title="Templates" subtitle="Your saved routines" right={<ChevronRight className="size-4" />} onClick={() => nav('/train/templates')} />
        <ListRow left={<CalendarDays className="size-5 text-muted" />} title="Program & schedule" subtitle={program ? `Block of ${version?.weeks} weeks · review in week ${version?.reviewWeek}` : 'Not set up'} right={<ChevronRight className="size-4" />} onClick={() => nav('/train/program')} />
      </Card>

      <Sheet open={repeatOpen} onClose={() => setRepeatOpen(false)} title="Repeat a past workout">
        <div className="divide-y divide-line -mx-5">
          {recent.map((s) => (
            <ListRow
              key={s.id}
              title={s.name}
              subtitle={`${formatDate(s.date)} · ${s.exercises.length} exercises · ${formatMinutes(((s.endedAt ?? s.startedAt) - s.startedAt - s.pausedTotalMs) / 1000)}`}
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
