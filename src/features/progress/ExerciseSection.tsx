import { useMemo, useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Trophy } from 'lucide-react';
import { Button, Card, EmptyState, ListRow, Select } from '@/components/ui';
import { RECORD_KIND_LABELS, e1rmEligible, exerciseSeries, exercisesWithHistory, personalRecords } from '@/domain/stats';
import { fromKg, round } from '@/domain/units';
import { exerciseName } from '@/data/catalog';
import { formatDate, formatDuration } from '@/lib/dates';
import { ChartFigure, ChartTip, Legend, axisProps, chartAnimation, shortDate, useChartColors } from './charts';
import { conventionNote, type ProgressData } from './shared';

export function ExerciseSection({ d }: { d: ProgressData }) {
  const c = useChartColors();
  const nav = useNavigate();
  const unit = d.settings.units.weight;
  const ids = useMemo(() => exercisesWithHistory(d.sessions), [d.sessions]);
  const [picked, setPicked] = useState<string>('');
  const id = picked && ids.includes(picked) ? picked : ids[0];
  const ex = id ? d.byId.get(id) : undefined;

  const series = useMemo(() => (id ? exerciseSeries(d.rangeSessions, id, ex) : []), [d.rangeSessions, id, ex]);
  const records = useMemo(() => (ex ? personalRecords(d.sessions, ex, unit) : []), [d.sessions, ex, unit]);

  if (!ids.length)
    return (
      <Card>
        <EmptyState
          icon={<Trophy className="size-6" />}
          title="No exercise history yet"
          body="Complete a workout and your load, reps and records for each exercise will show up here."
          action={
            <Button variant="primary" onClick={() => nav('/train')}>
              Log your first workout
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
  let legend: { label: string; color: string; dashed?: boolean }[] = [];
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
  const lineProps = { type: 'monotone' as const, strokeWidth: 2, dot: { r: 4, strokeWidth: 2, stroke: c.surface }, activeDot: { r: 6 }, isAnimationActive: chartAnimation(), connectNulls: true };
  const common = (
    <>
      <CartesianGrid vertical={false} stroke={c.line} />
      <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
    </>
  );

  if (tracking === 'weight_reps' || tracking === 'bodyweight_plus') {
    const eligible = ex ? e1rmEligible(ex) : false;
    legend = [{ label: tracking === 'bodyweight_plus' ? 'Top added load' : 'Top-set weight', color: c.accent }];
    if (eligible) legend.push({ label: 'Estimated 1RM (Epley)', color: c.info, dashed: true });
    const tops = data.filter((x) => x.top != null);
    summary = tops.length
      ? `Top working set went from ${tops[0].top} ${unit} on ${formatDate(tops[0].date)} to ${tops.at(-1)!.top} ${unit} on ${formatDate(tops.at(-1)!.date)} across ${series.length} session${series.length === 1 ? '' : 's'}.${eligible ? ' Estimated 1RM is a calculation, not a tested maximum.' : ''}`
      : `${series.length} session${series.length === 1 ? '' : 's'} without loaded sets in this period.`;
    table = {
      headers: ['Date', `Top set (${unit})`, ...(eligible ? [`Est. 1RM (${unit})`] : []), 'Working sets', 'Total reps'],
      rows: series.map((p, i) => [formatDate(p.date), data[i].top ?? '–', ...(eligible ? [data[i].e1rm ?? '–'] : []), p.workingSets, p.totalReps]),
    };
    chart = (
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        {common}
        <YAxis {...axisProps(c)} domain={['auto', 'auto']} width={52} unit={` ${unit}`} />
        <Tooltip cursor={{ stroke: c.line }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => `${v} ${unit}`} />} />
        <Line dataKey="top" name={legend[0].label} stroke={c.accent} {...lineProps} />
        {eligible && <Line dataKey="e1rm" name="Estimated 1RM (Epley)" stroke={c.info} strokeDasharray="5 4" {...lineProps} />}
      </LineChart>
    );
  } else if (tracking === 'reps') {
    legend = [{ label: 'Best set (reps)', color: c.accent }, { label: 'Total reps', color: c.info }];
    summary = first && last ? `Best set went from ${first.maxReps} to ${last.maxReps} reps; total reps from ${first.reps} to ${last.reps} across ${series.length} sessions.` : '';
    table = { headers: ['Date', 'Best set', 'Total reps', 'Working sets'], rows: series.map((p) => [formatDate(p.date), p.maxReps, p.totalReps, p.workingSets]) };
    chart = (
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
        {common}
        <YAxis {...axisProps(c)} allowDecimals={false} width={48} />
        <Tooltip cursor={{ stroke: c.line }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => `${v} reps`} />} />
        <Line dataKey="maxReps" name="Best set (reps)" stroke={c.accent} {...lineProps} />
        <Line dataKey="reps" name="Total reps" stroke={c.info} strokeDasharray="5 4" {...lineProps} />
      </LineChart>
    );
  } else if (tracking === 'assisted') {
    legend = [{ label: 'Least assistance', color: c.accent }];
    const pts = data.filter((x) => x.assist != null);
    summary = pts.length ? `Assistance went from ${pts[0].assist} ${unit} to ${pts.at(-1)!.assist} ${unit}. Lower means you are lifting more of your own bodyweight.` : 'No assisted sets with reps in this period.';
    table = { headers: ['Date', `Least assistance (${unit})`, 'Best set (reps)', 'Working sets'], rows: series.map((p, i) => [formatDate(p.date), data[i].assist ?? '–', p.maxReps, p.workingSets]) };
    chart = (
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        {common}
        <YAxis {...axisProps(c)} domain={[0, 'auto']} width={52} unit={` ${unit}`} />
        <Tooltip cursor={{ stroke: c.line }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => `${v} ${unit}`} />} />
        <Line dataKey="assist" name="Least assistance" stroke={c.accent} {...lineProps} />
      </LineChart>
    );
  } else {
    legend = [{ label: 'Longest set', color: c.accent }];
    const pts = data.filter((x) => x.longest != null);
    summary = pts.length ? `Longest set went from ${formatDuration(pts[0].longest!)} to ${formatDuration(pts.at(-1)!.longest!)} across ${pts.length} sessions.` : 'No timed sets in this period.';
    table = { headers: ['Date', 'Longest set', 'Working sets'], rows: series.map((p) => [formatDate(p.date), p.longestSec ? formatDuration(p.longestSec) : '–', p.workingSets]) };
    chart = (
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        {common}
        <YAxis {...axisProps(c)} tickFormatter={(v: number) => formatDuration(v)} width={52} />
        <Tooltip cursor={{ stroke: c.line }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => formatDuration(v)} />} />
        <Line dataKey="longest" name="Longest set" stroke={c.accent} {...lineProps} />
      </LineChart>
    );
  }

  const note = ex ? conventionNote(ex) : null;

  return (
    <Card className="p-4 flex flex-col gap-3">
      <Select label="Exercise" value={id} onChange={(e) => setPicked(e.target.value)}>
        {sorted.map((x) => (
          <option key={x} value={x}>
            {exerciseName(x, d.byId)}
          </option>
        ))}
      </Select>
      {note && <p className="text-xs text-muted -mt-1">{note}</p>}

      {series.length === 0 ? (
        <p className="text-sm text-muted py-4 text-center">No sessions with this exercise in the selected period. Try a longer range.</p>
      ) : (
        <div>
          {legend.length > 1 && <Legend items={legend} />}
          <ChartFigure title={`${ex?.name ?? exerciseName(id, d.byId)} progress`} summary={summary} table={table}>
            <ResponsiveContainer width="100%" height="100%">
              {chart ?? <div />}
            </ResponsiveContainer>
          </ChartFigure>
          {series.length === 1 && <p className="text-xs text-muted px-1 mt-1">One session so far — a trend appears after your next one.</p>}
        </div>
      )}

      <div className="border-t border-line pt-3">
        <h3 className="text-sm font-medium mb-1">Personal records</h3>
        <p className="text-xs text-muted mb-2">All-time, compared only with this exercise. Warm-ups don’t count.</p>
        {records.length === 0 ? (
          <p className="text-sm text-muted">No records yet.</p>
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
