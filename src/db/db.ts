import Dexie, { type Table } from 'dexie';
import type {
  AccountState, ActivityLog, ActivityTemplate, CustomExercise, CustomFood, FoodLogEntry, Measurement, MealPlan,
  PendingPost, Program, SavedMeal, SavedTemplate, UserGoal, WorkoutSession,
} from '@/domain/types';

/** Entities that sync to the backend, mapped to their local Dexie table. */
export const SYNCED_ENTITIES = {
  account_state: 'account',
  programs: 'programs',
  templates: 'templates',
  sessions: 'sessions',
  activities: 'activities',
  activity_templates: 'activityTemplates',
  measurements: 'measurements',
  goals: 'goals',
  custom_exercises: 'customExercises',
  custom_foods: 'customFoods',
  food_logs: 'foodLogs',
  saved_meals: 'savedMeals',
  meal_plans: 'mealPlans',
} as const;
export type SyncedEntity = keyof typeof SYNCED_ENTITIES;
export type LocalTable = (typeof SYNCED_ENTITIES)[SyncedEntity];

export interface OutboxOp {
  seq?: number;
  /** Account that queued the op. Ops are only ever sent with this account's credentials. */
  accountId: string;
  entity: SyncedEntity;
  recordId: string;
  op: 'upsert' | 'delete';
  queuedAt: number;
  attempts: number;
  status: 'pending' | 'error' | 'conflict';
  lastError?: string;
  nextAttemptAt?: number;
  /** Hashes of payloads already sent for this op — lets us recognise our own write after a lost response. */
  sentHashes?: string[];
  /** Set for imported records: if the id already exists in the cloud, keep the cloud copy. */
  preferRemote?: boolean;
}

export interface SyncConflict {
  id: string; // `${entity}:${recordId}`
  entity: SyncedEntity;
  recordId: string;
  local: unknown;
  remote: unknown;
  remoteVersion: number;
  /** The other side deleted the record (deletion wins on the server). */
  remoteDeleted?: boolean;
  detectedAt: number;
}

/** A coach-chat message written while offline or not yet confirmed by the server. */
export interface CoachOutboxItem {
  id: string; // becomes the server message id (idempotent)
  accountId: string;
  relationshipId: string;
  body: string;
  sharedFromAi?: boolean;
  photos?: { id: string; blob: Blob; thumb: Blob; width: number; height: number; uploaded?: boolean }[];
  status: 'queued' | 'sending' | 'failed';
  attempts: number;
  error?: string;
  createdAt: number;
}

export interface KV {
  key: string;
  value: unknown;
}

/** The single AccountState row always uses this local id. */
export const ACCOUNT_ROW_ID = 'account';

export class LiftDb extends Dexie {
  account!: Table<AccountState, string>;
  programs!: Table<Program, string>;
  templates!: Table<SavedTemplate, string>;
  sessions!: Table<WorkoutSession, string>;
  activities!: Table<ActivityLog, string>;
  activityTemplates!: Table<ActivityTemplate, string>;
  measurements!: Table<Measurement, string>;
  goals!: Table<UserGoal, string>;
  customExercises!: Table<CustomExercise, string>;
  customFoods!: Table<CustomFood, string>;
  foodLogs!: Table<FoodLogEntry, string>;
  savedMeals!: Table<SavedMeal, string>;
  mealPlans!: Table<MealPlan, string>;
  outbox!: Table<OutboxOp, number>;
  conflicts!: Table<SyncConflict, string>;
  pendingPosts!: Table<PendingPost, string>;
  kv!: Table<KV, string>;
  coachOutbox!: Table<CoachOutboxItem, string>;

  constructor(
    /** 'guest' or the authenticated user's id. */
    readonly accountKey: string,
  ) {
    super(dbNameFor(accountKey));
    // Version 1 schema. Future migrations add .version(2).stores(...).upgrade(...)
    // and must preserve existing records.
    this.version(1).stores({
      account: 'id',
      programs: 'id, active, updatedAt',
      templates: 'id, updatedAt',
      sessions: 'id, date, status, startedAt, updatedAt',
      activities: 'id, date, type, updatedAt',
      activityTemplates: 'id',
      measurements: 'id, kind, date, [kind+date]',
      goals: 'id',
      customExercises: 'id',
      customFoods: 'id, name',
      foodLogs: 'id, date, meal',
      savedMeals: 'id',
      mealPlans: 'id, weekStart',
      outbox: '++seq, accountId, [entity+recordId], status',
      conflicts: 'id, entity',
      pendingPosts: 'id, status',
      kv: 'key',
    });
    // Version 2 (coaching): additive — existing tables and records are untouched.
    this.version(2).stores({
      coachOutbox: 'id, relationshipId, status, accountId',
    });
  }

  /** No signed-in account behind this database (guest or demo): no sync, no social. */
  get isGuest() {
    return this.accountKey === 'guest' || this.accountKey === 'demo';
  }
  get isDemo() {
    return this.accountKey === 'demo';
  }
}

export function dbNameFor(accountKey: string) {
  return `liftcircle:${accountKey}`;
}

let current: LiftDb | null = null;
const listeners = new Set<(db: LiftDb) => void>();

/** Open (or switch to) the account-scoped database. Closes the previous one. */
export function openAccountDb(accountKey: string): LiftDb {
  if (current && current.accountKey === accountKey) return current;
  current?.close();
  current = new LiftDb(accountKey);
  listeners.forEach((l) => l(current!));
  return current;
}

export function getDb(): LiftDb {
  if (!current) current = new LiftDb('guest');
  return current;
}

export function onDbChange(fn: (db: LiftDb) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Delete an account's local database entirely (after sync/export or explicit discard). */
export async function deleteAccountDb(accountKey: string) {
  if (current?.accountKey === accountKey) {
    current.close();
    current = null;
  }
  await Dexie.delete(dbNameFor(accountKey));
}

export async function accountDbExists(accountKey: string): Promise<boolean> {
  const names = await Dexie.getDatabaseNames();
  return names.includes(dbNameFor(accountKey));
}

/** Ask the browser not to evict our storage (best-effort). */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* unsupported */
  }
  return null;
}
