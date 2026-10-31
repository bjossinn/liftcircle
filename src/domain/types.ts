/**
 * Core domain types shared by UI, local persistence, sync and backend access.
 * Canonical storage units: kilograms, centimetres, metres, seconds, epoch ms.
 * Local calendar dates are 'YYYY-MM-DD' strings in the user's chosen time zone.
 */

export type ID = string;
export type ISODate = string; // 'YYYY-MM-DD' (local calendar date)
export type Epoch = number; // milliseconds since epoch

/* ------------------------------------------------------------------ units */
export type WeightUnit = 'kg' | 'lb';
export type LengthUnit = 'cm' | 'ftin';
export type DistanceUnit = 'km' | 'mi';
export interface UnitPrefs {
  weight: WeightUnit;
  length: LengthUnit;
  distance: DistanceUnit;
}
/** The value exactly as the user typed it, so 45 lb is redisplayed as 45 lb, not 44.99. */
export interface EnteredValue {
  value: number;
  unit: WeightUnit;
}

/* ------------------------------------------------------- sync metadata */
/** Every synced private record carries these fields. */
export interface SyncFields {
  id: ID; // client-generated UUID, stable across devices
  createdAt: Epoch;
  updatedAt: Epoch; // local edit time (informational, NEVER used for conflict authority)
  serverVersion?: number; // server-issued version; authority for compare-and-swap
  deletedAt?: Epoch; // tombstone; kept so an old device cannot resurrect the record
}

/* -------------------------------------------------------------- exercises */
export type MuscleGroup =
  | 'chest' | 'upper_back' | 'lats' | 'shoulders' | 'rear_delts' | 'biceps' | 'triceps' | 'forearms'
  | 'quads' | 'hamstrings' | 'glutes' | 'calves' | 'adductors' | 'abs' | 'obliques' | 'lower_back'
  | 'full_body' | 'cardio';

export type MovementPattern =
  | 'squat' | 'lunge' | 'hinge'
  | 'horizontal_push' | 'vertical_push' | 'horizontal_pull' | 'vertical_pull'
  | 'trunk' | 'carry' | 'isolation_upper' | 'isolation_lower' | 'conditioning' | 'mobility';

export type Equipment =
  | 'barbell' | 'rack' | 'bench' | 'dumbbell' | 'kettlebell' | 'machine' | 'cable' | 'band'
  | 'bodyweight' | 'pullup_bar' | 'dip_station' | 'ez_bar' | 'smith' | 'cardio_machine';

export type ExerciseCategory = 'compound' | 'isolation' | 'core' | 'cardio' | 'mobility';
export type Difficulty = 1 | 2 | 3; // 1 beginner-friendly, 3 technically demanding

/**
 * How a set is tracked.
 * - weight_reps: external load × reps
 * - reps: reps only (bodyweight)
 * - bodyweight_plus: added load on top of bodyweight (weighted dip/pull-up)
 * - assisted: assistance load (machine/band); LESS assistance = progress
 * - duration: timed hold / timed work
 * - distance_time: distance and/or time (sled, carry, cardio machine)
 */
export type TrackingType = 'weight_reps' | 'reps' | 'bodyweight_plus' | 'assisted' | 'duration' | 'distance_time';

/**
 * What the entered load number means.
 * - total: the whole implement (barbell incl. bar, single kettlebell)
 * - per_hand: each dumbbell/kettlebell when using two (volume counts both)
 * - stack: machine / cable stack setting (not comparable with free weights)
 * - added: added load for bodyweight_plus
 * - assistance: assistance for assisted
 * - none: no load
 */
export type LoadConvention = 'total' | 'per_hand' | 'stack' | 'added' | 'assistance' | 'none';

export type LimitationArea = 'knee' | 'shoulder' | 'lower_back' | 'hip' | 'wrist' | 'elbow' | 'neck' | 'ankle';

