import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Ban, ChevronLeft, ChevronRight, CloudUpload, Flag, Heart, ImageOff, Lock, MessageCircle, MoreHorizontal, Pencil, RefreshCw, Trash2, Users, X, AlertTriangle } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, IconButton, ProgressBar, Segmented, Sheet, Textarea, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { socialApi } from '@/backend/social';
import type { Audience, PendingPost, Post, PostMedia } from '@/domain/types';
import { useDb } from '@/state/app';
import { cancelPendingPost, friendlyError, pendingStatusLabel, retryPendingPost, usePendingProgress } from '@/social/pendingPosts';
import { Avatar, ReportSheet, SnapshotView, Time } from './common';

export const CAPTION_MAX = 2000;
export const AUDIENCE_OPTIONS: { value: Audience; label: string }[] = [
  { value: 'only_me', label: 'Only me' },
  { value: 'friends', label: 'Friends' },
];

/* ================================================================ photos */
function gridClass(n: number) {
  if (n <= 1) return 'grid-cols-1';
  if (n === 3) return 'grid-cols-2 grid-rows-2';
  return 'grid-cols-2';
}

export function PhotoGrid({ media, authorName }: { media: PostMedia[]; authorName: string }) {
  const items = useMemo(() => [...media].sort((a, b) => a.position - b.position).slice(0, 4), [media]);
  const [open, setOpen] = useState<number | null>(null);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  if (!items.length) return null;
  const alt = (m: PostMedia, i: number) => m.description?.trim() || `Photo ${i + 1} of ${items.length} from ${authorName}’s post`;
  const single = items.length === 1 ? items[0] : null;
  const ratio = single && single.width && single.height ? Math.min(16 / 9, Math.max(4 / 5, single.width / single.height)) : 1;
  return (
    <>
      <div className={cx('grid gap-1 rounded-xl overflow-hidden mt-3', gridClass(items.length))}>
        {items.map((m, i) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setOpen(i)}
            aria-label={`Open photo ${i + 1} of ${items.length}`}
            className={cx('relative bg-surface-3 overflow-hidden', items.length === 3 && i === 0 && 'row-span-2')}
            style={{ aspectRatio: single ? String(ratio) : items.length === 3 && i === 0 ? undefined : '1' }}
          >
            {failed[m.id] || !(m.thumbUrl || m.url) ? (
              <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-faint text-xs">
                <ImageOff className="size-5" aria-hidden />
                Photo unavailable
              </span>
            ) : (
              <img
                src={(single ? m.url : m.thumbUrl) || m.thumbUrl || m.url}
                alt={alt(m, i)}
                loading="lazy"
                decoding="async"
                onError={() => setFailed((f) => ({ ...f, [m.id]: true }))}
                className="absolute inset-0 size-full object-cover"
              />
            )}
          </button>
        ))}
      </div>
      <Sheet open={open != null} onClose={() => setOpen(null)} title={open != null ? `Photo ${open + 1} of ${items.length}` : 'Photo'} wide>
        {open != null && (
          <figure>
            <div className="relative bg-surface-3 rounded-xl overflow-hidden flex items-center justify-center min-h-48">
              {failed[`full:${items[open].id}`] ? (
                <span className="py-16 text-sm text-faint">This photo is no longer available.</span>
              ) : (
                <img
                  src={items[open].url || items[open].thumbUrl}
                  alt={alt(items[open], open)}
                  onError={() => setFailed((f) => ({ ...f, [`full:${items[open].id}`]: true }))}
                  className="max-h-[70dvh] w-auto object-contain"
                />
              )}
            </div>
            {items[open].description && <figcaption className="text-sm text-muted mt-2">{items[open].description}</figcaption>}
            {items.length > 1 && (
              <div className="flex justify-between mt-3">
                <Button variant="ghost" icon={<ChevronLeft className="size-4" />} disabled={open === 0} onClick={() => setOpen(open - 1)}>
                  Previous
                </Button>
                <Button variant="ghost" disabled={open === items.length - 1} onClick={() => setOpen(open + 1)}>
                  Next <ChevronRight className="size-4" aria-hidden />
                </Button>
              </div>
            )}
          </figure>
        )}
      </Sheet>
    </>
  );
}

