# Cross-slice interfaces

Slices are built in parallel. Each slice MUST export exactly these signatures (more exports are fine).
Import paths use the `@/` alias (= `src/`).

## 1. Exercise catalog & library — owner: catalog slice
- `src/data/exercises.ts` → `export const EXERCISES: Exercise[]` (≥ 60; ids below are REQUIRED, more allowed).
- `src/data/exerciseMeta.ts` →
  `MUSCLE_LABELS: Record<MuscleGroup,string>`, `EQUIPMENT_LABELS: Record<Equipment,string>`,
  `PATTERN_LABELS: Record<MovementPattern,string>`, `TRACKING_LABELS: Record<TrackingType,string>`,
  `loadConventionNote(ex: Exercise): string | null` (e.g. "Dumbbell weight is per hand. Reps are per side."),
  `searchExercises(list: Exercise[], query: string, filters?: { muscle?: MuscleGroup; equipment?: Equipment; pattern?: MovementPattern }): Exercise[]`.
- `src/components/ExercisePicker.tsx` →
  `export function ExercisePicker(props: { open: boolean; onClose: () => void; onPick: (ex: Exercise) => void; title?: string; suggestIds?: ID[]; excludeIds?: ID[] }): JSX.Element`
  (sheet with search, filters, favourites/recent, "suggested substitutions" first when `suggestIds` given, "create custom exercise").
- `src/components/ExerciseGlyph.tsx` → `export function ExerciseGlyph(props: { pattern: MovementPattern; className?: string })` — intentional visual placeholder.
- Existing helper `src/data/catalog.ts` (`useExercises()`, `bundledExercise(id)`, `exerciseName(id, byId)`) stays as is.

Required exercise ids:
```
barbell-back-squat barbell-front-squat goblet-squat leg-press hack-squat bodyweight-squat bulgarian-split-squat
dumbbell-reverse-lunge walking-lunge dumbbell-step-up bodyweight-split-squat
conventional-deadlift romanian-deadlift dumbbell-romanian-deadlift single-leg-rdl barbell-hip-thrust glute-bridge
kettlebell-swing back-extension cable-pull-through
barbell-bench-press dumbbell-bench-press incline-dumbbell-press incline-barbell-press push-up incline-push-up
machine-chest-press cable-fly band-chest-press dip weighted-dip
overhead-press seated-dumbbell-shoulder-press machine-shoulder-press pike-push-up band-overhead-press
barbell-row one-arm-dumbbell-row seated-cable-row chest-supported-dumbbell-row machine-row inverted-row band-row
pull-up chin-up weighted-pull-up assisted-pull-up lat-pulldown band-pulldown straight-arm-pulldown
dumbbell-lateral-raise cable-lateral-raise face-pull band-pull-apart rear-delt-fly dumbbell-curl barbell-curl
hammer-curl band-curl triceps-pushdown overhead-dumbbell-triceps-extension skull-crusher band-triceps-pushdown
leg-extension lying-leg-curl seated-leg-curl standing-calf-raise seated-calf-raise band-lateral-walk
plank side-plank dead-bug bird-dog hanging-knee-raise cable-pallof-press band-pallof-press farmer-carry
rowing-machine stationary-bike mountain-climber worlds-greatest-stretch cat-cow thoracic-rotation
```

## 2. Program, progression, onboarding — owner: program slice
- `src/domain/program/generator.ts` →
  `generateProgram(answers: OnboardingAnswers, catalog: Exercise[], opts: { startDate: ISODate; variant?: number }): ProgramVersion` (deterministic for equal inputs+variant)
  `regenerateTemplates(version: ProgramVersion, templateIds: ID[], answers: OnboardingAnswers, catalog: Exercise[], variant: number): ProgramVersion`
  `estimateSessionMinutes(t: SessionTemplate, catalog: Exercise[]): number`
