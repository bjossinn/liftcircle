import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Info } from 'lucide-react';
import { Card, Notice, Segmented, Stat } from '@/components/ui';
import { volumeConventions, weeklyVolume, weeklyWorkingSets } from '@/domain/stats';
import { fromKg, round } from '@/domain/units';
import type { MuscleGroup } from '@/domain/types';
import { ChartFigure, ChartTip, PeriodEmpty, axisProps, chartAnimation, num, shortDate, useChartColors, weekLabel } from './charts';
import { fmtInt, muscleName, type ProgressData } from './shared';
import { useT, type MessageKey } from '@/i18n';
import { loadBuckets, validChoice } from './visibility';

type Bucket = 'freeWeightKg' | 'machineKg' | 'addedBodyweightKg';
const BUCKETS: { value: Bucket; label: MessageKey; long: MessageKey }[] = [
  { value: 'freeWeightKg', label: 'progress.freeWeights', long: 'progress.freeWeightVolume' },
  { value: 'machineKg', label: 'progress.machines', long: 'progress.machineVolume' },
  { value: 'addedBodyweightKg', label: 'progress.addedLoad', long: 'progress.bodyweightAddedLoad' },
];

export function VolumeSection({ d }: { d: ProgressData }) {
  const c = useChartColors();
  const { t, tp, language } = useT();
  const unit = d.settings.units.weight;
  const ws = d.settings.weekStart;
  const [requestedBucket, setBucket] = useState<Bucket>('freeWeightKg');

  const sets = useMemo(() => weeklyWorkingSets(d.rangeSessions, d.byId, ws, d.from, d.to), [d.rangeSessions, d.byId, ws, d.from, d.to]);
  const vol = useMemo(() => weeklyVolume(d.rangeSessions, d.byId, ws, d.from, d.to), [d.rangeSessions, d.byId, ws, d.from, d.to]);

  const weeks = Math.max(1, sets.length);
  const muscleAvgRaw = useMemo(() => {
    const tot: Partial<Record<MuscleGroup, number>> = {};
    for (const w of sets) for (const [m, n] of Object.entries(w.muscles) as [MuscleGroup, number][]) tot[m] = (tot[m] ?? 0) + n;
    return (Object.entries(tot) as [MuscleGroup, number][])
      .filter(([m]) => m !== 'cardio')
      .map(([m, n]) => ({ m, avg: round(n / weeks, 1) }))
      .sort((a, b) => b.avg - a.avg);
  }, [sets, weeks]);
  const muscleAvg = muscleAvgRaw.map((x) => ({ muscle: muscleName(x.m), avg: x.avg }));

  const totals = vol.reduce(
    (t, w) => ({ freeWeightKg: t.freeWeightKg + w.freeWeightKg, machineKg: t.machineKg + w.machineKg, addedBodyweightKg: t.addedBodyweightKg + w.addedBodyweightKg, bodyweightReps: t.bodyweightReps + w.bodyweightReps, workingSets: t.workingSets + w.workingSets }),
    { freeWeightKg: 0, machineKg: 0, addedBodyweightKg: 0, bodyweightReps: 0, workingSets: 0 },
  );
  // Only buckets with recorded load (bodyweight/assisted work never invents load volume).
  const available = loadBuckets(totals);
  const bucket = validChoice(requestedBucket, available) ?? 'freeWeightKg';
  const volData = vol.map((w) => ({ week: w.week, value: Math.round(fromKg(w[bucket], unit)) }));
  const b = BUCKETS.find((x) => x.value === bucket)!;

  const setsSummary = muscleAvg.length
    ? // A data enumeration, not a sentence list; Icelandic uses a semicolon because the numbers carry decimal commas.
      t('progress.weeklyMuscleSummary', { muscles: [...muscleAvg.slice(0, 4).map((m) => `${m.muscle} ${num(m.avg)}`), ...(muscleAvg.length > 4 ? ['…'] : [])].join(language === 'is' ? '; ' : ', ') })
    : t('progress.noWorkingSetsPeriod');
  const volSummary = t('progress.volumeSummary', { type: t(b.long), total: fmtInt(fromKg(totals[bucket], unit)), unit, average: fmtInt(fromKg(totals[bucket] / weeks, unit)) });

  if (totals.workingSets === 0)
    return (
      <Card className="p-4">
        <PeriodEmpty onShowAll={d.onShowAll} message={t('progress.noWorkingSetsPeriod')} />
      </Card>
    );

  return (
    <Card className="p-4 flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label={t('progress.workingSets')} value={totals.workingSets} sub={tp('progress.setsPerWeek', round(totals.workingSets / weeks, 1))} />
        {available.includes('freeWeightKg') && <Stat label={t('progress.freeWeights')} value={`${fmtInt(fromKg(totals.freeWeightKg, unit))}`} sub={unit} />}
        {available.includes('machineKg') && <Stat label={t('progress.machines')} value={`${fmtInt(fromKg(totals.machineKg, unit))}`} sub={unit} />}
      </div>
      {(totals.addedBodyweightKg > 0 || totals.bodyweightReps > 0) && (
        <p className="text-xs text-muted -mt-2">
          {totals.addedBodyweightKg > 0 && `${t('progress.addedLoadSummary', { weight: fmtInt(fromKg(totals.addedBodyweightKg, unit)), unit })} `}
          {totals.bodyweightReps > 0 && t('progress.bodyweightRepsSummary', { count: fmtInt(totals.bodyweightReps) })}
        </p>
      )}

      {/* Muscle chart only with mapped muscle data. */}
      {muscleAvg.length > 0 && (
        <ChartFigure
          title={t('progress.weeklyMuscleSets')}
          summary={setsSummary}
          height={Math.max(160, muscleAvg.length * 26)}
          table={{ headers: [t('workout.picker.muscle'), t('progress.setsPerWeekLabel')], rows: muscleAvg.map((m) => [m.muscle, m.avg]) }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={muscleAvg} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap={4}>
              <CartesianGrid horizontal={false} stroke={c.line} />
              <XAxis type="number" {...axisProps(c)} allowDecimals tickFormatter={(v: number) => num(v)} />
              <YAxis type="category" dataKey="muscle" {...axisProps(c)} width={84} />
              <Tooltip cursor={{ fill: c.accentSoft }} content={(p) => <ChartTip {...p} valueFmt={(v) => t('progress.setsPerWeekText', { count: v })} />} />
              <Bar dataKey="avg" name={t('progress.setsPerWeekLabel')} fill={c.accent} radius={[0, 4, 4, 0]} isAnimationActive={chartAnimation()} />
            </BarChart>
          </ResponsiveContainer>
        </ChartFigure>
      )}

      {available.length > 0 && (
        <div>
          {available.length > 1 && (
            <Segmented label={t('progress.volumeType')} value={bucket} onChange={setBucket} options={BUCKETS.filter((x) => available.includes(x.value)).map((x) => ({ value: x.value, label: t(x.label) }))} size="sm" className="mb-3" />
          )}
          <ChartFigure title={t('progress.volumeChartTitle', { type: t(b.long), unit })} summary={volSummary} table={{ headers: [t('progress.week'), t('progress.volumeUnit', { unit })], rows: volData.map((x) => [weekLabel(x.week), fmtInt(x.value)]) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={volData} margin={{ top: 8, right: 4, bottom: 0, left: -8 }}>
                <CartesianGrid vertical={false} stroke={c.line} />
                <XAxis dataKey="week" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
                <YAxis {...axisProps(c)} width={56} tickFormatter={(v: number) => (v >= 1000 ? `${num(round(v / 1000, 1))}k` : num(v))} />
                <Tooltip cursor={{ fill: c.accentSoft }} content={(p) => <ChartTip {...p} labelFmt={weekLabel} valueFmt={(v) => `${fmtInt(v)} ${unit}`} />} />
                <Bar dataKey="value" name={t(b.label)} fill={bucket === 'freeWeightKg' ? c.series[0] : bucket === 'machineKg' ? c.series[1] : c.series[2]} radius={[4, 4, 0, 0]} isAnimationActive={chartAnimation()} />
              </BarChart>
            </ResponsiveContainer>
          </ChartFigure>
        </div>
      )}

      <Notice>
        <div className="flex items-center gap-2 font-medium mb-1.5">
          <Info className="size-4 text-accent" aria-hidden /> {t('progress.calculationHelpTitle')}
        </div>
        <ul className="list-disc pl-5 space-y-1 text-xs text-muted">
          {volumeConventions(language).map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>{t('progress.volumeDisclaimer')}</li>
        </ul>
      </Notice>
    </Card>
  );
}
