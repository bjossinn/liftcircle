// ai-coach — the training assistant backend (OpenAI Chat Completions or Anthropic Messages API). See docs/AI_COACH.md.
//
// POST {action:'status'} | {action:'send', id, text, mode} with the user's access token.
// All logic lives in the Deno-free modules in ../_shared/ai/ (unit-tested with vitest); this file only
// wires the Deno runtime: env, fetch, the verified user, and Supabase clients.
//  - The user id comes ONLY from the verified JWT (requireUser). Nothing in the body can change it.
//  - Private reads use a client carrying the user's JWT (RLS applies) and also filter by that id.
//  - The service-role client is used only for the service-only RPCs (usage counter, exchange record).
//  - Never logs message content, notes or keys.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handler, json, readJson } from '../_shared/http.ts';
import { adminClient, publishableKey, requireUser, supabaseUrl } from '../_shared/supabase.ts';
import { handleAiCoach } from '../_shared/ai/coach.ts';
import { createSupabaseAiDb, type SbClient } from '../_shared/ai/supabaseDb.ts';
import type { FetchLike } from '../_shared/ai/types.ts';

Deno.serve(handler(async (req) => {
  const user = await requireUser(req);
  const body = await readJson<unknown>(req);
  const userClient = createClient(supabaseUrl(), publishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${user.token}` } },
  });
  const db = createSupabaseAiDb(userClient as unknown as SbClient, adminClient() as unknown as SbClient);
  const result = await handleAiCoach(
    {
      db,
      env: (name) => Deno.env.get(name),
      fetch: fetch as unknown as FetchLike,
      log: (event, fields) => console.log(JSON.stringify({ fn: 'ai-coach', event, ...fields })),
    },
    user.id,
    body,
  );
  return json(result.body, result.status);
}));
