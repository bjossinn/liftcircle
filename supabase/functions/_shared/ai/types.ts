/**
 * Types for the AI coach server modules (pure; no Deno / npm imports).
 * Payload shapes are the subsets of src/domain/types.ts that the server reads from the private tables'
 * `payload` column. Everything is optional because payloads are client-written and untrusted.
 */

export interface AiScopes {
  profile: boolean;
  training: boolean;
  measurements: boolean;
  nutrition: boolean;
}

export interface AiSettingsRow {
  enabled: boolean;
  paused: boolean;
  consentAt?: string | null;
  /** e.g. "2026-10-29:openai" — which provider the user agreed to (no suffix = Anthropic). */
  consentVersion?: string | null;
  scopes: AiScopes;
  scopesChangedAt?: string | null;
  profileNotes: string;
  /** 'supportive' | 'balanced' | 'strict'; absent/unknown → balanced (context.ts asCoachStyle). */
  coachStyle?: string | null;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status?: 'sent';
  proposalId?: string | null;
  grounding?: string[];
  /** Optional reasoning, shown collapsed under "Why this?" (null/absent when the model gave none). */
  why?: string | null;
  /** Optional structured action attached to the reply (e.g. a this-week schedule adjustment). */
  action?: WeekAdjustmentAction | null;
}

/**
 * A temporary, this-week-only schedule change the user can apply ("Apply to this week"). It never changes the
 * plan's content, frequency, split or version: the client turns it into date-specific schedule overrides
 * (src/domain/program/schedule.ts applyWeekPlan). Version-aware: applying against another plan/version is refused.
 */
export interface WeekAdjustmentAction {
  kind: 'week_adjustment';
  /** = the user message id of the exchange (stable → applying twice is a no-op). */
  id: string;
  baseProgramId: string;
  baseVersion: number;
  managedBy: 'self' | 'coach' | 'ai';
  weekStart: string;
  weekEnd: string;
  /** Total sessions the user can do this week, INCLUDING ones already completed. */
  targetSessions: number;
  completed: { date: string; name: string }[];
  /** Remaining sessions to do, in order (actual plan templates). */
  sessions: { templateId: string; name: string; date: string; plannedDate: string }[];
  /** Planned sessions this week that are dropped (become "skipped"). */
  skipped: { templateId: string; name: string; plannedDate: string }[];
  /** Small advisory tweaks (text only — never applied to the plan content). */
  adjustments: string[];
  warnings: string[];
  summary: string;
}

/** camelCase ProgramProposal as returned by the SQL helpers (src/backend/coachingContract.ts). */
export type ProposalJson = Record<string, unknown> & { id: string; status: string; target: string };

export interface StoredExchange {
  reply: StoredMessage;
  proposal: ProposalJson | null;
  duplicate?: boolean;
}

