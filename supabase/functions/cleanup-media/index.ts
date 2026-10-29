// cleanup-media — scheduled job. Removes storage objects of
//   * deleted posts (by author or moderator) that still have objects, and
//   * abandoned drafts older than 24 h (then deletes the draft row),
// using the service-role-only RPCs cleanup_media_candidates / cleanup_media_done.
//
// NOT callable by users: deploy with verify_jwt = false and call it with either
//   x-cleanup-secret: <CLEANUP_SECRET>      (recommended for pg_cron; set via `supabase secrets set`)
// or the project's service-role / secret key in `apikey` or `Authorization: Bearer`.
// Scheduling (Supabase Cron + pg_net + Vault) is documented in docs/BACKEND.md.
import { handler, HttpError, json } from '../_shared/http.ts';
import { adminClient, serviceKeys } from '../_shared/supabase.ts';
import { removeFolder } from '../_shared/storage.ts';

const BUCKET = 'post-media';
const BUDGET_MS = 50_000;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function authorize(req: Request) {
  const secret = Deno.env.get('CLEANUP_SECRET');
  const given = req.headers.get('x-cleanup-secret');
  if (secret && given && timingSafeEqual(secret, given)) return;
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const apikey = req.headers.get('apikey') ?? '';
  for (const k of serviceKeys()) {
    if ((bearer && timingSafeEqual(k, bearer)) || (apikey && timingSafeEqual(k, apikey))) return;
  }
  throw new HttpError(401, 'Not authorized.');
}

interface Candidate {
  post_id: string;
  author_id: string;
}

Deno.serve(handler(async (req) => {
  authorize(req);
  const admin = adminClient();
  const started = Date.now();
  const summary = { deletedPosts: 0, abandonedDrafts: 0, objectsRemoved: 0, errors: [] as string[] };

  while (Date.now() - started < BUDGET_MS) {
    const { data, error } = await admin.rpc('cleanup_media_candidates', { p_limit: 50 });
    if (error) throw new Error(error.message);
    const deleted = (data?.deleted ?? []) as Candidate[];
    const abandoned = (data?.abandoned ?? []) as Candidate[];
    if (!deleted.length && !abandoned.length) break;

    const doneDeleted: string[] = [];
    const doneAbandoned: string[] = [];
    for (const [list, done] of [[deleted, doneDeleted], [abandoned, doneAbandoned]] as const) {
      for (const c of list) {
        try {
          summary.objectsRemoved += await removeFolder(admin, BUCKET, `${c.author_id}/${c.post_id}`);
          done.push(c.post_id);
        } catch (e) {
          summary.errors.push(`${c.post_id}: ${(e as Error).message}`);
        }
      }
    }
    const { error: doneErr } = await admin.rpc('cleanup_media_done', { p_deleted: doneDeleted, p_abandoned: doneAbandoned });
    if (doneErr) throw new Error(doneErr.message);
    summary.deletedPosts += doneDeleted.length;
    summary.abandonedDrafts += doneAbandoned.length;
    if (!doneDeleted.length && !doneAbandoned.length) break; // only failures left: stop, retry next run
  }
  return json(summary);
}));
