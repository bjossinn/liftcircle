// Supabase clients for Edge Functions. The service/secret key exists ONLY here (server side).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { HttpError } from './http.ts';

/** Accepts legacy env names and the newer publishable/secret key env vars. */
function firstKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') return (parsed.default ?? Object.values(parsed)[0]) as string | undefined;
  } catch {
    return raw;
  }
  return undefined;
}

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export function supabaseUrl(): string {
  return env('SUPABASE_URL');
}

export function publishableKey(): string {
  const k = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? firstKey(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'));
  if (!k) throw new Error('Missing SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEYS');
  return k;
}

/** All server-side keys that identify a trusted (service) caller. */
export function serviceKeys(): string[] {
  const keys = [Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), Deno.env.get('SUPABASE_SECRET_KEY')];
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') keys.push(...(Object.values(parsed) as string[]));
    } catch {
      keys.push(raw);
    }
  }
  return keys.filter((k): k is string => Boolean(k));
}

let admin: SupabaseClient | null = null;
/** Service-role client: bypasses RLS. Always filter by the verified caller id yourself. */
export function adminClient(): SupabaseClient {
  if (!admin) {
    const key = serviceKeys()[0];
    if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS');
    admin = createClient(supabaseUrl(), key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return admin;
}

/**
 * Verifies the caller's access token (Authorization: Bearer <jwt>) and returns the user id.
 * Uses getClaims() (verifies asymmetric JWTs locally via JWKS, or asks the Auth server for
 * legacy symmetric tokens) and falls back to getUser(). Never trusts an unverified token.
 */
export async function requireUser(req: Request): Promise<{ id: string; token: string }> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new HttpError(401, 'You need to be signed in.');
  const client = createClient(supabaseUrl(), publishableKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  // deno-lint-ignore no-explicit-any
  const auth = client.auth as any;
  if (typeof auth.getClaims === 'function') {
    const { data, error } = await auth.getClaims(token);
    const sub = data?.claims?.sub as string | undefined;
    if (error || !sub || data?.claims?.role !== 'authenticated') {
      throw new HttpError(401, 'Your session has expired. Please sign in again.');
    }
    return { id: sub, token };
  }
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  return { id: data.user.id, token };
}
