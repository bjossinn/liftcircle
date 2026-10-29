/**
 * Backend contract shared by the client and the Supabase implementation.
 * Implementations: src/backend/social.ts (SocialApi) and src/backend/syncRemote.ts (SyncRemote).
 * Server side: supabase/migrations/*.sql RPCs + supabase/functions/*.
 */
import type {
  AppNotification, Audience, Comment, FriendRequest, FriendStatus, ID, Post, PostKind, SocialProfile, WorkoutSnapshot,
} from '@/domain/types';
import type { SyncedEntity } from '@/db/db';

/* ================================================================ SYNC */
/**
 * RPC `sync_push(p_entity text, p_id uuid, p_op text, p_base_version bigint, p_payload jsonb) returns jsonb`
 * Atomic compare-and-swap on the server-issued version:
 *  - base_version null + row absent        → insert, ok
 *  - base_version null + row present       → conflict (returns server copy) — e.g. guest import of an existing id
 *  - base_version = row.version            → update/tombstone, ok (version := nextval)
 *  - base_version ≠ row.version            → conflict (returns server copy, never overwrites)
 *  - row is tombstoned and op = 'upsert'   → 'gone' (deletions win; stale devices can't resurrect)
 * Idempotent: retrying an op that already applied returns conflict with an identical payload,
 * which the client treats as success (payload equality check).
 */
export type PushResult =
  | { status: 'ok'; version: number }
  | { status: 'conflict'; version: number; payload: unknown; deleted: boolean }
  | { status: 'gone'; version: number };

/** RPC `sync_pull(p_since bigint, p_limit int) returns jsonb` → changes with version > since, ascending. */
export interface PullChange {
  entity: SyncedEntity;
  id: ID;
  version: number;
  deleted: boolean;
  payload: unknown | null;
}
export interface PullResult {
  changes: PullChange[];
  cursor: number; // highest version included
  hasMore: boolean;
}

export interface SyncRemote {
  push(entity: SyncedEntity, id: ID, op: 'upsert' | 'delete', baseVersion: number | null, payload: unknown): Promise<PushResult>;
  pull(since: number, limit?: number): Promise<PullResult>;
}

/* ============================================================== SOCIAL */
export interface FeedCursor {
  createdAt: string;
  id: ID;
}
export interface Page<T> {
  items: T[];
  next?: FeedCursor | null;
}

export interface NewPostInput {
  /** Client-generated id → creating twice is a no-op (idempotent). */
  id: ID;
  kind: PostKind;
  audience: Audience;
  caption: string;
  snapshot?: WorkoutSnapshot | null;
  media: { id: ID; position: number; description?: string; width: number; height: number }[];
}

export interface ReportInput {
  postId?: ID;
  commentId?: ID;
  userId?: ID;
  reason: 'spam' | 'harassment' | 'inappropriate' | 'other';
  details?: string;
}

export interface ModerationReport {
  id: ID;
  reporterId: ID;
  postId?: ID | null;
  commentId?: ID | null;
  userId?: ID | null;
  reason: string;
  details?: string | null;
  status: 'open' | 'actioned' | 'dismissed';
  createdAt: string;
  /** Snapshot of reported content for moderators. */
  content?: { caption?: string; body?: string; authorId?: ID };
}

export interface SocialApi {
  /* profiles */
  getMyProfile(): Promise<SocialProfile | null>;
  saveMyProfile(p: { username: string; displayName: string; bio?: string; interests?: string[]; discoverable: boolean }): Promise<SocialProfile>;
  isUsernameAvailable(username: string): Promise<boolean>;
  uploadAvatar(blob: Blob): Promise<SocialProfile>;
  /** Exact username lookup. Returns null if not found, not discoverable, or blocked either way. */
  getProfileByUsername(username: string): Promise<{ profile: SocialProfile; relation: FriendStatus; requestId?: ID } | null>;
  getProfileById(id: ID): Promise<{ profile: SocialProfile; relation: FriendStatus; requestId?: ID } | null>;

  /* friends (mutual model) */
  sendFriendRequest(userId: ID): Promise<void>;
  respondFriendRequest(requestId: ID, accept: boolean): Promise<void>;
  cancelFriendRequest(requestId: ID): Promise<void>;
  removeFriend(userId: ID): Promise<void>;
  blockUser(userId: ID): Promise<void>;
  unblockUser(userId: ID): Promise<void>;
  listFriends(): Promise<SocialProfile[]>;
  listFriendRequests(): Promise<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }>;
  listBlocked(): Promise<SocialProfile[]>;

  /* posts & feed (online-only) */
  getFeed(cursor?: FeedCursor | null, limit?: number): Promise<Page<Post>>;
  getUserPosts(userId: ID, cursor?: FeedCursor | null, limit?: number): Promise<Page<Post>>;
  getPost(id: ID): Promise<Post | null>;
  /** Creates an unpublished draft (status 'pending'); idempotent on id. */
  createPostDraft(input: NewPostInput): Promise<void>;
  /** Uploads one processed (EXIF-free, resized) image + thumbnail to private storage. Idempotent (upsert). */
  uploadPostMedia(postId: ID, mediaId: ID, image: Blob, thumb: Blob, opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }): Promise<void>;
  /** Server verifies all media are present & valid, then publishes. Idempotent. */
  publishPost(postId: ID): Promise<Post>;
  updatePost(postId: ID, patch: { caption?: string; audience?: Audience }): Promise<void>;
  deletePost(postId: ID): Promise<void>;
  like(postId: ID): Promise<void>;
  unlike(postId: ID): Promise<void>;
  listComments(postId: ID): Promise<Comment[]>;
  addComment(postId: ID, id: ID, body: string): Promise<Comment>;
  deleteComment(commentId: ID): Promise<void>;
  report(input: ReportInput): Promise<void>;

  /* notifications */
  listNotifications(limit?: number): Promise<AppNotification[]>;
  unreadNotificationCount(): Promise<number>;
  markNotificationsRead(ids?: ID[]): Promise<void>;

  /* moderation (server-authorized role) */
  amModerator(): Promise<boolean>;
  listReports(status?: 'open' | 'actioned' | 'dismissed'): Promise<ModerationReport[]>;
  resolveReport(reportId: ID, action: 'dismiss' | 'remove_content'): Promise<void>;

  /* account */
  deleteAccount(): Promise<void>;
}
