// push-send — scheduled job (pg_cron + pg_net every 15 s or every minute; see docs/SETUP.md).
// Sends due Web Push notifications from public.push_jobs with VAPID.
//
// NOT callable by users: deployed with verify_jwt = false and authenticated with
//   x-push-secret: <PUSH_CRON_SECRET>
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…), PUSH_CRON_SECRET.
// The logic lives in ../_shared/push/send.ts (tested with a mocked push service); this file only wires env,
// the service-role client and fetch.
import { handler, HttpError, json } from '../_shared/http.ts';
import { adminClient } from '../_shared/supabase.ts';
import { authorizePush, runPushSend, type DueJob, type JobResult } from '../_shared/push/send.ts';
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
      claimDue: (limit) => rpc<DueJob[]>('push_claim_due', { p_limit: limit }),
      finish: async (results: JobResult[]) => void (await rpc('push_finish', { p_results: results })),
      subscriptionResult: async (endpoint, status) => void (await rpc('push_subscription_result', { p_endpoint: endpoint, p_status: status })),
      cleanup: () => rpc<number>('push_cleanup', {}),
    },
    send: (sub, payload, opts) =>
      sendWebPush(sub, payload, vapid, (url, init) => fetch(url, { ...init, body: init.body, signal: AbortSignal.timeout(10_000) }), opts),
    now: () => new Date(),
    // Content-free log: counts only.
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  });
  return json(summary);
}));
