import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/**
 * Window scroll position across navigations (the window is the app's scroll container and Shell stays mounted, so
 * without this a long page's scrollY carries over to the next page — e.g. the exercise library opened a detail page
 * at the bottom).
 *
 * - Every history entry (location.key) gets a saved position the moment it is reached, kept up to date while scrolling.
 * - PUSH / REPLACE to a new pathname → top of the page. Search-only updates (library ?q= / ?tab=, /settings?section=,
 *   nutrition dates) keep the current position, and a REPLACE hands the replaced entry's position to the new key
 *   (the old key can no longer be reached, so it is dropped). Pages that place themselves (Settings' scrollIntoView,
 *   Feed's own restore) run their layout effects after this one, so they win.
 * - POP (Back / Forward) → the entry's saved position, retried for a moment while a lazily loaded page grows tall
 *   enough. Nothing saved (first load, entries from before a reload) → leave it alone. /feed restores itself
 *   (FeedPage saves its position in a layout cleanup, which runs before this effect on the way out).
 * - A location with a #hash is left to the browser / the page.
 *
 * Mounted in Shell before <Outlet />: sibling layout effects run in tree order, so the page's own effects run later.
 * At most MAX_ENTRIES positions are kept (least recently used dropped).
 */
const SELF_RESTORING = [/^\/feed\/?$/];
const RETRY_MS = 1500;
export const MAX_ENTRIES = 50;

/** Bounded least-recently-used map of history key → scrollY. */
export class ScrollPositions {
  private map = new Map<string, number>();
  constructor(private max = MAX_ENTRIES) {}
  get(key: string): number | undefined {
    return this.map.get(key);
  }
  set(key: string, y: number): void {
    this.map.delete(key);
    this.map.set(key, y);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  get size(): number {
    return this.map.size;
  }
}

export function ScrollReset() {
  const location = useLocation();
  const navType = useNavigationType();
  const positions = useRef(new ScrollPositions());
  const current = useRef<{ key: string; pathname: string } | null>(null);

  // Keep the current entry's position up to date while scrolling.
  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    const onScroll = () => {
      if (current.current) positions.current.set(current.current.key, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const saved = positions.current;
    const prev = current.current;
    const { key, pathname, hash } = location;
    current.current = { key, pathname };
    // On the way out, record where this entry was left. This cleanup runs in the next commit's mutation phase, before
    // the outgoing page's DOM is removed, so it also catches a scroll whose event hadn't fired yet (scroll, then tap).
    let stopRestore: (() => void) | undefined;
    const leave = () => {
      stopRestore?.();
      saved.set(key, window.scrollY);
    };
    // Re-run for the same entry (StrictMode): nothing to do.
    if (prev?.key === key) return leave;
    if (prev && navType === 'REPLACE') saved.delete(prev.key);
    if (prev && !hash && navType === 'POP') {
      const y = saved.get(key);
      if (y !== undefined && !SELF_RESTORING.some((r) => r.test(pathname))) {
        saved.set(key, y);
        stopRestore = restore(y);
        return leave;
      }
    } else if (prev && !hash && prev.pathname !== pathname) {
      window.scrollTo(0, 0);
    }
    // Seed the entry where it is now (also covers the first load, #hash targets and search-only updates).
    saved.set(key, window.scrollY);
    return leave;
  }, [location, navType]);

  return null;
}

/** Scroll to y, retrying on animation frames until the page is tall enough (lazy routes, live queries). */
function restore(y: number): () => void {
  const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
  const start = performance.now();
  let frame = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    for (const ev of USER_INPUT) window.removeEventListener(ev, stop);
  };
  for (const ev of USER_INPUT) window.addEventListener(ev, stop, { passive: true });
  const attempt = () => {
    if (stopped) return;
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) <= 1 || performance.now() - start > RETRY_MS) return stop();
    frame = requestAnimationFrame(attempt);
  };
  attempt();
  return stop;
}
