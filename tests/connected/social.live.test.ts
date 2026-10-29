/**
 * LIVE acceptance test against a real Supabase project (not run in CI by default).
 * Exercises the real client code (src/backend/social.ts, syncRemote.ts) over HTTP,
 * real GoTrue auth, real Storage and the deployed finalize-post Edge Function.
 *
 * Setup: create three confirmed test users in your project (Auth → Users → Add user),
 * put VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local, then:
 *   LC_TEST_A=a@example.com:pass LC_TEST_B=b@example.com:pass LC_TEST_C=c@example.com:pass npm run test:live
 */
import { describe, expect, it, beforeAll } from 'vitest';
import sharp from 'sharp';
import { requireSupabase } from '@/backend/supabase';
import { socialApi } from '@/backend/social';
import { syncRemote } from '@/backend/syncRemote';

const creds = (k: string) => {
  const v = process.env[k];
  if (!v) return null;
  const i = v.indexOf(':');
  return { email: v.slice(0, i), password: v.slice(i + 1) };
};
const A = creds('LC_TEST_A');
const B = creds('LC_TEST_B');
const C = creds('LC_TEST_C');
const enabled = !!(A && B && C && process.env.VITE_SUPABASE_URL);

async function as(user: { email: string; password: string }): Promise<string> {
  const sb = requireSupabase();
  await sb.auth.signOut({ scope: 'local' }).catch(() => {});
  const { data, error } = await sb.auth.signInWithPassword(user);
  if (error) throw error;
  return data.user.id;
}
const suffix = Math.random().toString(36).slice(2, 7);

describe.skipIf(!enabled)('live: two accounts, a stranger and the real backend', () => {
  const ids: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };
  const postId = crypto.randomUUID();
  const mediaId = crypto.randomUUID();
  let requestId = '';

  beforeAll(async () => {
    for (const [k, u] of [['a', A], ['b', B], ['c', C]] as const) {
      ids[k] = await as(u!);
      await socialApi.saveMyProfile({ username: `lc_${k}_${suffix}`, displayName: `Test ${k.toUpperCase()}`, discoverable: true });
    }
  }, 60_000);

  it('A sends a request; a stranger cannot accept it; B accepts', async () => {
    await as(A!);
    await socialApi.sendFriendRequest(ids.b);
    await expect(socialApi.sendFriendRequest(ids.a)).rejects.toThrow(); // self-request
    await as(B!);
    const { incoming } = await socialApi.listFriendRequests();
    requestId = incoming.find((r) => r.requesterId === ids.a)!.id;
    expect(requestId).toBeTruthy();
    await as(C!);
    await expect(socialApi.respondFriendRequest(requestId, true)).rejects.toThrow();
    await as(A!);
    await expect(socialApi.respondFriendRequest(requestId, true)).rejects.toThrow(); // own outgoing request
    await as(B!);
    await socialApi.respondFriendRequest(requestId, true);
    expect((await socialApi.listFriends()).map((f) => f.id)).toContain(ids.a);
  });

  it('A shares a workout post with a processed photo; B sees, likes and comments', async () => {
    await as(A!);
    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#4fbf7f' } }).jpeg().toBuffer();
    const thumb = await sharp(img).resize(240).jpeg().toBuffer();
    await socialApi.createPostDraft({
      id: postId, kind: 'workout', audience: 'friends', caption: 'Live test',
      snapshot: { title: 'Upper body workout', kind: 'workout', date: '2026-10-28', durationSec: 3000 },
      media: [{ id: mediaId, position: 0, width: 800, height: 600, description: 'green square' }],
    });
    await socialApi.createPostDraft({ id: postId, kind: 'workout', audience: 'friends', caption: 'Live test', media: [{ id: mediaId, position: 0, width: 800, height: 600 }] }); // idempotent
    await socialApi.uploadPostMedia(postId, mediaId, new Blob([new Uint8Array(img)], { type: 'image/jpeg' }), new Blob([new Uint8Array(thumb)], { type: 'image/jpeg' }));
    const post = await socialApi.publishPost(postId);
    expect(post.id).toBe(postId);
    await socialApi.publishPost(postId); // idempotent

    await as(B!);
    const feed = await socialApi.getFeed(null, 20);
    const seen = feed.items.find((p) => p.id === postId);
    expect(seen?.media[0]?.url).toBeTruthy();
    expect((await fetch(seen!.media[0].url!)).ok).toBe(true);
    await socialApi.like(postId);
    await socialApi.like(postId); // one like per user
    await socialApi.addComment(postId, crypto.randomUUID(), 'Nice work');
    const again = await socialApi.getPost(postId);
    expect(again?.likeCount).toBe(1);
    expect(again?.commentCount).toBe(1);
  }, 60_000);

  it('a stranger cannot read the post, its comments or its media', async () => {
    await as(C!);
    expect(await socialApi.getPost(postId)).toBeNull();
    expect((await socialApi.getFeed(null, 50)).items.find((p) => p.id === postId)).toBeUndefined();
    const comments = await socialApi.listComments(postId).catch(() => []);
    expect(comments).toHaveLength(0);
    const { error } = await requireSupabase().storage.from('post-media').createSignedUrl(`${ids.a}/${postId}/${mediaId}.jpg`, 60);
    expect(error).toBeTruthy();
  });

  it('private records are owner-only even for friends', async () => {
    await as(A!);
    const recId = crypto.randomUUID();
    const r = await syncRemote.push('measurements', recId, 'upsert', null, { id: recId, kind: 'bodyweight', date: '2026-10-28', value: 81, createdAt: 1, updatedAt: 1 });
    expect(r.status).toBe('ok');
    await as(B!);
    const pulled = await syncRemote.pull(0, 500);
    expect(pulled.changes.find((c) => c.id === recId)).toBeUndefined();
    const { data } = await requireSupabase().from('measurements').select('id').eq('id', recId);
    expect(data ?? []).toHaveLength(0);
  });

  it('changing to Only me, unfriending and blocking revoke access', async () => {
    await as(A!);
    await socialApi.updatePost(postId, { audience: 'only_me' });
    await as(B!);
    expect(await socialApi.getPost(postId)).toBeNull();
    await as(A!);
    await socialApi.updatePost(postId, { audience: 'friends' });
    await as(B!);
    expect(await socialApi.getPost(postId)).not.toBeNull();
    await socialApi.blockUser(ids.a);
    expect(await socialApi.getPost(postId)).toBeNull();
    expect((await socialApi.listFriends()).map((f) => f.id)).not.toContain(ids.a);
    await socialApi.unblockUser(ids.a);
  });

  it('cleans up', async () => {
    await as(A!);
    await socialApi.deletePost(postId);
    await as(B!);
    expect(await socialApi.getPost(postId)).toBeNull();
    await requireSupabase().auth.signOut({ scope: 'local' });
  });
});
