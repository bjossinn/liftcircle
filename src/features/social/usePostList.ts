import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedCursor, Page } from '@/backend/contract';
import type { ID, Post } from '@/domain/types';
import { friendlyError } from '@/social/pendingPosts';

export const PAGE_SIZE = 20;

/** Newest first: createdAt desc, then id desc (matches the server's keyset order). */
export function comparePosts(a: Pick<Post, 'createdAt' | 'id'>, b: Pick<Post, 'createdAt' | 'id'>): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Merge a freshly fetched first page into a previously loaded list without jumping:
 * fresh items win; older cached items beyond the fresh window are kept only if the server says
 * there is more (otherwise they no longer exist).
 */
export function mergeFirstPage(fresh: Page<Post>, cached: Post[], cachedNext: FeedCursor | null | undefined): { items: Post[]; next: FeedCursor | null } {
  if (!fresh.next || fresh.items.length === 0) return { items: fresh.items, next: fresh.next ?? null };
  const ids = new Set(fresh.items.map((p) => p.id));
  const oldest = fresh.items[fresh.items.length - 1];
  const older = cached.filter((c) => !ids.has(c.id) && comparePosts(c, oldest) > 0);
  return older.length ? { items: [...fresh.items, ...older], next: cachedNext ?? null } : { items: fresh.items, next: fresh.next };
}

interface Snapshot {
  items: Post[];
  next: FeedCursor | null;
  scrollY: number;
}
/** In-memory only (never persisted, never in the service worker cache). Cleared on account change via key. */
const memory = new Map<string, Snapshot>();
export function rememberScroll(key: string | null, y: number) {
  if (!key) return;
  const m = memory.get(key);
  if (m) m.scrollY = y;
}
export function recalledScroll(key: string | null): number {
  return key ? (memory.get(key)?.scrollY ?? 0) : 0;
}

export function usePostList(key: string | null, fetchPage: (cursor: FeedCursor | null) => Promise<Page<Post>>, opts: { remember?: boolean } = {}) {
  const cached = key && opts.remember ? memory.get(key) : undefined;
  const [items, setItems] = useState<Post[]>(cached?.items ?? []);
  const [next, setNext] = useState<FeedCursor | null>(cached?.next ?? null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(cached ? 'ready' : 'loading');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const reqId = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const stateRef = useRef({ items, next });
  stateRef.current = { items, next };

  useEffect(() => {
    if (key && opts.remember) {
      const prev = memory.get(key);
      memory.set(key, { items, next, scrollY: prev?.scrollY ?? 0 });
    }
  }, [key, items, next, opts.remember]);

  const refresh = useCallback(
    async (mode: 'initial' | 'refresh' = 'refresh') => {
      if (!key) return;
      const id = ++reqId.current;
      if (mode === 'initial' && stateRef.current.items.length === 0) setStatus('loading');
      else setRefreshing(true);
      setError(null);
      try {
        const page = await fetchRef.current(null);
        if (id !== reqId.current) return;
        const merged = mergeFirstPage(page, stateRef.current.items, stateRef.current.next);
        setItems(merged.items);
        setNext(merged.next);
        setStatus('ready');
      } catch (e) {
        if (id !== reqId.current) return;
        const msg = friendlyError(e, 'Couldn’t load posts.');
        if (stateRef.current.items.length === 0) {
          setStatus('error');
          setError(msg);
        } else setError(msg); // keep showing what we have
      } finally {
        if (id === reqId.current) setRefreshing(false);
      }
    },
    [key],
  );

  useEffect(() => {
    if (!key) return;
    const remembered = opts.remember ? memory.get(key) : undefined;
    const startItems = remembered?.items ?? [];
    const startNext = remembered?.next ?? null;
    stateRef.current = { items: startItems, next: startNext };
    setItems(startItems);
    setNext(startNext);
    setStatus(remembered ? 'ready' : 'loading');
    void refresh('initial');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadMore = useCallback(async () => {
    const cursor = stateRef.current.next;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    const id = reqId.current;
    try {
      const page = await fetchRef.current(cursor);
      if (id !== reqId.current) return;
      setItems((cur) => {
        const ids = new Set(cur.map((p) => p.id));
        return [...cur, ...page.items.filter((p) => !ids.has(p.id))];
      });
      setNext(page.next ?? null);
    } catch (e) {
      setMoreError(friendlyError(e, 'Couldn’t load more posts.'));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore]);

  const update = useCallback((p: Post) => setItems((cur) => cur.map((x) => (x.id === p.id ? p : x))), []);
  const remove = useCallback((id: ID) => setItems((cur) => cur.filter((x) => x.id !== id)), []);
  const removeAuthor = useCallback((authorId: ID) => setItems((cur) => cur.filter((x) => x.authorId !== authorId)), []);

  return { items, status, error, refreshing, refresh, hasMore: !!next, loadMore, loadingMore, moreError, update, remove, removeAuthor };
}
