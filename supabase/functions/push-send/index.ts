// push-send — scheduled job (pg_cron + pg_net every 15 s or every minute; see docs/SETUP.md).
// Sends due Web Push notifications from public.push_jobs with VAPID.
//
// NOT callable by users: deployed with verify_jwt = false and authenticated with
//   x-push-secret: <PUSH_CRON_SECRET>
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…), PUSH_CRON_SECRET.
// Coach reminder copy (optional) reuses the training assistant's provider secrets (AI_PROVIDER, OPENAI_API_KEY /
// ANTHROPIC_API_KEY, …); generated wording is used only with PUSH_AI_COPY=on. Its model is independent of the chat
// default: with OpenAI, PUSH_COPY_MODEL (default gpt-5.4-mini), PUSH_COPY_REASONING_EFFORT (default none) and
// PUSH_COPY_REASONING_TOKEN_ALLOWANCE (default 0 for none, else 512). Without PUSH_AI_COPY every reminder uses the approved fallback text.
// The logic lives in ../_shared/push/send.ts (tested with a mocked push service); this file only wires env,
// the service-role client and fetch.
import { handler, HttpError, json } from '../_shared/http.ts';
import { adminClient } from '../_shared/supabase.ts';
import { authorizePush, runPushSend, type CheckResult, type DueJob, type JobResult } from '../_shared/push/send.ts';
import { sendWebPush, type VapidConfig } from '../_shared/push/webpush.ts';

Deno.serve(handler(async (req) => {
  if (!authorizePush(req.headers.get('x-push-secret'), Deno.env.get('PUSH_CRON_SECRET'))) throw new HttpError(401, 'Not authorized.');
  const vapid: VapidConfig = {
    publicKey: Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
    privateKey: Deno.env.get('VAPID_PRIVATE_KEY') ?? '',
    subject: Deno.env.get('VAPID_SUBJECT') ?? '',
  };
  if (!vapid.publicKey || !vapid.privateKey || !vapid.subject) throw new HttpError(503, 'VAPID keys are not configured.');
  const admin = adminClient();
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
  const summary = await runPushSend({
    db: {
      claimDue: (limit) => rpc<DueJob[]>('push_claim_due_v2', { p_limit: limit }),
      finish: async (results: JobResult[]) => void (await rpc('push_finish', { p_results: results })),
      subscriptionResult: async (endpoint, status) => void (await rpc('push_subscription_result', { p_endpoint: endpoint, p_status: status })),
      cleanup: () => rpc<number>('push_cleanup', {}),
      check: (id, token, stage, copy) => rpc<CheckResult>('push_check', { p_id: id, p_token: token, p_stage: stage, p_copy: copy ?? null }),
      generate: () => rpc<number>('push_generate_food', {}),
    },
    copy: { env: (name) => Deno.env.get(name), fetch: (url, init) => fetch(url, init) },
    send: (sub, payload, opts) =>
      sendWebPush(sub, payload, vapid, (url, init) => fetch(url, { ...init, body: init.body, signal: AbortSignal.timeout(10_000) }), opts),
    now: () => new Date(),
    // Content-free log: counts and token usage only (never notification text).
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  });
  return json(summary);
}));
