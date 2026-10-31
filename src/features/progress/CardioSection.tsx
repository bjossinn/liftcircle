import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Plus, Route } from 'lucide-react';
import { Button, Card, EmptyState, ListRow, Segmented, Select, Stat } from '@/components/ui';
import { cardioSeries, weeklyTotals } from '@/domain/stats';
import { ACTIVITY_TYPES, activityLabel, activityTypeInfo, formatPaceSec, paceOrSpeed } from '@/domain/activities';
import { formatDistance, fromMeters, round } from '@/domain/units';
import type { ActivityType } from '@/domain/types';
import { formatDate, formatMinutes } from '@/lib/dates';
import { ActivityIcon } from '@/features/activities/icons';
import { ChartFigure, ChartTip, axisProps, chartAnimation, seriesLine, shortDate, useChartColors, weekLabel } from './charts';
import { fmtInt, type ProgressData } from './shared';

export function CardioSection({ d }: { d: ProgressData }) {
  const c = useChartColors();
  const nav = useNavigate();
  const du = d.settings.units.distance;
  const ws = d.settings.weekStart;
  const [metric, setMetric] = useState<'minutes' | 'distance'>('minutes');
  const [typeSel, setTypeSel] = useState<ActivityType | ''>('');

  const weeks = useMemo(() => weeklyTotals([], d.rangeActivities, ws, d.from, d.to), [d.rangeActivities, ws, d.from, d.to]);
  const paceTypes = useMemo(() => {
    const set = new Set(d.rangeActivities.filter((a) => a.distanceM && activityTypeInfo(a.type).paceMode).map((a) => a.type));
    return ACTIVITY_TYPES.filter((t) => set.has(t.type)).map((t) => t.type);
  }, [d.rangeActivities]);
  const type = typeSel && paceTypes.includes(typeSel) ? typeSel : paceTypes[0];
  const paceData = useMemo(
    () =>
      type
        ? cardioSeries(d.rangeActivities, type)
            .filter((p) => p.distanceM)
            .map((p) => {
              const r = paceOrSpeed({ type, distanceM: p.distanceM, durationSec: p.durationSec }, du)!;
              return { date: p.date, value: round(r.value, 1), text: r.text, distance: formatDistance(p.distanceM!, du) };
            })
        : [],
    [d.rangeActivities, type, du],
  );

  if (!d.activities.length)
    return (
      <Card>
        <EmptyState
          icon={<Route className="size-6" />}
          title="No activities yet"
          body="Log a walk, run, ride, swim or class to see weekly time, distance and pace trends."
          action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/train/activity/new')}>Log an activity</Button>}
        />
      </Card>
    );

  const totalMin = Math.round(weeks.reduce((s, w) => s + w.activityMinutes, 0));
  const totalDist = weeks.reduce((s, w) => s + w.distanceM, 0);
  const n = Math.max(1, weeks.length);
  const chartData = weeks.map((w) => ({ week: w.week, value: metric === 'minutes' ? Math.round(w.activityMinutes) : round(fromMeters(w.distanceM, du), 1) }));
  const sum =
    metric === 'minutes'
      ? `${fmtInt(totalMin)} minutes of activity in this period, ${fmtInt(totalMin / n)} per week on average.`
      : `${formatDistance(totalDist, du, 1)} in this period, ${formatDistance(totalDist / n, du, 1)} per week on average.`;
  const mode = type ? activityTypeInfo(type).paceMode : null;
  const isSpeed = mode === 'speed';
  const paceUnit = paceData[0]?.text.replace(/^[\d:.]+\s*/, '') ?? '';
  const paceSummary =
    paceData.length >= 2
      ? `${activityLabel({ type: type! })} ${isSpeed ? 'speed' : 'pace'} went from ${paceData[0].text} to ${paceData.at(-1)!.text} over ${paceData.length} sessions.${isSpeed ? '' : ' Lower pace is faster.'}`
      : paceData.length === 1
        ? `One ${activityLabel({ type: type! }).toLowerCase()} with distance: ${paceData[0].text}.`
        : '';
  const recent = [...d.rangeActivities].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt))).slice(0, 8);

  return (
    <Card className="p-4 flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Activities" value={d.rangeActivities.length} />
        <Stat label="Time" value={formatMinutes(totalMin * 60)} />
        <Stat label="Distance" value={formatDistance(totalDist, du, 1)} />
      </div>

      <div>
        <Segmented label="Weekly metric" value={metric} onChange={setMetric} options={[{ value: 'minutes', label: 'Minutes' }, { value: 'distance', label: `Distance (${du})` }]} size="sm" className="mb-3" />
        <ChartFigure
          title={metric === 'minutes' ? 'Activity minutes per week' : `Distance per week (${du})`}
          summary={sum}
          table={{ headers: ['Week', metric === 'minutes' ? 'Minutes' : du], rows: chartData.map((x) => [weekLabel(x.week), x.value]) }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
              <CartesianGrid vertical={false} stroke={c.line} />
              <XAxis dataKey="week" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
              <YAxis {...axisProps(c)} width={48} />
              <Tooltip cursor={{ fill: c.accentSoft }} content={(p) => <ChartTip {...p} labelFmt={weekLabel} valueFmt={(v) => (metric === 'minutes' ? `${v} min` : `${v} ${du}`)} />} />
              <Bar dataKey="value" name={metric === 'minutes' ? 'Minutes' : 'Distance'} fill={c.series[0]} radius={[4, 4, 0, 0]} isAnimationActive={chartAnimation()} />
            </BarChart>
          </ResponsiveContainer>
        </ChartFigure>
      </div>

      <div className="border-t border-line pt-3 flex flex-col gap-3">
        <h3 className="text-sm font-medium">{isSpeed ? 'Speed' : 'Pace'} trend</h3>
        {paceTypes.length === 0 ? (
          <p className="text-sm text-muted">Add a distance to a walk, run, ride, hike, swim or row to see pace trends.</p>
        ) : (
          <>
            {paceTypes.length > 1 && (
              <Select aria-label="Activity type for pace trend" value={type} onChange={(e) => setTypeSel(e.target.value as ActivityType)}>
                {paceTypes.map((t) => (
                  <option key={t} value={t}>{activityLabel({ type: t })}</option>
                ))}
              </Select>
            )}
            <ChartFigure
              title={`${activityLabel({ type: type! })} ${isSpeed ? 'speed' : 'pace'} (${paceUnit})`}
              summary={paceSummary}
              table={{ headers: ['Date', 'Distance', isSpeed ? 'Speed' : 'Pace'], rows: paceData.map((p) => [formatDate(p.date), p.distance, p.text]) }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={paceData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid vertical={false} stroke={c.line} />
                  <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis {...axisProps(c)} domain={['auto', 'auto']} width={52} tickFormatter={(v: number) => (isSpeed ? String(v) : formatPaceSec(v))} />
                  <Tooltip
                    cursor={{ stroke: c.line }}
                    content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => (isSpeed ? `${v} ${paceUnit}` : `${formatPaceSec(v)} ${paceUnit}`)} />}
                  />
                  <Line type="monotone" dataKey="value" name={isSpeed ? 'Speed' : 'Pace'} strokeWidth={2} isAnimationActive={chartAnimation()} {...seriesLine(0, c)} />
                </LineChart>
              </ResponsiveContainer>
            </ChartFigure>
          </>
        )}
      </div>

      <div className="border-t border-line pt-3">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-medium">Recent activities</h3>
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => nav('/train/activity/new')}>Log</Button>
        </div>
        {recent.length === 0 ? (
          <p className="text-sm text-muted">No activities in this period.</p>
        ) : (
          <ul className="-mx-4 divide-y divide-line">
            {recent.map((a) => {
              const p = paceOrSpeed(a, du);
              return (
                <li key={a.id}>
                  <Link to={`/train/activity/${a.id}`} aria-label={`Edit ${activityLabel(a)} on ${formatDate(a.date)}`}>
                    <ListRow
                      left={<span className="text-accent"><ActivityIcon type={a.type} /></span>}
                      title={activityLabel(a)}
                      subtitle={[formatDate(a.date), formatMinutes(a.durationSec), a.distanceM ? formatDistance(a.distanceM, du) : null, p?.text].filter(Boolean).join(' · ')}
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
