/**
 * Optional demo dataset. It lives in its own local database ('demo'), is clearly labelled,
 * never syncs or shares, contains no fake social users, and is removed completely on exit.
 */
import { FlaskConical } from 'lucide-react';
import { deleteAccountDb, LiftDb, ACCOUNT_ROW_ID } from '@/db/db';
import { saveRecord, newRecord } from '@/db/repo';
import { DEMO_KEY, useApp } from '@/state/app';
import { defaultAccountState } from '@/state/defaults';
import { EXERCISES } from '@/data/exercises';
import { generateProgram } from '@/domain/program/generator';
import { createProgram, currentVersion } from '@/domain/program/program';
import { buildSessionFromTemplate } from '@/domain/program/session';
import type { ActivityLog, Measurement, OnboardingAnswers, WorkoutSession, FoodLogEntry, SyncFields } from '@/domain/types';
import { addDays, todayISO, weekday, deviceTimeZone, toUTCms } from '@/lib/dates';
import { Button } from '@/components/ui';

const DEMO_ANSWERS: OnboardingAnswers = {
  displayName: 'Demo',
  units: { weight: 'kg', length: 'cm', distance: 'km' },
  age: 34,
  weightKg: 82,
  heightCm: 180,
  goal: 'build_muscle',
  experience: 'returning',
  totalDaysPerWeek: 4,
  liftingDaysPerWeek: 3,
  availableWeekdays: [1, 2, 3, 4, 5, 6],
  preferredLiftingWeekdays: [1, 3, 5],
  sessionMinutes: 60,
  location: 'full_gym',
  equipment: ['barbell', 'rack', 'bench', 'dumbbell', 'machine', 'cable', 'pullup_bar', 'bodyweight'],
  preferredActivities: ['walk', 'run'],
  enjoyedExerciseIds: [],
  excludedExerciseIds: [],
  limitations: [],
  activityLevel: 'light',
  wantsNutrition: true,
  nutritionMode: 'protein_only',
  diet: { tags: [], allergens: [], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 },
};

