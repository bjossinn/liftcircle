/*
 * Progress tab: consistency, exercise progress & records, volume, cardio, body, nutrition, goals.
 * Roadmap item 11: only sections with recorded data are shown (in the existing order); a new account gets one neutral
 * empty state; "Add a record" is always available. Opening the page or changing its view writes no records or settings.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Activity, ChevronDown, Dumbbell, Flag, Plus, Ruler, Utensils } from 'lucide-react';
import { Card, EmptyState, Page, SectionTitle, Segmented, Spinner, cx } from '@/components/ui';
import { TopActions } from '@/app/TopActions';
import { useApp } from '@/state/app';
import type { LiftDb } from '@/db/db';
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
import { MeasurementEditor } from './MeasurementEditor';
import { GoalEditor } from './GoalEditor';
import { inRange, type ProgressData } from './shared';
import { earliestDate, sectionAvailability } from './visibility';
import type { Measurement, UserGoal } from '@/domain/types';
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

/**
 * A live query tagged with the DB it ran on. While a new account's query is pending the previous result is never
 * shown: undefined (loading) until the current DB answers. Loading is never "empty".
 */
function useDbQuery<T>(db: LiftDb, fn: (db: LiftDb) => Promise<T>): T | undefined {
  const res = useLiveQuery(async () => ({ db, value: await fn(db) }), [db]);
  return res && res.db === db ? res.value : undefined;
}

/** "Add a record": workout, activity, food, measurement, goal. Always available, also with no data. */
function AddRecordMenu({ onMeasurement, onGoal, open: alwaysOpen }: { onMeasurement: () => void; onGoal: () => void; open?: boolean }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const shown = alwaysOpen || expanded;
  const item = 'flex items-center gap-3 w-full min-h-11 px-4 py-2 text-left text-[15px] hover:bg-surface-2 rounded-xl';
  const list = (
    <ul id="progress-add-menu" className="flex flex-col py-1" aria-label={t('progress.actions')}>
      <li>
        <Link to="/train" className={item}>
          <Dumbbell className="size-4 text-accent" aria-hidden /> {t('train.historyLog')}
        </Link>
      </li>
      <li>
        <Link to="/train/activity/new" className={item}>
          <Activity className="size-4 text-accent" aria-hidden /> {t('progress.logActivity')}
        </Link>
      </li>
      <li>
        <Link to="/nutrition/log" className={item}>
          <Utensils className="size-4 text-accent" aria-hidden /> {t('today.logFood')}
        </Link>
      </li>
      <li>
        <button type="button" className={item} onClick={onMeasurement}>
          <Ruler className="size-4 text-accent" aria-hidden /> {t('progress.addMeasurementGeneric')}
        </button>
      </li>
      <li>
        <button type="button" className={item} onClick={onGoal}>
          <Flag className="size-4 text-accent" aria-hidden /> {t('progress.addGoal')}
        </button>
      </li>
    </ul>
  );
  if (alwaysOpen) return <div className="w-full max-w-xs text-left">{list}</div>;
  return (
    <Card className="mt-3 p-1">
      <button
        type="button"
        aria-expanded={shown}
        aria-controls="progress-add-menu"
        onClick={() => setExpanded((x) => !x)}
        className="flex items-center gap-2 w-full min-h-11 px-3 text-sm font-semibold rounded-xl hover:bg-surface-2"
      >
        <Plus className="size-4 text-accent" aria-hidden />
        <span className="flex-1 text-left">{t('progress.actions')}</span>
        <ChevronDown className={cx('size-4 transition-transform motion-reduce:transition-none', shown && 'rotate-180')} aria-hidden />
      </button>
      {shown && list}
    </Card>
  );
}

