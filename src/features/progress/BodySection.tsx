import { useMemo, useState } from 'react';
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Pencil, Plus } from 'lucide-react';
import { Button, Card, IconButton, Select } from '@/components/ui';
import { rollingAverage } from '@/domain/stats';
import type { Measurement, MeasurementKind } from '@/domain/types';
import { formatDate } from '@/lib/dates';
import { ChartFigure, ChartTip, Legend, PeriodEmpty, axisProps, chartAnimation, num, seriesLine, shortDate, useChartColors } from './charts';
import { useT } from '@/i18n';
import type { ProgressData } from './shared';
import { KIND_ORDER, MEASUREMENT_KINDS, MeasurementEditor, kindLabel, shownValue, unitFor } from './MeasurementEditor';
import { measuredKinds, pickMeasurementKind } from './visibility';

/**
 * Body: the chart selector offers only measured kinds (bodyweight first when present); the Add editor keeps all seven.
 * A single real point is shown; a removed selection falls back to an available kind.
 */
export function BodySection({ d, today }: { d: ProgressData; today: string }) {
  const c = useChartColors();
  const { t, locale } = useT();
  const lower = (s: string) => s.toLocaleLowerCase(locale);
  const available = useMemo(() => measuredKinds(d.measurements, KIND_ORDER), [d.measurements]);
  const [requested, setRequested] = useState<MeasurementKind | null>(null);
  const kind = pickMeasurementKind(requested, available) ?? 'bodyweight';
  const [editing, setEditing] = useState<Measurement | 'new' | null>(null);

  const u = unitFor(kind, d.settings);
  const all = useMemo(() => d.measurements.filter((m) => m.kind === kind).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt)), [d.measurements, kind]);
  const inRange = all.filter((m) => m.date >= d.from && m.date <= d.to);
  const isBw = kind === 'bodyweight';
  const chartData = useMemo(() => {
    // Rolling average uses all entries so the first points in the range have a full window.
    const avg = rollingAverage(all.map((m) => ({ date: m.date, value: m.value, id: m.id })), 7);
    const byId = new Map(avg.map((a) => [a.id, a.avg]));
    return [...inRange].reverse().map((m) => ({ date: m.date, value: u.toDisplay(m.value), avg: isBw ? u.toDisplay(byId.get(m.id) ?? m.value) : undefined }));
  }, [all, inRange, isBw, u]);

  const fmt = (m: Measurement) => `${num(shownValue(m, d.settings))} ${u.unit}`;
  const latest = chartData.at(-1);
  const firstPt = chartData[0];
  const summary =
    chartData.length >= 2
      ? t('progress.measurementTrend', { count: chartData.length, metric: t(isBw ? 'progress.average7Days' : 'progress.value'), first: (isBw ? firstPt.avg : firstPt.value) ?? '–', last: (isBw ? latest!.avg : latest!.value) ?? '–', unit: u.unit })
      : chartData.length === 1
        ? t('progress.oneMeasurement', { value: latest!.value, unit: u.unit })
        : '';

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex gap-2 items-end">
        <Select label={t('progress.measurement')} value={kind} onChange={(e) => setRequested(e.target.value as MeasurementKind)} className="flex-1">
          {MEASUREMENT_KINDS.filter((k) => available.includes(k.value)).map((k) => (
            <option key={k.value} value={k.value}>{t(k.label)}</option>
          ))}
        </Select>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
          {t('progress.add')}
        </Button>
      </div>

      {chartData.length > 0 ? (
        <div>
          {isBw && <Legend items={[{ label: t('progress.entries'), color: c.series[1], series: 1 }, { label: t('progress.average7Days'), color: c.series[0], series: 0 }]} />}
          <ChartFigure
            title={`${kindLabel(kind)} (${u.unit})`}
            summary={summary}
            table={{ headers: [t('progress.date'), t('progress.valueUnit', { unit: u.unit }), ...(isBw ? [t('progress.average7DaysShort')] : [])], rows: chartData.map((p) => [formatDate(p.date), p.value, ...(isBw ? [p.avg ?? '–'] : [])]) }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke={c.line} />
                <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
                <YAxis {...axisProps(c)} domain={['auto', 'auto']} width={52} tickFormatter={(v: number) => num(v)} />
                <Tooltip cursor={{ stroke: c.line }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => `${num(v)} ${u.unit}`} />} />
                <Line dataKey="value" name={t('progress.entry')} strokeWidth={2} isAnimationActive={chartAnimation()} {...seriesLine(isBw ? 1 : 0, c)} stroke={isBw ? 'transparent' : c.series[0]} />
                {isBw && <Line type="monotone" dataKey="avg" name={t('progress.average7Days')} strokeWidth={2} isAnimationActive={chartAnimation()} {...seriesLine(0, c)} dot={false} />}
              </ComposedChart>
            </ResponsiveContainer>
          </ChartFigure>
        </div>
      ) : (
        <PeriodEmpty onShowAll={d.onShowAll} />
      )}
      <ul className="-mx-4 divide-y divide-line border-t border-line max-h-80 overflow-y-auto">
        {all.slice(0, 50).map((m) => (
          <li key={m.id} className="flex items-center gap-2 px-4 min-h-12">
            <span className="flex-1 min-w-0">
              <span className="text-[15px] tabular">{fmt(m)}</span>
              <span className="block text-xs text-muted truncate">{formatDate(m.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}{m.note ? ` · ${m.note}` : ''}</span>
            </span>
            <IconButton label={t('progress.editMeasurementDated', { measurement: lower(kindLabel(kind)), date: formatDate(m.date) })} onClick={() => setEditing(m)}>
              <Pencil className="size-4" />
            </IconButton>
          </li>
        ))}
      </ul>

      <MeasurementEditor target={editing} kind={kind} measurements={d.measurements} settings={d.settings} today={today} onClose={() => setEditing(null)} />
    </Card>
  );
}