/* ================================================================ post card */
export interface PostCardProps {
  post: Post;
  meId?: string;
  onChange?: (p: Post) => void;
  onRemove?: (id: string) => void;
  onBlocked?: (authorId: string) => void;
  /** Hide the "comments" link (used on the post page itself). */
  standalone?: boolean;
}

type Dialog = null | 'menu' | 'edit' | 'audience' | 'delete' | 'report' | 'block';

export function PostCard({ post, meId, onChange, onRemove, onBlocked, standalone }: PostCardProps) {
  const toast = useToast();
  const [p, setP] = useState(post);
  useEffect(() => setP(post), [post]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [likeBusy, setLikeBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftCaption, setDraftCaption] = useState(post.caption);
  const [draftAudience, setDraftAudience] = useState<Audience>(post.audience);
  const mine = !!meId && p.authorId === meId;
  const authorName = p.author?.displayName || (p.author?.username ? `@${p.author.username}` : mine ? 'You' : 'Someone');
  const authorLink = p.author?.username ? `/u/${p.author.username}` : mine ? '/profile' : undefined;

  const update = (next: Post) => {
    setP(next);
    onChange?.(next);
  };

  const toggleLike = async () => {
    if (likeBusy) return;
    const before = p;
    const liked = !p.likedByMe;
    update({ ...p, likedByMe: liked, likeCount: Math.max(0, p.likeCount + (liked ? 1 : -1)) });
    setLikeBusy(true);
    try {
      if (liked) await socialApi.like(p.id);
      else await socialApi.unlike(p.id);
    } catch (e) {
      update(before);
      toast.show(friendlyError(e, liked ? 'Couldn’t like this post.' : 'Couldn’t remove your like.'), { tone: 'error' });
    } finally {
      setLikeBusy(false);
    }
  };

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    try {
      await fn();
      setDialog(null);
    } catch (e) {
      toast.show(friendlyError(e, fallback), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const saveCaption = () =>
    run(async () => {
      const caption = draftCaption.trim();
      await socialApi.updatePost(p.id, { caption });
      update({ ...p, caption, editedAt: new Date().toISOString() });
      toast.show('Caption updated', { tone: 'success' });
    }, 'Couldn’t update the caption.');

  const saveAudience = () =>
    run(async () => {
      await socialApi.updatePost(p.id, { audience: draftAudience });
      update({ ...p, audience: draftAudience });
      toast.show(draftAudience === 'only_me' ? 'Now only you can see this post' : 'Now visible to your friends', { tone: 'success' });
    }, 'Couldn’t change who can see this post.');

  const remove = () =>
    run(async () => {
      await socialApi.deletePost(p.id);
      onRemove?.(p.id);
      toast.show('Post deleted', { tone: 'success' });
    }, 'Couldn’t delete the post.');

  const block = () =>
    run(async () => {
      await socialApi.blockUser(p.authorId);
      onBlocked?.(p.authorId);
      toast.show(`${authorName} is blocked`, { tone: 'success' });
    }, 'Couldn’t block this person.');

  const menuItem = (label: string, icon: ReactNode, onClick: () => void, danger?: boolean) => (
    <li>
      <button type="button" onClick={onClick} className={cx('flex items-center gap-3 w-full min-h-12 px-2 rounded-xl hover:bg-surface-2 text-left', danger && 'text-danger')}>
        {icon}
        <span className="text-[15px]">{label}</span>
      </button>
    </li>
  );

  return (
    <Card as="article" className="p-4" aria-label={`Post by ${authorName}`}>
      <header className="flex items-center gap-3">
        {authorLink ? (
          <Link to={authorLink} className="flex items-center gap-3 min-w-0 flex-1 min-h-11">
            <Avatar profile={p.author} />
            <span className="min-w-0">
              <span className="block font-semibold truncate">{authorName}</span>
              <span className="block text-xs text-muted truncate">
                <Time iso={p.createdAt} />
                {p.editedAt ? ' · edited' : ''}
              </span>
            </span>
          </Link>
        ) : (
          <div className="flex items-center gap-3 min-w-0 flex-1 min-h-11">
            <Avatar profile={p.author} />
            <span className="min-w-0">
              <span className="block font-semibold truncate">{authorName}</span>
              <span className="block text-xs text-muted">
                <Time iso={p.createdAt} />
              </span>
            </span>
          </div>
        )}
        {mine && p.audience === 'only_me' && (
          <Badge>
            <Lock className="size-3" aria-hidden /> Only me
          </Badge>
        )}
        <IconButton label="Post options" onClick={() => setDialog('menu')}>
          <MoreHorizontal className="size-5" />
        </IconButton>
      </header>

      {p.caption && <p className="mt-3 text-[15px] whitespace-pre-wrap break-words">{p.caption}</p>}
      {p.snapshot && <SnapshotView snapshot={p.snapshot} className="mt-3" />}
      <PhotoGrid media={p.media} authorName={authorName} />

      <footer className="flex items-center gap-1 mt-2 -mb-1 -ml-2">
        <button
          type="button"
          onClick={toggleLike}
          aria-pressed={p.likedByMe}
          aria-label={p.likedByMe ? 'Unlike' : 'Like'}
          className={cx('inline-flex items-center gap-1.5 min-h-11 min-w-11 px-2 rounded-xl hover:bg-surface-2', p.likedByMe ? 'text-accent' : 'text-muted')}
        >
          <Heart className={cx('size-5', p.likedByMe && 'fill-current')} aria-hidden />
          <span className="text-sm tabular">{p.likeCount}</span>
          <span className="sr-only">{p.likeCount === 1 ? 'like' : 'likes'}</span>
        </button>
        {standalone ? (
          <span className="inline-flex items-center gap-1.5 min-h-11 px-2 text-muted">
            <MessageCircle className="size-5" aria-hidden />
            <span className="text-sm tabular">{p.commentCount}</span>
            <span className="sr-only">{p.commentCount === 1 ? 'comment' : 'comments'}</span>
          </span>
        ) : (
          <Link to={`/feed/post/${p.id}`} className="inline-flex items-center gap-1.5 min-h-11 min-w-11 px-2 rounded-xl hover:bg-surface-2 text-muted">
            <MessageCircle className="size-5" aria-hidden />
            <span className="text-sm tabular">{p.commentCount}</span>
            <span className="sr-only">{p.commentCount === 1 ? 'comment' : 'comments'}, open post</span>
          </Link>
        )}
      </footer>

      <Sheet open={dialog === 'menu'} onClose={() => setDialog(null)} title="Post options">
        <ul className="flex flex-col">
          {mine ? (
            <>
              {menuItem('Edit caption', <Pencil className="size-5" aria-hidden />, () => {
                setDraftCaption(p.caption);
                setDialog('edit');
              })}
              {menuItem('Change who can see this', p.audience === 'friends' ? <Users className="size-5" aria-hidden /> : <Lock className="size-5" aria-hidden />, () => {
                setDraftAudience(p.audience);
                setDialog('audience');
              })}
              {menuItem('Delete post', <Trash2 className="size-5" aria-hidden />, () => setDialog('delete'), true)}
            </>
          ) : (
            <>
              {menuItem('Report post', <Flag className="size-5" aria-hidden />, () => setDialog('report'))}
              {menuItem(`Block ${authorName}`, <Ban className="size-5" aria-hidden />, () => setDialog('block'), true)}
            </>
          )}
        </ul>
      </Sheet>

      <Sheet
        open={dialog === 'edit'}
        onClose={() => setDialog(null)}
        title="Edit caption"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={saveCaption} disabled={draftCaption.trim() === p.caption}>
              Save
            </Button>
          </>
        }
      >
        <Textarea label="Caption" value={draftCaption} maxLength={CAPTION_MAX} onChange={(e) => setDraftCaption(e.target.value)} hint={`${draftCaption.length}/${CAPTION_MAX}`} />
      </Sheet>

      <Sheet
        open={dialog === 'audience'}
        onClose={() => setDialog(null)}
        title="Who can see this post"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={saveAudience} disabled={draftAudience === p.audience}>
              Save
            </Button>
          </>
        }
      >
        <Segmented label="Audience" value={draftAudience} onChange={setDraftAudience} options={AUDIENCE_OPTIONS} />
        <p className="text-xs text-muted mt-2">
          {draftAudience === 'only_me' ? 'Only you will see this post, its photos and comments.' : 'Your friends will see this post, its photos and comments.'}
        </p>
      </Sheet>

      <ConfirmDialog open={dialog === 'delete'} title="Delete this post?" body="The post, its photos, likes and comments will be removed. Your workout stays in your history." confirmLabel="Delete" danger busy={busy} onConfirm={remove} onCancel={() => setDialog(null)} />
      <ConfirmDialog
        open={dialog === 'block'}
        title={`Block ${authorName}?`}
        body="You won’t see each other’s posts or profiles, and they can’t send you friend requests. If you’re friends, the friendship ends. You can unblock later from Friends."
        confirmLabel="Block"
        danger
        busy={busy}
        onConfirm={block}
        onCancel={() => setDialog(null)}
      />
      <ReportSheet open={dialog === 'report'} onClose={() => setDialog(null)} target={{ postId: p.id }} what="post" />
    </Card>
  );
}

/* ================================================================ pending */
function useObjectUrls(blobs: Blob[]): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const u = blobs.map((b) => URL.createObjectURL(b));
    setUrls(u);
    return () => u.forEach((x) => URL.revokeObjectURL(x));
  }, [blobs]);
  return urls;
}