export default function ProgressPage() {
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
  const [measurementEdit, setMeasurementEdit] = useState<Measurement | 'new' | null>(null);
  const [goalEdit, setGoalEdit] = useState<UserGoal | 'new' | null>(null);

  const sessionsRaw = useDbQuery(db, (x) => x.sessions.where('status').equals('completed').toArray());
  const activitiesRaw = useDbQuery(db, (x) => x.activities.toArray());
  const measurementsRaw = useDbQuery(db, (x) => x.measurements.toArray());
  const goalsRaw = useDbQuery(db, (x) => x.goals.toArray());
  const programsRaw = useDbQuery(db, (x) => x.programs.toArray());
  // Historical food data is read regardless of the nutrition setting (it only controls optional entry points).
  const foodRaw = useDbQuery(db, (x) => x.foodLogs.toArray());

  const sessions = useMemo(() => (sessionsRaw ? completedSessions(sessionsRaw) : undefined), [sessionsRaw]);
  const activities = useMemo(() => (activitiesRaw ? alive(activitiesRaw) : undefined), [activitiesRaw]);
  const measurements = useMemo(() => (measurementsRaw ? alive(measurementsRaw) : undefined), [measurementsRaw]);
  const foodLogs = useMemo(() => (foodRaw ? alive(foodRaw) : undefined), [foodRaw]);

  const from = useMemo(() => {
    const r = RANGES.find((x) => x.value === range)!;
    if (r.days) return addDays(today, -(r.days - 1));
    // "All" starts at the earliest record of any kind, food included (at least four weeks).
    const earliest = earliestDate({ sessions: sessions ?? [], activities: activities ?? [], measurements: measurements ?? [], foodLogs: foodLogs ?? [] }, today) ?? addDays(today, -27);
    return earliest < addDays(today, -27) ? earliest : addDays(today, -27);
  }, [range, today, sessions, activities, measurements, foodLogs]);

  const wk = startOfWeek(today, settings.weekStart);

  const data: ProgressData | null = useMemo(() => {
    if (!sessions || !activities || !measurements || !goalsRaw || !programsRaw || !foodLogs) return null;
    const program = alive(programsRaw).find((p) => p.active) ?? null;
    return {
      sessions,
      rangeSessions: inRange(sessions, from, today),
      activities,
      rangeActivities: inRange(activities, from, today),
      measurements,
      goals: alive(goalsRaw),
      // All history (weekly goals filter the current account-timezone week; range sections use rangeFoodLogs).
      foodLogs,
      rangeFoodLogs: inRange(foodLogs, from, today),
      program,
      exercises,
      byId,
      from,
      to: today,
      today,
      settings,
      onShowAll: range === 'all' ? undefined : () => setRange('all'),
    };
  }, [sessions, activities, measurements, goalsRaw, programsRaw, foodLogs, from, today, exercises, byId, settings, range]);

  const avail = useMemo(
    () => (data ? sectionAvailability({ sessions: data.sessions, activities: data.activities, measurements: data.measurements, goals: data.goals, foodLogs: data.foodLogs, byId: data.byId }) : null),
    [data],
  );

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
    return observations({ sessions: data.sessions, activities: data.activities, measurements: data.measurements, today, weekStart: settings.weekStart, unit: settings.units.weight, plan, byId }, language);
  }, [data, wk, today, settings.weekStart, settings.units.weight, byId, language]);

  const header = { title: t('nav.progress'), actions: <TopActions /> };
  if (!data || !avail || !accountReady)
    return (
      <Page {...header}>
        <Spinner label={t('progress.loading')} />
      </Page>
    );

  const proteinTargetG = account.nutrition.proteinG;
  const editors = (
    <>
      <MeasurementEditor target={measurementEdit} kind="bodyweight" measurements={data.measurements} settings={settings} today={today} onClose={() => setMeasurementEdit(null)} />
      <GoalEditor edit={goalEdit} sessions={data.sessions} exercises={data.exercises} byId={data.byId} unit={settings.units.weight} today={today} onClose={() => setGoalEdit(null)} />
    </>
  );

  // A genuinely new account: one neutral empty state with the add actions, no empty sections beneath it.
  if (!avail.any)
    return (
      <Page {...header}>
        <Card className="mt-4">
          <EmptyState
            illustration={<NoWorkoutsArt />}
            title={t('progress.emptyTitle')}
            body={t('progress.emptyHelp')}
            action={<AddRecordMenu open onMeasurement={() => setMeasurementEdit('new')} onGoal={() => setGoalEdit('new')} />}
          />
        </Card>
        {editors}
      </Page>
    );

  return (
    <Page {...header}>
      <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-bg/95 backdrop-blur">
        <Segmented label={t('progress.range')} value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: t(r.label) }))} />
        <p className="text-xs text-muted mt-1.5 px-1">
          {formatDate(from, { day: 'numeric', month: 'short', year: 'numeric' })} – {formatDate(today, { day: 'numeric', month: 'short', year: 'numeric' })} ·{' '}
          {t('progress.weeks_start_on_x', { day: t(settings.weekStart === 1 ? 'settings.monday' : 'settings.sunday') })}
        </p>
      </div>

      {obs.length > 0 && (
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
      )}

      <AddRecordMenu onMeasurement={() => setMeasurementEdit('new')} onGoal={() => setGoalEdit('new')} />

      {avail.consistency && (
        <Section id="p-consistency" title={t('progress.consistency')}>
          <ConsistencySection d={data} />
        </Section>
      )}
      {avail.exercise && (
        <Section id="p-exercise" title={t('progress.exerciseProgress')}>
          <ExerciseSection d={data} />
        </Section>
      )}
      {avail.volume && (
        <Section id="p-volume" title={t('progress.volumeSets')}>
          <VolumeSection d={data} />
        </Section>
      )}
      {avail.activities && (
        <Section id="p-cardio" title={t('progress.activities')}>
          <CardioSection d={data} />
        </Section>
      )}
      {avail.body && (
        <Section id="p-body" title={t('progress.body')}>
          <BodySection d={data} today={today} />
        </Section>
      )}
      {avail.nutrition && (
        <Section id="p-nutrition" title={t('progress.protein')}>
          <NutritionSection d={data} proteinTargetG={proteinTargetG} />
        </Section>
      )}
      {avail.goals && (
        <Section id="p-goals" title={t('progress.goals')}>
          <GoalsSection d={data} proteinTargetG={proteinTargetG} />
        </Section>
      )}
      {editors}
    </Page>
  );
}