- `src/domain/program/program.ts` →
  `createProgram(answers: OnboardingAnswers | null, version: ProgramVersion, startDate: ISODate, name: string, source: 'generated'|'manual'): Program`
  `currentVersion(p: Program): ProgramVersion`
  `withNewVersion(p: Program, version: Omit<ProgramVersion,'version'|'createdAt'>): Program` (never mutates completed sessions)
  `templateById(p: Program, id: ID): SessionTemplate | undefined`
- `src/domain/program/schedule.ts` →
  ```ts
  type PlannedStatus = 'planned' | 'today' | 'done' | 'missed' | 'skipped' | 'moved';
  interface PlannedSession { date: ISODate; template: SessionTemplate; status: PlannedStatus; sessionId?: ID; movedTo?: ISODate; movedFrom?: ISODate }
  plannedSessionsInRange(p: Program, from: ISODate, to: ISODate, today: ISODate, sessions: WorkoutSession[], activities?: ActivityLog[]): PlannedSession[]
  nextPlannedSession(p: Program, today: ISODate, sessions: WorkoutSession[]): PlannedSession | null
  rescheduleMissed(p: Program, missedDate: ISODate, templateId: ID, today: ISODate, sessions: WorkoutSession[]): { program: Program; movedTo: ISODate | null; message: string }
  skipPlanned(p: Program, date: ISODate, templateId: ID): Program
  adherence(p: Program, from: ISODate, to: ISODate, today: ISODate, sessions: WorkoutSession[]): { planned: number; completed: number }
  ```
- `src/domain/program/session.ts` →
  `buildSessionFromTemplate(t: SessionTemplate, ctx: { catalog: Exercise[]; history: WorkoutSession[]; settings: Settings; programId?: ID; programVersion?: number; plannedDate?: ISODate; date: ISODate; timeZone: string }): WorkoutSession`
  (status 'active', pre-filled warm-up hint + target working sets using progression suggestions and previous comparable performance; uses `newRecord`-equivalent fields: id via `uuid()`, createdAt/updatedAt).
- `src/domain/progression.ts` →
  ```ts
  type SuggestionAction = 'increase_load' | 'hold' | 'add_reps' | 'calibrate' | 'reduce_assistance' | 'increase_duration' | 'increase_distance' | 'review_recovery' | 'discomfort_hold';
  interface Suggestion { action: SuggestionAction; loadKg?: number | null; repMin?: number; repMax?: number; durationSec?: number; reason: string }
  suggestNext(ex: Exercise, rx: { sets: number; repMin: number; repMax: number; targetRir: number; durationSec?: number }, history: SessionExercise[] /* comparable, newest first, completed sessions only */, opts: { unit: WeightUnit; incrementKg?: number }): Suggestion
  comparableHistory(sessions: WorkoutSession[], exerciseId: ID, beforeSessionId?: ID): SessionExercise[]
  ```
- Screens: `/onboarding` (`src/features/onboarding/OnboardingPage.tsx`), `/train/program` (`src/features/program/ProgramPage.tsx`).

## 3. Nutrition — owner: nutrition slice
- `src/domain/nutrition/targets.ts` →
  ```ts
  interface TargetInput { age?: number; weightKg?: number; heightCm?: number; sexParam?: SexParam; activityLevel: ActivityLevel; goal: Goal;
    mode: 'protein_only' | 'full'; proteinPerKg?: number; referenceWeightKg?: number; referenceWeightSource?: 'current' | 'goal' | 'custom';
    mealsPerDay: number; individualizedNutrition?: boolean; goalAdjustPct?: number; activityFactor?: number }
  computeNutritionTargets(input: TargetInput): { targets: NutritionTargets; explanation: string[]; warnings: string[] }
  proteinTarget(referenceKg: number, perKg?: number): number
  mifflinStJeor(p: { weightKg: number; heightCm: number; age: number; sex: SexParam }): number
  ACTIVITY_FACTORS: Record<ActivityLevel, number>
  ```
  Under-18 → no calorie/weight-loss prescription (autoDisabledReason 'under_18'); individualized → 'individualized'.
