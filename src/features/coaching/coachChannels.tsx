/**
 * Coach tab channels: the training assistant (AI) is the Coach tab's main screen for everyone. Human coaching (My coach,
 * messages, past coaching, the coach workspace, applications, admin) gets a switcher next to it, but only for people it
 * concerns: anyone who has or had a human coach or a pending request, approved coaches and applicants, admins, and,
 * when the coach marketplace flag is on, everyone, guests included (the hub is where you find a coach).
 * When it isn't known yet whether someone has coaching (first load failed, or offline with nothing known), the
 * Coaching entry stays with a Retry button rather than disappearing.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Bot, HeartHandshake, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { coachingApi } from '@/backend/coaching';
import type { CoachingRelationship, CoachProfile } from '@/backend/coachingContract';
import { isFeatureEnabled } from '@/config/featureFlags';
import { useApp } from '@/state/app';
import { useT } from '@/i18n';

export interface CoachContext {
  marketplace: boolean;
  /** undefined = not known (not signed in, offline, or the request failed). */
  relationships?: CoachingRelationship[];
  coachProfile?: CoachProfile | null;
  admin?: boolean;
  /** Unread coaching messages (tab badge). */
  unread?: number;
}

/** Whether the human-coaching channel is shown next to the training assistant. */
export function hasHumanCoaching(c: CoachContext): boolean {
  if (c.marketplace) return true;
  if ((c.unread ?? 0) > 0) return true;
  if (c.admin) return true;
  if (c.coachProfile) return true; // approved coach or applicant (any status)
  // As a client: active, pending or past coaching. As a coach: any client relationship.
  return (c.relationships ?? []).length > 0;
}

export interface HumanCoaching {
  /** Show the Coaching channel next to the training assistant. */
  show: boolean;
  /** Unread coaching messages across relationships (from the last load). */
  unread: number;
  /**
   * The answer isn't known: the first load failed (network error, server hiccup) or the app is offline, and nothing was
   * known before for this account. The Coaching entry stays (with Retry) instead of vanishing, so an existing client
   * opening a fresh tab during a network error keeps access to their coach; a confirmed empty answer hides it.
   */
  uncertain?: boolean;
  /** Load again (shown as Retry while `uncertain`). */
  retry?: () => void;
}

/** Last known answer per account (memory, plus localStorage so a fresh tab starts from it too). */
const cache = new Map<string, HumanCoaching>();
const STORE_PREFIX = 'lc-coach-channels:';
function readKnown(key: string): HumanCoaching | undefined {
  const mem = cache.get(key);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    const v = raw ? (JSON.parse(raw) as Partial<HumanCoaching>) : null;
    if (v && typeof v.show === 'boolean') {
      const known = { show: v.show, unread: typeof v.unread === 'number' && v.unread >= 0 ? v.unread : 0 };
      cache.set(key, known);
      return known;
    }
  } catch {
    /* storage blocked or malformed: treat as unknown */
  }
  return undefined;
}
function writeKnown(key: string, v: HumanCoaching) {
  const known = { show: v.show, unread: v.unread };
  cache.set(key, known);
  try {
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify(known));
  } catch {
    /* storage blocked: the in-memory copy still covers this tab */
  }
}
/** Forget the last known answers. `keepStored`: only this tab's memory (as a fresh tab would start). */
export function clearCoachChannelCache(opts: { keepStored?: boolean } = {}) {
  cache.clear();
  if (opts.keepStored) return;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(STORE_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    /* storage blocked */
  }
}

const NONE: HumanCoaching = { show: false, unread: 0 };
/** Nothing known and the answer couldn't be loaded: keep the Coaching entry, with Retry. */
const UNKNOWN: HumanCoaching = { show: true, unread: 0, uncertain: true };

/**
 * Whether to show the human-coaching channel. Never in the personal version (no backend). Guests see it only when the
 * coach marketplace is on (the hub is where you find a coach, and it has a guest intro); signed-in users when
 * hasHumanCoaching says so, or always with the marketplace on.
 */
