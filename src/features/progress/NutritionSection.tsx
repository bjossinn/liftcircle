import { useMemo } from 'react';
import { Link } from 'react-router';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, Stat } from '@/components/ui';
import { proteinDays, weekStarts } from '@/domain/stats';
import { formatDate, startOfWeek } from '@/lib/dates';
import { round } from '@/domain/units';
import { ChartFigure, ChartTip, Legend, PeriodEmpty, axisProps, chartAnimation, num, shortDate, useChartColors, weekLabel } from './charts';
import { inRange, type ProgressData } from './shared';
import { proteinView } from './visibility';
import { useT } from '@/i18n';

/**
 * Protein from the food log, shown whenever food is logged (whatever the nutrition setting). A numeric zero is data;
 * logs without a protein value are "no data", never zero. Without a target, only recorded grams and their average.
 */
export function NutritionSection({ d, proteinTargetG }: { d: ProgressData; proteinTargetG?: number }) {
  const c = useChartColors();
  const { t, tp } = useT();
  const ws = d.settings.weekStart;
  const rangeLogs = useMemo(() => d.rangeFoodLogs ?? inRange(d.foodLogs, d.from, d.to), [d.rangeFoodLogs, d.foodLogs, d.from, d.to]);
  const view = proteinView(rangeLogs);
  const target = proteinTargetG && proteinTargetG > 0 ? proteinTargetG : undefined;
  const days = useMemo(() => proteinDays(rangeLogs, d.from, d.to, target), [rangeLogs, d.from, d.to, target]);

  if (view === 'none')
    return (
      <Card className="p-4">
        <PeriodEmpty onShowAll={d.onShowAll} />
      </Card>
    );
  if (view === 'unknown')
    return (
      <Card className="p-4 flex flex-col items-start gap-2">
        <p className="text-sm text-muted">{t('progress.proteinUnknown')}</p>
        <Link to="/nutrition/log" className="text-sm text-accent font-medium min-h-11 inline-flex items-center">
          {t('today.logFood')}
        </Link>
      </Card>
    );

  const logged = days.filter((x) => x.proteinG != null);
  const noData = days.length - logged.length;
  const avg = logged.length ? Math.round(logged.reduce((s, x) => s + (x.proteinG ?? 0), 0) / logged.length) : 0;

  if (!target) {
    const summary = t('progress.proteinTrendWithoutTarget', { logged: logged.length, average: avg, noData });
    const points = logged.map((x) => ({ date: x.date, value: round(x.proteinG!, 1) }));
    return (
      <Card className="p-4 flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Stat label={t('progress.loggedDays')} value={logged.length} />
          <Stat label={t('progress.average')} value={`${num(avg)} g`} />
        </div>
        <ChartFigure title={t('progress.loggedProtein')} summary={summary} table={{ headers: [t('progress.date'), t('progress.loggedProtein')], rows: points.map((p) => [formatDate(p.date), `${num(p.value)} g`]) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: -16 }}>
              <CartesianGrid vertical={false} stroke={c.line} />
              <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
              <YAxis allowDecimals={false} {...axisProps(c)} width={48} tickFormatter={(v: number) => num(v)} />
              <Tooltip cursor={{ fill: c.accentSoft }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => `${num(v)} g`} />} />
              <Bar dataKey="value" name={t('progress.loggedProtein')} fill={c.accent} radius={[4, 4, 0, 0]} isAnimationActive={chartAnimation()} />
            </BarChart>
          </ResponsiveContainer>
        </ChartFigure>
      </Card>
    );
  }

  const met = logged.filter((x) => x.met).length;
  const weeks = weekStarts(d.from, d.to, ws).map((w) => ({ week: w, met: 0, notMet: 0, noData: 0 }));
  const idx = new Map(weeks.map((w, i) => [w.week, i]));
  for (const day of days) {
    const row = weeks[idx.get(startOfWeek(day.date, ws)) ?? -1];
    if (!row) continue;
    if (day.proteinG == null) row.noData++;
    else if (day.met) row.met++;
    else row.notMet++;
  }
  const summary = t('progress.proteinTrend', { target, met, logged: logged.length, average: avg, noData });

  return (
    <Card className="p-4 flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label={t('progress.targetMet')} value={`${met}/${logged.length}`} sub={t('progress.loggedDays')} />
        <Stat label={t('progress.average')} value={`${num(avg)} g`} sub={t('progress.proteinTargetValue', { target })} />
        <Stat label={t('progress.noData')} value={tp('progress.dayCount', noData)} />
      </div>
      <div>
        <Legend items={[{ label: t('progress.targetMet'), color: c.accent }, { label: t('progress.proteinBelow'), color: c.faint }]} />
        <ChartFigure
          title={t('progress.proteinDaysWeek')}
          summary={summary}
          table={{ headers: [t('progress.week'), t('progress.targetMet'), t('progress.proteinBelow'), t('progress.noData')], rows: weeks.map((w) => [weekLabel(w.week), w.met, w.notMet, w.noData]) }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weeks} margin={{ top: 8, right: 4, bottom: 0, left: -24 }}>
              <CartesianGrid vertical={false} stroke={c.line} />
              <XAxis dataKey="week" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
              <YAxis allowDecimals={false} domain={[0, 7]} {...axisProps(c)} width={48} />
              <Tooltip cursor={{ fill: c.accentSoft }} content={(p) => <ChartTip {...p} labelFmt={weekLabel} valueFmt={(v) => tp('progress.dayCount', round(v, 0))} />} />
              <Bar dataKey="met" name={t('progress.targetMet')} stackId="p" fill={c.accent} stroke={c.surface} strokeWidth={1} isAnimationActive={chartAnimation()} />
              <Bar dataKey="notMet" name={t('progress.proteinBelow')} stackId="p" fill={c.faint} stroke={c.surface} strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={chartAnimation()} />
            </BarChart>
          </ResponsiveContainer>
        </ChartFigure>
      </div>
    </Card>
  );
}
