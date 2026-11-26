/**
 * Coach tab channels: the training assistant (AI) is the Coach tab's main screen for everyone. Human coaching (My coach,
 * messages, past coaching, the coach workspace, applications, admin) gets a switcher next to it, but only for people it
 * concerns: anyone who has or had a human coach or a pending request, approved coaches and applicants, admins, and,
 * when the coach marketplace flag is on, everyone (the hub is where you find a coach).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Bot, HeartHandshake } from 'lucide-react';
import clsx from 'clsx';
import { coachingApi } from '@/backend/coaching';
import type { CoachingRelationship, CoachProfile } from '@/backend/coachingContract';
import { isFeatureEnabled } from '@/config/featureFlags';
import { useApp } from '@/state/app';

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
}

/** Last known answer per account, so coming back to the tab shows the switcher right away. */
const cache = new Map<string, HumanCoaching>();
export function clearCoachChannelCache() {
  cache.clear();
}

const NONE: HumanCoaching = { show: false, unread: 0 };

/** Whether to show the human-coaching channel for the signed-in user (never for guests or the personal version). */
export function useHumanCoaching(): HumanCoaching {
  const { auth, backendConfigured, online } = useApp();
  const marketplace = isFeatureEnabled('coachMarketplace');
  const userId = auth.status === 'signed_in' ? auth.userId : undefined;
  const key = userId ?? '';
  const [state, setState] = useState<HumanCoaching>(() => (userId ? (cache.get(key) ?? NONE) : NONE));

  useEffect(() => {
    if (!backendConfigured || !userId) {
      setState(NONE);
      return;
    }
    setState(cache.get(key) ?? NONE);
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
      // Only a complete answer can hide the channel; if any part failed (e.g. a network blip), keep what we knew.
      const complete = rels.status === 'fulfilled' && profile.status === 'fulfilled' && roles.status === 'fulfilled';
      const prev = cache.get(key) ?? NONE;
      const unread = relationships ? relationships.reduce((n, r) => n + (r.status === 'active' && r.unread > 0 ? r.unread : 0), 0) : prev.unread;
      const next: HumanCoaching = { show: hasHumanCoaching(ctx) || (!complete && prev.show), unread };
      cache.set(key, next);
      setState(next);
    });
    return () => {
      stale = true;
    };
  }, [backendConfigured, userId, key, online, marketplace]);

  if (!userId || !backendConfigured) return NONE;
  return marketplace ? { ...state, show: true } : state;
}

const pill = 'flex-1 inline-flex items-center justify-center gap-1.5 min-h-10 rounded-lg px-3 text-sm font-medium transition-colors';

/** Training assistant ↔ Coaching switch (links: /coach and /coaching). */
export function CoachSwitcher({ current, unread = 0 }: { current: 'ai' | 'human'; unread?: number }) {
  return (
    <nav aria-label="Coach channels" className="flex p-1 gap-1 rounded-xl bg-surface-2 border border-line">
      <Link to="/coach" aria-current={current === 'ai' ? 'page' : undefined} className={clsx(pill, current === 'ai' ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink')}>
        <Bot className="size-4" aria-hidden />
        Training assistant
      </Link>
      <Link to="/coaching" aria-current={current === 'human' ? 'page' : undefined} className={clsx(pill, current === 'human' ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink')}>
        <HeartHandshake className="size-4" aria-hidden />
        Coaching
        {unread > 0 && (
          <span className="ml-0.5 min-w-5 h-5 px-1 rounded-full bg-ember text-accent-ink text-[11px] leading-5 tabular" aria-label={`${unread} unread`}>
            {unread}
          </span>
        )}
      </Link>
    </nav>
  );
}