/** A local post that has NOT been published. Never shows likes/comments and never implies visibility. */
export function PendingPostCard({ pending }: { pending: PendingPost }) {
  const db = useDb();
  const toast = useToast();
  const progress = usePendingProgress(pending.id);
  const [confirm, setConfirm] = useState(false);
  const thumbs = useMemo(() => pending.photos.map((p) => p.thumb), [pending.photos]);
  const urls = useObjectUrls(thumbs);
  const label = pendingStatusLabel(pending);
  return (
    <Card as="article" className="p-4 border-dashed" aria-label={`Unpublished post: ${label}`}>
      <div className="flex items-center gap-2 text-sm">
        {pending.status === 'error' ? (
          <AlertTriangle className="size-4 text-danger" aria-hidden />
        ) : (
          <CloudUpload className={cx('size-4 text-warn', pending.status === 'uploading' && 'animate-pulse')} aria-hidden />
        )}
        <span className={cx('font-medium', pending.status === 'error' ? 'text-danger' : 'text-warn')}>{pending.status === 'error' ? 'Upload failed' : label}</span>
        <span className="text-muted">· not posted yet</span>
      </div>
      {pending.status === 'uploading' && (
        <div className="mt-2">
          <ProgressBar value={Math.round((progress ?? 0) * 100)} max={100} label="Upload progress" />
        </div>
      )}
      {pending.status === 'error' && pending.error && <p className="text-xs text-muted mt-1">{pending.error}</p>}
      <p className="text-xs text-muted mt-1">
        {pending.audience === 'friends' ? 'Friends will see it once it’s uploaded.' : 'It will be saved as Only me once it’s uploaded.'}
      </p>
      {pending.caption && <p className="mt-3 text-[15px] whitespace-pre-wrap break-words">{pending.caption}</p>}
      {pending.snapshot && <SnapshotView snapshot={pending.snapshot} className="mt-3" />}
      {urls.length > 0 && (
        <div className="grid grid-cols-4 gap-1 mt-3">
          {urls.map((u, i) => (
            <img key={u} src={u} alt={pending.photos[i]?.description || `Photo ${i + 1} waiting to upload`} className="aspect-square object-cover rounded-lg bg-surface-3" />
          ))}
        </div>
      )}
      <div className="flex gap-2 mt-3">
        {pending.status !== 'uploading' && (
          <Button size="sm" variant={pending.status === 'error' ? 'primary' : 'secondary'} icon={<RefreshCw className="size-4" />} onClick={() => void retryPendingPost(pending.id, db)}>
            {pending.status === 'error' ? 'Retry' : 'Try now'}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => setConfirm(true)}>
          Cancel post
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Cancel this post?"
        body="It won’t be uploaded and its photos will be removed from this device. Your workout isn’t affected."
        confirmLabel="Cancel post"
        danger
        onConfirm={async () => {
          setConfirm(false);
          await cancelPendingPost(pending.id, db);
          toast.show('Post cancelled');
        }}
        onCancel={() => setConfirm(false)}
      />
    </Card>
  );
}