/** Deterministic pseudo-random so the demo looks the same each time. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

const START_LOADS: Record<string, number> = { barbell: 50, dumbbell: 14, machine: 35, cable: 25, kettlebell: 16 };

export async function seedDemo(): Promise<void> {
  const db = new LiftDb('demo');
  const tz = deviceTimeZone();
  const today = todayISO(tz);
  const start = addDays(today, -42);
  const rand = rng(42);
  const acct = defaultAccountState();
  acct.profile = { ...acct.profile, displayName: 'Demo', age: 34, ageRecordedAt: Date.now(), heightCm: 180, goal: 'build_muscle', experience: 'returning', activityLevel: 'light', onboardedAt: Date.now() };
  acct.settings = { ...acct.settings, nutritionEnabled: true, demoData: true, timeZone: tz };
  acct.nutrition = { ...acct.nutrition, mode: 'protein_only', proteinPerKg: 1.8, referenceWeightKg: 82, referenceWeightSource: 'current', proteinG: 148, mealsPerDay: 3 };
  await saveRecord('account_state', { ...acct, id: ACCOUNT_ROW_ID }, db);

  const version = generateProgram(DEMO_ANSWERS, EXERCISES, { startDate: start });
  const program = createProgram(DEMO_ANSWERS, version, start, 'Demo program', 'generated');
  await saveRecord('programs', program, db);
  const v = currentVersion(program);
  const byId = new Map(EXERCISES.map((e) => [e.id, e]));

  const history: WorkoutSession[] = [];
  for (let d = start; d < today; d = addDays(d, 1)) {
    const slot = v.schedule.find((s) => s.weekday === weekday(d));
    if (!slot || rand() < 0.12) continue; // a few missed sessions, like real life
    const t = v.templates.find((x) => x.id === slot.templateId);
    if (!t || t.exercises.length === 0) continue;
    const s = buildSessionFromTemplate(t, { catalog: EXERCISES, history, settings: acct.settings, programId: program.id, programVersion: v.version, plannedDate: d, date: d, timeZone: tz });
    const startedAt = toUTCms(d) + 17 * 3600_000;
    s.startedAt = startedAt;
    for (const se of s.exercises) {
      const ex = byId.get(se.exerciseId);
      const rx = se.prescription;
      for (const st of se.sets) {
        if (ex && (ex.tracking === 'weight_reps' || ex.tracking === 'bodyweight_plus') && st.weightKg == null) {
          const eq = ex.equipment.find((e) => START_LOADS[e]);
          st.weightKg = ex.tracking === 'bodyweight_plus' ? 0 : eq ? START_LOADS[eq] : 20;
          st.entered = { value: st.weightKg, unit: 'kg' };
        }
        if (ex?.tracking === 'duration') st.durationSec = st.durationSec ?? rx?.durationSec ?? 30;
        else if (ex?.tracking === 'distance_time') st.distanceM = st.distanceM ?? 40;
        else if (st.reps == null || st.type !== 'warmup') st.reps = rx ? Math.min(rx.repMax, rx.repMin + Math.floor(rand() * (rx.repMax - rx.repMin + 2))) : 10;
        st.completed = true;
        st.completedAt = startedAt + 60_000;
      }
    }
    s.status = 'completed';
    s.endedAt = startedAt + (t.estimatedMinutes + Math.round(rand() * 10 - 5)) * 60_000;
    s.rest = undefined;
    await saveRecord('sessions', s, db);
    history.unshift(s);
  }

  // Easy runs and walks.
  for (let d = start; d < today; d = addDays(d, 1)) {
    const wd = weekday(d);
    if (wd === 6 || (wd === 2 && rand() > 0.3)) {
      const run = wd === 6;
      const km = run ? 5 + Math.round(rand() * 20) / 10 : 3 + Math.round(rand() * 20) / 10;
      const pace = run ? 330 + rand() * 40 : 680 + rand() * 60;
      await saveRecord(
        'activities',
        newRecord<Omit<ActivityLog, keyof SyncFields>>({ type: run ? 'run' : 'walk', date: d, timeZone: tz, durationSec: Math.round(km * pace), distanceM: Math.round(km * 1000), intensity: run ? 'moderate' : 'easy' }) as ActivityLog,
        db,
      );
    }
  }

  // Bodyweight with a gentle trend and day-to-day noise.
  for (let i = 0; i <= 42; i += 2) {
    const d = addDays(start, i);
    const kg = Math.round((82 - i * 0.012 + (rand() - 0.5) * 0.8) * 10) / 10;
    await saveRecord('measurements', newRecord<Omit<Measurement, keyof SyncFields>>({ kind: 'bodyweight', date: d, value: kg, entered: { value: kg, unit: 'kg' } }) as Measurement, db);
  }

  // A week of quick protein entries.
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, -i);
    for (const [meal, p] of [['breakfast', 35], ['lunch', 45], ['dinner', 50]] as const) {
      await saveRecord(
        'food_logs',
        newRecord<Omit<FoodLogEntry, keyof SyncFields>>({ date: d, meal, name: 'Quick entry', source: { kind: 'quick' }, protein: Math.round(p + (rand() - 0.5) * 20) }) as FoodLogEntry,
        db,
      );
    }
  }
  db.close();
}

export async function enterDemo() {
  await deleteAccountDb('demo');
  await seedDemo();
  try {
    localStorage.setItem(DEMO_KEY, '1');
  } catch {
    /* ignore */
  }
  location.assign('/');
}

export async function exitDemo() {
  try {
    localStorage.removeItem(DEMO_KEY);
  } catch {
    /* ignore */
  }
  await deleteAccountDb('demo');
  location.assign('/');
}

export function DemoBanner() {
  const { db } = useApp();
  if (!db.isDemo) return null;
  return (
    <div role="status" className="flex items-center gap-2 bg-info/15 border-b border-info/30 px-4 py-2 text-sm">
      <FlaskConical className="size-4 text-info shrink-0" aria-hidden />
      <span className="flex-1">Demo data: sample records, not a real person.</span>
      <Button size="sm" variant="ghost" onClick={() => void exitDemo()}>
        Exit demo
      </Button>
    </div>
  );
}
