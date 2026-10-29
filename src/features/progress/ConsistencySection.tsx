import { useMemo } from 'react';
import { Link } from 'react-router';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, ProgressBar, Stat } from '@/components/ui';
import { weeklyTotals } from '@/domain/stats';
import { adherence } from '@/domain/program/schedule';
import { startOfWeek } from '@/lib/dates';
import { round } from '@/domain/units';
import { ChartFigure, ChartTip, Legend, axisProps, chartAnimation, shortDate, useChartColors, weekLabel } from './charts';
import type { ProgressData } from './shared';

function safeAdherence(d: ProgressData, from: string): { planned: number; completed: number } | null {
  if (!d.program) return null;
  const start = from < d.program.startDate ? d.program.startDate : from;
  if (start > d.today) return { planned: 0, completed: 0 };
  try {
    return adherence(d.program, start, d.today, d.today, d.sessions);
  } catch {
    return null;
  }
}

export function ConsistencySection({ d }: { d: ProgressData }) {
  const c = useChartColors();
  const ws = d.settings.weekStart;
  const weeks = useMemo(() => weeklyTotals(d.rangeSessions, d.rangeActivities, ws, d.from, d.to), [d.rangeSessions, d.rangeActivities, ws, d.from, d.to]);
  const range = useMemo(() => safeAdherence(d, d.from), [d]);
  const thisWeek = useMemo(() => safeAdherence(d, startOfWeek(d.today, ws)), [d, ws]);

  const workouts = d.rangeSessions.length;
  const acts = d.rangeActivities.length;
  const avg = weeks.length ? round((workouts + acts) / weeks.length, 1) : 0;
  const summary = `${workouts} workout${workouts === 1 ? '' : 's'} and ${acts} other activit${acts === 1 ? 'y' : 'ies'} over ${weeks.length} week${weeks.length === 1 ? '' : 's'}, about ${avg} sessions per week.`;

  return (
    <Card className="p-4 flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Workouts" value={workouts} />
        <Stat label="Activities" value={acts} />
        <Stat label="Per week" value={avg} />
      </div>

      <div>
        <Legend items={[{ label: 'Workouts', color: c.accent }, { label: 'Other activities', color: c.info }]} />
        <ChartFigure
          title="Sessions per week"
          summary={summary}
          table={{ headers: ['Week', 'Workouts', 'Activities'], rows: weeks.map((w) => [weekLabel(w.week), w.workouts, w.activities]) }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weeks} margin={{ top: 8, right: 4, bottom: 0, left: -24 }}>
              <CartesianGrid vertical={false} stroke={c.line} />
              <XAxis dataKey="week" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
              <YAxis allowDecimals={false} {...axisProps(c)} width={48} />
              <Tooltip cursor={{ fill: c.accentSoft }} content={(p) => <ChartTip {...p} labelFmt={weekLabel} />} />
              <Bar dataKey="workouts" name="Workouts" stackId="s" fill={c.accent} isAnimationActive={chartAnimation()} stroke={c.surface} strokeWidth={1} />
              <Bar dataKey="activities" name="Other activities" stackId="s" fill={c.info} radius={[4, 4, 0, 0]} isAnimationActive={chartAnimation()} stroke={c.surface} strokeWidth={1} />
            </BarChart>
          </ResponsiveContainer>
        </ChartFigure>
      </div>

      <div className="border-t border-line pt-3">
        <h3 className="text-sm font-medium mb-2">Plan adherence</h3>
        {!d.program ? (
          <p className="text-sm text-muted">
            No active program. <Link to="/train/program" className="text-accent underline-offset-2 hover:underline">Set up a program</Link> to compare planned and completed sessions.
          </p>
        ) : range && range.planned > 0 ? (
          <div className="flex flex-col gap-3">
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>This period</span>
                <span className="tabular">{range.completed} of {range.planned} planned sessions</span>
              </div>
              <ProgressBar value={range.completed} max={range.planned} label="Planned sessions completed in this period" />
            </div>
            {thisWeek && thisWeek.planned > 0 && (
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span>This week so far</span>
                  <span className="tabular">{thisWeek.completed} of {thisWeek.planned}</span>
                </div>
                <ProgressBar value={thisWeek.completed} max={thisWeek.planned} label="Planned sessions completed this week" />
              </div>
            )}
            <p className="text-xs text-muted">Counts planned sessions up to today in “{d.program.name}”. Moved sessions count on their new date.</p>
          </div>
        ) : (
          <p className="text-sm text-muted">No planned sessions in this period yet for “{d.program.name}”.</p>
        )}
      </div>
    </Card>
  );
}
