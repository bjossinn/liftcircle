/* Progress tab: consistency, exercise progress & records, volume, cardio, body, nutrition, goals. */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Dumbbell, Plus } from 'lucide-react';
import { Button, Card, EmptyState, Page, SectionTitle, Segmented, Spinner } from '@/components/ui';
import { TopActions } from '@/app/TopActions';
import { useApp } from '@/state/app';
import { alive } from '@/db/repo';
import { useExercises } from '@/data/catalog';
import { completedSessions, observations } from '@/domain/stats';
import { adherence } from '@/domain/program/schedule';
import { addDays, formatDate, startOfWeek, todayISO } from '@/lib/dates';
import { ConsistencySection } from './ConsistencySection';
import { NoWorkoutsArt } from '@/components/illustrations';
import { ExerciseSection } from './ExerciseSection';
import { VolumeSection } from './VolumeSection';
import { CardioSection } from './CardioSection';
import { BodySection } from './BodySection';
import { NutritionSection } from './NutritionSection';
import { GoalsSection } from './GoalsSection';
import type { ProgressData } from './shared';
import type { FoodLogEntry } from '@/domain/types';
import { useT, type MessageKey } from '@/i18n';

type RangeKey = '4w' | '3m' | '6m' | '1y' | 'all';
const RANGES: { value: RangeKey; label: MessageKey; days?: number }[] = [
  { value: '4w', label: 'progress.range4Weeks', days: 28 },
  { value: '3m', label: 'progress.range3Months', days: 91 },
  { value: '6m', label: 'progress.range6Months', days: 182 },
  { value: '1y', label: 'progress.rangeYear', days: 365 },
  { value: 'all', label: 'progress.rangeAll' },
];
const RANGE_STORAGE = 'lc-progress-range';
function readRange(): RangeKey {
  try {
    const v = localStorage.getItem(RANGE_STORAGE) as RangeKey | null;
    return v && RANGES.some((r) => r.value === v) ? v : '3m';
  } catch {
    return '3m';
  }
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <SectionTitle id={id}>{title}</SectionTitle>
      {children}
    </section>
  );
}

