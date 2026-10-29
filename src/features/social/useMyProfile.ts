import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { socialApi } from '@/backend/social';
import type { SocialProfile } from '@/domain/types';
import { friendlyError } from '@/social/pendingPosts';

/** In-memory (per account) copy of my social profile, shared across social screens. */
let cache: { account: string; profile: SocialProfile | null } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setMyProfileCache(account: string, profile: SocialProfile | null) {
  cache = { account, profile };
  emit();
}

/**
 * For the Settings screen: mirror settings.social.discoverable onto the server profile.
 * No-op (returns null) when the user has no social profile yet. Throws a user-readable Error.
 */
export async function updateDiscoverable(account: string, discoverable: boolean): Promise<SocialProfile | null> {
  try {
    const p = await socialApi.getMyProfile();
    if (!p) return null;
    if (p.discoverable === discoverable) return p;
    const saved = await socialApi.saveMyProfile({ username: p.username, displayName: p.displayName, bio: p.bio ?? undefined, interests: p.interests, discoverable });
    setMyProfileCache(account, saved);
    return saved;
  } catch (e) {
    throw new Error(friendlyError(e, 'Couldn’t update who can find you.'));
  }
}

export function useMyProfile(meId: string | undefined) {
  const snap = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cache,
    () => cache,
  );
  const known = !!meId && snap?.account === meId;
  const [loading, setLoading] = useState(!known);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!meId) return;
    setLoading(true);
    setError(null);
    try {
      setMyProfileCache(meId, await socialApi.getMyProfile());
    } catch (e) {
      setError(friendlyError(e, 'Couldn’t load your profile.'));
    } finally {
      setLoading(false);
    }
  }, [meId]);

  useEffect(() => {
    if (!meId) return;
    if (cache?.account === meId) {
      setLoading(false);
      return;
    }
    void reload();
  }, [meId, reload]);

  return { profile: known ? snap!.profile : null, loading: !!meId && !known && loading, known, error, reload };
}
