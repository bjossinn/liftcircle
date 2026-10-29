/**
 * Supabase implementation of SocialApi (see contract.ts). Online-only.
 *
 * All writes go through security-definer RPCs (supabase/migrations/*_social_rpcs.sql) that take the
 * author/owner from the access token. Media and avatars live in PRIVATE buckets; this module signs
 * short-lived URLs (SIGNED_URL_TTL) for whatever the caller is currently allowed to see.
 */
import type {
  AppNotification, Audience, Comment, FriendRequest, FriendStatus, ID, Post, PostMedia, SocialProfile, WorkoutSnapshot,
} from '@/domain/types';
import type { FeedCursor, ModerationReport, NewPostInput, Page, ReportInput, SocialApi } from './contract';
import { requireSupabase } from './supabase';
import { BackendError, toBackendError } from './syncRemote';
import { uuid } from '@/lib/id';

/** Signed URL lifetime. Short on purpose: revoked access stops working within this window. */
export const SIGNED_URL_TTL = 300;
const MEDIA_BUCKET = 'post-media';
const AVATAR_BUCKET = 'avatars';

/* ------------------------------------------------------------------ helpers */

async function call<T>(fn: string, args?: Record<string, unknown>, fallback?: string): Promise<T> {
  let res: { data: unknown; error: unknown };
  try {
    res = await requireSupabase().rpc(fn, args);
  } catch (e) {
    throw toBackendError(e, fallback);
  }
  if (res.error) throw toBackendError(res.error, fallback);
  return res.data as T;
}

async function session() {
  const { data } = await requireSupabase().auth.getSession();
  const s = data.session;
  if (!s) throw new BackendError('You need to be signed in.', 'auth', 401);
  return s;
}

/** In-memory signed URL cache: path → url valid until `exp` (ms). */
const signedCache = new Map<string, { url: string; exp: number }>();

/** Signs many paths in one request per bucket. Paths the caller may not read come back undefined. */
async function signPaths(bucket: string, paths: (string | null | undefined)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(paths.filter((x): x is string => Boolean(x)))];
  if (!wanted.length) return out;
  // Cache entries are scoped to the signed-in account so an account switch never reuses URLs.
  const uid = (await requireSupabase().auth.getSession()).data.session?.user.id ?? 'anon';
  const now = Date.now();
  const todo: string[] = [];
  for (const p of wanted) {
    const hit = signedCache.get(`${uid}:${bucket}/${p}`);
    if (hit && hit.exp - now > 60_000) out.set(p, hit.url);
    else todo.push(p);
  }
  if (!todo.length) return out;
  try {
    const { data, error } = await requireSupabase().storage.from(bucket).createSignedUrls(todo, SIGNED_URL_TTL);
    if (error || !data) return out; // images are optional: render placeholders instead of failing the page
    for (const row of data) {
      const url = row.signedUrl ?? row.signedURL;
      if (row.path && url && !row.error) {
        out.set(row.path, url);
        signedCache.set(`${uid}:${bucket}/${row.path}`, { url, exp: now + SIGNED_URL_TTL * 1000 });
      }
    }
  } catch {
    /* network hiccup: no images this time */
  }
  return out;
}

/** Forget cached signed URLs (call on sign-out / account switch). */
export function clearSignedUrlCache() {
  signedCache.clear();
}

/* ------------------------------------------------------------- row types */

interface RawAuthor {
  id: ID;
  username: string;
  display_name: string;
  avatar_path: string | null;
}
interface RawProfile extends RawAuthor {
  bio: string | null;
  interests: string[] | null;
  discoverable: boolean;
}
interface RawMedia {
  id: ID;
  position: number;
  description: string | null;
  width: number;
  height: number;
  status: 'pending' | 'ready';
  image_path: string;
  thumb_path: string;
}
interface RawPost {
  id: ID;
  author_id: ID;
  author: RawAuthor | null;
  kind: Post['kind'];
  audience: Audience;
  caption: string;
  snapshot: WorkoutSnapshot | null;
  status: 'draft' | 'published';
  created_at: string;
  edited_at: string | null;
  media: RawMedia[];
  like_count: number;
  comment_count: number;
  liked_by_me: boolean;
}
interface RawComment {
  id: ID;
  post_id: ID;
  author_id: ID;
  author: RawAuthor | null;
  body: string;
  created_at: string;
}
interface RawRequest {
  id: ID;
  requester_id: ID;
  addressee_id: ID;
  status: 'pending' | 'accepted';
  created_at: string;
  other: RawAuthor | null;
}
interface RawLookup {
  profile: RawProfile;
  relation: FriendStatus;
  request_id?: ID | null;
}
interface RawNotification {
  id: ID;
  type: AppNotification['type'];
  actor: RawAuthor | null;
  post_id: ID | null;
  comment_id: ID | null;
  relationship_id?: ID | null;
  coach_id?: ID | null;
  proposal_id?: ID | null;
  created_at: string;
  read_at: string | null;
}
interface RawPage {
  items: RawPost[];
  next: { created_at: string; id: ID } | null;
}
interface RawReport {
  id: ID;
  reporter_id: ID;
  target_kind: 'post' | 'comment' | 'user';
  post_id: ID | null;
  comment_id: ID | null;
  user_id: ID | null;
  reason: string;
  details: string | null;
  status: ModerationReport['status'];
  created_at: string;
  content: { caption?: string; body?: string; author_id?: ID; username?: string; bio?: string | null } | null;
}