export interface Exercise {
  id: ID; // stable identifier, e.g. 'barbell-back-squat'
  name: string;
  aliases: string[];
  category: ExerciseCategory;
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
  pattern: MovementPattern;
  /** ALL of these are required to perform the exercise. */
  equipment: Equipment[];
  difficulty: Difficulty;
  tracking: TrackingType;
  load: LoadConvention;
  /** Number of implements counted toward volume (2 for a pair of dumbbells). Default 1. */
  implements?: 1 | 2;
  /** Reps are counted per side (e.g. split squat, one-arm row). */
  unilateral?: boolean;
  /** Joint areas this exercise commonly loads; used to suggest alternatives when a user reports discomfort. */
  stresses: LimitationArea[];
  /** Suitable as a main/primary lift in program generation. */
  mainLift?: boolean;
  /** Smallest practical load increase in kg (and lb for imperial users). */
  increment?: { kg: number; lb: number };
  setup: string;
  execution: string;
  cues: string[];
  mistakes: string[];
  substitutions: ID[];
  /** Optional verified external reference (never a hot-linked image). */
  referenceUrl?: string;
  custom?: boolean;
}

/** User-created exercise (owner-only, synced). */
export type CustomExercise = Exercise & SyncFields & { custom: true };

/* ------------------------------------------------------------- onboarding */
export type Goal = 'build_muscle' | 'strength' | 'lose_fat' | 'general_fitness' | 'endurance';
export type Experience = 'new' | 'returning' | 'intermediate' | 'advanced';
export type Location = 'full_gym' | 'home_gym' | 'minimal';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'very' | 'extra';
export type ActivityType =
  | 'walk' | 'run' | 'cycle' | 'hike' | 'swim' | 'row' | 'sport' | 'class' | 'yoga' | 'mobility' | 'stretch' | 'custom';
export type DietTag = 'vegetarian' | 'vegan' | 'pescatarian' | 'dairy_free' | 'gluten_free' | 'high_protein';
export type Allergen =
  | 'milk' | 'egg' | 'fish' | 'shellfish' | 'tree_nuts' | 'peanuts' | 'wheat' | 'gluten' | 'soy' | 'sesame' | 'mustard' | 'celery';
export type BudgetPref = 'low' | 'medium' | 'any';
export type SexParam = 'male' | 'female';
/** Lifting-split structure (catalog in src/domain/program/splits.ts). */
export type SplitKey = 'fb1' | 'fb2' | 'fb3' | 'fb4' | 'ul2' | 'ulf' | 'ppl3' | 'ul4' | 'ul5' | 'ulppl' | 'ul6' | 'ppl6' | 'es';

export interface OnboardingAnswers {
  displayName: string;
  units: UnitPrefs;
  age?: number;
  weightKg?: number;
  heightCm?: number;
  goal: Goal;
  secondaryGoal?: Goal;
  targetWeightKg?: number;
  experience: Experience;
  totalDaysPerWeek: number; // all activity days 1–7
  liftingDaysPerWeek: number; // hard lifting days 0–6
  availableWeekdays: number[]; // 0 = Sunday … 6 = Saturday
  preferredLiftingWeekdays: number[];
  sessionMinutes: number;
  location: Location;
  equipment: Equipment[];
  preferredActivities: ActivityType[];
  enjoyedExerciseIds: ID[];
  excludedExerciseIds: ID[];
  limitations: LimitationArea[];
  limitationNotes?: string;
  activityLevel: ActivityLevel;
  wantsNutrition: boolean;
  nutritionMode?: 'protein_only' | 'full';
  diet: DietPrefs;
  sexParam?: SexParam; // ONLY used for Mifflin–St Jeor if a calorie estimate was requested
  /** Pregnancy/breastfeeding or a condition requiring individualized nutrition → no generic prescriptions. */
  individualizedNutrition?: boolean;
  /** Endurance-first calibration. */
  endurance?: { activity: ActivityType; recentMinutes?: number; recentDistanceKm?: number };
  /** Comfortable known loads (kg) by exercise id; never inferred from age/bodyweight. */
  knownLoads?: Record<ID, number>;
  /** Explicitly chosen lifting split. Absent = the recommended default for the lifting-day count. */
  splitPreference?: SplitKey;
}

export interface DietPrefs {
  tags: DietTag[];
  allergens: Allergen[];
  dislikedIngredientIds: ID[];
  maxCookMinutes: number;
  budget: BudgetPref;
  mealsPerDay: number;
  /** Optional; absent on data saved before 0.9.0 (= no preference). */
  proteinPrefs?: ProteinPrefs;
}

