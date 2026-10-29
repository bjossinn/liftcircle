import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button, Card, Stat } from '@/components/ui';
import { proteinDays, weekStarts } from '@/domain/stats';
import { startOfWeek } from '@/lib/dates';
import { round } from '@/domain/units';
import { ChartFigure, ChartTip, Legend, axisProps, chartAnimation, shortDate, useChartColors, weekLabel } from './charts';
import type { ProgressData } from './shared';

export function NutritionSection({ d, proteinTargetG }: { d: ProgressData; proteinTargetG?: number }) {
  const c = useChartColors();
  const nav = useNavigate();
  const ws = d.settings.weekStart;
  const days = useMemo(() => proteinDays(d.foodLogs, d.from, d.to, proteinTargetG), [d.foodLogs, d.from, d.to, proteinTargetG]);

  if (!proteinTargetG)
    return (
      <Card className="p-4 flex flex-col gap-3 items-start">
        <p className="text-sm text-muted">Set a daily protein target to see how often you reach it.</p>
        <Button variant="primary" onClick={() => nav('/nutrition/targets')}>Set protein target</Button>
      </Card>
    );

  const logged = days.filter((x) => x.proteinG != null);
  const met = logged.filter((x) => x.met).length;
  const noData = days.length - logged.length;
  const avg = logged.length ? Math.round(logged.reduce((s, x) => s + (x.proteinG ?? 0), 0) / logged.length) : null;

  const weeks = weekStarts(d.from, d.to, ws).map((w) => ({ week: w, met: 0, notMet: 0, noData: 0 }));
  const idx = new Map(weeks.map((w, i) => [w.week, i]));
  for (const day of days) {
    const row = weeks[idx.get(startOfWeek(day.date, ws)) ?? -1];
    if (!row) continue;
    if (day.proteinG == null) row.noData++;
    else if (day.met) row.met++;
    else row.notMet++;
  }
  const summary = logged.length
    ? `Protein target of ${proteinTargetG} g reached on ${met} of ${logged.length} logged days${avg != null ? `, averaging ${avg} g on logged days` : ''}. ${noData} day${noData === 1 ? '' : 's'} had no protein logged and are shown as no data, not zero.`
    : `No protein logged in this period. Days without logs are treated as no data, not zero.`;

  return (
    <Card className="p-4 flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Target met" value={`${met}/${logged.length}`} sub="logged days" />
        <Stat label="Average" value={avg != null ? `${avg} g` : '–'} sub={`target ${proteinTargetG} g`} />
        <Stat label="No data" value={noData} sub={noData === 1 ? 'day' : 'days'} />
      </div>
      {logged.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted">{summary}</p>
          <Button onClick={() => nav('/nutrition/log')}>Log food</Button>
        </div>
      ) : (
        <div>
          <Legend items={[{ label: 'Target met', color: c.accent }, { label: 'Logged, below target', color: c.faint }]} />
          <ChartFigure
            title="Protein days per week"
            summary={summary}
            table={{ headers: ['Week', 'Met', 'Below target', 'No data'], rows: weeks.map((w) => [weekLabel(w.week), w.met, w.notMet, w.noData]) }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weeks} margin={{ top: 8, right: 4, bottom: 0, left: -24 }}>
                <CartesianGrid vertical={false} stroke={c.line} />
                <XAxis dataKey="week" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
                <YAxis allowDecimals={false} domain={[0, 7]} {...axisProps(c)} width={48} />
                <Tooltip cursor={{ fill: c.accentSoft }} content={(p) => <ChartTip {...p} labelFmt={weekLabel} valueFmt={(v) => `${round(v, 0)} day${v === 1 ? '' : 's'}`} />} />
                <Bar dataKey="met" name="Target met" stackId="p" fill={c.accent} stroke={c.surface} strokeWidth={1} isAnimationActive={chartAnimation()} />
                <Bar dataKey="notMet" name="Below target" stackId="p" fill={c.faint} stroke={c.surface} strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={chartAnimation()} />
              </BarChart>
            </ResponsiveContainer>
          </ChartFigure>
        </div>
      )}
    </Card>
  );
}