/* --------------------------------------------------------------- mappers */

type Avatars = Map<string, string>;

const mapAuthor = (a: RawAuthor | null | undefined, avatars: Avatars) =>
  a ? { id: a.id, username: a.username, displayName: a.display_name, avatarUrl: a.avatar_path ? avatars.get(a.avatar_path) ?? null : null } : undefined;

function mapProfile(p: RawProfile, avatars: Avatars): SocialProfile {
  return {
    id: p.id,
    username: p.username,
    displayName: p.display_name,
    avatarPath: p.avatar_path,
    avatarUrl: p.avatar_path ? avatars.get(p.avatar_path) ?? null : null,
    bio: p.bio ?? null,
    interests: p.interests ?? [],
    discoverable: Boolean(p.discoverable),
  };
}

async function profilesWithAvatars(list: RawProfile[]): Promise<SocialProfile[]> {
  const avatars = await signPaths(AVATAR_BUCKET, list.map((p) => p.avatar_path));
  return list.map((p) => mapProfile(p, avatars));
}

async function mapPosts(list: RawPost[]): Promise<Post[]> {
  const mediaPaths = list.flatMap((p) => (p.media ?? []).flatMap((m) => [m.image_path, m.thumb_path]));
  const [media, avatars] = await Promise.all([
    signPaths(MEDIA_BUCKET, mediaPaths),
    signPaths(AVATAR_BUCKET, list.map((p) => p.author?.avatar_path)),
  ]);
  return list.map((p) => ({
    id: p.id,
    authorId: p.author_id,
    author: mapAuthor(p.author, avatars),
    kind: p.kind,
    audience: p.audience,
    caption: p.caption ?? '',
    snapshot: p.snapshot ?? null,
    media: (p.media ?? []).map(
      (m): PostMedia => ({
        id: m.id,
        position: m.position,
        description: m.description,
        width: m.width,
        height: m.height,
        url: media.get(m.image_path),
        thumbUrl: media.get(m.thumb_path),
      }),
    ),
    likeCount: Number(p.like_count ?? 0),
    commentCount: Number(p.comment_count ?? 0),
    likedByMe: Boolean(p.liked_by_me),
    createdAt: p.created_at,
    editedAt: p.edited_at,
  }));
}

async function mapPage(raw: RawPage): Promise<Page<Post>> {
  return {
    items: await mapPosts(raw.items ?? []),
    // created_at is passed back verbatim (microsecond precision) so keyset paging never skips/repeats.
    next: raw.next ? { createdAt: raw.next.created_at, id: raw.next.id } : null,
  };
}

async function mapComments(list: RawComment[]): Promise<Comment[]> {
  const avatars = await signPaths(AVATAR_BUCKET, list.map((c) => c.author?.avatar_path));
  return list.map((c) => ({
    id: c.id,
    postId: c.post_id,
    authorId: c.author_id,
    author: mapAuthor(c.author, avatars),
    body: c.body,
    createdAt: c.created_at,
  }));
}

async function mapLookup(raw: RawLookup | null) {
  if (!raw?.profile) return null;
  const [profile] = await profilesWithAvatars([raw.profile]);
  return { profile, relation: raw.relation, requestId: raw.request_id ?? undefined };
}

