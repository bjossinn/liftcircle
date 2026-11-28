import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/**
 * Window scroll position across navigations (the window is the app's scroll container and Shell stays mounted, so
 * without this a long page's scrollY carries over to the next page — e.g. the exercise library opened a detail page
 * at the bottom).
 *
 * - PUSH / REPLACE to a new pathname → top of the page. Search-only updates (library ?q= / ?tab=, /settings?section=,
 *   nutrition dates) keep the position, and pages that place themselves (Settings' scrollIntoView, Feed's own restore)
 *   run their layout effects after this one, so they win.
 * - POP (Back / Forward) → the position saved for that history entry (location.key), retried for a moment while a
 *   lazily loaded page grows tall enough. Nothing saved (first load) → leave it alone. /feed restores itself.
 * - A location with a #hash is left to the browser / the page.
 *
 * Mounted in Shell before <Outlet />: sibling layout effects run in tree order, so the page's own effects run later.
 */
const SELF_RESTORING = [/^\/feed\/?$/];
const RETRY_MS = 1500;

export function ScrollReset() {
  const location = useLocation();
  const navType = useNavigationType();
  const positions = useRef(new Map<string, number>());
  const current = useRef<{ key: string; pathname: string } | null>(null);

  // Remember each history entry's position as the user scrolls (read before the next page renders and clamps it).
  useLayoutEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    const onScroll = () => {
      if (current.current) positions.current.set(current.current.key, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const prev = current.current;
    current.current = { key: location.key, pathname: location.pathname };
    if (!prev || location.hash) return; // first load, or an anchor target
    if (navType === 'POP') {
      if (SELF_RESTORING.some((r) => r.test(location.pathname))) return;
      const y = positions.current.get(location.key);
      if (y === undefined) return;
      return restore(y);
    }
    if (prev.pathname !== location.pathname) window.scrollTo(0, 0);
  }, [location.key, location.pathname, location.hash, navType]);

  return null;
}

/** Scroll to y, retrying on animation frames until the page is tall enough (lazy routes, live queries). */
function restore(y: number): () => void {
  const start = performance.now();
  let frame = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    for (const ev of USER_INPUT) window.removeEventListener(ev, stop);
  };
  const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
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