export function useHumanCoaching(): HumanCoaching {
  const { auth, backendConfigured, online } = useApp();
  const marketplace = isFeatureEnabled('coachMarketplace');
  const userId = auth.status === 'signed_in' ? auth.userId : undefined;
  const key = userId ?? '';
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const [state, setState] = useState<HumanCoaching>(() => (userId ? (readKnown(key) ?? (online ? NONE : UNKNOWN)) : NONE));

  useEffect(() => {
    if (!backendConfigured || !userId) {
      setState(NONE);
      return;
    }
    const known = readKnown(key);
    // Offline with nothing known for this account: unknown, not "no coaching".
    setState(known ?? (online ? NONE : UNKNOWN));
    if (!online) return;
    let stale = false;
    void Promise.allSettled([coachingApi.myRelationships(), coachingApi.getMyCoachProfile(), coachingApi.myRoles()]).then(([rels, profile, roles]) => {
      if (stale) return;
      const relationships = rels.status === 'fulfilled' && Array.isArray(rels.value) ? rels.value : undefined;
      const ctx: CoachContext = {
        marketplace,
        relationships,
        coachProfile: profile.status === 'fulfilled' ? profile.value : undefined,
        admin: roles.status === 'fulfilled' ? !!roles.value?.admin : undefined,
      };
      const complete = rels.status === 'fulfilled' && Array.isArray(rels.value) && profile.status === 'fulfilled' && roles.status === 'fulfilled';
      const prev = readKnown(key);
      const unread = relationships ? relationships.reduce((n, r) => n + (r.status === 'active' && r.unread > 0 ? r.unread : 0), 0) : (prev?.unread ?? 0);
      const yes = hasHumanCoaching(ctx);
      let next: HumanCoaching;
      if (complete) {
        // A confirmed answer (possibly "none"): remember it for this account, on this device too.
        next = { show: yes, unread };
        writeKnown(key, next);
      } else if (yes) {
        next = { show: true, unread };
        writeKnown(key, next);
      } else if (prev) {
        // Only a complete answer can change a known one: a network blip keeps what we knew (shown or confirmed none).
        next = prev.show ? { show: true, unread } : prev;
      } else {
        next = UNKNOWN; // first load failed: keep a Coaching entry with Retry
      }
      setState(next);
    });
    return () => {
      stale = true;
    };
  }, [backendConfigured, userId, key, online, marketplace, attempt]);

  if (!backendConfigured) return NONE;
  if (!userId) return marketplace ? { show: true, unread: 0 } : NONE;
  if (marketplace) return { ...state, show: true, ...(state.uncertain ? { retry } : {}) };
  return state.uncertain ? { ...state, retry } : state;
}

const pill = 'flex-1 inline-flex items-center justify-center gap-1.5 min-h-10 rounded-lg px-3 text-sm font-medium transition-colors';

/**
 * Training assistant ↔ Coaching switch (links: /coach and /coaching). `onRetry`: whether there's coaching for this
 * account couldn't be loaded yet; a small Retry button sits next to the Coaching entry.
 */
export function CoachSwitcher({ current, unread = 0, onRetry }: { current: 'ai' | 'human'; unread?: number; onRetry?: () => void }) {
  const { t, tp } = useT();
  return (
    <div className="flex items-center gap-1">
      <nav aria-label={t('ai.channels.label')} className="flex-1 flex p-1 gap-1 rounded-xl bg-surface-2 border border-line">
        <Link to="/coach" aria-current={current === 'ai' ? 'page' : undefined} className={clsx(pill, current === 'ai' ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink')}>
          <Bot className="size-4" aria-hidden />
          {t('ai.title')}
        </Link>
        <Link to="/coaching" aria-current={current === 'human' ? 'page' : undefined} className={clsx(pill, current === 'human' ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink')}>
          <HeartHandshake className="size-4" aria-hidden />
          {t('ai.channels.human')}
          {unread > 0 && (
            <span className="ml-0.5 min-w-5 h-5 px-1 rounded-full bg-ember text-accent-ink text-[11px] leading-5 tabular" aria-label={tp('ai.channels.unread', unread)}>
              {unread}
            </span>
          )}
        </Link>
      </nav>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          aria-label={t('ai.channels.retry')}
          title={t('ai.channels.retryHint')}
          className="shrink-0 size-11 inline-flex items-center justify-center rounded-xl text-muted hover:text-ink hover:bg-surface-2"
        >
          <RotateCcw className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
