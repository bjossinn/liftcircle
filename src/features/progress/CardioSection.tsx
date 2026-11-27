import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Plus } from 'lucide-react';
import { Button, Card, ListRow, Segmented, Select, Stat } from '@/components/ui';
import { cardioSeries, weeklyTotals } from '@/domain/stats';
import { activityLabel, activityTypeInfo, formatPaceSec, paceOrSpeed, type PaceResult } from '@/domain/activities';
import { fromMeters, round } from '@/domain/units';
import type { ActivityType, DistanceUnit } from '@/domain/types';
import { formatDate, formatMinutes } from '@/lib/dates';
import { ActivityIcon } from '@/features/activities/icons';
import { ChartFigure, ChartTip, PeriodEmpty, axisProps, chartAnimation, num, seriesLine, shortDate, useChartColors, weekLabel } from './charts';
import { fmtInt, type ProgressData } from './shared';
import { t as tr, useT, type Language } from '@/i18n';
import { hasDistance, paceEligible, paceTypes as paceTypesOf, validChoice } from './visibility';

/** "5.25 km" / "5,25 km": formatDistance with a locale decimal separator (same rounding, unit unchanged). */
function distanceText(m: number | undefined, unit: DistanceUnit, decimals = 2): string {
  return m == null ? '–' : `${num(round(fromMeters(m, unit), decimals), decimals)} ${unit}`;
}
/** Pace keeps its clock form ("5:30 /km"); speed gets a locale decimal ("12,3 km/h"). */
function paceText(r: PaceResult): string {
  return r.kind === 'speed' ? `${num(round(r.value, 1), 1)} ${r.per}` : r.text;
}
/** "pace"/"speed" inside a sentence: lower-case in English, the approved label as-is in Icelandic. */
function metricWord(isSpeed: boolean, language: Language): string {
  const w = tr(isSpeed ? 'summary.speed' : 'summary.pace', undefined, language);
  return language === 'en' ? w.toLowerCase() : w;
}