/** Readable message from a failed functions.invoke (FunctionsHttpError carries the Response). */
async function functionError(error: unknown, fallback: string): Promise<BackendError> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string; details?: unknown };
      return new BackendError(body.error || fallback, ctx.status === 401 ? 'auth' : `http_${ctx.status}`, ctx.status, body.details);
    } catch {
      return new BackendError(fallback, `http_${ctx.status}`, ctx.status);
    }
  }
  const e = toBackendError(error, fallback);
  return /FunctionsFetchError|Failed to send a request/i.test(String((error as Error)?.message ?? (error as Error)?.name))
    ? new BackendError('You appear to be offline. Check your connection and try again.', 'network')
    : e;
}

/* --------------------------------------------------------------- uploads */

const env = import.meta.env as Record<string, string | undefined>;

function uploadErrorMessage(status: number, body: string): string {
  let msg = '';
  try {
    const j = JSON.parse(body) as { message?: string; error?: string; statusCode?: string };
    msg = j.message || j.error || '';
  } catch {
    /* not json */
  }
  if (status === 413 || /too large|exceeded the maximum/i.test(msg)) return 'This photo is too large to upload.';
  if (status === 415 || /mime|content type/i.test(msg)) return 'This image format isn’t supported. Use JPEG or WebP.';
  if (status === 401 || /jwt|token/i.test(msg)) return 'Your session has expired. Please sign in again.';
  if (status === 403 || /row-level security|unauthorized|policy/i.test(msg)) {
    return 'This photo can’t be uploaded: the post was already published or deleted.';
  }
  return msg || `Upload failed (${status}). Please try again.`;
}

