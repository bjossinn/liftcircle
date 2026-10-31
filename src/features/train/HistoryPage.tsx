import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import clsx from 'clsx';
import { Activity, ChevronLeft, ChevronRight, Dumbbell, Search } from 'lucide-react';
import { useApp } from '@/state/app';
import { Card, EmptyState, IconButton, Input, ListRow, Page, Segmented, Spinner, Button } from '@/components/ui';
import { useAllActivities, useAllSessions } from './hooks';
import { useExercises } from '@/data/catalog';
import { addDays, formatDate, formatMinutes, startOfWeek, todayISO, WEEKDAY_SHORT } from '@/lib/dates';
import { activityLabel } from '@/domain/activities';
import { formatDistance } from '@/domain/units';
import { sessionDurationSec } from '@/domain/stats';
import { NoWorkoutsArt } from '@/components/illustrations';

type Kind = 'all' | 'workouts' | 'activities';
interface Item {
  id: string;
  kind: 'workout' | 'activity';
  date: string;
  sort: number;
  title: string;
  subtitle: string;
  search: string;
  href: string;
}

export default function HistoryPage() {
  const nav = useNavigate();
  const { account } = useApp();
  const settings = account.settings;
  const sessions = useAllSessions();
  const activities = useAllActivities();
  const { byId } = useExercises();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const today = todayISO(settings.timeZone);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [day, setDay] = useState<string | null>(null);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const s of sessions ?? []) {
      if (s.status !== 'completed') continue;
      const names = s.exercises.map((e) => byId.get(e.exerciseId)?.name ?? '').filter(Boolean);
      out.push({
        id: s.id,
        kind: 'workout',
        date: s.date,
        sort: s.startedAt,
        title: s.name,
        subtitle: `${formatMinutes(sessionDurationSec(s))} · ${s.exercises.length} exercise${s.exercises.length === 1 ? '' : 's'}`,
        search: [s.name, s.notes, ...names].join(' ').toLowerCase(),
        href: `/train/history/${s.id}`,
      });
    }
    for (const a of activities ?? []) {
      out.push({
        id: a.id,
        kind: 'activity',
        date: a.date,
        sort: a.startedAt ?? a.createdAt,
        title: activityLabel(a),
        subtitle: [formatMinutes(a.durationSec), a.distanceM != null ? formatDistance(a.distanceM, settings.units.distance) : null].filter(Boolean).join(' · '),
        search: [activityLabel(a), a.notes, a.type].join(' ').toLowerCase(),
        href: `/train/activity/${a.id}`,
      });
    }
    return out.sort((a, b) => (a.date === b.date ? b.sort - a.sort : b.date.localeCompare(a.date)));
  }, [sessions, activities, byId, settings.units.distance]);

  if (!sessions || !activities) return <Spinner />;

  const filtered = items.filter(
    (i) => (kind === 'all' || (kind === 'workouts' ? i.kind === 'workout' : i.kind === 'activity')) && (!q.trim() || i.search.includes(q.trim().toLowerCase())) && (!day || i.date === day),
  );
  const byDate = new Map<string, Item[]>();
  for (const i of items) byDate.set(i.date, [...(byDate.get(i.date) ?? []), i]);

  // Month grid
  const first = `${month}-01`;
  const gridStart = startOfWeek(first, settings.weekStart);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const shiftMonth = (n: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
    setDay(null);
  };
  const weekdays = Array.from({ length: 7 }, (_, i) => WEEKDAY_SHORT[(settings.weekStart + i) % 7]);

  return (
    <Page
      title="History"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <Card className="p-3">
        <div className="flex items-center justify-between">
          <IconButton label="Previous month" onClick={() => shiftMonth(-1)}>
            <ChevronLeft className="size-5" />
          </IconButton>
          <h2 className="font-semibold">{formatDate(first, { month: 'long', year: 'numeric' })}</h2>
          <IconButton label="Next month" onClick={() => shiftMonth(1)} disabled={month >= today.slice(0, 7)}>
            <ChevronRight className="size-5" />
          </IconButton>
        </div>
        <div className="grid grid-cols-7 gap-1 mt-1 text-center" role="grid" aria-label="Calendar">
          {weekdays.map((w) => (
            <div key={w} className="text-[11px] text-muted py-1" role="columnheader">
              {w.slice(0, 2)}
            </div>
          ))}
          {cells.map((d) => {
            const its = byDate.get(d) ?? [];
            const inMonth = d.startsWith(month);
            const hasW = its.some((i) => i.kind === 'workout');
            const hasA = its.some((i) => i.kind === 'activity');
            return (
              <button
                key={d}
                role="gridcell"
                aria-label={`${formatDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}: ${its.length} entr${its.length === 1 ? 'y' : 'ies'}`}
                aria-selected={day === d}
                onClick={() => setDay(day === d ? null : d)}
                className={clsx(
                  'min-h-11 rounded-lg flex flex-col items-center justify-center text-sm tabular',
                  !inMonth && 'opacity-35',
                  day === d ? 'bg-accent text-accent-ink' : d === today ? 'ring-1 ring-accent' : 'hover:bg-surface-2',
                )}
              >
                {Number(d.slice(8))}
                <span className="flex gap-0.5 h-1.5 mt-0.5">
                  {hasW && <span className={clsx('size-1.5 rounded-full', day === d ? 'bg-accent-ink' : 'bg-accent')} />}
                  {hasA && <span className={clsx('size-1.5 rounded-full', day === d ? 'bg-accent-ink' : 'bg-info')} />}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex gap-4 justify-center text-[11px] text-muted mt-2">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-accent" /> Workout
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-info" /> Activity
          </span>
        </div>
      </Card>

      <div className="mt-4 space-y-3">
        <div className="relative">
          <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label="Search history" placeholder="Search by name, exercise or notes" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented
          label="Filter"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'All' },
            { value: 'workouts', label: 'Workouts' },
            { value: 'activities', label: 'Activities' },
          ]}
        />
        {day && (
          <div className="flex items-center justify-between text-sm">
            <span>Showing {formatDate(day)}</span>
            <Button size="sm" variant="ghost" onClick={() => setDay(null)}>
              Show all
            </Button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState illustration={<NoWorkoutsArt />} title="No workouts yet" body="Your first one is the hardest. Finished workouts and activities will collect here." action={<Button variant="primary" onClick={() => nav('/train')}>Start training</Button>} />
      ) : filtered.length === 0 ? (
        <EmptyState title="No matches" body="Try another search or filter." />
      ) : (
        <Card className="divide-y divide-line overflow-hidden mt-3">
          {filtered.slice(0, 300).map((i) => (
            <ListRow
              key={`${i.kind}-${i.id}`}
              left={i.kind === 'workout' ? <Dumbbell className="size-5 text-accent" /> : <Activity className="size-5 text-info" />}
              title={i.title}
              subtitle={`${formatDate(i.date)} · ${i.subtitle}`}
              right={<ChevronRight className="size-4" />}
              onClick={() => nav(i.href)}
            />
          ))}
        </Card>
      )}
    </Page>
  );
}
