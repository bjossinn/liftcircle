import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import clsx from 'clsx';
import { Activity, CalendarClock, Check, ChevronRight, Dumbbell, Flame, Play, Plus, Sparkles, Timer } from 'lucide-react';
import { useApp } from '@/state/app';
import { Badge, Button, Card, ConfirmDialog, Page, ProgressBar, SectionTitle, Spinner } from '@/components/ui';
import { TopActions } from '@/app/TopActions';
import { addDays, formatDate, formatMinutes, startOfWeek, todayISO, weekday, WEEKDAY_SHORT } from '@/lib/dates';
import { useActiveProgram, useAllActivities, useAllSessions, useStarters } from '@/features/train/hooks';
import { nextPlannedSession, plannedSessionsInRange, rescheduleMissed, skipPlanned, type PlannedSession } from '@/domain/program/schedule';
import { saveRecord } from '@/db/repo';
import { NutritionTodayCard } from '@/features/nutrition/NutritionTodayCard';
import { useToast } from '@/components/toast';
import { BRAND } from '@/config/brand';
import { PlanOwnerBadge } from '@/features/program/PlanOwner';
import { useExercises } from '@/data/catalog';
import { plannedWeekStreak } from '@/domain/program/streak';

/** A friendly greeting for the time of day (device clock). */
export function greeting(hour = new Date().getHours()): string {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function TodayPage() {
  const { account, db } = useApp();
  const settings = account.settings;
  const tz = settings.timeZone;
  const today = todayISO(tz);
  const program = useActiveProgram();
  const sessions = useAllSessions();
  const activities = useAllActivities();
  const { startTemplate, empty } = useStarters();
  const nav = useNavigate();
  const toast = useToast();
  const [missedAction, setMissedAction] = useState<PlannedSession | null>(null);
  const { byId } = useExercises();

  const weekFrom = startOfWeek(today, settings.weekStart);
  const weekTo = addDays(weekFrom, 6);
  const plan = useMemo(() => {
    if (!program || !sessions) return null;
    try {
      return {
        next: nextPlannedSession(program, today, sessions),
        week: plannedSessionsInRange(program, weekFrom, weekTo, today, sessions, activities ?? []),
        missed: plannedSessionsInRange(program, addDays(today, -6), addDays(today, -1), today, sessions, activities ?? []).filter((p) => p.status === 'missed'),
      };
    } catch {
      return null;
    }
  }, [program, sessions, activities, today, weekFrom, weekTo]);
  const celebrations = settings.workout.celebrations !== false;
  const streak = useMemo(
    () => (celebrations && program && sessions ? plannedWeekStreak(program, sessions, activities ?? [], today, settings.weekStart) : 0),
    [celebrations, program, sessions, activities, today, settings.weekStart],
  );

  if (sessions === undefined || program === undefined || activities === undefined) return <Spinner />;

  const active = sessions.find((s) => s.status === 'active');
  const completed = sessions.filter((s) => s.status === 'completed');
  const weekSessions = completed.filter((s) => s.date >= weekFrom && s.date <= weekTo);
  const weekActs = activities.filter((a) => a.date >= weekFrom && a.date <= weekTo);
  const weekMinutes =
    weekSessions.reduce((m, s) => m + ((s.endedAt ?? s.startedAt) - s.startedAt - s.pausedTotalMs) / 60000, 0) + weekActs.reduce((m, a) => m + a.durationSec / 60, 0);
  const activeDays = new Set([...weekSessions.map((s) => s.date), ...weekActs.map((a) => a.date)]);
  const plannedThisWeek = plan?.week.filter((p) => p.template.kind === 'lifting') ?? [];
  const doneThisWeek = plannedThisWeek.filter((p) => p.status === 'done').length;
  const isNew = !program && completed.length === 0 && activities.length === 0 && !account.profile.onboardedAt;
  const next = plan?.next;
  const name = account.profile.displayName;

  return (
    <Page title={name ? `${greeting()}, ${name}` : greeting()} actions={<TopActions />}>
      <div className="-mt-1 mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">{formatDate(today, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <p className="text-[15px] font-medium mt-0.5">
            {active
              ? 'You’re mid-workout. Pick up where you left off.'
              : next?.date === today
                ? `Today’s focus: ${next.template.name}`
                : program
                  ? 'Rest day. Recovery counts too.'
                  : isNew
                    ? 'Let’s get you started.'
                    : 'Ready when you are.'}
          </p>
        </div>
        {streak > 0 && (
          <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-streak-soft text-streak px-2.5 min-h-8 text-sm font-semibold" title="Weeks in a row with every planned session done">
            <Flame className="size-4 flame" aria-hidden />
            {streak}-week streak
          </span>
        )}
      </div>

      {isNew && !active && (
        <Card className="p-5 space-y-3" tint="accent">
          <div className="flex items-center gap-2 text-accent">
            <Sparkles className="size-5" aria-hidden />
            <span className="font-semibold">Welcome to {BRAND.name}</span>
          </div>
          <p className="text-[15px]">Answer a few quick questions and get a starting program that fits your days, equipment and time. Or just start logging. Every rep counts.</p>
          <div className="flex flex-col gap-2">
            <Button variant="primary" size="lg" onClick={() => nav('/onboarding')}>
              Set up my plan
            </Button>
            <Button onClick={() => void empty()}>Start an empty workout</Button>
            <Button variant="ghost" onClick={() => nav('/train/activity/new')}>
              Log a walk, run or other activity
            </Button>
          </div>
        </Card>
      )}

      {active && (
        <Card className="p-4 flex items-center gap-3 border-accent/40">
          <Play className="size-5 text-accent" aria-hidden />
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{active.name}</div>
            <div className="text-xs text-muted">Workout in progress</div>
          </div>
          <Button variant="primary" onClick={() => nav(`/train/session/${active.id}`)}>
            Resume
          </Button>
        </Card>
      )}

      {!active && program && (
        <>
          <SectionTitle>{next?.date === today ? 'Today’s session' : 'Next session'}</SectionTitle>
          {next ? (
            <Card className="p-4" tint="accent">
              <div className="flex items-start gap-3">
                <div className="size-11 rounded-xl bg-accent-soft text-accent flex items-center justify-center shrink-0">
                  {next.template.kind === 'lifting' ? <Dumbbell className="size-5" /> : <Activity className="size-5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-lg font-semibold leading-tight">{next.template.name}</div>
                  <div className="text-sm text-muted mt-0.5">
                    {next.date === today ? 'Today' : next.date === addDays(today, 1) ? 'Tomorrow' : formatDate(next.date)} · about {next.template.estimatedMinutes} min
                    {next.template.exercises.length > 0 && ` · ${next.template.exercises.length} exercises`}
                  </div>
                  {next.movedFrom && <Badge className="mt-1">Moved from {formatDate(next.movedFrom)}</Badge>}
                  <PlanOwnerBadge program={program} className="mt-1" />
                </div>
              </div>
              {next.template.exercises.length > 0 && (
                <p className="text-xs text-muted mt-3 line-clamp-2">{next.template.exercises.map((e) => byId.get(e.exerciseId)?.name ?? 'Exercise').join(' · ')}</p>
              )}
              <Button
                variant="primary"
                size="lg"
                block
                className="mt-4"
                icon={<Play className="size-5" />}
                onClick={() => void startTemplate(next.template, { program, plannedDate: next.date })}
              >
                {next.template.kind === 'lifting' || next.template.exercises.length > 0 ? 'Start workout' : 'Log this activity'}
              </Button>
              {next.date !== today && (
                <p className="text-xs text-muted mt-2 text-center">You can start it early — it’ll count for this planned session.</p>
              )}
            </Card>
          ) : (
            <Card className="p-4 text-sm text-muted">
              Nothing planned right now.{' '}
              <Link className="text-accent" to="/train/program">
                Review your program
              </Link>
            </Card>
          )}
        </>
      )}

      {!active && !program && !isNew && (
        <>
          <SectionTitle>Start</SectionTitle>
          <Card className="p-4 space-y-2">
            <Button variant="primary" size="lg" block icon={<Play className="size-5" />} onClick={() => void empty()}>
              Start a workout
            </Button>
            <Button block onClick={() => nav('/onboarding')}>
              Get a suggested program
            </Button>
          </Card>
        </>
      )}

      {plan && plan.missed.length > 0 && (
        <Card className="p-4 mt-3 border-warn/40">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CalendarClock className="size-4 text-warn" aria-hidden />
            Missed {plan.missed.length === 1 ? 'session' : 'sessions'}
          </div>
          <ul className="mt-2 space-y-2">
            {plan.missed.map((m) => (
              <li key={`${m.date}-${m.template.id}`} className="flex items-center gap-2 text-sm">
                <span className="flex-1 min-w-0 truncate">
                  {m.template.name} · {formatDate(m.date)}
                </span>
                <Button size="sm" onClick={() => setMissedAction(m)}>
                  Options
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <SectionTitle>This week</SectionTitle>
      <Card className="p-4" tint="streak">
        <div className="grid grid-cols-7 gap-1" role="list" aria-label="Days this week">
          {Array.from({ length: 7 }, (_, i) => addDays(weekFrom, i)).map((d) => {
            const done = activeDays.has(d);
            const planned = plan?.week.some((p) => p.date === d && p.status !== 'skipped' && p.status !== 'moved');
            return (
              <div key={d} role="listitem" className="flex flex-col items-center gap-1" aria-label={`${formatDate(d, { weekday: 'long' })}: ${done ? 'active' : planned ? 'planned' : 'rest'}`}>
                <span className={clsx('text-[11px]', d === today ? 'text-accent font-semibold' : 'text-muted')}>{WEEKDAY_SHORT[weekday(d)].slice(0, 2)}</span>
                <span
                  className={clsx(
                    'size-9 rounded-full flex items-center justify-center text-xs',
                    done ? 'bg-accent text-accent-ink' : planned ? 'border-2 border-dashed border-accent/60' : 'bg-surface-2',
                    d === today && !done && 'ring-2 ring-accent/50',
                  )}
                >
                  {done ? <Check className="size-4" strokeWidth={3} /> : Number(d.slice(8))}
                </span>
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-3 gap-3 mt-4">
          <Mini label="Workouts" value={String(weekSessions.length)} />
          <Mini label="Activities" value={String(weekActs.length)} />
          <Mini label="Active time" value={formatMinutes(weekMinutes * 60)} />
        </div>
        {plannedThisWeek.length > 0 && (
          <div className="mt-4 space-y-1.5">
            <p className="text-sm">
              You completed {doneThisWeek} of {plannedThisWeek.length} planned lifting session{plannedThisWeek.length === 1 ? '' : 's'} this week.
            </p>
            <ProgressBar value={doneThisWeek} max={plannedThisWeek.length} label="Planned sessions completed this week" />
          </div>
        )}
      </Card>

      <NutritionTodayCard />

      <SectionTitle>Quick actions</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        <QuickLink to="/train" icon={<Dumbbell className="size-5" />} label="Train" />
        <QuickLink to="/train/activity/new" icon={<Plus className="size-5" />} label="Log activity" />
        <QuickLink to="/train/intervals" icon={<Timer className="size-5" />} label="Interval timer" />
        <QuickLink to="/progress" icon={<Activity className="size-5" />} label="Log bodyweight" />
      </div>

      <ConfirmDialog
        open={!!missedAction}
        title={missedAction ? `Missed: ${missedAction.template.name}` : ''}
        body="Move it to the next suitable free day, or skip it and carry on with the plan. We won’t cram it into tomorrow if that would mean back-to-back hard days."
        confirmLabel="Reschedule"
        onCancel={() => setMissedAction(null)}
        onConfirm={async () => {
          if (!missedAction || !program || !sessions) return;
          const r = rescheduleMissed(program, missedAction.date, missedAction.template.id, today, sessions);
          await saveRecord('programs', r.program, db);
          toast.show(r.message, { tone: r.movedTo ? 'success' : 'info' });
          setMissedAction(null);
        }}
      >
        <Button
          variant="ghost"
          className="mt-3"
          onClick={async () => {
            if (!missedAction || !program) return;
            await saveRecord('programs', skipPlanned(program, missedAction.date, missedAction.template.id), db);
            toast.show('Skipped — your plan continues as scheduled.');
            setMissedAction(null);
          }}
        >
          Skip it instead
        </Button>
      </ConfirmDialog>
    </Page>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold tabular">{value}</div>
    </div>
  );
}

function QuickLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <Link to={to} className="pressable card-shadow flex items-center gap-2.5 rounded-2xl bg-surface border border-line px-3.5 min-h-14 hover:bg-surface-2">
      <span className="size-8 rounded-xl bg-accent-soft text-accent flex items-center justify-center">{icon}</span>
      <span className="font-medium flex-1 text-sm leading-tight">{label}</span>
      <ChevronRight className="size-4 text-faint" aria-hidden />
    </Link>
  );
}
