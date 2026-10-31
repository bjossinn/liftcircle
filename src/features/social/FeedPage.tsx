import { useEffect, useLayoutEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router';
import { Plus, RefreshCw, UserPlus } from 'lucide-react';
import { Button, EmptyState, ErrorState, IconButton, Notice, Page, SectionTitle, Spinner, cx } from '@/components/ui';
import { TopActions } from '@/app/TopActions';
import { socialApi } from '@/backend/social';
import { usePendingPosts, usePendingPostsRunner } from '@/social/pendingPosts';
import { AccessNotice, useSocialAccess } from './common';
import { PendingPostCard, PostCard } from './PostCard';
import { PAGE_SIZE, recalledScroll, rememberScroll, usePostList } from './usePostList';
import { useMyProfile } from './useMyProfile';
import { NoFriendsArt } from '@/components/illustrations';

export default function FeedPage() {
  usePendingPostsRunner();
  const nav = useNavigate();
  const { access, meId } = useSocialAccess();
  const pending = usePendingPosts();
  const key = access === 'ok' && meId ? `feed:${meId}` : null;
  const list = usePostList(key, (cursor) => socialApi.getFeed(cursor, PAGE_SIZE), { remember: true });
  const me = useMyProfile(access === 'ok' ? meId : undefined);

  // Stable scroll: restore where the reader left off (e.g. after opening a post), save on leave.
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || !key || list.items.length === 0) return;
    restored.current = true;
    const y = recalledScroll(key);
    if (y > 0) window.scrollTo(0, y);
  }, [key, list.items.length]);
  useEffect(() => {
    if (!key) return;
    return () => rememberScroll(key, window.scrollY);
  }, [key]);

  // When a pending post finishes publishing, pull it into the feed.
  const prevPending = useRef(pending.length);
  useEffect(() => {
    if (pending.length < prevPending.current && key) void list.refresh();
    prevPending.current = pending.length;
  }, [pending.length, key, list]);

  // Infinite scroll (with a visible "Load more" button as fallback).
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMore, loadMore, loadingMore, moreError } = list;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || moreError || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadMore(), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, moreError, list.items.length]);

  const canCompose = access === 'ok' || access === 'offline' || access === 'expired';

  return (
    <Page
      title="Feed"
      actions={
        <>
          {canCompose && (
            <IconButton label="New post" onClick={() => nav('/feed/new')}>
              <Plus className="size-5" />
            </IconButton>
          )}
          <TopActions />
        </>
      }
    >
      {pending.length > 0 && canCompose && (
        <section aria-labelledby="pending-title">
          <SectionTitle id="pending-title">Not posted yet</SectionTitle>
          {access === 'expired' && <Notice className="mb-2">These will upload after you sign in again.</Notice>}
          <ul className="flex flex-col gap-3">
            {pending.map((p) => (
              <li key={p.id}>
                <PendingPostCard pending={p} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {access !== 'ok' ? (
        <AccessNotice access={access} what="The feed" />
      ) : (
        <section aria-labelledby="feed-title" aria-busy={list.status === 'loading' || list.refreshing}>
          <div className="flex items-center justify-between mt-4 mb-2 px-1">
            <h2 id="feed-title" className="text-[13px] font-semibold uppercase tracking-wide text-muted">
              You and your friends
            </h2>
            <Button size="sm" variant="ghost" onClick={() => void list.refresh()} disabled={list.refreshing || list.status === 'loading'} icon={<RefreshCw className={cx('size-4', list.refreshing && 'animate-spin')} aria-hidden />}>
              {list.refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>

          {me.known && !me.profile && (
            <Notice tone="accent" className="mb-3">
              <p>Create a profile so friends can find you and see your posts.</p>
              <Link to="/profile/edit" className="inline-flex min-h-11 items-center font-semibold text-accent">
                Create profile
              </Link>
            </Notice>
          )}

          {list.status === 'ready' && list.error && (
            <Notice tone="warn" className="mb-3">
              <span>{list.error}</span>{' '}
              <button type="button" className="font-semibold text-accent min-h-11" onClick={() => void list.refresh()}>
                Try again
              </button>
            </Notice>
          )}

          {list.status === 'loading' && <Spinner label="Loading the feed" />}
          {list.status === 'error' && <ErrorState title="Couldn’t load the feed" message={list.error ?? undefined} onRetry={() => void list.refresh('initial')} />}
          {list.status === 'ready' && list.items.length === 0 && (
            <EmptyState
              illustration={<NoFriendsArt />}
              title="Your feed is quiet"
              body="Share a workout, or add friends to see what they’re up to."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => nav('/feed/new')}>
                    New post
                  </Button>
                  <Button icon={<UserPlus className="size-4" />} onClick={() => nav('/friends')}>
                    Find friends
                  </Button>
                </div>
              }
            />
          )}

          {list.items.length > 0 && (
            <ul className="flex flex-col gap-3">
              {list.items.map((p) => (
                <li key={p.id}>
                  <PostCard post={p} meId={meId} onChange={list.update} onRemove={list.remove} onBlocked={list.removeAuthor} />
                </li>
              ))}
            </ul>
          )}

          {list.status === 'ready' && list.items.length > 0 && (
            <div className="flex flex-col items-center py-4" ref={sentinel}>
              {list.hasMore ? (
                <>
                  {list.moreError && (
                    <p role="alert" className="text-sm text-danger mb-2">
                      {list.moreError}
                    </p>
                  )}
                  <Button onClick={() => void list.loadMore()} loading={list.loadingMore}>
                    {list.moreError ? 'Try again' : 'Load more'}
                  </Button>
                </>
              ) : (
                <p className="text-xs text-faint">You’re all caught up</p>
              )}
            </div>
          )}
          {loadingMore && <span className="sr-only" role="status">Loading more posts</span>}
        </section>
      )}
    </Page>
  );
}
