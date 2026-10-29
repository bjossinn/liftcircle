import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Info } from 'lucide-react';
import { Card, Notice, Segmented, Stat } from '@/components/ui';
import { VOLUME_CONVENTIONS, weeklyVolume, weeklyWorkingSets } from '@/domain/stats';
import { fromKg, round } from '@/domain/units';
import type { MuscleGroup } from '@/domain/types';
import { ChartFigure, ChartTip, axisProps, chartAnimation, shortDate, useChartColors, weekLabel } from './charts';
import { MUSCLE_NAMES, fmtInt, type ProgressData } from './shared';

type Bucket = 'freeWeightKg' | 'machineKg' | 'addedBodyweightKg';
const BUCKETS: { value: Bucket; label: string; long: string }[] = [
  { value: 'freeWeightKg', label: 'Free weights', long: 'Free-weight volume' },
  { value: 'machineKg', label: 'Machines', long: 'Machine & cable volume' },
  { value: 'addedBodyweightKg', label: 'Added load', long: 'Added load on bodyweight exercises' },
];

export function VolumeSection({ d }: { d: ProgressData }) {
  const c = useChartColors();
  const unit = d.settings.units.weight;
  const ws = d.settings.weekStart;
  const [bucket, setBucket] = useState<Bucket>('freeWeightKg');

  const sets = useMemo(() => weeklyWorkingSets(d.rangeSessions, d.byId, ws, d.from, d.to), [d.rangeSessions, d.byId, ws, d.from, d.to]);
  const vol = useMemo(() => weeklyVolume(d.rangeSessions, d.byId, ws, d.from, d.to), [d.rangeSessions, d.byId, ws, d.from, d.to]);

  const weeks = Math.max(1, sets.length);
  const muscleAvg = useMemo(() => {
    const tot: Partial<Record<MuscleGroup, number>> = {};
    for (const w of sets) for (const [m, n] of Object.entries(w.muscles) as [MuscleGroup, number][]) tot[m] = (tot[m] ?? 0) + n;
    return (Object.entries(tot) as [MuscleGroup, number][])
      .filter(([m]) => m !== 'cardio')
      .map(([m, n]) => ({ muscle: MUSCLE_NAMES[m], avg: round(n / weeks, 1) }))
      .sort((a, b) => b.avg - a.avg);
  }, [sets, weeks]);

  const totals = vol.reduce(
    (t, w) => ({ freeWeightKg: t.freeWeightKg + w.freeWeightKg, machineKg: t.machineKg + w.machineKg, addedBodyweightKg: t.addedBodyweightKg + w.addedBodyweightKg, bodyweightReps: t.bodyweightReps + w.bodyweightReps, workingSets: t.workingSets + w.workingSets }),
    { freeWeightKg: 0, machineKg: 0, addedBodyweightKg: 0, bodyweightReps: 0, workingSets: 0 },
  );
  const volData = vol.map((w) => ({ week: w.week, value: Math.round(fromKg(w[bucket], unit)) }));
  const b = BUCKETS.find((x) => x.value === bucket)!;
  const anyVolume = totals.workingSets > 0;

  const setsSummary = muscleAvg.length
    ? `Average weekly working sets: ${muscleAvg.slice(0, 4).map((m) => `${m.muscle} ${m.avg}`).join(', ')}${muscleAvg.length > 4 ? ', …' : ''}.`
    : 'No working sets in this period.';
  const volSummary = `${b.long}: ${fmtInt(fromKg(totals[bucket], unit))} ${unit} in this period, ${fmtInt(fromKg(totals[bucket] / weeks, unit))} ${unit} per week on average.`;

  return (
    <Card className="p-4 flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Working sets" value={totals.workingSets} sub={`${round(totals.workingSets / weeks, 1)}/week`} />
        <Stat label="Free weights" value={`${fmtInt(fromKg(totals.freeWeightKg, unit))}`} sub={unit} />
        <Stat label="Machines" value={`${fmtInt(fromKg(totals.machineKg, unit))}`} sub={unit} />
      </div>
      {(totals.addedBodyweightKg > 0 || totals.bodyweightReps > 0) && (
        <p className="text-xs text-muted -mt-2">
          {totals.addedBodyweightKg > 0 && `Added load on bodyweight exercises: ${fmtInt(fromKg(totals.addedBodyweightKg, unit))} ${unit}. `}
          {totals.bodyweightReps > 0 && `Bodyweight and assisted reps: ${fmtInt(totals.bodyweightReps)}.`}
        </p>
      )}

      {!anyVolume ? (
        <p className="text-sm text-muted text-center py-4">Complete a workout to see working sets and volume.</p>
      ) : (
        <>
          <ChartFigure
            title="Weekly working sets by muscle (average)"
            summary={setsSummary}
            height={Math.max(160, muscleAvg.length * 26)}
            table={{ headers: ['Muscle', 'Sets per week'], rows: muscleAvg.map((m) => [m.muscle, m.avg]) }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={muscleAvg} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap={4}>
                <CartesianGrid horizontal={false} stroke={c.line} />
                <XAxis type="number" {...axisProps(c)} allowDecimals />
                <YAxis type="category" dataKey="muscle" {...axisProps(c)} width={84} />
                <Tooltip cursor={{ fill: c.accentSoft }} content={(p) => <ChartTip {...p} valueFmt={(v) => `${v} sets/week`} />} />
                <Bar dataKey="avg" name="Sets per week" fill={c.accent} radius={[0, 4, 4, 0]} isAnimationActive={chartAnimation()} />
              </BarChart>
            </ResponsiveContainer>
          </ChartFigure>

          <div>
            <Segmented label="Volume type" value={bucket} onChange={setBucket} options={BUCKETS.map((x) => ({ value: x.value, label: x.label }))} size="sm" className="mb-3" />
            <ChartFigure title={`${b.long} per week (${unit})`} summary={volSummary} table={{ headers: ['Week', `Volume (${unit})`], rows: volData.map((x) => [weekLabel(x.week), fmtInt(x.value)]) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={volData} margin={{ top: 8, right: 4, bottom: 0, left: -8 }}>
                  <CartesianGrid vertical={false} stroke={c.line} />
                  <XAxis dataKey="week" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis {...axisProps(c)} width={56} tickFormatter={(v: number) => (v >= 1000 ? `${round(v / 1000, 1)}k` : String(v))} />
                  <Tooltip cursor={{ fill: c.accentSoft }} content={(p) => <ChartTip {...p} labelFmt={weekLabel} valueFmt={(v) => `${fmtInt(v)} ${unit}`} />} />
                  <Bar dataKey="value" name={b.label} fill={bucket === 'freeWeightKg' ? c.accent : bucket === 'machineKg' ? c.info : c.warn} radius={[4, 4, 0, 0]} isAnimationActive={chartAnimation()} />
                </BarChart>
              </ResponsiveContainer>
            </ChartFigure>
          </div>
        </>
      )}

      <Notice>
        <div className="flex items-center gap-2 font-medium mb-1.5">
          <Info className="size-4 text-accent" aria-hidden /> How we calculate this
        </div>
        <ul className="list-disc pl-5 space-y-1 text-xs text-muted">
          {VOLUME_CONVENTIONS.map((t) => (
            <li key={t}>{t}</li>
          ))}
          <li>Volume describes how much work you logged. It doesn’t measure muscle gained.</li>
        </ul>
      </Notice>
    </Card>
  );
}
