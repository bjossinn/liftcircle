import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import clsx from 'clsx';
import { Activity, ChevronLeft, ChevronRight, Dumbbell, Search } from 'lucide-react';
import { useApp } from '@/state/app';
import { Card, EmptyState, IconButton, Input, ListRow, Page, Segmented, Spinner, Button } from '@/components/ui';
import { useAllActivities, useAllSessions } from './hooks';
import { useExercises } from '@/data/catalog';
import { addDays, formatDate, formatMinutes, startOfWeek, todayISO, weekdayShort } from '@/lib/dates';
import { useT } from '@/i18n';
import { activityLabel } from '@/domain/activities';
import { formatDistance } from '@/domain/units';
import { exercisesDone, sessionDurationSec } from '@/domain/stats';
import { NoWorkoutsArt } from '@/components/illustrations';
import { exerciseDisplayName } from '@/data/catalogText';

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
  const { t, tp } = useT();

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const s of sessions ?? []) {
      if (s.status !== 'completed') continue;
      const names = s.exercises.map((e) => (byId.get(e.exerciseId) ? exerciseDisplayName(byId.get(e.exerciseId)) : '')).filter(Boolean);
      out.push({
        id: s.id,
        kind: 'workout',
        date: s.date,
        sort: s.startedAt,
        title: s.name,
        subtitle: tp('train.historyMeta', exercisesDone(s), { duration: formatMinutes(sessionDurationSec(s)) }),
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
  }, [sessions, activities, byId, settings.units.distance, tp]);

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
  const weekdays = Array.from({ length: 7 }, (_, i) => weekdayShort((settings.weekStart + i) % 7));

  return (
    <Page
      title={t('train.historyTitle')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <Card className="p-3">
        <div className="flex items-center justify-between">
          <IconButton label={t('train.previousMonth')} onClick={() => shiftMonth(-1)}>
            <ChevronLeft className="size-5" />
          </IconButton>
          <h2 className="font-semibold">{formatDate(first, { month: 'long', year: 'numeric' })}</h2>
          <IconButton label={t('train.nextMonth')} onClick={() => shiftMonth(1)} disabled={month >= today.slice(0, 7)}>
            <ChevronRight className="size-5" />
          </IconButton>
        </div>
        <div className="grid grid-cols-7 gap-1 mt-1 text-center" role="grid" aria-label={t('train.calendar')}>
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
                aria-label={tp('train.calendarEntries', its.length, { date: formatDate(d, { weekday: 'long', day: 'numeric', month: 'long' }) })}
                aria-selected={day === d}
                onClick={() => setDay(day === d ? null : d)}
                className={clsx(
                  'min-h-11 rounded-lg flex flex-col items-center justify-center text-sm tabular',
                  !inMonth && 'opacity-35',
                  day === d ? 'bg-ember text-accent-ink' : d === today ? 'ring-1 ring-accent' : 'hover:bg-surface-2',
                )}
              >
                {Number(d.slice(8))}
                <span className="flex gap-0.5 h-1.5 mt-0.5">
                  {hasW && <span className={clsx('size-1.5 rounded-full', day === d ? 'bg-accent-ink' : 'bg-ember')} />}
                  {hasA && <span className={clsx('size-1.5 rounded-full', day === d ? 'bg-accent-ink' : 'bg-info')} />}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex gap-4 justify-center text-[11px] text-muted mt-2">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-ember" /> {t('train.historyWorkout')}
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-info" /> {t('train.historyActivity')}
          </span>
        </div>
      </Card>

      <div className="mt-4 space-y-3">
        <div className="relative">
          <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label={t('train.searchHistory')} placeholder={t('train.searchHistoryPlaceholder')} className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented
          label={t('train.filterHistory')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'workouts', label: t('train.filterWorkouts') },
            { value: 'activities', label: t('train.filterActivities') },
          ]}
        />
        {day && (
          <div className="flex items-center justify-between text-sm">
            <span>{t('train.showingDate', { date: formatDate(day) })}</span>
            <Button size="sm" variant="ghost" onClick={() => setDay(null)}>
              {t('train.showAll')}
            </Button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState illustration={<NoWorkoutsArt />} title={t('train.historyEmptyTitle')} body={t('train.historyEmptyHelp')} action={<Button variant="primary" onClick={() => nav('/train')}>{t('train.historyLog')}</Button>} />
      ) : filtered.length === 0 ? (
        <EmptyState title={t('train.noMatches')} body={t('train.noMatchesHelp')} />
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
