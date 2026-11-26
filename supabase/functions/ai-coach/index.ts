// ai-coach — the training assistant backend (OpenAI Chat Completions or Anthropic Messages API). See docs/AI_COACH.md.
//
// POST {action:'status'} | {action:'send', id, text, mode, stream?} | {action:'cancel', id} | {action:'request_status', id}
// with the user's access token. All logic lives in the Deno-free modules in ../_shared/ai/ (unit-tested with vitest);
// this file only wires the Deno runtime: env, fetch, the verified user, Supabase clients and the SSE transport.
//  - The user id comes ONLY from the verified JWT (requireUser). Nothing in the body can change it.
//  - Private reads use a client carrying the user's JWT (RLS applies) and also filter by that id.
//  - The service-role client is used only for the service-only RPCs (usage counter, exchange record, request state).
//  - Never logs message content, notes or keys.
//  - Streaming (item 10): {stream:true} with "Accept: text/event-stream". Authentication, consent and the request
//    reservation happen first, so every refusal is a normal JSON response; only a started request becomes a stream. The
//    work runs as a background task, independent of the connection: a client that disconnects detaches, it doesn't cancel.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, handler, json, readJson } from '../_shared/http.ts';
import { adminClient, publishableKey, requireUser, supabaseUrl } from '../_shared/supabase.ts';
import { startAiCoach } from '../_shared/ai/coach.ts';
import { SSE_HEADERS, streamCoachRun } from '../_shared/ai/sse.ts';
import { createSupabaseAiDb, type SbClient } from '../_shared/ai/supabaseDb.ts';
import type { FetchLike } from '../_shared/ai/types.ts';

Deno.serve(handler(async (req) => {
  const user = await requireUser(req);
  const body = await readJson<Record<string, unknown>>(req);
  const userClient = createClient(supabaseUrl(), publishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${user.token}` } },
  });
  const db = createSupabaseAiDb(userClient as unknown as SbClient, adminClient() as unknown as SbClient);
  const log = (event: string, fields: Record<string, string | number | boolean | null>) => console.log(JSON.stringify({ fn: 'ai-coach', event, ...fields }));
  const deps = { db, env: (name: string) => Deno.env.get(name), fetch: fetch as unknown as FetchLike, log };
  const start = await startAiCoach(deps, user.id, body);
  if (start.kind === 'done') return json(start.result.body, start.result.status);
  const wantsStream = body?.stream === true && (req.headers.get('accept') ?? '').includes('text/event-stream');
  if (!wantsStream) {
    const result = await start.run();
    return json(result.body, result.status);
  }
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true; // the client went away: detach (the work continues and settles normally)
    },
  });
  const work = streamCoachRun(start, {
    write(chunk) {
      if (closed || !controller) throw new Error('closed');
      controller.enqueue(encoder.encode(chunk));
    },
    close() {
      if (!closed) {
        closed = true;
        controller?.close();
      }
    },
  }, { log }).catch((e) => log('ai_stream_failed', { message: String((e as Error)?.name ?? 'error') }));
  // Supabase background task: the bounded work outlives the connection (older runtimes: the open stream keeps it alive).
  (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(work);
  return new Response(stream, { status: 200, headers: { ...corsHeaders, ...SSE_HEADERS } });
}));
