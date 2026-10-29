// delete-account — permanently deletes the caller's account.
//
// POST with the user's access token. Steps:
//  1. verify the JWT (the caller can only ever delete THEMSELVES — the id comes from the token)
//  2. remove the caller's storage objects in the private buckets:
//     {uid}/… in post-media, avatars, coach-public (coach photo) and coach-docs (qualification documents),
//     and {relationship_id}/… in coach-media for every coaching relationship the caller is part of
//     (those conversations are deleted with the account by FK cascade, for both participants).
//  3. auth.admin.deleteUser(uid) → every public table row cascades via FKs to auth.users
//     (account_state, workouts, measurements, food logs, profile, posts, media rows, likes,
//      comments, friendships, blocks, notifications, reports, rate-limit events).
// Retrying after a partial failure is safe: steps 2 and 3 are idempotent.
import { handler, json } from '../_shared/http.ts';
import { adminClient, requireUser } from '../_shared/supabase.ts';
import { removeFolder } from '../_shared/storage.ts';

Deno.serve(handler(async (req) => {
  const user = await requireUser(req);
  const admin = adminClient();

  const removed: Record<string, number> = {};
  for (const bucket of ['post-media', 'avatars', 'coach-public', 'coach-docs']) {
    removed[bucket] = await removeFolder(admin, bucket, user.id);
  }
  // Chat attachments are keyed by relationship, not by user (service role: RLS does not apply).
  const { data: rels, error: relErr } = await admin
    .from('coaching_relationships')
    .select('id')
    .or(`coach_id.eq.${user.id},client_id.eq.${user.id}`);
  if (relErr) throw new Error(`relationships: ${relErr.message}`);
  removed['coach-media'] = 0;
  for (const r of (rels ?? []) as { id: string }[]) {
    removed['coach-media'] += await removeFolder(admin, 'coach-media', r.id);
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error && !/not.?found/i.test(error.message)) throw new Error(`deleteUser: ${error.message}`);

  return json({ deleted: true, removedObjects: removed });
}));
