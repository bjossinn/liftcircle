/**
 * Product feature flags. Each flag hides a whole area from navigation without touching its data, tables or API code;
 * flipping a flag back on brings the area back as it was.
 *
 * Defaults live in DEFAULT_FLAGS. To switch an area on without a code change, set its Vite env var at build time
 * (Netlify → Site configuration → Environment variables, or `.env.local`), then rebuild:
 *   VITE_ENABLE_COACH_MARKETPLACE=true   browse/find coaches, coach profiles, new coaching requests
 *   VITE_ENABLE_SOCIAL_FEED=true         the Feed tab (a fifth tab after Today, Train, Coach, Progress) and the /feed list
 * Set the same names without the VITE_ prefix on the ai-coach Edge Function too, so the training assistant's app guide
 * mentions (and links to) those areas only when they're on (supabase/functions/_shared/ai/appGuide.ts).
 * Accepted values: true/false, 1/0, yes/no, on/off (any case). Anything else keeps the default.
 *
 * What stays on regardless of the flags:
 * - coachMarketplace off: existing coaching relationships (My coach, messages, check-ins, proposals), the coach
 *   workspace for approved coaches, coach applications, admin review and the training assistant.
 * - socialFeed off: sharing a workout (share card → post), post pages (links from notifications and push), profile,
 *   friends, notifications, auto-share. Nothing is deleted.
 */
export interface FeatureFlags {
  /** Browsing / finding human coaches and sending new coaching requests. */
  coachMarketplace: boolean;
  /** The social feed tab and its list of friends' posts. */
  socialFeed: boolean;
}
export type FeatureFlag = keyof FeatureFlags;

export const DEFAULT_FLAGS: Readonly<FeatureFlags> = Object.freeze({ coachMarketplace: false, socialFeed: false });

/** The Vite env var that overrides each flag. */
export const FLAG_ENV_VARS: Readonly<Record<FeatureFlag, string>> = Object.freeze({
  coachMarketplace: 'VITE_ENABLE_COACH_MARKETPLACE',
  socialFeed: 'VITE_ENABLE_SOCIAL_FEED',
});

/** Parses an env value; returns `fallback` for missing or unrecognised values. */
export function parseFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

type Env = Record<string, unknown>;

/** Resolves every flag from an env object (defaults to Vite's import.meta.env). */
export function readFeatureFlags(env: Env = import.meta.env as Env): FeatureFlags {
  const out = { ...DEFAULT_FLAGS };
  for (const k of Object.keys(DEFAULT_FLAGS) as FeatureFlag[]) out[k] = parseFlag(env[FLAG_ENV_VARS[k]], DEFAULT_FLAGS[k]);
  return out;
}

/**
 * Whether a feature is on. Read at call time (not cached at import) so tests can use vi.stubEnv; in a production
 * build the env values are compile-time constants, so this is just a lookup.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return readFeatureFlags()[flag];
}