export interface UsageRow {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/* ------------------------------------------------------------------ reference catalogs */
export interface RefExercise {
  id: string;
  name: string;
  pattern?: string;
  category?: string;
  equipment: string[];
  tracking?: string;
  substitutions?: string[];
  stresses?: string[];
  primaryMuscles?: string[];
  increment?: { kg: number; lb: number };
}

export interface RefIngredient {
  id: string;
  name: string;
  per100g: { kcal?: number; protein?: number; carbs?: number; fat?: number };
  allergens: string[];
  diet?: { vegetarian?: boolean; vegan?: boolean; dairyFree?: boolean; glutenFree?: boolean; pescatarian?: boolean };
}

export interface RefRecipe {
  id: string;
  name: string;
  meal: string;
  servings: number;
  prepMinutes?: number;
  cookMinutes?: number;
  ingredients: { ingredientId: string; grams: number; optional?: boolean }[];
}

/* ------------------------------------------------------------------ private payloads (subset) */
export interface PrescriptionPayload {
  id?: string;
  exerciseId?: string;
  sets?: number;
  repMin?: number;
  repMax?: number;
  targetRir?: number;
  restSec?: number;
  durationSec?: number;
}
export interface TemplatePayload {
  id?: string;
  name?: string;
  focus?: string;
  kind?: string;
  estimatedMinutes?: number;
  exercises?: PrescriptionPayload[];
}
export interface ProgramVersionPayload {
  version?: number;
  templates?: TemplatePayload[];
  schedule?: { weekday?: number; templateId?: string }[];
  weeks?: number;
  reviewWeek?: number;
}
export interface ProgramPayload {
  id?: string;
  name?: string;
  source?: string;
  managedBy?: { kind?: string; coachName?: string };
  startDate?: string;
  active?: boolean;
  currentVersion?: number;
  versions?: ProgramVersionPayload[];
  overrides?: { date?: string; templateId?: string; status?: string; movedTo?: string }[];
  inputs?: {
    equipment?: string[];
    excludedExerciseIds?: string[];
    totalDaysPerWeek?: number;
    liftingDaysPerWeek?: number;
    sessionMinutes?: number;
    location?: string;
    availableWeekdays?: number[];
    preferredLiftingWeekdays?: number[];
    goal?: string;
    experience?: string;
  };
}
export interface LoggedSetPayload {
  type?: string;
  weightKg?: number | null;
  reps?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
  rir?: number | null;
  rpe?: number | null;
  completed?: boolean;
}
export interface SessionPayload {
  id?: string;
  name?: string;
  status?: string;
  date?: string;
  startedAt?: number;
  endedAt?: number;
  pausedTotalMs?: number;
  programId?: string;
  templateId?: string;
  plannedDate?: string;
  exercises?: { exerciseId?: string; discomfort?: boolean; sets?: LoggedSetPayload[] }[];
}
export interface AccountStatePayload {
  settings?: { units?: { weight?: string; length?: string; distance?: string }; timeZone?: string; weekStart?: number };
  profile?: {
    goal?: string;
    secondaryGoal?: string;
    experience?: string;
    activityLevel?: string;
    limitations?: string[];
    targetWeightKg?: number;
    diet?: { tags?: string[]; allergens?: string[]; dislikedIngredientIds?: string[]; maxCookMinutes?: number; mealsPerDay?: number };
    individualizedNutrition?: boolean;
    // Deliberately NOT read: injuryNotes, age, heightCm, sexParam, displayName.
  };
  nutrition?: {
    mode?: string;
    proteinG?: number;
    calories?: number;
    carbsG?: number;
    fatG?: number;
    proteinPerKg?: number;
    autoDisabledReason?: string | null;
  };
}
export interface MeasurementPayload {
  kind?: string;
  date?: string;
  value?: number;
}
export interface FoodLogPayload {
  date?: string;
  kcal?: number | null;
  protein?: number | null;
}
export interface GoalPayload {
  title?: string;
  kind?: string;
  target?: number;
  deadline?: string;
  achievedAt?: number;
}
export interface ActiveProgramRow {
  id: string;
  payload: ProgramPayload;
}

/* ------------------------------------------------------------------ proposal input */
export interface RecordProposalInput {
  baseProgramId: string | null;
  baseVersion: number | null;
  program: Record<string, unknown>;
  changeSummary: string[];
  message: string | null;
  target: 'apply' | 'for_coach_review';
  validationErrors: string[];
  effectiveDate: string | null;
}

export interface RecordExchangeInput {
  message: { id: string; content: string; mode: 'chat' | 'checkin_review' };
  reply: {
    content: string;
    grounding: string[];
    model: string;
    inputTokens: number;
    outputTokens: number;
    why?: string | null;
    action?: WeekAdjustmentAction | null;
  };
  proposal: RecordProposalInput | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
}

/**
 * Data access for the AI coach. EVERY user-scoped method takes the verified user id as its first
 * argument and must filter by it (the Supabase implementation also uses the user's JWT, so RLS applies).
 * There are deliberately no methods for coach messages, coach notes/feedback, social data or other users.
 */
export interface AiDb {
  getSettings(uid: string): Promise<AiSettingsRow | null>;
  getExchange(uid: string, messageId: string): Promise<StoredExchange | null>;
  /** Counts one request; returns remaining. Throws an error with code 'PT429' when over the limit. */
  checkAndCountUsage(uid: string, limit: number): Promise<number>;
  getUsage(uid: string, day: string): Promise<UsageRow | null>;
  getAccountState(uid: string): Promise<AccountStatePayload | null>;
  getActiveProgram(uid: string): Promise<ActiveProgramRow | null>;
  getRecentSessions(uid: string, limit: number): Promise<SessionPayload[]>;
  getGoals(uid: string): Promise<GoalPayload[]>;
  getBodyweight(uid: string, sinceDate: string): Promise<MeasurementPayload[]>;
  getFoodLogs(uid: string, sinceDate: string): Promise<FoodLogPayload[]>;
  /** AI messages created strictly after `after` (ISO) — newest `limit`, returned oldest first. */
  getHistory(uid: string, after: string | null, limit: number): Promise<StoredMessage[]>;
  recordExchange(uid: string, input: RecordExchangeInput): Promise<StoredExchange>;
  /* shared, read-only reference catalogs (not user data) */
  getExercises(): Promise<RefExercise[]>;
  getRecipes(): Promise<RefRecipe[]>;
  getIngredients(): Promise<RefIngredient[]>;
}

/** Facts the server uses for tools and validation (never sent wholesale to the provider). */
export interface UserFacts {
  units: 'kg' | 'lb';
  timeZone: string;
  /** 0 = weeks start on Sunday, 1 = Monday (account setting; default Monday). */
  weekStart: 0 | 1;
  equipment: string[] | null; // null = unknown → equipment check skipped
  excludedExerciseIds: string[];
  limitations: string[];
  allergens: string[];
  dietTags: string[];
  dislikedIngredientIds: string[];
  maxCookMinutes: number | null;
  activeProgram: null | {
    id: string;
    name: string;
    currentVersion: number;
    managedBy: 'self' | 'coach' | 'ai';
    version: ProgramVersionPayload | null;
    startDate: string | null;
    overrides: NonNullable<ProgramPayload['overrides']>;
    /** Typed weekdays the user said they can train (0 = Sun); empty = not recorded. */
    availableWeekdays: number[];
  };
}

/* ------------------------------------------------------------------ Anthropic wire types (subset) */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ApiResponse {
  id?: string;
  model?: string;
  content: ContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;