/* --------------------------------------------------------------- programs */
export interface Prescription {
  /** Slot id unique within the session template. */
  id: ID;
  exerciseId: ID;
  sets: number;
  repMin: number;
  repMax: number;
  /** Target reps in reserve ("reps left in the tank"). */
  targetRir: number;
  restSec: number;
  /** For timed exercises (seconds per set). */
  durationSec?: number;
  warmup: string;
  /** 1 = main, 2 = secondary, 3 = accessory (trimmed first when over time). */
  priority: 1 | 2 | 3;
  /** Starting load in kg if the user told us a comfortable known load. */
  startLoadKg?: number;
  /** No known load: first session is a light calibration session. */
  calibrate?: boolean;
  alternatives: ID[];
  notes?: string;
}

export type SessionKind = 'lifting' | 'cardio' | 'walk' | 'mobility' | 'conditioning';

export interface SessionTemplate {
  id: ID;
  name: string;
  focus: string; // e.g. 'Upper', 'Full body A', 'Easy run'
  kind: SessionKind;
  exercises: Prescription[];
  estimatedMinutes: number;
  cardio?: { activity: ActivityType; minutes: number; intensity: 'easy' | 'moderate' | 'hard'; notes: string };
  trimmedExerciseIds?: ID[]; // accessories removed to fit the time budget
}

export interface ScheduleSlot {
  weekday: number; // 0 Sunday … 6 Saturday
  templateId: ID;
}

export interface ProgramVersion {
  version: number;
  createdAt: Epoch;
  reason: string; // 'Generated from onboarding', 'Swapped bench press', …
  templates: SessionTemplate[];
  schedule: ScheduleSlot[];
  weeks: number; // length of the block
  reviewWeek: number; // week at which to review
  rationale: string[]; // why this fits the inputs
  warnings: string[]; // compromises / recommendations
}

/** Who manages a program's content. Exactly one program is active at a time. */
export interface ProgramManager {
  kind: 'self' | 'coach' | 'ai';
  /** Coach-managed: the coaching relationship and coach. */
  relationshipId?: ID;
  coachId?: ID;
  coachName?: string;
  /** The accepted proposal that produced the current version (coach or AI). */
  proposalId?: ID;
}

export interface Program extends SyncFields {
  name: string;
  source: 'generated' | 'manual' | 'coach' | 'ai';
  /** Absent = self-managed (back-compat with programs created before coaching existed). */
  managedBy?: ProgramManager;
  startDate: ISODate;
  active: boolean;
  currentVersion: number;
  versions: ProgramVersion[];
  inputs?: OnboardingAnswers;
  /** Index into the lifting rotation for the next planned session. */
  rotationIndex: number;
  /** Missed / moved planned sessions. */
  overrides: PlanOverride[];
}

export interface PlanOverride {
  date: ISODate; // originally planned date
  templateId: ID;
  status: 'skipped' | 'moved';
  movedTo?: ISODate;
  /** Set when the override came from an applied this-week plan (AI "Apply to this week"); lets it be undone as a unit. */
  weekPlanId?: ID;
}

/** A saved, reusable routine outside the program (user library). */
export interface SavedTemplate extends SyncFields {
  template: SessionTemplate;
}

/* ---------------------------------------------------------------- logging */
export type SetType = 'warmup' | 'normal' | 'drop' | 'timed';

export interface LoggedSet {
  id: ID;
  type: SetType;
  /** Load in kg per the exercise's LoadConvention (assistance for assisted, added for weighted BW). */
  weightKg?: number | null;
  entered?: EnteredValue;
  reps?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
  rpe?: number | null;
  rir?: number | null;
  completed: boolean;
  completedAt?: Epoch;
}

export interface SessionExercise {
  id: ID;
  exerciseId: ID;
  order: number;
  supersetGroup?: string;
  prescription?: Pick<Prescription, 'sets' | 'repMin' | 'repMax' | 'targetRir' | 'restSec' | 'durationSec'> & { slotId?: ID };
  sets: LoggedSet[];
  notes?: string;
  /** User flagged discomfort on this exercise during the session. */
  discomfort?: boolean;
  swappedFrom?: ID;
}

export interface RestTimerState {
  /** Wall-clock deadline; remaining time is always recomputed from this. */
  endsAt?: Epoch;
  /** Set while paused. */
  pausedRemainingMs?: number;
  durationMs: number;
  forExerciseId?: ID;
}