export function CardioSection({ d }: { d: ProgressData }) {
  const c = useChartColors();
  const nav = useNavigate();
  const { t, language, locale: locale_ } = useT();
  const du = d.settings.units.distance;
  const ws = d.settings.weekStart;
  const [requestedMetric, setMetric] = useState<'minutes' | 'distance'>('minutes');
  const [typeSel, setTypeSel] = useState<ActivityType | ''>('');

  const weeks = useMemo(() => weeklyTotals([], d.rangeActivities, ws, d.from, d.to), [d.rangeActivities, ws, d.from, d.to]);
  // Distance needs a recorded finite value; pace/speed a positive distance and duration on a supported type.
  const anyDistance = d.rangeActivities.some(hasDistance);
  const metric = anyDistance ? requestedMetric : 'minutes';
  const paceTypes = useMemo(() => paceTypesOf(d.rangeActivities), [d.rangeActivities]);
  const type = validChoice(typeSel || undefined, paceTypes);
  const paceData = useMemo(
    () =>
      type
        ? cardioSeries(d.rangeActivities, type)
            .filter((p) => paceEligible({ type, distanceM: p.distanceM ?? undefined, durationSec: p.durationSec }))
            .map((p) => {
              const r = paceOrSpeed({ type, distanceM: p.distanceM, durationSec: p.durationSec }, du)!;
              return { date: p.date, value: round(r.value, 1), text: paceText(r), per: r.kind === 'pace' ? `/${r.per}` : r.per, distance: distanceText(p.distanceM!, du) };
            })
        : [],
    // language: the texts carry locale decimals
    [d.rangeActivities, type, du, language],
  );

  if (!d.rangeActivities.length)
    return (
      <Card className="p-4 flex flex-col gap-3">
        <PeriodEmpty onShowAll={d.onShowAll} />
        <Button size="sm" variant="ghost" className="self-start" icon={<Plus className="size-4" />} onClick={() => nav('/train/activity/new')}>{t('progress.logActivity')}</Button>
      </Card>
    );

  const totalMin = Math.round(weeks.reduce((s, w) => s + w.activityMinutes, 0));
  const totalDist = weeks.reduce((s, w) => s + w.distanceM, 0);
  const n = Math.max(1, weeks.length);
  const chartData = weeks.map((w) => ({ week: w.week, value: metric === 'minutes' ? Math.round(w.activityMinutes) : round(fromMeters(w.distanceM, du), 1) }));
  const sum =
    metric === 'minutes'
      ? t('progress.activityTimeSummary', { total: fmtInt(totalMin), average: fmtInt(totalMin / n) })
      : t('progress.activityDistanceSummary', { distance: distanceText(totalDist, du, 1), averageDistance: distanceText(totalDist / n, du, 1) });
  const mode = type ? activityTypeInfo(type).paceMode : null;
  const isSpeed = mode === 'speed';
  const paceUnit = paceData[0]?.per ?? '';
  const metric_ = metricWord(isSpeed, language);
  const paceSummary =
    paceData.length >= 2
      ? t('progress.activityPaceTrend', { activity: activityLabel({ type: type! }), metric: metric_, first: paceData[0].text, last: paceData.at(-1)!.text, count: paceData.length }) +
        (isSpeed ? '' : ` ${t('progress.paceHelp')}`)
      : paceData.length === 1
        ? t('progress.oneActivityPace', { activity: activityLabel({ type: type! }).toLocaleLowerCase(locale_), pace: paceData[0].text })
        : '';
  const recent = [...d.rangeActivities].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt))).slice(0, 8);

  return (
    <Card className="p-4 flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label={t('progress.activitiesLabel')} value={d.rangeActivities.length} />
        <Stat label={t('progress.activityTime')} value={formatMinutes(totalMin * 60)} />
        {anyDistance && <Stat label={t('progress.distance')} value={distanceText(totalDist, du, 1)} />}
      </div>

      <div>
        {anyDistance && (
          <Segmented label={t('progress.weeklyMetric')} value={metric} onChange={setMetric} options={[{ value: 'minutes', label: t('progress.minutes') }, { value: 'distance', label: t('progress.distanceUnit', { unit: du }) }]} size="sm" className="mb-3" />
        )}
        <ChartFigure
          title={metric === 'minutes' ? t('progress.activityMinutesWeek') : t('progress.activityDistanceWeek', { unit: du })}
          summary={sum}
          table={{ headers: [t('progress.week'), metric === 'minutes' ? t('progress.minutes') : du], rows: chartData.map((x) => [weekLabel(x.week), x.value]) }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
              <CartesianGrid vertical={false} stroke={c.line} />
              <XAxis dataKey="week" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
              <YAxis {...axisProps(c)} width={48} tickFormatter={(v: number) => num(v)} />
              <Tooltip cursor={{ fill: c.accentSoft }} content={(p) => <ChartTip {...p} labelFmt={weekLabel} valueFmt={(v) => (metric === 'minutes' ? t('format.minutes', { count: v }) : `${num(v)} ${du}`)} />} />
              <Bar dataKey="value" name={metric === 'minutes' ? t('progress.minutes') : t('progress.distance')} fill={c.series[0]} radius={[4, 4, 0, 0]} isAnimationActive={chartAnimation()} />
            </BarChart>
          </ResponsiveContainer>
        </ChartFigure>
      </div>

      {/* Pace/speed only when some activity supports it; no unused selectors or charts. */}
      {type && paceData.length > 0 && (
      <div className="border-t border-line pt-3 flex flex-col gap-3">
        <h3 className="text-sm font-medium">{t(isSpeed ? 'progress.speedTrend' : 'progress.paceTrend')}</h3>
        {(
          <>
            {paceTypes.length > 1 && (
              <Select aria-label={t('progress.paceType')} value={type} onChange={(e) => setTypeSel(e.target.value as ActivityType)}>
                {paceTypes.map((t) => (
                  <option key={t} value={t}>{activityLabel({ type: t })}</option>
                ))}
              </Select>
            )}
            <ChartFigure
              title={t('progress.paceTitle', { activity: activityLabel({ type: type! }), metric: metric_, unit: paceUnit })}
              summary={paceSummary}
              table={{ headers: [t('progress.date'), t('progress.distance'), t(isSpeed ? 'summary.speed' : 'summary.pace')], rows: paceData.map((p) => [formatDate(p.date), p.distance, p.text]) }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={paceData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid vertical={false} stroke={c.line} />
                  <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis {...axisProps(c)} domain={['auto', 'auto']} width={52} tickFormatter={(v: number) => (isSpeed ? num(v) : formatPaceSec(v))} />
                  <Tooltip
                    cursor={{ stroke: c.line }}
                    content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => (isSpeed ? `${num(v)} ${paceUnit}` : `${formatPaceSec(v)} ${paceUnit}`)} />}
                  />
                  <Line type="monotone" dataKey="value" name={t(isSpeed ? 'summary.speed' : 'summary.pace')} strokeWidth={2} isAnimationActive={chartAnimation()} {...seriesLine(0, c)} />
                </LineChart>
              </ResponsiveContainer>
            </ChartFigure>
          </>
        )}
      </div>
      )}

      <div className="border-t border-line pt-3">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-medium">{t('progress.recentActivities')}</h3>
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => nav('/train/activity/new')}>{t('progress.log')}</Button>
        </div>
        {recent.length === 0 ? (
          <p className="text-sm text-muted">{t('progress.noActivitiesPeriod')}</p>
        ) : (
          <ul className="-mx-4 divide-y divide-line">
            {recent.map((a) => {
              const p = paceOrSpeed(a, du);
              return (
                <li key={a.id}>
                  <Link to={`/train/activity/${a.id}`} aria-label={t('progress.editActivity', { activity: activityLabel(a), date: formatDate(a.date) })}>
                    <ListRow
                      left={<span className="text-accent"><ActivityIcon type={a.type} /></span>}
                      title={activityLabel(a)}
                      subtitle={[formatDate(a.date), formatMinutes(a.durationSec), a.distanceM ? distanceText(a.distanceM, du) : null, p ? paceText(p) : null].filter(Boolean).join(' · ')}
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