/** Upload one object with real progress via XHR to the Storage REST API (upsert = idempotent retry). */
function xhrUpload(path: string, blob: Blob, token: string, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<void> {
  const base = (env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const url = `${base}/storage/v1/object/${MEDIA_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Upload cancelled.', 'AbortError'));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (env.VITE_SUPABASE_ANON_KEY) xhr.setRequestHeader('apikey', env.VITE_SUPABASE_ANON_KEY);
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.setRequestHeader('cache-control', 'max-age=3600');
    xhr.setRequestHeader('Content-Type', blob.type || 'image/jpeg');
    xhr.upload.onprogress = (ev) => onProgress(ev.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(blob.size);
        resolve();
      } else reject(new BackendError(uploadErrorMessage(xhr.status, xhr.responseText), `http_${xhr.status}`, xhr.status));
    };
    xhr.onerror = () => reject(new BackendError('Upload failed. Check your connection and try again.', 'network'));
    xhr.ontimeout = () => reject(new BackendError('Upload timed out. Please try again.', 'network'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'));
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener('abort', onAbort);
    xhr.send(blob);
  });
}

/** Fallback without XHR (tests / non-browser): supabase-js upload with coarse progress. */
async function fetchUpload(path: string, blob: Blob, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Upload cancelled.', 'AbortError');
  const { error } = await requireSupabase().storage.from(MEDIA_BUCKET).upload(path, blob, {
    upsert: true,
    contentType: blob.type || 'image/jpeg',
    cacheControl: '3600',
  });
  if (signal?.aborted) throw new DOMException('Upload cancelled.', 'AbortError');
  if (error) {
    const status = Number((error as { statusCode?: string | number }).statusCode ?? 0);
    throw new BackendError(uploadErrorMessage(status, JSON.stringify({ message: error.message })), 'upload', status || undefined);
  }
}

/* ===================================================================== api */

export const socialApi: SocialApi = {
  /* ---------------------------------------------------------- profiles */
  async getMyProfile() {
    const raw = await call<RawProfile | null>('get_my_profile');
    return raw ? (await profilesWithAvatars([raw]))[0] : null;
  },

  async saveMyProfile(p) {
    const raw = await call<RawProfile>('save_my_profile', {
      p_username: p.username.trim().toLowerCase(),
      p_display_name: p.displayName,
      p_bio: p.bio ?? null,
      p_interests: p.interests ?? [],
      p_discoverable: p.discoverable,
    }, 'Could not save your profile.');
    return (await profilesWithAvatars([raw]))[0];
  },

  isUsernameAvailable(username) {
    return call<boolean>('is_username_available', { p_username: username.trim().toLowerCase() });
  },

  async uploadAvatar(blob) {
    const s = await session();
    const before = await call<RawProfile | null>('get_my_profile');
    if (!before) throw new BackendError('Set up your profile first.', 'P0001', 400);
    const path = `${s.user.id}/avatar_${uuid()}.jpg`;
    const sb = requireSupabase();
    const { error } = await sb.storage.from(AVATAR_BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false, cacheControl: '3600' });
    if (error) {
      const status = Number((error as { statusCode?: string | number }).statusCode ?? 0);
      throw new BackendError(uploadErrorMessage(status, JSON.stringify({ message: error.message })), 'upload', status || undefined);
    }
    const raw = await call<RawProfile>('set_avatar_path', { p_path: path }, 'Could not update your photo.');
    if (before.avatar_path && before.avatar_path !== path) {
      void sb.storage.from(AVATAR_BUCKET).remove([before.avatar_path]).catch(() => undefined); // best effort
    }
    return (await profilesWithAvatars([raw]))[0];
  },

  async getProfileByUsername(username) {
    return mapLookup(await call<RawLookup | null>('get_profile_by_username', { p_username: username.trim().toLowerCase() }));
  },

  async getProfileById(id) {
    return mapLookup(await call<RawLookup | null>('get_profile_by_id', { p_user_id: id }));
  },

  /* ----------------------------------------------------------- friends */
  async sendFriendRequest(userId) {
    await call('send_friend_request', { p_target: userId }, 'Could not send the friend request.');
  },
  async respondFriendRequest(requestId, accept) {
    await call('respond_friend_request', { p_request_id: requestId, p_accept: accept }, 'Could not respond to the request.');
  },
  async cancelFriendRequest(requestId) {
    await call('cancel_friend_request', { p_request_id: requestId }, 'Could not cancel the request.');
  },
  async removeFriend(userId) {
    await call('remove_friend', { p_other: userId }, 'Could not remove this friend.');
  },
  async blockUser(userId) {
    await call('block_user', { p_other: userId }, 'Could not block this person.');
  },
  async unblockUser(userId) {
    await call('unblock_user', { p_other: userId }, 'Could not unblock this person.');
  },
  async listFriends() {
    return profilesWithAvatars(await call<RawProfile[]>('list_friends'));
  },
  async listFriendRequests() {
    const raw = await call<{ incoming: RawRequest[]; outgoing: RawRequest[] }>('list_friend_requests');
    const all = [...(raw.incoming ?? []), ...(raw.outgoing ?? [])];
    const avatars = await signPaths(AVATAR_BUCKET, all.map((r) => r.other?.avatar_path));
    const map = (r: RawRequest): FriendRequest => ({
      id: r.id,
      requesterId: r.requester_id,
      addresseeId: r.addressee_id,
      other: mapAuthor(r.other, avatars) ?? { id: '', username: 'unknown', displayName: 'Unknown', avatarUrl: null },
      status: r.status,
      createdAt: r.created_at,
    });
    return { incoming: (raw.incoming ?? []).map(map), outgoing: (raw.outgoing ?? []).map(map) };
  },
  async listBlocked() {
    return profilesWithAvatars(await call<RawProfile[]>('list_blocked'));
  },

  /* ------------------------------------------------------------- posts */
  async getFeed(cursor?: FeedCursor | null, limit = 20) {
    return mapPage(await call<RawPage>('get_feed', {
      p_cursor_created_at: cursor?.createdAt ?? null,
      p_cursor_id: cursor?.id ?? null,
      p_limit: limit,
    }, 'Could not load the feed.'));
  },

  async getUserPosts(userId, cursor, limit = 20) {
    return mapPage(await call<RawPage>('get_user_posts', {
      p_user_id: userId,
      p_cursor_created_at: cursor?.createdAt ?? null,
      p_cursor_id: cursor?.id ?? null,
      p_limit: limit,
    }, 'Could not load posts.'));
  },

  async getPost(id) {
    const raw = await call<RawPost | null>('get_post', { p_post_id: id });
    return raw ? (await mapPosts([raw]))[0] : null;
  },

  async createPostDraft(input: NewPostInput) {
    await call('create_post_draft', {
      p_id: input.id,
      p_kind: input.kind,
      p_audience: input.audience,
      p_caption: input.caption ?? '',
      p_snapshot: input.snapshot ?? null,
      p_media: input.media.map((m) => ({
        id: m.id,
        position: m.position,
        width: Math.round(m.width),
        height: Math.round(m.height),
        description: m.description ?? null,
      })),
    }, 'Could not prepare the post.');
  },

  async uploadPostMedia(postId, mediaId, image, thumb, opts) {
    const s = await session();
    const prefix = `${s.user.id}/${postId}/${mediaId}`;
    const total = Math.max(image.size + thumb.size, 1);
    const report = (done: number) => opts?.onProgress?.(Math.min(1, Math.max(0, done / total)));
    report(0);
    if (typeof XMLHttpRequest !== 'undefined') {
      await xhrUpload(`${prefix}_thumb.jpg`, thumb, s.access_token, (n) => report(n), opts?.signal);
      await xhrUpload(`${prefix}.jpg`, image, s.access_token, (n) => report(thumb.size + n), opts?.signal);
    } else {
      await fetchUpload(`${prefix}_thumb.jpg`, thumb, opts?.signal);
      report(thumb.size);
      await fetchUpload(`${prefix}.jpg`, image, opts?.signal);
    }
    report(total);
  },

  async publishPost(postId) {
    const { error } = await requireSupabase().functions.invoke('finalize-post', { body: { postId } });
    if (error) throw await functionError(error, 'Could not publish the post. Please try again.');
    const post = await socialApi.getPost(postId);
    if (!post) throw new BackendError('The post was published but could not be loaded.');
    return post;
  },

  async updatePost(postId, patch) {
    await call('update_post', { p_post_id: postId, p_caption: patch.caption ?? null, p_audience: patch.audience ?? null }, 'Could not update the post.');
  },

  async deletePost(postId) {
    await call('delete_post', { p_post_id: postId }, 'Could not delete the post.');
  },

  async like(postId) {
    await call('like_post', { p_post_id: postId }, 'Could not like the post.');
  },
  async unlike(postId) {
    await call('unlike_post', { p_post_id: postId }, 'Could not remove your like.');
  },

  async listComments(postId) {
    return mapComments(await call<RawComment[]>('list_comments', { p_post_id: postId }, 'Could not load comments.'));
  },

  async addComment(postId, id, body) {
    const raw = await call<RawComment>('add_comment', { p_post_id: postId, p_id: id, p_body: body }, 'Could not post the comment.');
    return (await mapComments([raw]))[0];
  },

  async deleteComment(commentId) {
    await call('delete_comment', { p_comment_id: commentId }, 'Could not delete the comment.');
  },

  async report(input: ReportInput) {
    await call('report_content', {
      p_reason: input.reason,
      p_post_id: input.postId ?? null,
      p_comment_id: input.commentId ?? null,
      p_user_id: input.userId ?? null,
      p_details: input.details ?? null,
    }, 'Could not send the report.');
  },

  /* ------------------------------------------------------ notifications */
  async listNotifications(limit = 50) {
    const raw = await call<RawNotification[]>('list_notifications', { p_limit: limit });
    const avatars = await signPaths(AVATAR_BUCKET, raw.map((n) => n.actor?.avatar_path));
    return raw.map((n) => ({
      id: n.id,
      type: n.type,
      actor: mapAuthor(n.actor, avatars),
      postId: n.post_id,
      commentId: n.comment_id,
      relationshipId: n.relationship_id ?? null,
      coachId: n.coach_id ?? null,
      proposalId: n.proposal_id ?? null,
      createdAt: n.created_at,
      readAt: n.read_at,
    }));
  },
  async unreadNotificationCount() {
    return Number(await call<number>('unread_notification_count'));
  },
  async markNotificationsRead(ids) {
    await call('mark_notifications_read', { p_ids: ids && ids.length ? ids : null });
  },

  /* --------------------------------------------------------- moderation */
  async amModerator() {
    try {
      return Boolean(await call<boolean>('am_moderator'));
    } catch {
      return false;
    }
  },
  async listReports(status = 'open') {
    const raw = await call<RawReport[]>('list_reports', { p_status: status }, 'Could not load reports.');
    return raw.map((r) => ({
      id: r.id,
      reporterId: r.reporter_id,
      postId: r.post_id,
      commentId: r.comment_id,
      userId: r.user_id,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.created_at,
      content: r.content
        ? { caption: r.content.caption, body: r.content.body ?? (r.target_kind === 'user' ? r.content.bio ?? undefined : undefined), authorId: r.content.author_id }
        : undefined,
    }));
  },
  async resolveReport(reportId, action) {
    await call('resolve_report', { p_report_id: reportId, p_action: action }, 'Could not resolve the report.');
  },

  /* ------------------------------------------------------------ account */
  async deleteAccount() {
    const { error } = await requireSupabase().functions.invoke('delete-account', { body: {} });
    if (error) throw await functionError(error, 'Could not delete your account. Please try again.');
    clearSignedUrlCache();
    // The user no longer exists; drop the local session (the app's SIGNED_OUT handler clears caches).
    await requireSupabase().auth.signOut({ scope: 'local' }).catch(() => undefined);
  },
};
