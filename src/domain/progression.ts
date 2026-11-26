/**
 * Load progression for the app. The rule itself lives in supabase/functions/_shared/training/progression.ts so the
 * app and the ai-coach function run ONE implementation (the Edge Functions are deployed with Deno and can only import
 * from supabase/functions). Import progression from here in app code; never re-derive next loads elsewhere.
 */
export * from '../../supabase/functions/_shared/training/progression';
