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
import { useT } from '@/i18n';

export const CAPTION_MAX = 2000;
/** Audience choices with labels in the current language. */
export function useAudienceOptions(): { value: Audience; label: string }[] {
  const { t } = useT();
  return [
    { value: 'only_me', label: t('settings.onlyMe') },
    { value: 'friends', label: t('profile.friends') },
  ];
}

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
  const { t } = useT();
  if (!items.length) return null;
  const alt = (m: PostMedia, i: number) => m.description?.trim() || t('social.photo_alt_from', { n: i + 1, total: items.length, name: authorName });
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
            aria-label={t('social.open_photo_x_of_x', { n: i + 1, total: items.length })}
            className={cx('relative bg-surface-3 overflow-hidden', items.length === 3 && i === 0 && 'row-span-2')}
            style={{ aspectRatio: single ? String(ratio) : items.length === 3 && i === 0 ? undefined : '1' }}
          >
            {failed[m.id] || !(m.thumbUrl || m.url) ? (
              <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-faint text-xs">
                <ImageOff className="size-5" aria-hidden />
                {t('social.photo_unavailable')}
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
      <Sheet open={open != null} onClose={() => setOpen(null)} title={open != null ? t('social.photo_x_of_x', { n: open + 1, total: items.length }) : t('social.photo')} wide>
        {open != null && (
          <figure>
            <div className="relative bg-surface-3 rounded-xl overflow-hidden flex items-center justify-center min-h-48">
              {failed[`full:${items[open].id}`] ? (
                <span className="py-16 text-sm text-faint">{t('social.this_photo_is_no_longer_available')}</span>
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
                  {t('social.previous')}
                </Button>
                <Button variant="ghost" disabled={open === items.length - 1} onClick={() => setOpen(open + 1)}>
                  {t('social.next')} <ChevronRight className="size-4" aria-hidden />
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
  const { t, tp } = useT();
  const audienceOptions = useAudienceOptions();
  const [p, setP] = useState(post);
  useEffect(() => setP(post), [post]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [likeBusy, setLikeBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftCaption, setDraftCaption] = useState(post.caption);
  const [draftAudience, setDraftAudience] = useState<Audience>(post.audience);
  const mine = !!meId && p.authorId === meId;
  const authorName = p.author?.displayName || (p.author?.username ? `@${p.author.username}` : mine ? t('social.you') : t('social.someone'));
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
      toast.show(friendlyError(e, liked ? t('social.error.like') : t('social.error.unlike')), { tone: 'error' });
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
      toast.show(t('social.caption_updated'), { tone: 'success' });
    }, t('social.error.caption'));

  const saveAudience = () =>
    run(async () => {
      await socialApi.updatePost(p.id, { audience: draftAudience });
      update({ ...p, audience: draftAudience });
      toast.show(draftAudience === 'only_me' ? t('social.now_only_you_can_see_this') : t('social.now_visible_to_your_friends'), { tone: 'success' });
    }, t('social.error.audience'));

  const remove = () =>
    run(async () => {
      await socialApi.deletePost(p.id);
      onRemove?.(p.id);
      toast.show(t('social.post_deleted'), { tone: 'success' });
    }, t('social.error.delete_post'));

  const block = () =>
    run(async () => {
      await socialApi.blockUser(p.authorId);
      onBlocked?.(p.authorId);
      toast.show(t('social.x_is_blocked', { name: authorName }), { tone: 'success' });
    }, t('social.error.block'));

  const menuItem = (label: string, icon: ReactNode, onClick: () => void, danger?: boolean) => (
    <li>
      <button type="button" onClick={onClick} className={cx('flex items-center gap-3 w-full min-h-12 px-2 rounded-xl hover:bg-surface-2 text-left', danger && 'text-danger')}>
        {icon}
        <span className="text-[15px]">{label}</span>
      </button>
    </li>
  );

  return (
    <Card as="article" className="p-4" aria-label={t('social.post_by_x', { name: authorName })}>
      <header className="flex items-center gap-3">
        {authorLink ? (
          <Link to={authorLink} className="flex items-center gap-3 min-w-0 flex-1 min-h-11">
            <Avatar profile={p.author} />
            <span className="min-w-0">
              <span className="block font-semibold truncate">{authorName}</span>
              <span className="block text-xs text-muted truncate">
                <Time iso={p.createdAt} />
                {p.editedAt ? ` · ${t('social.edited')}` : ''}
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
            <Lock className="size-4" aria-hidden /> {t('settings.onlyMe')}
          </Badge>
        )}
        <IconButton label={t('social.post_options')} onClick={() => setDialog('menu')}>
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
          aria-label={p.likedByMe ? t('social.unlike') : t('social.like_2')}
          className={cx('inline-flex items-center gap-1.5 min-h-11 min-w-11 px-2 rounded-xl hover:bg-surface-2', p.likedByMe ? 'text-accent' : 'text-muted')}
        >
          <Heart className={cx('size-5', p.likedByMe && 'fill-current')} aria-hidden />
          <span className="text-sm tabular">{p.likeCount}</span>
          <span className="sr-only">{tp('social.likeWord', p.likeCount)}</span>
        </button>
        {standalone ? (
          <span className="inline-flex items-center gap-1.5 min-h-11 px-2 text-muted">
            <MessageCircle className="size-5" aria-hidden />
            <span className="text-sm tabular">{p.commentCount}</span>
            <span className="sr-only">{tp('social.commentWord', p.commentCount)}</span>
          </span>
        ) : (
          <Link to={`/feed/post/${p.id}`} className="inline-flex items-center gap-1.5 min-h-11 min-w-11 px-2 rounded-xl hover:bg-surface-2 text-muted">
            <MessageCircle className="size-5" aria-hidden />
            <span className="text-sm tabular">{p.commentCount}</span>
            <span className="sr-only">{tp('social.commentWordOpen', p.commentCount)}</span>
          </Link>
        )}
      </footer>

      <Sheet open={dialog === 'menu'} onClose={() => setDialog(null)} title={t('social.post_options')}>
        <ul className="flex flex-col">
          {mine ? (
            <>
              {menuItem(t('social.edit_caption'), <Pencil className="size-5" aria-hidden />, () => {
                setDraftCaption(p.caption);
                setDialog('edit');
              })}
              {menuItem(t('social.change_audience'), p.audience === 'friends' ? <Users className="size-5" aria-hidden /> : <Lock className="size-5" aria-hidden />, () => {
                setDraftAudience(p.audience);
                setDialog('audience');
              })}
              {menuItem(t('social.delete_post'), <Trash2 className="size-5" aria-hidden />, () => setDialog('delete'), true)}
            </>
          ) : (
            <>
              {menuItem(t('social.report_post'), <Flag className="size-5" aria-hidden />, () => setDialog('report'))}
              {menuItem(t('social.block_name', { name: authorName }), <Ban className="size-5" aria-hidden />, () => setDialog('block'), true)}
            </>
          )}
        </ul>
      </Sheet>

      <Sheet
        open={dialog === 'edit'}
        onClose={() => setDialog(null)}
        title={t('social.edit_caption')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={saveCaption} disabled={draftCaption.trim() === p.caption}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Textarea label={t('workout.share.caption')} value={draftCaption} maxLength={CAPTION_MAX} onChange={(e) => setDraftCaption(e.target.value)} hint={`${draftCaption.length}/${CAPTION_MAX}`} />
      </Sheet>

      <Sheet
        open={dialog === 'audience'}
        onClose={() => setDialog(null)}
        title={t('social.who_can_see_this_post')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={saveAudience} disabled={draftAudience === p.audience}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Segmented label={t('workout.share.audience')} value={draftAudience} onChange={setDraftAudience} options={audienceOptions} />
        <p className="text-xs text-muted mt-2">
          {draftAudience === 'only_me' ? t('social.only_you_will_see_this_post') : t('social.your_friends_will_see_this_post')}
        </p>
      </Sheet>

      <ConfirmDialog
        open={dialog === 'delete'}
        title={t('social.delete_this_post')}
        body={t('social.the_post_its_photos_likes_and')}
        confirmLabel={t('common.delete')}
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'block'}
        title={t('social.block_x', { name: authorName })}
        body={t('social.you_wont_see_each_others_posts_2')}
        confirmLabel={t('social.block')}
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
  const { t } = useT();
  const progress = usePendingProgress(pending.id);
  const [confirm, setConfirm] = useState(false);
  const thumbs = useMemo(() => pending.photos.map((p) => p.thumb), [pending.photos]);
  const urls = useObjectUrls(thumbs);
  const label = pendingStatusLabel(pending);
  return (
    <Card as="article" className="p-4 border-dashed" aria-label={t('social.unpublished_post_x', { status: label })}>
      <div className="flex items-center gap-2 text-sm">
        {pending.status === 'error' ? (
          <AlertTriangle className="size-4 text-danger" aria-hidden />
        ) : (
          <CloudUpload className={cx('size-4 text-warn', pending.status === 'uploading' && 'animate-pulse')} aria-hidden />
        )}
        <span className={cx('font-medium', pending.status === 'error' ? 'text-danger' : 'text-warn')}>{pending.status === 'error' ? t('social.upload_failed') : label}</span>
        <span className="text-muted">· {t('social.not_posted_yet')}</span>
      </div>
      {pending.status === 'uploading' && (
        <div className="mt-2">
          <ProgressBar value={Math.round((progress ?? 0) * 100)} max={100} label={t('workout.share.uploadProgress')} />
        </div>
      )}
      {pending.status === 'error' && pending.error && <p className="text-xs text-muted mt-1">{pending.error}</p>}
      <p className="text-xs text-muted mt-1">
        {pending.audience === 'friends' ? t('social.friends_will_see_it_once_its') : t('social.it_will_be_saved_as_only')}
      </p>
      {pending.caption && <p className="mt-3 text-[15px] whitespace-pre-wrap break-words">{pending.caption}</p>}
      {pending.snapshot && <SnapshotView snapshot={pending.snapshot} className="mt-3" />}
      {urls.length > 0 && (
        <div className="grid grid-cols-4 gap-1 mt-3">
          {urls.map((u, i) => (
            <img key={u} src={u} alt={pending.photos[i]?.description || t('social.photo_waiting_x', { n: i + 1 })} className="aspect-square object-cover rounded-lg bg-surface-3" />
          ))}
        </div>
      )}
      <div className="flex gap-2 mt-3">
        {pending.status !== 'uploading' && (
          <Button size="sm" variant={pending.status === 'error' ? 'primary' : 'secondary'} icon={<RefreshCw className="size-4" />} onClick={() => void retryPendingPost(pending.id, db)}>
            {pending.status === 'error' ? t('workout.retry') : t('social.try_now')}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => setConfirm(true)}>
          {t('social.cancel_post')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        title={t('social.cancel_this_post')}
        body={t('social.it_wont_be_uploaded_and_its')}
        confirmLabel={t('social.cancel_post')}
        danger
        onConfirm={async () => {
          setConfirm(false);
          await cancelPendingPost(pending.id, db);
          toast.show(t('social.post_cancelled'));
        }}
        onCancel={() => setConfirm(false)}
      />
    </Card>
  );
}