- `src/features/nutrition/NutritionTodayCard.tsx` → `export function NutritionTodayCard(): JSX.Element | null` (for Today; null when nutrition disabled).
- `src/data/ingredients.ts` (`INGREDIENTS`), `src/data/recipes.ts` (`RECIPES`, 24).

## 4. Backend — owner: backend slice
- `src/backend/social.ts` → `export const socialApi: SocialApi` (contract in `src/backend/contract.ts`).
- `src/backend/syncRemote.ts` → `export const syncRemote: SyncRemote`.
- `supabase/migrations/*.sql`, `supabase/functions/*`, `tests/rls/run.mjs` (`npm run test:rls`).

## 5. Social UI — owner: social slice
- `src/social/snapshot.ts` → `buildWorkoutSnapshot(s: WorkoutSession, fields: ShareFields, ctx: { byId: Map<ID, Exercise>; unit: WeightUnit; records?: { exercise: string; label: string }[] }): WorkoutSnapshot`,
  `buildActivitySnapshot(a: ActivityLog, fields: ShareFields, ctx: { distanceUnit: DistanceUnit }): WorkoutSnapshot`
- `src/social/pendingPosts.ts` → `queuePost(p: Omit<PendingPost,'status'|'attempts'|'createdAt'>, db): Promise<void>`, `processPendingPosts(db): Promise<void>`, `retryPendingPost(id, db)`, `cancelPendingPost(id, db)`, `usePendingPosts(): PendingPost[]`
- `src/social/autoShare.ts` → `maybeAutoShare(source: { session?: WorkoutSession; activity?: ActivityLog }, ctx: { db: LiftDb; settings: Settings; byId: Map<ID, Exercise> }): Promise<boolean>` (respects opt-in; never attaches photos)
- `src/features/social/SharePreview.tsx` → `export function SharePreview(props: { session?: WorkoutSession; activity?: ActivityLog; records?: { exercise: string; label: string }[]; onDone?: (postId: ID | null) => void })`
  (field toggles, caption, up to 4 photos, audience, publish / "Waiting to upload").
- `src/features/social/useUnreadCount.ts` → `useUnreadCount(): number`.

## 6. Activities & progress — owner: activity slice
- `src/domain/stats.ts` →
  ```ts
  e1rm(weightKg: number, reps: number): number | null      // Epley, only 1–10 reps
  e1rmEligible(ex: Exercise): boolean                      // loaded weight_reps with total/per_hand
  setVolumeKg(set: LoggedSet, ex: Exercise): number          // weight × reps × implements; 0 for non-comparable
  interface SessionSummary { durationSec: number; workingSets: number; warmupSets: number; totalReps: number; exercisesDone: number;
    volume: { freeWeightKg: number; machineKg: number; addedBodyweightKg: number }; }
  summarizeSession(s: WorkoutSession, byId: Map<ID, Exercise>): SessionSummary
  interface RecordHit { exerciseId: ID; kind: 'heaviest' | 'e1rm' | 'reps_at_weight' | 'most_reps' | 'longest_duration' | 'least_assistance'; value: number; label: string }
  detectRecords(s: WorkoutSession, history: WorkoutSession[] /* other completed sessions */, byId: Map<ID, Exercise>, unit: WeightUnit): RecordHit[]
  ```
- `src/domain/activities.ts` → `ACTIVITY_TYPES: { type: ActivityType; label: string; fields: ('distance'|'elevation'|'hr'|'pace')[] }[]`, `activityLabel(a: ActivityLog): string`.
- Screens: `/train/activity/new`, `/train/activity/:id`, `/train/intervals`, `/progress`.
- After saving a NEW activity, navigate to `/train/summary/<id>?kind=activity`.

## 7. Core logging (integrator) — Today, Train hub, session logger, summary, history, settings, auth, sync, PWA.
- Summary route: `/train/summary/:id` (workout) and `/train/summary/:id?kind=activity`.
- `src/sync/engine.ts` → `syncNow(): Promise<void>`, `useSyncStatus()`.
