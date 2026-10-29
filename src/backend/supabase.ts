import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when publishable Supabase config is present → Connected mode is available. */
export const backendConfigured = Boolean(url && anonKey && !url.includes('YOUR-PROJECT-REF'));

let client: SupabaseClient | null = null;

/** Returns null in Personal mode (no backend configured). */
export function supabase(): SupabaseClient | null {
  if (!backendConfigured) return null;
  if (!client) {
    client = createClient(url!, anonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'lc-auth' },
    });
  }
  return client;
}

export function requireSupabase(): SupabaseClient {
  const c = supabase();
  if (!c) throw new Error('Connected mode is not configured. See docs/SETUP.md.');
  return c;
}

export const publicAppUrl = (import.meta.env.VITE_PUBLIC_APP_URL as string | undefined) || (typeof location !== 'undefined' ? location.origin : '');