export default function ProgressPage() {
  const nav = useNavigate();
  const { t, language } = useT();
  const { db, account, accountReady } = useApp();
  const settings = account.settings;
  const today = todayISO(settings.timeZone);
  const [range, setRangeState] = useState<RangeKey>(readRange);
  const setRange = (r: RangeKey) => {
    setRangeState(r);
    try {
      localStorage.setItem(RANGE_STORAGE, r);
    } catch {
      /* ignore */
    }
  };
  const { list: exercises, byId } = useExercises();

  const sessionsRaw = useLiveQuery(() => db.sessions.where('status').equals('completed').toArray(), [db]);
  const activitiesRaw = useLiveQuery(() => db.activities.toArray(), [db]);
  const measurementsRaw = useLiveQuery(() => db.measurements.toArray(), [db]);
  const goalsRaw = useLiveQuery(() => db.goals.toArray(), [db]);
  const programsRaw = useLiveQuery(() => db.programs.toArray(), [db]);

  const sessions = useMemo(() => (sessionsRaw ? completedSessions(sessionsRaw) : undefined), [sessionsRaw]);
  const activities = useMemo(() => (activitiesRaw ? alive(activitiesRaw) : undefined), [activitiesRaw]);
  const measurements = useMemo(() => (measurementsRaw ? alive(measurementsRaw) : undefined), [measurementsRaw]);

  const from = useMemo(() => {
    const r = RANGES.find((x) => x.value === range)!;
    if (r.days) return addDays(today, -(r.days - 1));
    const dates = [...(sessions ?? []).map((s) => s.date), ...(activities ?? []).map((a) => a.date), ...(measurements ?? []).map((m) => m.date)].filter((d) => d <= today).sort();
    const earliest = dates[0] ?? addDays(today, -27);
    return earliest < addDays(today, -27) ? earliest : addDays(today, -27);
  }, [range, today, sessions, activities, measurements]);

  // Food logs are only read when nutrition is enabled; cover this week too for weekly protein goals.
  const nutritionOn = settings.nutritionEnabled;
  const wk = startOfWeek(today, settings.weekStart);
  const foodFrom = from < wk ? from : wk;
  const foodRaw = useLiveQuery(() => (nutritionOn ? db.foodLogs.where('date').between(foodFrom, today, true, true).toArray() : Promise.resolve([] as FoodLogEntry[])), [db, nutritionOn, foodFrom, today]);

  const data: ProgressData | null = useMemo(() => {
    if (!sessions || !activities || !measurements || !goalsRaw || !programsRaw || !foodRaw) return null;
    const program = alive(programsRaw).find((p) => p.active) ?? null;
    return {
      sessions,
      rangeSessions: sessions.filter((s) => s.date >= from && s.date <= today),
      activities,
      rangeActivities: activities.filter((a) => a.date >= from && a.date <= today),
      measurements,
      goals: alive(goalsRaw),
      foodLogs: alive(foodRaw),
      program,
      exercises,
      byId,
      from,
      to: today,
      today,
      settings,
    };
  }, [sessions, activities, measurements, goalsRaw, programsRaw, foodRaw, from, today, exercises, byId, settings]);

  const obs = useMemo(() => {
    if (!data) return [];
    let plan: { planned: number; completed: number } | null = null;
    if (data.program) {
      const start = wk < data.program.startDate ? data.program.startDate : wk;
      try {
        plan = start <= today ? adherence(data.program, start, today, today, data.sessions) : null;
      } catch {
        plan = null;
      }
    }
    return observations({ sessions: data.sessions, activities: data.activities, measurements: data.measurements, today, weekStart: settings.weekStart, unit: settings.units.weight, plan, byId });
  }, [data, wk, today, settings.weekStart, settings.units.weight, byId]);

  const header = { title: t('nav.progress'), actions: <TopActions /> };
  if (!data || !accountReady)
    return (
      <Page {...header}>
        <Spinner label={t('progress.loading')} />
      </Page>
    );

  const nothing = !data.sessions.length && !data.activities.length && !data.measurements.length && !data.goals.length;
  const proteinTargetG = account.nutrition.proteinG;

  return (
    <Page {...header}>
      <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-bg/95 backdrop-blur">
        <Segmented label={t('progress.range')} value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: t(r.label) }))} />
        <p className="text-xs text-muted mt-1.5 px-1">
          {formatDate(from, { day: 'numeric', month: 'short', year: 'numeric' })} – {formatDate(today, { day: 'numeric', month: 'short', year: 'numeric' })} ·{' '}
          {language === 'en'
            ? `weeks start on ${t(settings.weekStart === 1 ? 'settings.monday' : 'settings.sunday')}`
            : `${t('settings.weekStart')} ${t(settings.weekStart === 1 ? 'settings.monday' : 'settings.sunday')}`}
        </p>
      </div>

      {nothing ? (
        <Card className="mt-4">
          <EmptyState
            illustration={<NoWorkoutsArt />}
            title={t('progress.emptyTitle')}
            body={t('progress.emptyHelp')}
            action={
              <div className="flex flex-col gap-2 w-full max-w-xs">
                <Button variant="primary" icon={<Dumbbell className="size-4" />} onClick={() => nav('/train')}>{t('progress.logFirst')}</Button>
                <Button icon={<Plus className="size-4" />} onClick={() => nav('/train/activity/new')}>{t('progress.logActivity')}</Button>
              </div>
            }
          />
        </Card>
      ) : (
        obs.length > 0 && (
          <Card as="section" aria-labelledby="obs-title" className="p-4 mt-3">
            <h2 id="obs-title" className="text-sm font-semibold mb-2">{t('progress.thisWeek')}</h2>
            <ul className="flex flex-col gap-1.5 text-sm">
              {obs.map((o) => (
                <li key={o} className="flex gap-2">
                  <span className="mt-2 size-1.5 rounded-full bg-ember shrink-0" aria-hidden />
                  <span>{o}</span>
                </li>
              ))}
            </ul>
          </Card>
        )
      )}

      <Section id="p-consistency" title={t('progress.consistency')}>
        <ConsistencySection d={data} />
      </Section>
      <Section id="p-exercise" title={t('progress.exerciseProgress')}>
        <ExerciseSection d={data} />
      </Section>
      <Section id="p-volume" title={t('progress.volumeSets')}>
        <VolumeSection d={data} />
      </Section>
      <Section id="p-cardio" title={t('progress.activities')}>
        <CardioSection d={data} />
      </Section>
      <Section id="p-body" title={t('progress.body')}>
        <BodySection d={data} today={today} />
      </Section>
      {nutritionOn && (
        <Section id="p-nutrition" title={t('progress.protein')}>
          <NutritionSection d={data} proteinTargetG={proteinTargetG} />
        </Section>
      )}
      <Section id="p-goals" title={t('progress.goals')}>
        <GoalsSection d={data} proteinTargetG={proteinTargetG} />
      </Section>
    </Page>
  );
}
