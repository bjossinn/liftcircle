/**
 * Product analytics: the ONLY events and properties that may ever be recorded (roadmap item 5).
 *
 * Privacy contract, enforced here and again by the server (public.log_product_events):
 * - A closed list of event names. Anything else is dropped.
 * - Each event has a closed list of property keys, and every value must be one of that key's enum values.
 *   There is no free-text, numeric or nested property anywhere, so weights, reps, RPE/RIR, exercise names, body
 *   measurements, calories, protein, macros, injuries, discomfort, notes, chat text, email or names cannot be
 *   carried even by mistake: unknown keys and non-enum values are stripped at this boundary.
 * - What is stored per event: event name, the enum properties, a random event id and the time it happened. The
 *   server adds the signed-in user's id. Nothing else.
 *
 * Keep this file and the allowlist in supabase/migrations/20261127000001_product_analytics.sql in step
 * (tests/unit/analytics.test.ts checks they match).
 */

export const AI_ACTION_TYPES = ['chat_message', 'checkin_review', 'program_proposal', 'week_plan', 'meal_plan'] as const;
export const AI_OUTCOMES = ['sent', 'proposed', 'applied', 'dismissed', 'reverted'] as const;
export const WORKOUT_START_SOURCES = ['template', 'repeat', 'empty'] as const;
export const ONBOARDING_PATHS = ['suggested', 'manual'] as const;

/** Event name → allowed property keys → allowed values. `required` keys must be present or the event is dropped. */
export const EVENT_SCHEMA = {
  first_set_logged: { props: {}, required: [], once: true },
  first_workout_completed: { props: {}, required: [], once: true },
  second_workout_within_7d: { props: {}, required: [], once: true },
  onboarding_completed: { props: { path: ONBOARDING_PATHS }, required: [], once: true },
  workout_started: { props: { source: WORKOUT_START_SOURCES }, required: [], once: false },
  ai_action_used: { props: { action_type: AI_ACTION_TYPES, outcome: AI_OUTCOMES }, required: ['action_type', 'outcome'], once: false },
} as const satisfies Record<string, { props: Record<string, readonly string[]>; required: readonly string[]; once: boolean }>;

export type EventName = keyof typeof EVENT_SCHEMA;
export const EVENT_NAMES = Object.keys(EVENT_SCHEMA) as EventName[];
/** Events recorded at most once per account (deduplicated on the device and by a unique index on the server). */
export const ONCE_EVENTS = EVENT_NAMES.filter((n) => EVENT_SCHEMA[n].once);

type PropsOf<N extends EventName> = { [K in keyof (typeof EVENT_SCHEMA)[N]['props']]?: (typeof EVENT_SCHEMA)[N]['props'][K] extends readonly (infer V)[] ? V : never };
export type EventProps<N extends EventName = EventName> = PropsOf<N>;
export type AiActionType = (typeof AI_ACTION_TYPES)[number];
export type AiOutcome = (typeof AI_OUTCOMES)[number];
export type WorkoutStartSource = (typeof WORKOUT_START_SOURCES)[number];

export interface CleanEvent {
  name: EventName;
  props: Record<string, string>;
}

export const isEventName = (v: unknown): v is EventName => typeof v === 'string' && Object.prototype.hasOwnProperty.call(EVENT_SCHEMA, v);

/**
 * The boundary check. Returns the event with only allowlisted keys whose values are allowlisted enum strings, or
 * null when the name is unknown or a required property is missing/invalid. Never throws.
 */
export function sanitizeEvent(name: unknown, props?: unknown): CleanEvent | null {
  if (!isEventName(name)) return null;
  const schema = EVENT_SCHEMA[name] as { props: Record<string, readonly string[]>; required: readonly string[] };
  const out: Record<string, string> = {};
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const [k, allowed] of Object.entries(schema.props)) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      const v = (props as Record<string, unknown>)[k];
      if (typeof v === 'string' && allowed.includes(v)) out[k] = v;
    }
  }
  if (schema.required.some((k) => !(k in out))) return null;
  return { name, props: out };
}