export interface WorkoutSession extends SyncFields {
  name: string;
  status: 'active' | 'completed';
  programId?: ID;
  programVersion?: number;
  templateId?: ID;
  plannedDate?: ISODate;
  date: ISODate; // local calendar date of the session
  timeZone: string;
  startedAt: Epoch;
  endedAt?: Epoch;
  pausedAt?: Epoch;
  pausedTotalMs: number;
  exercises: SessionExercise[];
  notes?: string;
  rest?: RestTimerState;
  /** Posts created from this session (snapshot copies, never live links). */
  sharedPostIds?: ID[];
}

/* ------------------------------------------------------------- activities */
export type Intensity = 'easy' | 'moderate' | 'hard';
export interface ActivityLog extends SyncFields {
  type: ActivityType;
  customName?: string;
  date: ISODate;
  timeZone: string;
  startedAt?: Epoch;
  durationSec: number;
  distanceM?: number;
  elevationM?: number;
  avgHr?: number;
  maxHr?: number;
  intensity?: Intensity;
  /** Optional energy figure; always approximate. */
  energyKcal?: number;
  energySource?: 'user' | 'device' | 'estimate';
  notes?: string;
  sharedPostIds?: ID[];
}

export interface ActivityTemplate extends SyncFields {
  name: string;
  type: ActivityType;
  durationSec?: number;
  distanceM?: number;
  intervals?: { label: string; seconds: number; repeat: number }[];
}

/* ---------------------------------------------------------- measurements */
export type MeasurementKind = 'bodyweight' | 'waist' | 'chest' | 'hips' | 'arm' | 'thigh' | 'bodyfat_pct';
export interface Measurement extends SyncFields {
  kind: MeasurementKind;
  date: ISODate;
  /** kg for bodyweight, cm for circumferences, % for body fat. */
  value: number;
  entered?: EnteredValue;
  note?: string;
}

export interface UserGoal extends SyncFields {
  title: string;
  kind: 'sessions_per_week' | 'exercise_load' | 'bodyweight' | 'protein_days' | 'cardio_minutes' | 'custom';
  exerciseId?: ID;
  target: number;
  deadline?: ISODate;
  achievedAt?: Epoch;
}

/* ------------------------------------------------------------- nutrition */
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';
/**
 * Protein groups for "proteins I like / not for me" preferences. An ingredient carries at most one. Separate from
 * allergens: an allergy is a safety filter, a protein preference is taste.
 */
export type ProteinGroup =
  | 'chicken' | 'turkey' | 'beef' | 'pork' | 'lamb'
  | 'white_fish' | 'oily_fish' | 'tuna' | 'prawns' | 'shellfish'
  | 'eggs' | 'dairy'
  | 'tofu_tempeh' | 'beans_lentils' | 'chickpeas'
  | 'whey' | 'plant_protein';

/** liked = rank and pick these more often; excluded = never use. Missing = no preference. */
export interface ProteinPrefs {
  liked: ProteinGroup[];
  excluded: ProteinGroup[];
}

export interface Macros {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
}

export interface Ingredient {
  id: ID;
  name: string;
  category: 'protein' | 'dairy' | 'grain' | 'legume' | 'vegetable' | 'fruit' | 'fat' | 'nut_seed' | 'condiment' | 'other';
  /** Nutrition per 100 g in the stated state. */
  per100g: Macros;
  state: 'raw' | 'dry' | 'cooked' | 'as_sold';
  /** e.g. 'USDA FoodData Central SR Legacy #171287' or 'Typical label value' */
  source: string;
  allergens: Allergen[];
  /** Diet compatibility of the ingredient itself. */
  diet: { vegetarian: boolean; vegan: boolean; dairyFree: boolean; glutenFree: boolean; pescatarian: boolean };
  /** Grams for common household units, e.g. { piece: 50 } for one egg. */
  units?: Partial<Record<'piece' | 'cup' | 'tbsp' | 'tsp' | 'slice' | 'can', number>>;
  costTier: 1 | 2 | 3;
  /** The protein group this ingredient belongs to, if it is a protein food. */
  proteinGroup?: ProteinGroup;
}

export interface RecipeIngredient {
  ingredientId: ID;
  grams: number; // for the whole recipe at base servings, in the ingredient's stated state
  display?: string; // '2 eggs', '1 cup'
  prep?: string; // 'dry', 'diced', 'drained'
  optional?: boolean;
}

