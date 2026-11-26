import { useMemo, useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Trophy } from 'lucide-react';
import { Button, Card, EmptyState, ListRow, Select } from '@/components/ui';
import { RECORD_KIND_LABELS, e1rmEligible, exerciseSeries, exercisesWithHistory, personalRecords } from '@/domain/stats';
import { fromKg, round } from '@/domain/units';
import { exerciseName } from '@/data/catalog';
import { formatDate, formatDuration } from '@/lib/dates';
import { ChartFigure, ChartTip, Legend, axisProps, chartAnimation, num, seriesLine, shortDate, useChartColors } from './charts';
import { loadText, useT } from '@/i18n';
import { conventionNote, type ProgressData } from './shared';

export function ExerciseSection({ d }: { d: ProgressData }) {
  const c = useChartColors();
  const nav = useNavigate();
  const { t, tp, language } = useT();
  const unit = d.settings.units.weight;
  const ids = useMemo(() => exercisesWithHistory(d.sessions), [d.sessions]);
  const [picked, setPicked] = useState<string>('');
  const id = picked && ids.includes(picked) ? picked : ids[0];
  const ex = id ? d.byId.get(id) : undefined;

  const series = useMemo(() => (id ? exerciseSeries(d.rangeSessions, id, ex) : []), [d.rangeSessions, id, ex]);
  // English keeps "1 session" (singular); Icelandic copy is count-neutral.
  const enOne = language === 'en' && series.length === 1;
  const records = useMemo(() => (ex ? personalRecords(d.sessions, ex, unit) : []), [d.sessions, ex, unit]);

  if (!ids.length)
    return (
      <Card>
        <EmptyState
          icon={<Trophy className="size-6" />}
          title={t('progress.exerciseEmptyTitle')}
          body={t('progress.exerciseEmptyHelp')}
          action={
            <Button variant="primary" onClick={() => nav('/train')}>
              {t('progress.logFirst')}
            </Button>
          }
        />
      </Card>
    );

  const sorted = [...ids].sort((a, b) => exerciseName(a, d.byId).localeCompare(exerciseName(b, d.byId)));
  const tracking = ex?.tracking ?? 'weight_reps';
  const w = (kg: number | null) => (kg == null ? null : round(fromKg(kg, unit), 1));

  let chart: ReactElement | null = null;
  let summary = '';
  let table: { headers: string[]; rows: (string | number)[][] } = { headers: [], rows: [] };
  let legend: { label: string; color: string; dashed?: boolean; series?: number }[] = [];
  const data = series.map((p) => ({
    date: p.date,
    top: w(p.topWeightKg),
    e1rm: w(p.bestE1rmKg),
    reps: p.totalReps,
    maxReps: p.maxReps,
    assist: w(p.minAssistanceKg),
    longest: p.longestSec,
  }));
  const first = data[0];
  const last = data.at(-1);
  const lineProps = { type: 'monotone' as const, strokeWidth: 2, isAnimationActive: chartAnimation(), connectNulls: true };
  const common = (
    <>
      <CartesianGrid vertical={false} stroke={c.line} />
      <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
    </>
  );

  if (tracking === 'weight_reps' || tracking === 'bodyweight_plus') {
    const eligible = ex ? e1rmEligible(ex) : false;
    legend = [{ label: t(tracking === 'bodyweight_plus' ? 'progress.topAddedLoad' : 'progress.topSetWeight'), color: c.series[0], series: 0 }];
    if (eligible) legend.push({ label: t('progress.estimated1rm'), color: c.series[1], series: 1 });
    const tops = data.filter((x) => x.top != null);
    summary = tops.length
      ? (enOne
          ? `Top working set went from ${tops[0].top} ${unit} on ${formatDate(tops[0].date)} to ${tops.at(-1)!.top} ${unit} on ${formatDate(tops.at(-1)!.date)} across 1 session.`
          : t('progress.loadedTrend', { first: tops[0].top!, unit, firstDate: formatDate(tops[0].date), last: tops.at(-1)!.top!, lastDate: formatDate(tops.at(-1)!.date), count: series.length })) +
        (eligible ? ` ${t('progress.estimated1rmHelp')}` : '')
      : enOne
        ? '1 session without loaded sets in this period.'
        : t('progress.noLoadedSessions', { count: series.length });
    table = {
      headers: [t('progress.date'), t('progress.topSetUnit', { unit }), ...(eligible ? [t('progress.estimated1rmUnit', { unit })] : []), t('progress.workingSets'), t('progress.totalReps')],
      rows: series.map((p, i) => [formatDate(p.date), data[i].top ?? '–', ...(eligible ? [data[i].e1rm ?? '–'] : []), p.workingSets, p.totalReps]),
    };
    chart = (
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        {common}
        <YAxis {...axisProps(c)} domain={['auto', 'auto']} width={52} unit={` ${unit}`} tickFormatter={(v: number) => num(v)} />
        <Tooltip cursor={{ stroke: c.line }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => loadText(v, unit)} />} />
        <Line dataKey="top" name={legend[0].label} {...lineProps} {...seriesLine(0, c)} />
        {eligible && <Line dataKey="e1rm" name={t('progress.estimated1rm')} {...lineProps} {...seriesLine(1, c)} />}
      </LineChart>
    );
  } else if (tracking === 'reps') {
    legend = [{ label: t('progress.bestRepsSet'), color: c.series[0], series: 0 }, { label: t('progress.totalReps'), color: c.series[1], series: 1 }];
    summary = first && last ? t('progress.bodyweightTrend', { firstBest: first.maxReps ?? 0, lastBest: last.maxReps ?? 0, firstTotal: first.reps, lastTotal: last.reps, count: series.length }) : '';
    // i18n: no approved Icelandic copy for the short 'Best set' header
    table = { headers: [t('progress.date'), 'Best set', t('progress.totalReps'), t('progress.workingSets')], rows: series.map((p) => [formatDate(p.date), p.maxReps, p.totalReps, p.workingSets]) };
    chart = (
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
        {common}
        <YAxis {...axisProps(c)} allowDecimals={false} width={48} />
        <Tooltip cursor={{ stroke: c.line }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => tp('progress.repCount', v)} />} />
        <Line dataKey="maxReps" name={t('progress.bestRepsSet')} {...lineProps} {...seriesLine(0, c)} />
        <Line dataKey="reps" name={t('progress.totalReps')} {...lineProps} {...seriesLine(1, c)} />
      </LineChart>
    );
  } else if (tracking === 'assisted') {
    legend = [{ label: t('progress.leastAssistance'), color: c.series[0], series: 0 }];
    const pts = data.filter((x) => x.assist != null);
    summary = pts.length ? t('progress.assistanceTrend', { first: pts[0].assist!, unit, last: pts.at(-1)!.assist! }) : t('progress.assistanceEmpty');
    table = { headers: [t('progress.date'), t('progress.leastAssistanceUnit', { unit }), t('progress.bestRepsSet'), t('progress.workingSets')], rows: series.map((p, i) => [formatDate(p.date), data[i].assist ?? '–', p.maxReps, p.workingSets]) };
    chart = (
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        {common}
        <YAxis {...axisProps(c)} domain={[0, 'auto']} width={52} unit={` ${unit}`} tickFormatter={(v: number) => num(v)} />
        <Tooltip cursor={{ stroke: c.line }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => loadText(v, unit)} />} />
        <Line dataKey="assist" name={t('progress.leastAssistance')} {...lineProps} {...seriesLine(0, c)} />
      </LineChart>
    );
  } else {
    legend = [{ label: t('progress.longestSet'), color: c.series[0], series: 0 }];
    const pts = data.filter((x) => x.longest != null);
    summary = pts.length ? t('progress.timedTrend', { firstDuration: formatDuration(pts[0].longest!), lastDuration: formatDuration(pts.at(-1)!.longest!), count: pts.length }) : t('progress.timedEmpty');
    table = { headers: [t('progress.date'), t('progress.longestSet'), t('progress.workingSets')], rows: series.map((p) => [formatDate(p.date), p.longestSec ? formatDuration(p.longestSec) : '–', p.workingSets]) };
    chart = (
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        {common}
        <YAxis {...axisProps(c)} tickFormatter={(v: number) => formatDuration(v)} width={52} />
        <Tooltip cursor={{ stroke: c.line }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => formatDuration(v)} />} />
        <Line dataKey="longest" name={t('progress.longestSet')} {...lineProps} {...seriesLine(0, c)} />
      </LineChart>
    );
  }

  const note = ex ? conventionNote(ex) : null;

  return (
    <Card className="p-4 flex flex-col gap-3">
      <Select label={t('progress.exercise')} value={id} onChange={(e) => setPicked(e.target.value)}>
        {sorted.map((x) => (
          <option key={x} value={x}>
            {exerciseName(x, d.byId)}
          </option>
        ))}
      </Select>
      {note && <p className="text-xs text-muted -mt-1">{note}</p>}

      {series.length === 0 ? (
        <p className="text-sm text-muted py-4 text-center">{t('progress.exercisePeriodEmpty')}</p>
      ) : (
        <div>
          {legend.length > 1 && <Legend items={legend} />}
          <ChartFigure title={t('progress.exerciseProgressTitle', { exercise: ex?.name ?? exerciseName(id, d.byId) })} summary={summary} table={table}>
            <ResponsiveContainer width="100%" height="100%">
              {chart ?? <div />}
            </ResponsiveContainer>
          </ChartFigure>
          {series.length === 1 && <p className="text-xs text-muted px-1 mt-1">{t('progress.oneSession')}</p>}
        </div>
      )}

      <div className="border-t border-line pt-3">
        <h3 className="text-sm font-medium mb-1">{t('progress.records')}</h3>
        <p className="text-xs text-muted mb-2">{t('progress.recordsHelp')}</p>
        {records.length === 0 ? (
          <p className="text-sm text-muted">{t('progress.noRecords')}</p>
        ) : (
          <ul className="-mx-4 divide-y divide-line">
            {records.map((r) => (
              <li key={`${r.kind}-${r.value}-${r.sessionId}`}>
                <Link to={`/train/history/${r.sessionId}`} className="block">
                  <ListRow title={r.label} subtitle={`${RECORD_KIND_LABELS[r.kind]} · ${formatDate(r.date, { day: 'numeric', month: 'short', year: 'numeric' })}`} left={<Trophy className="size-4 text-accent" aria-hidden />} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
