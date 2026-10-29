/** Loading AI coach availability/settings and the user's active human coach (if any). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { aiApi } from '@/backend/ai';
import { coachingApi } from '@/backend/coaching';
import type { AiAvailability, AiSettings, AiUsage, CoachingRelationship } from '@/backend/coachingContract';
import { useApp } from '@/state/app';
import { classifyAiError } from './model';

export type AiBoot =
  | { phase: 'loading' }
  | { phase: 'guest' }
  | {
      phase: 'ready';
      availability: AiAvailability;
      usage?: AiUsage;
      /** null = never set up; undefined = couldn't be loaded (e.g. offline). */
      settings: AiSettings | null | undefined;
      settingsError?: string;
    };

export function useAiBoot() {
  const { auth, backendConfigured, online } = useApp();
  const [boot, setBoot] = useState<AiBoot>({ phase: 'loading' });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    const set = (b: AiBoot) => {
      if (my === seq.current) setBoot(b);
    };
    if (!backendConfigured) return set({ phase: 'ready', availability: { available: false, reason: 'backend_missing' }, settings: undefined });
    if (auth.status === 'loading') return set({ phase: 'loading' });
    if (auth.status === 'guest') return set({ phase: 'guest' });
    if (!online) return set({ phase: 'ready', availability: { available: false, reason: 'offline' }, settings: undefined });

    const [st, se] = await Promise.allSettled([aiApi.status(), aiApi.getSettings()]);
    let availability: AiAvailability;
    // A rejected status() means the server couldn't answer at all; classify it truthfully.
    let usage: AiUsage | undefined;
    if (st.status === 'fulfilled') {
      const { usage: u, ...a } = st.value;
      availability = a as AiAvailability;
      usage = u;
    } else {
      const c = classifyAiError(st.reason);
      availability =
        c.kind === 'offline'
          ? { available: false, reason: 'offline' }
          : c.kind === 'disabled'
            ? { available: false, reason: 'disabled' }
            : { available: false, reason: c.reason ?? 'provider_down' };
    }
    const settings = se.status === 'fulfilled' ? se.value : undefined;
    const settingsError = se.status === 'rejected' ? classifyAiError(se.reason).message : undefined;
    set({ phase: 'ready', availability, usage, settings, settingsError });
  }, [auth.status, backendConfigured, online]);

  useEffect(() => {
    void load();
  }, [load]);

  const setSettings = useCallback((s: AiSettings) => {
    setBoot((b) => (b.phase === 'ready' ? { ...b, settings: s } : b));
  }, []);
  const setUsage = useCallback((u: Partial<AiUsage>) => {
    setBoot((b) => (b.phase === 'ready' && b.usage ? { ...b, usage: { ...b.usage, ...u } } : b.phase === 'ready' && typeof u.requests === 'number' ? { ...b, usage: u as AiUsage } : b));
  }, []);

  return { boot, reload: load, setSettings, setUsage };
}

/** The user's active human coach (as a client). null when none or when coaching isn't reachable. */
export function useActiveCoach(): CoachingRelationship | null {
  const { auth, online, backendConfigured } = useApp();
  const [rel, setRel] = useState<CoachingRelationship | null>(null);
  useEffect(() => {
    if (!backendConfigured || auth.status !== 'signed_in' || !online) return;
    let cancelled = false;
    coachingApi
      .myRelationships()
      .then((rs) => {
        if (!cancelled) setRel(rs.find((r) => r.status === 'active' && !r.viewerIsCoach && !r.coach.suspended) ?? null);
      })
      .catch(() => {
        if (!cancelled) setRel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.status, online, backendConfigured]);
  return rel;
}