export interface Recipe {
  id: ID;
  name: string;
  meal: MealSlot;
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  ingredients: RecipeIngredient[];
  steps: string[];
  /** Ingredient substitutions: from → alternatives */
  substitutions: { ingredientId: ID; alternatives: ID[] }[];
  notes?: string;
}

export interface CustomFood extends SyncFields {
  name: string;
  brand?: string;
  /** Nutrition for `per` amount. */
  per: { amount: number; unit: 'g' | 'ml' | 'serving' };
  macros: Partial<Macros>;
  isLabel: boolean; // branded label values vs generic estimate
}

export interface FoodLogEntry extends SyncFields {
  date: ISODate;
  meal: MealSlot;
  name: string;
  source: { kind: 'recipe' | 'ingredient' | 'custom' | 'quick' | 'saved'; refId?: ID };
  servings?: number;
  grams?: number;
  /** Missing values are unknown, NOT zero. */
  kcal?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
}

export interface SavedMeal extends SyncFields {
  name: string;
  items: Omit<FoodLogEntry, keyof SyncFields | 'date' | 'meal'>[];
}

export interface MealPlanItem {
  id: ID;
  slot: MealSlot;
  recipeId: ID;
  servings: number;
  swaps?: { from: ID; to: ID }[];
  /** Optional protein sides added to this meal (e.g. 100 g roast chicken). Plans saved before Oct 2026 have none. */
  extras?: MealPlanExtra[];
}
/** A catalogue ingredient added to a planned meal, in grams as eaten. */
export interface MealPlanExtra {
  ingredientId: ID;
  grams: number;
}
export interface MealPlan extends SyncFields {
  weekStart: ISODate;
  days: { date: ISODate; items: MealPlanItem[] }[];
  shoppingChecked: ID[];
}

export interface NutritionTargets {
  mode: 'none' | 'protein_only' | 'full' | 'manual';
  proteinG?: number;
  proteinPerKg: number;
  referenceWeightKg?: number;
  referenceWeightSource?: 'current' | 'goal' | 'custom';
  calories?: number;
  carbsG?: number;
  fatG?: number;
  restingKcal?: number;
  activityFactor?: number;
  goalAdjustPct?: number;
  mealsPerDay: number;
  /** Why automated prescriptions are disabled, if they are. */
  autoDisabledReason?: 'under_18' | 'individualized' | null;
  updatedAt: Epoch;
}

/* -------------------------------------------------------------- settings */
export interface ShareFields {
  duration: boolean;
  exerciseNames: boolean;
  weightsReps: boolean;
  volume: boolean;
  records: boolean;
}
export type Audience = 'only_me' | 'friends';
/** How hard the coach pushes (AI chat and workout cheers). Safety limits apply in every style. */
export type CoachStyle = 'supportive' | 'balanced' | 'strict';

export interface Settings {
  units: UnitPrefs;
  /**
   * 'dark' = Dark, 'light' = Light, 'system' = Match my phone (names in src/theme/theme.ts). Optional since
   * 0.8.0: undefined means not chosen yet (new accounts), and the first-launch picker asks.
   */
  theme?: 'dark' | 'light' | 'system';
  weekStart: 0 | 1;
  timeZone: string;
  language: 'en';
  rest: { defaultSec: number; autoStart: boolean; sound: boolean; vibrate: boolean; keepAwake: boolean };
  workout: {
    showRir: boolean; defaultSets: number; plateIncrementKg: number; plateIncrementLb: number;
    /** Empty-bar weight for barbell warm-ups (defaults 20 kg / 45 lb when absent). */
    barKg?: number; barLb?: number;
    /** "Coach cheers during workouts" (logger popups). Optional (added in 0.4.0); undefined means on. */
    coachCheers?: boolean;
    /** A brief celebration on a new record and at the end of a workout, plus the Today streak flame. Optional (0.8.0); undefined means on. */
    celebrations?: boolean;
  };
  /**
   * Local mirror of the training assistant style (ai_settings.coach_style, the authority) so offline features such as the
   * logger's coach cheers can follow it. Optional; undefined means 'balanced'.
   */
  coachStyle?: CoachStyle;
  /** `coaching` is optional (added later); undefined means on. The server honours it when creating coaching notifications. */
  notifications: { friendRequests: boolean; likes: boolean; comments: boolean; coaching?: boolean };
  social: {
    discoverable: boolean;
    autoShare: { enabled: boolean; audience: Audience; fields: ShareFields };
    defaultAudience: Audience;
  };
  nutritionEnabled: boolean;
  demoData: boolean;
}

/** Private profile — never part of the discoverable social profile. */
export interface PrivateProfile {
  displayName: string;
  age?: number;
  ageRecordedAt?: Epoch;
  heightCm?: number;
  sexParam?: SexParam;
  goal?: Goal;
  secondaryGoal?: Goal;
  targetWeightKg?: number;
  experience?: Experience;
  activityLevel?: ActivityLevel;
  limitations: LimitationArea[];
  injuryNotes?: string;
  diet: DietPrefs;
  individualizedNutrition?: boolean;
  onboardedAt?: Epoch;
}

/** One row per account holding settings, private profile and nutrition targets. */
export interface AccountState extends SyncFields {
  settings: Settings;
  profile: PrivateProfile;
  nutrition: NutritionTargets;
  favorites: { exercises: ID[]; recipes: ID[] };
}

/* ---------------------------------------------------------------- social */
export interface SocialProfile {
  id: ID;
  username: string;
  displayName: string;
  avatarPath?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  interests: string[];
  discoverable: boolean;
}

export type PostKind = 'workout' | 'activity' | 'achievement' | 'text';

/** Snapshot copied at share time; never a link back into private records. */
export interface WorkoutSnapshot {
  title: string; // 'Upper body workout'
  kind: 'workout' | 'activity' | 'achievement';
  date: ISODate;
  durationSec?: number;
  exercises?: { name: string; sets?: { weight?: string; reps?: number; duration?: string }[] }[];
  volume?: { value: number; unit: WeightUnit; convention: string };
  records?: { exercise: string; label: string }[];
  activity?: { type: ActivityType; label: string; distance?: string; pace?: string };
}

export interface PostMedia {
  id: ID;
  position: number;
  description?: string | null;
  width: number;
  height: number;
  url?: string; // short-lived signed URL
  thumbUrl?: string;
}

export interface Post {
  id: ID;
  authorId: ID;
  author?: Pick<SocialProfile, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
  kind: PostKind;
  audience: Audience;
  caption: string;
  snapshot?: WorkoutSnapshot | null;
  media: PostMedia[];
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  createdAt: string; // server timestamp ISO
  editedAt?: string | null;
}

export interface Comment {
  id: ID;
  postId: ID;
  authorId: ID;
  author?: Pick<SocialProfile, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
  body: string;
  createdAt: string;
}

export type FriendStatus = 'none' | 'outgoing' | 'incoming' | 'friends' | 'blocked' | 'blocked_by';

export interface FriendRequest {
  id: ID;
  requesterId: ID;
  addresseeId: ID;
  other: Pick<SocialProfile, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
  status: 'pending' | 'accepted';
  createdAt: string;
}

export type SocialNotificationType = 'friend_request' | 'friend_accept' | 'like' | 'comment';
export const COACHING_NOTIFICATION_TYPES = [
  'coach_request',
  'coach_request_accepted',
  'coach_request_declined',
  'coach_request_cancelled',
  'coach_ended',
  'coach_message',
  'coach_proposal',
  'coach_proposal_response',
  'coach_checkin',
  'coach_feedback',
  'coach_application',
  'coach_status',
] as const;
export type CoachingNotificationType = (typeof COACHING_NOTIFICATION_TYPES)[number];

export interface AppNotification {
  id: ID;
  type: SocialNotificationType | CoachingNotificationType;
  actor?: Pick<SocialProfile, 'id' | 'username' | 'displayName' | 'avatarUrl'>;
  postId?: ID | null;
  commentId?: ID | null;
  /** Coaching notifications reference ids only — never message text. */
  relationshipId?: ID | null;
  coachId?: ID | null;
  proposalId?: ID | null;
  createdAt: string;
  readAt?: string | null;
}

/** A post the user shared while offline or whose upload failed — kept locally until published. */
export interface PendingPost {
  id: ID; // becomes the server post id (idempotent)
  createdAt: Epoch;
  kind: PostKind;
  audience: Audience;
  caption: string;
  snapshot?: WorkoutSnapshot | null;
  sourceRecordId?: ID;
  photos: { id: ID; blob: Blob; thumb: Blob; width: number; height: number; description?: string; uploaded?: boolean }[];
  status: 'waiting' | 'uploading' | 'error';
  error?: string;
  attempts: number;
}
